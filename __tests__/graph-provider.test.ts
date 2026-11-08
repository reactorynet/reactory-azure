import ApiError from '@reactory/server-core/exceptions';

/**
 * The Graph SDK is mocked: this module has no tenant and must never make a live
 * call (AZ-01 hard constraint). `Client.init` is the seam the provider uses, so
 * every assertion here is about the shape it builds and the policy it applies.
 */
jest.mock('@microsoft/microsoft-graph-client', () => ({
  Client: { init: jest.fn() },
  ResponseType: { RAW: 'raw', TEXT: 'text', JSON: 'json' },
}));

// eslint-disable-next-line import/first
import { Client } from '@microsoft/microsoft-graph-client';
// eslint-disable-next-line import/first
import {
  AzureGraphClientProvider,
  GRAPH_BATCH_LIMIT,
  GRAPH_MAX_ATTEMPTS,
} from '../services/graph/AzureGraphClientProvider';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';

interface IChainMock {
  version: jest.Mock;
  query: jest.Mock;
  headers: jest.Mock;
  select: jest.Mock;
  responseType: jest.Mock;
  search: jest.Mock;
  get: jest.Mock;
  post: jest.Mock;
  api: jest.Mock;
}

/**
 * Build the fluent `client.api(path).version().query().headers().get()` chain the
 * provider talks to, and wire `Client.init` to return it.
 */
function mockClient(): IChainMock {
  const chain: any = {};
  chain.version = jest.fn(() => chain);
  chain.query = jest.fn(() => chain);
  chain.headers = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.responseType = jest.fn(() => chain);
  chain.search = jest.fn(() => chain);
  chain.get = jest.fn();
  chain.post = jest.fn();
  chain.api = jest.fn(() => chain);

  (Client.init as jest.Mock).mockReturnValue(chain);
  return chain;
}

function createProvider(getToken: jest.Mock = jest.fn().mockResolvedValue({ token: 'vault-token', source: 'vault' })) {
  const authService = { getToken };
  const context: any = {
    getService: jest.fn((id: string) => (id === 'azure.AzureAuthService@1.0.0' ? authService : undefined)),
    error: jest.fn(),
  };

  const provider = new AzureGraphClientProvider({} as any, context);
  provider.setAzureAuthService(authService);

  return { provider, authService, context };
}

describe('AzureGraphClientProvider — client construction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds the client through Client.init with debugLogging disabled', async () => {
    const chain = mockClient();
    const { provider } = createProvider();

    const client = provider.getClient(USER_ID);

    expect(Client.init).toHaveBeenCalledTimes(1);
    const options = (Client.init as jest.Mock).mock.calls[0][0];

    expect(options.debugLogging).toBe(false);
    expect(options.defaultVersion).toBe('v1.0');
    expect(typeof options.authProvider).toBe('function');
    expect(client).toBe(chain);
  });

  it('resolves the token through AzureAuthService.getToken(userId)', async () => {
    mockClient();
    const { provider, authService } = createProvider();

    const client: any = provider.getClient(USER_ID);
    const options = (Client.init as jest.Mock).mock.calls[0][0];

    const done = jest.fn();
    options.authProvider(done);
    await new Promise((resolve) => setImmediate(resolve));

    expect(authService.getToken).toHaveBeenCalledWith(USER_ID);
    expect(done).toHaveBeenCalledWith(null, 'vault-token');
    // The provider records the provenance so a later 401 can be classified.
    expect(client.__azureTokenSource()).toBe('vault');
  });

  it('refuses to build a client without a userId', () => {
    const { provider } = createProvider();
    expect(() => provider.getClient('')).toThrow(ApiError);
  });
});

describe('AzureGraphClientProvider — error contract', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a 401 with ApiError InvalidAuthenticationToken — not [] or null', async () => {
    const chain = mockClient();
    chain.get.mockRejectedValue(
      Object.assign(new Error('Access token has expired'), {
        statusCode: 401,
        code: 'InvalidAuthenticationToken',
      }),
    );

    const { provider } = createProvider();

    let caught: any;
    try {
      await provider.request(USER_ID, '/me');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('InvalidAuthenticationToken');
    expect(caught).not.toEqual([]);
    expect(caught).not.toBeNull();
  });

  it('maps a bare 401 to InvalidAuthenticationToken', async () => {
    const chain = mockClient();
    chain.get.mockRejectedValue({ statusCode: 401 });

    const { provider } = createProvider();

    await expect(provider.request(USER_ID, '/me')).rejects.toMatchObject({
      code: 'InvalidAuthenticationToken',
    });
  });

  it('raises LegacyTokenExpired for a 401 on a legacy-sourced token', async () => {
    const chain = mockClient();
    chain.get.mockRejectedValue({ statusCode: 401, code: 'InvalidAuthenticationToken' });

    const { provider } = createProvider(
      jest.fn().mockResolvedValue({ token: 'legacy-token', source: 'legacy' }),
    );

    await expect(provider.request(USER_ID, '/me')).rejects.toMatchObject({
      code: 'LegacyTokenExpired',
    });
  });

  it('never retries a 4xx other than 429', async () => {
    const chain = mockClient();
    chain.get.mockRejectedValue({ statusCode: 404, code: 'itemNotFound' });

    const { provider } = createProvider();

    await expect(provider.request(USER_ID, '/me/drive/items/missing')).rejects.toMatchObject({
      code: 'itemNotFound',
    });
    expect(chain.get).toHaveBeenCalledTimes(1);
  });
});

describe('AzureGraphClientProvider — pagination', () => {
  beforeEach(() => jest.clearAllMocks());

  it('follows three @odata.nextLink pages and returns every item', async () => {
    const chain = mockClient();
    chain.get
      .mockResolvedValueOnce({
        value: [{ id: 'a' }, { id: 'b' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=2',
      })
      .mockResolvedValueOnce({
        value: [{ id: 'c' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=3',
      })
      .mockResolvedValueOnce({
        value: [{ id: 'd' }],
      });

    const { provider } = createProvider();
    const items = await provider.requestAll<{ id: string }>(USER_ID, '/me/messages', { top: 2 });

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(chain.get).toHaveBeenCalledTimes(3);
    expect(chain.api.mock.calls.map((call: any[]) => call[0])).toEqual([
      '/me/messages',
      'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=2',
      'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=3',
    ]);
  });

  it('throws when the page bound is exceeded instead of truncating', async () => {
    const chain = mockClient();
    const page = (n: number) => ({
      value: [{ id: `item-${n}` }],
      '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=${n + 1}`,
    });

    chain.get
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2))
      .mockResolvedValueOnce(page(3))
      .mockResolvedValueOnce(page(4));

    const { provider } = createProvider();

    await expect(
      provider.requestAll(USER_ID, '/me/messages', { maxPages: 3 }),
    ).rejects.toMatchObject({ code: 'PaginationLimitExceeded' });

    expect(chain.get).toHaveBeenCalledTimes(3);
  });

  it('collects delta items and the final deltaLink', async () => {
    const chain = mockClient();
    chain.get
      .mockResolvedValueOnce({
        value: [{ id: 'a' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=2',
      })
      .mockResolvedValueOnce({
        value: [{ id: 'b' }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=final',
      });

    const { provider } = createProvider();
    const result = await provider.delta<{ id: string }>(USER_ID, '/me/messages/delta');

    expect(result.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.deltaLink).toBe('https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=final');
  });
});

describe('AzureGraphClientProvider — retry policy', () => {
  beforeEach(() => jest.clearAllMocks());

  afterEach(() => jest.useRealTimers());

  it('honours Retry-After: 2 on a 429 and retries exactly once', async () => {
    jest.useFakeTimers();

    const chain = mockClient();
    chain.get
      .mockRejectedValueOnce({ statusCode: 429, headers: { 'retry-after': '2' } })
      .mockResolvedValueOnce({ ok: true });

    const { provider } = createProvider();
    const pending = provider.request(USER_ID, '/me');

    await jest.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result).toEqual({ ok: true });
    expect(chain.get).toHaveBeenCalledTimes(2);
  });

  it('does not wait at all for a 400', async () => {
    const chain = mockClient();
    chain.get.mockRejectedValue({ statusCode: 400, code: 'ErrorInvalidRequest' });

    const { provider } = createProvider();

    await expect(provider.request(USER_ID, '/me')).rejects.toMatchObject({
      code: 'ErrorInvalidRequest',
    });
    expect(chain.get).toHaveBeenCalledTimes(1);
  });

  it('gives up after three attempts on a persistent 503', async () => {
    jest.useFakeTimers();

    const chain = mockClient();
    chain.get.mockRejectedValue({ statusCode: 503, code: 'serviceNotAvailable' });

    const { provider } = createProvider();
    const pending = provider.request(USER_ID, '/me');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'serviceNotAvailable' });

    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(chain.get).toHaveBeenCalledTimes(GRAPH_MAX_ATTEMPTS);
  });
});

describe('AzureGraphClientProvider — batching', () => {
  beforeEach(() => jest.clearAllMocks());

  it(`refuses more than ${GRAPH_BATCH_LIMIT} requests without calling Graph`, async () => {
    mockClient();
    const { provider } = createProvider();

    const requests = Array.from({ length: GRAPH_BATCH_LIMIT + 1 }, (_, index) => ({
      id: String(index),
      method: 'GET' as const,
      url: '/me',
    }));

    await expect(provider.batch(USER_ID, requests)).rejects.toMatchObject({
      code: 'BatchSizeExceeded',
    });
    expect(Client.init).not.toHaveBeenCalled();
  });

  it('posts a valid batch and returns the responses', async () => {
    const chain = mockClient();
    chain.post.mockResolvedValue({ responses: [{ id: '1', status: 200 }] });

    const { provider } = createProvider();
    const responses = await provider.batch(USER_ID, [{ id: '1', method: 'GET', url: '/me' }]);

    expect(chain.post).toHaveBeenCalledWith({ requests: [{ id: '1', method: 'GET', url: '/me' }] });
    expect(responses).toEqual([{ id: '1', status: 200 }]);
  });
});

describe('AzureGraphClientProvider — requestRaw', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses ResponseType.RAW and maps a Buffer body to a binary response', async () => {
    const chain = mockClient();
    chain.get.mockResolvedValue({
      status: 200,
      headers: { 'Content-Type': 'image/png', 'content-length': '4' },
      body: Buffer.from('PNG!'),
    });

    const { provider } = createProvider();
    const response = await provider.requestRaw(USER_ID, '/me/photos/96x96/$value');

    expect(chain.responseType).toHaveBeenCalledWith('raw');
    expect(response.status).toBe(200);
    expect(response.buffer.toString()).toBe('PNG!');
    expect(response.contentType).toBe('image/png');
    // Header names are lower-cased so callers never have to guess the casing.
    expect(response.headers['content-length']).toBe('4');
  });

  it('reads a fetch-style Headers collection', async () => {
    const chain = mockClient();
    const headers = new Map<string, string>([['content-type', 'image/jpeg']]);
    chain.get.mockResolvedValue({ status: 200, headers, body: Buffer.from('jpeg') });

    const { provider } = createProvider();
    const response = await provider.requestRaw(USER_ID, '/me/photos/120x120/$value');

    expect(response.contentType).toBe('image/jpeg');
  });

  it('reads a body that only exposes arrayBuffer()', async () => {
    const chain = mockClient();
    // A standalone Uint8Array: Buffer.from(string).buffer is a pooled slab and
    // would include neighbouring bytes, which would make this assertion lie.
    chain.get.mockResolvedValue({
      status: 200,
      headers: {},
      body: { arrayBuffer: async () => new Uint8Array([102, 114, 111, 109, 45, 98, 111, 100, 121]).buffer },
    });

    const { provider } = createProvider();
    await expect(provider.requestRaw(USER_ID, '/x')).resolves.toMatchObject({
      buffer: Buffer.from('from-body'),
    });
  });

  it('reads a response that only exposes arrayBuffer()', async () => {
    const chain = mockClient();
    chain.get.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: async () => new Uint8Array([114, 101, 115, 112]).buffer,
    });

    const { provider } = createProvider();
    await expect(provider.requestRaw(USER_ID, '/x')).resolves.toMatchObject({
      buffer: Buffer.from('resp'),
    });
  });

  it('drains a stream body', async () => {
    const { Readable } = require('stream');
    const chain = mockClient();
    chain.get.mockResolvedValue({
      status: 200,
      headers: {},
      body: Readable.from([Buffer.from('streamed')]),
    });

    const { provider } = createProvider();
    await expect(provider.requestRaw(USER_ID, '/x')).resolves.toMatchObject({
      buffer: Buffer.from('streamed'),
    });
  });

  it('returns an empty buffer when the body has no readable form', async () => {
    const chain = mockClient();
    chain.get.mockResolvedValue({ status: 204, headers: {}, body: null });

    const { provider } = createProvider();
    const response = await provider.requestRaw(USER_ID, '/x');

    expect(response.status).toBe(204);
    expect(response.buffer).toHaveLength(0);
  });

  it('rejects with the Graph code, not an empty buffer', async () => {
    const chain = mockClient();
    chain.get.mockRejectedValue({ statusCode: 404, code: 'ImageNotFound' });

    const { provider } = createProvider();
    await expect(provider.requestRaw(USER_ID, '/me/photos/96x96/$value')).rejects.toMatchObject({
      code: 'ImageNotFound',
    });
  });
});

describe('AzureGraphClientProvider — delta page bound', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws instead of returning a partial sync when the bound is hit', async () => {
    const chain = mockClient();
    const page = (n: number) => ({
      value: [{ id: `c${n}` }],
      '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=${n + 1}`,
    });

    chain.get
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2));

    const { provider } = createProvider();

    await expect(
      provider.delta(USER_ID, '/me/messages/delta', { maxPages: 2 }),
    ).rejects.toMatchObject({ code: 'PaginationLimitExceeded' });

    expect(chain.get).toHaveBeenCalledTimes(2);
  });
});

describe('AzureGraphClientProvider — request options and batch failures', () => {
  beforeEach(() => jest.clearAllMocks());

  it('applies the requested api version and query string', async () => {
    const chain = mockClient();
    chain.get.mockResolvedValue({ ok: true });

    const { provider } = createProvider();
    await provider.request(USER_ID, '/me/messages', { apiVersion: 'v1.0', select: 'id', top: 5 });

    expect(chain.version).toHaveBeenCalledWith('v1.0');
    expect(chain.query).toHaveBeenCalledWith('$select=id&$top=5');
    expect(chain.headers).toHaveBeenCalledWith(expect.objectContaining({ Accept: 'application/json' }));
  });

  it('rejects an empty batch', async () => {
    mockClient();
    const { provider } = createProvider();

    await expect(provider.batch(USER_ID, [])).rejects.toMatchObject({ code: 'BatchSizeExceeded' });
  });

  it('surfaces a batch failure as an ApiError', async () => {
    const chain = mockClient();
    chain.post.mockRejectedValue({ statusCode: 400, code: 'BadRequest', message: 'malformed batch' });

    const { provider } = createProvider();

    await expect(
      provider.batch(USER_ID, [{ id: '1', method: 'GET', url: '/me' }]),
    ).rejects.toMatchObject({ code: 'BadRequest' });
  });

  it('never masks the Graph error when re-resolving the token provenance fails', async () => {
    const chain = mockClient();
    chain.get.mockRejectedValue({ statusCode: 400, code: 'ErrorInvalidRequest' });

    const getToken = jest.fn()
      .mockResolvedValueOnce({ token: 'vault-token', source: 'vault' })
      .mockRejectedValueOnce(new Error('token store unavailable'));

    const { provider } = createProvider(getToken);

    await expect(provider.request(USER_ID, '/me')).rejects.toMatchObject({
      code: 'ErrorInvalidRequest',
    });
  });

  it('keeps the deprecated token client within this file and debugLogging false', () => {
    const chain = mockClient();
    const { provider } = createProvider();

    expect(provider.getClientWithToken('legacy-token')).toBe(chain);

    const options = (Client.init as jest.Mock).mock.calls[0][0];
    expect(options.debugLogging).toBe(false);
  });
});

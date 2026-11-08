import ApiError from '@reactory/server-core/exceptions';

/**
 * Request-shape suite: asserts the exact Graph request the mail service
 * produces.
 *
 * The Graph SDK is mocked (this module has no tenant and must never make a live
 * call), but the *real* `AzureGraphClientProvider` sits between the service and
 * the SDK, so these assertions cover the whole path: path encoding, `$select`,
 * `$filter`, `$search`, `$top`, `$orderby`, `$count` and the `Prefer` /
 * `ConsistencyLevel` headers.
 */
jest.mock('@microsoft/microsoft-graph-client', () => ({
  Client: { init: jest.fn() },
  ResponseType: { RAW: 'raw', TEXT: 'text', JSON: 'json' },
}));

// eslint-disable-next-line import/first
import { Client } from '@microsoft/microsoft-graph-client';
// eslint-disable-next-line import/first
import { AzureGraphClientProvider } from '../services/graph/AzureGraphClientProvider';
// eslint-disable-next-line import/first
import { AzureMailService } from '../services/AzureMailService';
// eslint-disable-next-line import/first
import {
  DEFAULT_MAIL_MESSAGE_DETAIL_SELECT,
  DEFAULT_MAIL_MESSAGE_SELECT,
} from '../types/mail.types';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';

/** The fluent SDK chain the provider talks to. */
function mockSdk(): any {
  const chain: any = {};
  chain.api = jest.fn(() => chain);
  chain.version = jest.fn(() => chain);
  chain.query = jest.fn(() => chain);
  chain.headers = jest.fn(() => chain);
  chain.get = jest.fn();
  chain.patch = jest.fn();

  (Client.init as jest.Mock).mockReturnValue(chain);
  return chain;
}

function createService(): { service: AzureMailService; redis: any } {
  const authService = {
    getToken: jest.fn().mockResolvedValue({ token: 'vault-token', source: 'vault' }),
  };

  const context: any = {
    getService: jest.fn((id: string) =>
      (id === 'azure.AzureAuthService@1.0.0' ? authService : undefined)),
  };

  const provider = new AzureGraphClientProvider({} as any, context);
  provider.setAzureAuthService(authService);

  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const service = new AzureMailService({} as any, context);
  service.setGraphClientProvider(provider);
  service.setRedisService(redis);

  return { service, redis };
}

/** Decode a query string into a parameter map so assertions are exact. */
function parseQuery(query: string): Record<string, string> {
  const params: Record<string, string> = {};

  for (const entry of String(query || '').replace(/^\?/, '').split('&')) {
    if (!entry) continue;
    const index = entry.indexOf('=');
    const key = index === -1 ? entry : entry.slice(0, index);
    const value = index === -1 ? '' : entry.slice(index + 1);
    params[decodeURIComponent(key)] = decodeURIComponent(value);
  }

  return params;
}

/** The query string of the nth SDK request (0-based). */
function queryOf(chain: any, index = 0): Record<string, string> {
  const call = chain.query.mock.calls[index];
  return call ? parseQuery(call[0]) : {};
}

/** The headers of the nth SDK request (0-based). */
function headersOf(chain: any, index = 0): Record<string, string> {
  return chain.headers.mock.calls[index]?.[0] ?? {};
}

describe('AzureMailService — listMessages request shape', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends $select, $filter, $search, $orderby, $top, Prefer and ConsistencyLevel', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ value: [] });

    await service.listMessages(USER_ID, {
      top: 10,
      filter: 'isRead eq false',
      search: 'from:alice@example.test',
      orderBy: 'receivedDateTime desc',
      immutableIds: true,
    });

    expect(chain.api).toHaveBeenCalledWith('/me/messages');

    const params = queryOf(chain);
    expect(params.$select).toBe(DEFAULT_MAIL_MESSAGE_SELECT);
    expect(params.$filter).toBe('isRead eq false');
    expect(params.$search).toBe('"from:alice@example.test"');
    expect(params.$orderby).toBe('receivedDateTime desc');
    expect(params.$top).toBe('10');

    const headers = headersOf(chain);
    expect(headers.ConsistencyLevel).toBe('eventual');
    expect(headers.Prefer).toBe('IdType="ImmutableId"');
  });

  it('applies the default projection, page size and ordering when nothing is supplied', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ value: [] });

    await service.listMessages(USER_ID);

    const params = queryOf(chain);
    expect(params.$select).toBe(DEFAULT_MAIL_MESSAGE_SELECT);
    expect(params.$top).toBe('25');
    expect(params.$orderby).toBe('receivedDateTime desc');
    expect(params.$filter).toBeUndefined();
    expect(params.$search).toBeUndefined();
    expect(params.$count).toBeUndefined();
    expect(headersOf(chain).Prefer).toBeUndefined();
  });

  it('sends no $orderby and no $count for a search with no explicit orderBy', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ value: [] });

    // `count: true` is deliberately supplied: the unverified interaction must
    // still suppress it, because ordering was not explicitly chosen.
    await service.listMessages(USER_ID, { search: 'quarterly report', count: true });

    const params = queryOf(chain);
    expect(params.$search).toBe('"quarterly report"');
    expect(params.$orderby).toBeUndefined();
    expect(params.$count).toBeUndefined();
    expect(headersOf(chain).ConsistencyLevel).toBe('eventual');
  });

  it('sends $count and the default ordering when there is no search', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ value: [], '@odata.count': 0 });

    await service.listMessages(USER_ID, { count: true });

    const params = queryOf(chain);
    expect(params.$count).toBe('true');
    expect(params.$orderby).toBe('receivedDateTime desc');
  });

  it('returns the nextLink Graph sent', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({
      value: [{ id: 'm1' }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=cursor',
    });

    const page = await service.listMessages(USER_ID);

    expect(page.nextLink).toBe('https://graph.microsoft.com/v1.0/me/messages?$skiptoken=cursor');
    expect(page.items.map((item) => item.id)).toEqual(['m1']);
  });
});

describe('AzureMailService — getMessage request shape', () => {
  beforeEach(() => jest.clearAllMocks());

  it('encodes the id and sends $select plus $expand=attachments', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ id: 'AAMk#?', body: { contentType: 'text', content: 'x' } });

    await service.getMessage(USER_ID, 'AAMk#?', { expand: 'attachments' });

    expect(chain.api).toHaveBeenCalledWith('/me/messages/AAMk%23%3F');

    const params = queryOf(chain);
    expect(params.$select).toBe(DEFAULT_MAIL_MESSAGE_DETAIL_SELECT);
    expect(params.$expand).toBe('attachments');
    expect(DEFAULT_MAIL_MESSAGE_DETAIL_SELECT).toContain('body');
  });

  it('selects every recipient list the normaliser maps, including bccRecipients', async () => {
    // Graph only returns properties named in $select, so a field that is
    // normalised and exposed in the schema but missing from the projection is
    // silently empty on every read. `bccRecipients` is the classic case: it is
    // required on IMailMessage and exposed on AzureMailMessage, and its absence
    // reads as "no BCC" rather than as a bug - especially for Sent Items.
    const addressFields = ['from', 'sender', 'toRecipients', 'ccRecipients', 'bccRecipients', 'replyTo'];

    for (const field of addressFields) {
      expect(DEFAULT_MAIL_MESSAGE_SELECT.split(',')).toContain(field);
      expect(DEFAULT_MAIL_MESSAGE_DETAIL_SELECT.split(',')).toContain(field);
    }
  });

  it('sends bccRecipients in $select on every message read path', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ value: [] });

    await service.listMessages(USER_ID);
    expect(queryOf(chain).$select.split(',')).toContain('bccRecipients');

    chain.get.mockClear();
    chain.query.mockClear();
    chain.get.mockResolvedValue({ value: [] });

    await service.listMessagesInFolder(USER_ID, 'inbox');
    expect(queryOf(chain).$select.split(',')).toContain('bccRecipients');

    chain.get.mockClear();
    chain.query.mockClear();
    chain.get.mockResolvedValue({ value: [] });

    await service.listByConversation(USER_ID, 'conv-1');
    expect(queryOf(chain).$select.split(',')).toContain('bccRecipients');

    chain.get.mockClear();
    chain.query.mockClear();
    chain.get.mockResolvedValue({ id: 'm1' });

    await service.getMessage(USER_ID, 'm1');
    expect(queryOf(chain).$select.split(',')).toContain('bccRecipients');
  });

  it('sends Prefer: IdType="ImmutableId" only when requested', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ id: 'm1' });

    await service.getMessage(USER_ID, 'm1', { immutableIds: true });

    expect(headersOf(chain).Prefer).toBe('IdType="ImmutableId"');
    // No search, so no consistency header.
    expect(headersOf(chain).ConsistencyLevel).toBeUndefined();
  });
});

describe('AzureMailService — folder, category and conversation request shape', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads /me/mailFolders with the counters, then serves the cache', async () => {
    const { service, redis } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({
      value: [{ id: 'inbox', childFolderCount: 0, unreadItemCount: 1 }],
    });

    const first = await service.listFolders(USER_ID);

    expect(chain.api).toHaveBeenCalledWith('/me/mailFolders');
    const params = queryOf(chain);
    expect(params.$select).toContain('childFolderCount');
    expect(params.$select).toContain('unreadItemCount');
    expect(first).toEqual([{ id: 'inbox', childFolderCount: 0, unreadItemCount: 1 }]);

    // Cache write: ten-minute TTL on the documented key.
    expect(redis.set).toHaveBeenCalledWith(
      `azure:${USER_ID}:mail:folders`,
      expect.any(String),
      600,
    );

    // Second read is served from Redis: no second Graph call.
    redis.get.mockResolvedValue(redis.set.mock.calls[0][1]);
    const second = await service.listFolders(USER_ID);

    expect(second).toEqual(first);
    expect(chain.get).toHaveBeenCalledTimes(1);
  });

  it('lists a folder’s messages through the folder path', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ value: [] });

    await service.listMessagesInFolder(USER_ID, 'AAMkAD', { top: 3 });

    expect(chain.api).toHaveBeenCalledWith('/me/mailFolders/AAMkAD/messages');
    expect(queryOf(chain).$top).toBe('3');
  });

  it('reads master categories with an explicit projection', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ value: [{ id: 'c1', displayName: 'Finance' }] });

    await service.listCategories(USER_ID);

    expect(chain.api).toHaveBeenCalledWith('/me/outlook/masterCategories');
    expect(queryOf(chain).$select).toBe('id,displayName,color');
  });

  it('filters a conversation by conversationId, oldest first, with escaped quotes', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockResolvedValue({ value: [] });

    await service.listByConversation(USER_ID, "conv'1");

    const params = queryOf(chain);
    expect(params.$filter).toBe("conversationId eq 'conv''1'");
    expect(params.$orderby).toBe('receivedDateTime asc');
  });

  it('PATCHes /me/messages/{id} with the categories body', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.patch.mockResolvedValue({ id: 'm1', categories: ['Finance'] });

    const message = await service.setCategories(USER_ID, 'm1', ['Finance']);

    expect(chain.api).toHaveBeenCalledWith('/me/messages/m1');
    expect(chain.patch).toHaveBeenCalledWith({ categories: ['Finance'] });
    expect(message.categories).toEqual(['Finance']);
  });
});

describe('AzureMailService — pagination', () => {
  beforeEach(() => jest.clearAllMocks());

  it('follows a four-page nextLink chain and returns every item in order', async () => {
    const { service } = createService();
    const chain = mockSdk();

    const link = (page: number) =>
      `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page-${page}`;

    chain.get
      .mockResolvedValueOnce({ value: [{ id: 'a' }, { id: 'b' }], '@odata.nextLink': link(2) })
      .mockResolvedValueOnce({ value: [{ id: 'c' }], '@odata.nextLink': link(3) })
      .mockResolvedValueOnce({ value: [{ id: 'd' }], '@odata.nextLink': link(4) })
      .mockResolvedValueOnce({ value: [{ id: 'e' }] });

    const page = await service.listMessages(USER_ID, { all: true, top: 2 });

    expect(page.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(page.nextLink).toBeUndefined();

    expect(chain.api.mock.calls.map((call: any[]) => call[0])).toEqual([
      '/me/messages',
      link(2),
      link(3),
      link(4),
    ]);

    // Only the first page carries a constructed query; a nextLink is verbatim.
    expect(chain.query).toHaveBeenCalledTimes(1);
    expect(queryOf(chain).$top).toBe('2');
    expect(chain.get).toHaveBeenCalledTimes(4);
  });

  it('keeps Prefer: IdType="ImmutableId" on every page of an all-pages read', async () => {
    // B2: requestAll rebuilds page 2+ options from `headers` only, so a
    // provider-only `immutableIds` option is lost - and a paginated read would
    // then return page-1 ids in one shape and later ids in another, exactly the
    // mixture the IMailListOptions JSDoc forbids.
    const { service } = createService();
    const chain = mockSdk();

    const link = (page: number) =>
      `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=imm-${page}`;

    chain.get
      .mockResolvedValueOnce({ value: [{ id: 'a' }], '@odata.nextLink': link(2) })
      .mockResolvedValueOnce({ value: [{ id: 'b' }], '@odata.nextLink': link(3) })
      .mockResolvedValueOnce({ value: [{ id: 'c' }] });

    await service.listMessages(USER_ID, { all: true, immutableIds: true });

    expect(chain.get).toHaveBeenCalledTimes(3);
    expect(headersOf(chain, 0).Prefer).toBe('IdType="ImmutableId"');
    expect(headersOf(chain, 1).Prefer).toBe('IdType="ImmutableId"');
    expect(headersOf(chain, 2).Prefer).toBe('IdType="ImmutableId"');
  });

  it('keeps Prefer on every page for the folder and conversation all-pages reads too', async () => {
    const { service } = createService();

    const cases: Array<{ label: string; run: () => Promise<unknown> }> = [
      {
        label: 'listMessagesInFolder',
        run: () => service.listMessagesInFolder(
          USER_ID,
          'inbox',
          { all: true, immutableIds: true },
        ),
      },
      {
        label: 'listByConversation',
        run: () => service.listByConversation(
          USER_ID,
          'conv-1',
          { all: true, immutableIds: true },
        ),
      },
    ];

    for (const testCase of cases) {
      // A fresh SDK chain per case keeps the header call indices unambiguous.
      const chain = mockSdk();
      chain.get
        .mockResolvedValueOnce({
          value: [{ id: 'a' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next',
        })
        .mockResolvedValueOnce({ value: [{ id: 'b' }] });

      await testCase.run();

      expect([testCase.label, headersOf(chain, 0).Prefer])
        .toEqual([testCase.label, 'IdType="ImmutableId"']);
      expect([testCase.label, headersOf(chain, 1).Prefer])
        .toEqual([testCase.label, 'IdType="ImmutableId"']);
    }
  });

  it('carries Prefer and ConsistencyLevel together on a paged search with immutable ids', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get
      .mockResolvedValueOnce({
        value: [{ id: 'a' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=both',
      })
      .mockResolvedValueOnce({ value: [{ id: 'b' }] });

    await service.listMessages(USER_ID, {
      all: true,
      immutableIds: true,
      search: 'quarterly report',
    });

    for (const index of [0, 1]) {
      expect(headersOf(chain, index).Prefer).toBe('IdType="ImmutableId"');
      expect(headersOf(chain, index).ConsistencyLevel).toBe('eventual');
    }
  });

  it('keeps ConsistencyLevel: eventual on every page of a paged search', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get
      .mockResolvedValueOnce({
        value: [{ id: 'a' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=search-2',
      })
      .mockResolvedValueOnce({ value: [{ id: 'b' }] });

    const page = await service.listMessages(USER_ID, { search: 'quarterly report', all: true });

    expect(page.items.map((item) => item.id)).toEqual(['a', 'b']);
    // Only the first page carries $search, but both pages need the header.
    expect(queryOf(chain, 0).$search).toBe('"quarterly report"');
    expect(headersOf(chain, 0).ConsistencyLevel).toBe('eventual');
    expect(headersOf(chain, 1).ConsistencyLevel).toBe('eventual');
  });

  it('throws PaginationLimitExceeded instead of truncating an unbounded chain', async () => {
    const { service } = createService();
    const chain = mockSdk();

    const page = (n: number) => ({
      value: [{ id: `m${n}` }],
      '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=${n + 1}`,
    });

    chain.get
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2));

    await expect(
      service.listMessages(USER_ID, { all: true, maxPages: 2 }),
    ).rejects.toMatchObject({ code: 'PaginationLimitExceeded' });

    expect(chain.get).toHaveBeenCalledTimes(2);
  });
});

describe('AzureMailService — Graph error contract', () => {
  beforeEach(() => jest.clearAllMocks());

  it('surfaces a 400 ErrorInvalidRequest as ApiError with that code', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockRejectedValue({
      statusCode: 400,
      code: 'ErrorInvalidRequest',
      message: 'Invalid filter clause',
    });

    let caught: any;
    try {
      await service.listMessages(USER_ID, { filter: 'bogus eq true' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('ErrorInvalidRequest');
    expect(caught.status).toBe(400);
    expect(caught).not.toEqual([]);
  });

  it('never turns a failure into an empty page on any read path', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.get.mockRejectedValue({ statusCode: 400, code: 'ErrorInvalidRequest' });

    const calls = [
      () => service.listMessages(USER_ID),
      () => service.getMessage(USER_ID, 'm1'),
      () => service.listFolders(USER_ID),
      () => service.listMessagesInFolder(USER_ID, 'inbox'),
      () => service.listCategories(USER_ID),
      () => service.listByConversation(USER_ID, 'conv-1'),
    ];

    for (const call of calls) {
      let resolved: unknown;
      let caught: any;

      try {
        resolved = await call();
      } catch (error) {
        caught = error;
      }

      expect(resolved).toBeUndefined();
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught.code).toBe('ErrorInvalidRequest');
    }
  });

  it('surfaces a PATCH failure as ApiError with the Graph code', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.patch.mockRejectedValue({ statusCode: 400, code: 'ErrorInvalidRequest' });

    await expect(service.setCategories(USER_ID, 'm1', ['Finance'])).rejects.toMatchObject({
      code: 'ErrorInvalidRequest',
    });
  });
});

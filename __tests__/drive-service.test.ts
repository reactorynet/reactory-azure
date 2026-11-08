/**
 * `drive-service.test.ts` - OneDrive behaviour and the HTTP proxy.
 *
 * The three properties this suite exists to defend:
 *
 *  1. **No credential leak on the redirect.** `downloadItem` stops at Graph's
 *     302 and re-requests the pre-authenticated storage URL with *no*
 *     `Authorization` header, and no pre-authenticated URL is ever returned.
 *  2. **No silent failure.** A 404 `itemNotFound` (or any Graph failure) arrives
 *     as an `ApiError` carrying the Graph code - never `[]`, `null` or an empty
 *     stream.
 *  3. **No truncation.** The copy monitor and the upload session are bounded and
 *     resumable, and a timed-out monitor reports `inProgress` rather than
 *     pretending the copy succeeded.
 *
 * The Graph SDK is mocked and the byte transport is injected: no live Graph call
 * is made, because this repository has no Azure tenant.
 */
jest.mock('@microsoft/microsoft-graph-client', () => ({
  ResponseType: { RAW: 'raw', TEXT: 'text', JSON: 'json' },
}));

// eslint-disable-next-line import/first
import http from 'http';
// eslint-disable-next-line import/first
import fs from 'fs';
// eslint-disable-next-line import/first
import path from 'path';
// eslint-disable-next-line import/first
import express from 'express';
// eslint-disable-next-line import/first
import request from 'supertest';
// eslint-disable-next-line import/first
import { Readable } from 'stream';
// eslint-disable-next-line import/first
import ApiError from '@reactory/server-core/exceptions';
// eslint-disable-next-line import/first
import { AzureDriveService, AzureDriveServiceDefinition, setDriveHttpClient } from '../services/AzureDriveService';
// eslint-disable-next-line import/first
import proxyRoutes, { buildContentDisposition } from '../routes/proxy';
// eslint-disable-next-line import/first
import DriveResolver from '../graphql/resolvers/DriveResolver';
// eslint-disable-next-line import/first
import type { IDriveHttpRequest, IDriveHttpResponse } from '../types/drive.types';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const GRAPH_CONTENT_URL = 'https://graph.microsoft.com/v1.0/me/drive/items/ITEM/content';
const PREAUTH_URL = 'https://storage.example/preauth/file?sig=secret-signature';

interface IChainMock {
  api: jest.Mock;
  headers: jest.Mock;
  version: jest.Mock;
  query: jest.Mock;
  responseType: jest.Mock;
  get: jest.Mock;
  post: jest.Mock;
  patch: jest.Mock;
  put: jest.Mock;
  delete: jest.Mock;
}

function createChain(): IChainMock {
  const chain: any = {};

  chain.api = jest.fn(() => chain);
  chain.headers = jest.fn(() => chain);
  chain.version = jest.fn(() => chain);
  chain.query = jest.fn(() => chain);
  chain.responseType = jest.fn(() => chain);
  chain.get = jest.fn();
  chain.post = jest.fn();
  chain.patch = jest.fn();
  chain.put = jest.fn();
  chain.delete = jest.fn();

  return chain as IChainMock;
}

function createHarness(options: { bindServices?: boolean } = {}) {
  const chain = createChain();
  const provider = {
    request: jest.fn(),
    requestAll: jest.fn(),
    getClient: jest.fn(() => chain),
  };
  const authService = {
    getToken: jest.fn().mockResolvedValue({ token: 'graph-token', source: 'vault' }),
  };

  const context: any = {
    user: { _id: USER_ID },
    getService: jest.fn((id: string) => {
      if (id === 'azure.AzureGraphClientProvider@1.0.0') return provider;
      if (id === 'azure.AzureAuthService@1.0.0') return authService;
      return undefined;
    }),
  };

  const service = new AzureDriveService({} as any, context);

  if (options.bindServices !== false) {
    service.setGraphProvider(provider);
    service.setAuthService(authService);
  }

  return { service, provider, chain, authService, context };
}

/** A transport that hands back a scripted response per hop and records the hops. */
function scriptedTransport(script: Array<IDriveHttpResponse | Error>) {
  const calls: IDriveHttpRequest[] = [];

  setDriveHttpClient(async (hop) => {
    calls.push(hop);
    const next = script[Math.min(calls.length - 1, script.length - 1)];

    if (next instanceof Error) throw next;
    return next;
  });

  return calls;
}

/** Supertest buffers a non-text content type into a Buffer, not `text`. */
function bodyText(response: any): string {
  if (typeof response.text === 'string' && response.text.length) return response.text;
  if (Buffer.isBuffer(response.body)) return response.body.toString('utf8');
  if (response.body && response.body.type === 'Buffer' && Array.isArray(response.body.data)) {
    return Buffer.from(response.body.data).toString('utf8');
  }
  return '';
}

/** Read a Node stream to a string. */
async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

  return Buffer.concat(chunks).toString('utf8');
}

/** A Graph error body, as Graph sends it. */
function graphErrorBody(code: string, message = 'The requested item was not found'): Buffer {
  return Buffer.from(JSON.stringify({ error: { code, message } }));
}

afterEach(() => {
  setDriveHttpClient(null);
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Download: the redirect contract
// ---------------------------------------------------------------------------

describe('downloadItem - redirect handling', () => {
  it('follows the 302 to the storage host without forwarding Authorization', async () => {
    const { service } = createHarness();

    const hops = scriptedTransport([
      { status: 302, headers: { location: PREAUTH_URL }, body: undefined },
      {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '11' },
        body: Readable.from([Buffer.from('hello world')]),
      },
    ]);

    const download = await service.downloadItem(USER_ID, 'ITEM');

    // Hop 1: Graph, authenticated, and explicitly not following the redirect.
    expect(hops[0].url).toBe(GRAPH_CONTENT_URL);
    expect(hops[0].headers?.Authorization).toBe('Bearer graph-token');
    expect(hops[0].redirect).toBe('manual');

    // Hop 2: the pre-authenticated URL, with no credential of any kind.
    expect(hops[1].url).toBe(PREAUTH_URL);
    expect(hops[1].redirect).toBe('follow');

    const forwarded = Object.keys(hops[1].headers || {}).map((name) => name.toLowerCase());
    expect(forwarded).not.toContain('authorization');
    expect(forwarded).not.toContain('cookie');
    expect(JSON.stringify(hops[1].headers || {})).not.toContain('graph-token');
    expect(JSON.stringify(hops[1].headers || {})).not.toContain('Bearer');

    expect(download.contentType).toBe('application/pdf');
    expect(download.contentLength).toBe(11);
    await expect(collect(download.stream)).resolves.toBe('hello world');
  });

  it('never returns the pre-authenticated URL, only the stream and metadata', async () => {
    const { service } = createHarness();

    scriptedTransport([
      { status: 302, headers: { location: PREAUTH_URL }, body: undefined },
      { status: 200, headers: { 'content-type': 'text/plain' }, body: Readable.from([Buffer.from('x')]) },
    ]);

    const download: any = await service.downloadItem(USER_ID, 'ITEM');
    const serialisable = { ...download, stream: '[stream]' };

    expect(JSON.stringify(serialisable)).not.toContain('storage.example');
    expect(JSON.stringify(serialisable)).not.toContain('sig=');
    expect(Object.keys(download)).not.toContain('url');
    expect(Object.keys(download)).not.toContain('downloadUrl');
  });

  it('accepts a direct 200 without a second hop', async () => {
    const { service } = createHarness();

    const hops = scriptedTransport([
      { status: 200, headers: { 'content-type': 'text/plain' }, body: Readable.from([Buffer.from('direct')]) },
    ]);

    const download = await service.downloadItem(USER_ID, 'ITEM');

    expect(hops).toHaveLength(1);
    expect(hops[0].headers?.Authorization).toBe('Bearer graph-token');
    await expect(collect(download.stream)).resolves.toBe('direct');
  });

  it('fails when a redirect has no Location header', async () => {
    const { service } = createHarness();

    scriptedTransport([{ status: 302, headers: {}, body: undefined }]);

    await expect(service.downloadItem(USER_ID, 'ITEM')).rejects.toMatchObject({
      code: 'InvalidDriveRedirect',
    });
  });

  it('surfaces a 404 itemNotFound as an ApiError', async () => {
    const { service } = createHarness();

    scriptedTransport([
      { status: 404, headers: { 'content-type': 'application/json' }, body: graphErrorBody('itemNotFound') },
    ]);

    let caught: any;

    try {
      await service.downloadItem(USER_ID, 'missing');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('itemNotFound');
    expect(caught.status).toBe(404);
    expect(caught.operation).toBe('drive.downloadItem');
    // A failure must not masquerade as a stream.
    expect(caught.stream).toBeUndefined();
  });

  it('surfaces a 401 as InvalidAuthenticationToken', async () => {
    const { service } = createHarness();

    scriptedTransport([
      { status: 401, headers: {}, body: graphErrorBody('InvalidAuthenticationToken', 'Token expired') },
    ]);

    await expect(service.downloadItem(USER_ID, 'ITEM')).rejects.toMatchObject({
      code: 'InvalidAuthenticationToken',
      status: 401,
    });
  });

  it('requires an auth service rather than streaming unauthenticated', async () => {
    const { service, authService } = createHarness();
    authService.getToken.mockRejectedValue(new Error('token vault unavailable'));

    await expect(service.downloadItem(USER_ID, 'ITEM')).rejects.toBeInstanceOf(ApiError);
  });

  it('URL-encodes a thumbnail item id and drops Authorization on the redirect', async () => {
    const { service } = createHarness();

    const hops = scriptedTransport([
      { status: 302, headers: { location: PREAUTH_URL }, body: undefined },
      { status: 200, headers: { 'content-type': 'image/png' }, body: Readable.from([Buffer.from('png')]) },
    ]);

    const thumbnail = await service.getThumbnail(USER_ID, 'ITEM a#b?c');

    expect(hops[0].url).toBe(
      'https://graph.microsoft.com/v1.0/me/drive/items/ITEM%20a%23b%3Fc/thumbnails/0/large/content',
    );
    expect(hops[0].url).not.toContain('#');
    expect(hops[1].headers?.Authorization).toBeUndefined();
    await expect(collect(thumbnail.stream)).resolves.toBe('png');
  });
});

// ---------------------------------------------------------------------------
// Reads and error translation
// ---------------------------------------------------------------------------

describe('drive reads', () => {
  it('maps a children page onto items/nextLink/count', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({
      value: [{ id: 'a', name: 'a.txt' }, { id: 'b', name: 'Folder', folder: { childCount: 3 } }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=2',
      '@odata.count': 42,
    });

    const page = await service.listChildren(USER_ID);

    expect(page.items).toHaveLength(2);
    expect(page.count).toBe(42);
    expect(page.nextLink).toContain('$skiptoken=2');
  });

  it('strips Graph pre-authenticated download and thumbnail URLs from items', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({
      id: 'a',
      name: 'secret.pdf',
      '@microsoft.graph.downloadUrl': PREAUTH_URL,
      thumbnails: [null, { id: '0', large: { url: PREAUTH_URL, width: 800, height: 600 }, small: null }],
    });

    const item: any = await service.getItem(USER_ID, 'a');

    expect(item['@microsoft.graph.downloadUrl']).toBeUndefined();
    expect(item.thumbnails[0]).toBeNull();
    expect(item.thumbnails[1].large.url).toBeUndefined();
    expect(item.thumbnails[1].large.width).toBe(800);
    expect(JSON.stringify(item)).not.toContain('storage.example');
  });

  it('propagates a provider ApiError untouched', async () => {
    const { service, provider } = createHarness();
    const failure = Object.assign(new ApiError('gone'), { code: 'itemNotFound', status: 404 });
    (failure as any).__isReactoryApiError = true;
    provider.request.mockRejectedValue(failure);

    await expect(service.getItem(USER_ID, 'x')).rejects.toMatchObject({ code: 'itemNotFound' });
  });

  it('translates a raw provider error into an ApiError with the Graph code', async () => {
    const { service, provider } = createHarness();
    provider.request.mockRejectedValue({ statusCode: 404, code: 'itemNotFound', message: 'not found' });

    const error: any = await service.getItem(USER_ID, 'x').catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('itemNotFound');
    expect(error.status).toBe(404);
  });

  it('falls back to the request context for the user and the services', async () => {
    const { service, provider, authService } = createHarness({ bindServices: false });
    provider.request.mockResolvedValue({ id: 'from-context' });

    const item = await service.getItem('', 'ITEM');

    expect(item).toMatchObject({ id: 'from-context' });
    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      '/me/drive/items/ITEM',
      expect.any(Object),
    );
    expect(authService.getToken).not.toHaveBeenCalled();
  });

  it('fails typed when there is no provider and no user', async () => {
    const service = new AzureDriveService({} as any, { getService: (): undefined => undefined } as any);

    await expect(service.getDefaultDrive(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
    await expect(service.getDefaultDrive('')).rejects.toMatchObject({ code: 'NotConnected' });
  });
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

describe('drive uploads', () => {
  it('reads the item back when the final fragment answers 202', async () => {
    const { service, chain, provider } = createHarness();
    chain.post.mockResolvedValue({ uploadUrl: 'https://upload.example/session/9' });
    provider.request.mockResolvedValue({ id: 'verified', name: 'late.bin' });

    scriptedTransport([
      { status: 202, headers: {}, body: Buffer.from(JSON.stringify({ nextExpectedRanges: [] })) },
    ]);

    const item = await service.uploadItem(
      USER_ID,
      'PARENT',
      'late.bin',
      Buffer.alloc(4 * 1024 * 1024 + 10, 1),
    );

    expect(item).toMatchObject({ id: 'verified' });
    expect(provider.request.mock.calls[0][1]).toBe('/me/drive/items/PARENT:/late.bin:');
  });

  it('translates a failed fragment into an ApiError', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ uploadUrl: 'https://upload.example/session/10' });

    scriptedTransport([
      { status: 507, headers: {}, body: graphErrorBody('insufficientStorage', 'No space left') },
    ]);

    await expect(
      service.uploadItem(USER_ID, null, 'big.bin', Buffer.alloc(4 * 1024 * 1024 + 10, 1)),
    ).rejects.toMatchObject({ code: 'insufficientStorage', status: 507 });
  });
});

// ---------------------------------------------------------------------------
// Copy: the asynchronous monitor
// ---------------------------------------------------------------------------

describe('copyItem - async monitor', () => {
  it('polls the monitor until the copy completes', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({
      status: 202,
      headers: { location: 'https://graph.microsoft.com/v1.0/monitor/abc' },
      body: undefined,
    });
    chain.get
      .mockResolvedValueOnce({ status: 202, headers: {}, body: undefined })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: async () => ({ id: 'copy-1', name: 'copy.txt', size: 4 }),
      });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST', {
      name: 'copy.txt',
      pollIntervalMs: 0,
    });

    expect(result).toMatchObject({ status: 'completed', itemId: 'copy-1' });
    expect(result.item).toMatchObject({ name: 'copy.txt' });
    expect(result.monitorUrl).toBe('https://graph.microsoft.com/v1.0/monitor/abc');

    // The copy POST asks Graph for the asynchronous form.
    expect(chain.headers).toHaveBeenCalledWith({ Prefer: 'respond-async' });
    expect(chain.post).toHaveBeenCalledWith({
      parentReference: { id: 'DEST' },
      name: 'copy.txt',
    });
    expect(chain.get).toHaveBeenCalledTimes(2);
  });

  it('returns immediately when the caller does not want to wait', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({
      status: 202,
      headers: { location: 'https://graph.microsoft.com/v1.0/monitor/abc' },
      body: undefined,
    });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST', { wait: false });

    expect(result).toEqual({
      status: 'inProgress',
      monitorUrl: 'https://graph.microsoft.com/v1.0/monitor/abc',
    });
    expect(chain.get).not.toHaveBeenCalled();
  });

  it('stops at the poll bound and reports inProgress', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({
      status: 202,
      headers: { location: 'https://graph.microsoft.com/v1.0/monitor/slow' },
      body: undefined,
    });
    chain.get.mockResolvedValue({ status: 202, headers: {}, body: undefined });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST', {
      pollIntervalMs: 0,
      maxPollAttempts: 3,
    });

    expect(result.status).toBe('inProgress');
    expect(chain.get).toHaveBeenCalledTimes(3);
  });

  it('raises the monitor failure instead of reporting success', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({
      status: 202,
      headers: { location: 'https://graph.microsoft.com/v1.0/monitor/bad' },
      body: undefined,
    });
    chain.get.mockResolvedValue({
      status: 404,
      headers: {},
      body: graphErrorBody('itemNotFound', 'The destination folder no longer exists'),
    });

    await expect(
      service.copyItem(USER_ID, 'ITEM', 'DEST', { pollIntervalMs: 0 }),
    ).rejects.toMatchObject({ code: 'itemNotFound', status: 404 });
  });

  it('accepts an inline copy that returns the item instead of a monitor', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({
      status: 200,
      headers: {},
      json: async () => ({ id: 'inline-1', name: 'inline.txt' }),
    });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST');

    expect(result).toMatchObject({ status: 'completed', itemId: 'inline-1' });
  });

  it('fails loudly when Graph returns neither item nor monitor', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ status: 202, headers: {}, body: undefined });

    await expect(service.copyItem(USER_ID, 'ITEM', 'DEST')).rejects.toMatchObject({
      code: 'GraphRequestFailed',
    });
  });
});

// ---------------------------------------------------------------------------
// routes/proxy.ts
// ---------------------------------------------------------------------------

describe('GET /azure/files/:itemId', () => {
  function buildApp(options: { service?: any; user?: any } = {}) {
    const app = express();

    app.use((req, _res, next) => {
      (req as any).context = options.user === null
        ? undefined
        : { user: options.user === undefined ? { _id: USER_ID } : options.user, getService: () => options.service };
      next();
    });
    app.use('/azure', proxyRoutes);

    return app;
  }

  function fakeService(overrides: Record<string, any> = {}) {
    return {
      getItem: jest.fn().mockResolvedValue({
        id: 'ITEM',
        name: 'Report.pdf',
        file: { mimeType: 'application/pdf' },
      }),
      downloadItem: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('file-bytes')]),
        contentType: 'application/pdf',
        contentLength: 10,
      }),
      getThumbnail: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('thumb-bytes')]),
        contentType: 'image/jpeg',
      }),
      ...overrides,
    };
  }

  it('streams the file with a content type and Content-Disposition', async () => {
    const service = fakeService();
    const response = await request(buildApp({ service })).get('/azure/files/ITEM');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="Report.pdf"; filename*=UTF-8\'\'Report.pdf',
    );
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-length']).toBe('10');
    expect(bodyText(response)).toBe('file-bytes');

    expect(service.getItem).toHaveBeenCalledWith(USER_ID, 'ITEM');
    expect(service.downloadItem).toHaveBeenCalledWith(USER_ID, 'ITEM', { fileName: 'Report.pdf' });
  });

  it('honours ?disposition=inline', async () => {
    const response = await request(buildApp({ service: fakeService() }))
      .get('/azure/files/ITEM?disposition=inline');

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/^inline; filename=/);
  });

  it('never leaks a pre-authenticated URL in the response', async () => {
    const response = await request(buildApp({ service: fakeService() })).get('/azure/files/ITEM');

    expect(JSON.stringify(response.headers)).not.toContain('storage.example');
    expect(bodyText(response)).not.toContain('storage.example');
    expect(bodyText(response)).not.toContain('sig=');
  });

  it('uses the item name when Graph does not set one and encodes non-ASCII names', async () => {
    const service = fakeService({
      getItem: jest.fn().mockResolvedValue({ id: 'ITEM', name: 'Résumé final.pdf' }),
      downloadItem: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('x')]),
        contentType: undefined,
        contentLength: undefined,
      }),
    });

    const response = await request(buildApp({ service })).get('/azure/files/ITEM');

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('filename="R_sum_ final.pdf"');
    expect(response.headers['content-disposition']).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20final.pdf");
    // No content length was known, so none is claimed.
    expect(response.headers['content-length']).toBeUndefined();
  });

  it('cannot be used for header injection through a file name', () => {
    const header = buildContentDisposition('a"b\r\nX-Injected: yes.txt');

    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header).toBe('attachment; filename="abX-Injected: yes.txt"; filename*=UTF-8\'\'a%22b%0D%0AX-Injected%3A%20yes.txt');
  });

  it('maps a 404 itemNotFound onto HTTP 404 without echoing internals', async () => {
    const failure = Object.assign(new ApiError('Item not found'), {
      code: 'itemNotFound',
      status: 404,
    });
    const service = fakeService({ getItem: jest.fn().mockRejectedValue(failure) });

    const response = await request(buildApp({ service })).get('/azure/files/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Item not found', code: 'itemNotFound' });
  });

  it('401s without a user and 503s without the service', async () => {
    await request(buildApp({ service: fakeService(), user: null })).get('/azure/files/ITEM').expect(401);
    await request(buildApp({ service: undefined })).get('/azure/files/ITEM').expect(503);
  });

  it('maps an unexpected failure to 500', async () => {
    const service = fakeService({
      getItem: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'Weird' })),
    });

    const response = await request(buildApp({ service })).get('/azure/files/ITEM');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('Weird');
  });
});

describe('GET /azure/files/:itemId/thumbnail', () => {
  function buildApp(service: any) {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).context = { user: { _id: USER_ID }, getService: () => service };
      next();
    });
    app.use('/azure', proxyRoutes);

    return app;
  }

  it('streams the rendition inline with a short private cache', async () => {
    const service = {
      getThumbnail: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('thumb-bytes')]),
        contentType: 'image/jpeg',
      }),
    };

    const response = await request(buildApp(service)).get('/azure/files/ITEM/thumbnail?size=medium');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['content-disposition']).toMatch(/^inline; /);
    expect(response.headers['cache-control']).toBe('private, max-age=300');
    expect(bodyText(response)).toBe('thumb-bytes');
    expect(service.getThumbnail).toHaveBeenCalledWith(USER_ID, 'ITEM', { size: 'medium' });
  });

  it('falls back to the large rendition for an unknown size', async () => {
    const service = {
      getThumbnail: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('x')]),
        contentType: 'image/png',
      }),
    };

    await request(buildApp(service)).get('/azure/files/ITEM/thumbnail?size=enormous').expect(200);

    expect(service.getThumbnail).toHaveBeenCalledWith(USER_ID, 'ITEM', { size: 'large' });
  });

  it('maps a missing item to 404', async () => {
    const service = {
      getThumbnail: jest.fn().mockRejectedValue(
        Object.assign(new ApiError('Item not found'), { code: 'itemNotFound', status: 404 }),
      ),
    };

    const response = await request(buildApp(service)).get('/azure/files/ITEM/thumbnail');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('itemNotFound');
  });
});

// ---------------------------------------------------------------------------
// graphql/resolvers/DriveResolver.ts
// ---------------------------------------------------------------------------

describe('DriveResolver', () => {
  function buildResolver(service: any) {
    const context = {
      user: { _id: USER_ID },
      // `@roles(['USER'], 'args.context')` calls `context.hasRole(role)`.
      hasRole: jest.fn(() => true),
      getService: jest.fn((id: string) => (id === 'azure.AzureDriveService@1.0.0' ? service : undefined)),
    };

    return { resolver: new DriveResolver() as any, context };
  }

  function driveService(overrides: Record<string, any> = {}) {
    return {
      getDefaultDrive: jest.fn().mockResolvedValue({ id: 'drive-1' }),
      listDrives: jest.fn().mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]),
      listChildren: jest.fn().mockResolvedValue({ items: [], nextLink: undefined }),
      getItem: jest.fn().mockResolvedValue({ id: 'ITEM' }),
      getItemByPath: jest.fn().mockResolvedValue({ id: 'BY-PATH' }),
      search: jest.fn().mockResolvedValue({ items: [] }),
      listPermissions: jest.fn().mockResolvedValue([]),
      listVersions: jest.fn().mockResolvedValue([]),
      createFolder: jest.fn().mockResolvedValue({ id: 'folder' }),
      uploadItem: jest.fn().mockResolvedValue({ id: 'uploaded' }),
      moveItem: jest.fn().mockResolvedValue({ id: 'moved' }),
      copyItem: jest.fn().mockResolvedValue({ status: 'completed', itemId: 'copied' }),
      deleteItem: jest.fn().mockResolvedValue(undefined),
      restoreItem: jest.fn().mockResolvedValue({ id: 'restored' }),
      createShareLink: jest.fn().mockResolvedValue({ id: 'perm-1' }),
      inviteCollaborators: jest.fn().mockResolvedValue([]),
      deletePermission: jest.fn().mockResolvedValue(undefined),
      restoreVersion: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('delegates every query to the service with the caller id', async () => {
    const service = driveService();
    const { resolver, context } = buildResolver(service);

    await resolver.getDefaultDrive({}, {}, context);
    await resolver.listDrives({}, {}, context);
    await resolver.listChildren({}, { itemId: 'ITEM', top: 10 }, context);
    await resolver.search({}, { query: 'budget' }, context);
    await resolver.listPermissions({}, { itemId: 'ITEM' }, context);
    await resolver.listVersions({}, { itemId: 'ITEM' }, context);

    expect(service.getDefaultDrive).toHaveBeenCalledWith(USER_ID);
    expect(service.listChildren).toHaveBeenCalledWith(USER_ID, 'ITEM', expect.objectContaining({ top: 10 }));
    expect(service.search).toHaveBeenCalledWith(USER_ID, 'budget', expect.any(Object));
    expect(service.listPermissions).toHaveBeenCalledWith(USER_ID, 'ITEM', expect.any(Object));
    expect(service.listVersions).toHaveBeenCalledWith(USER_ID, 'ITEM', expect.any(Object));
  });

  it('treats a missing itemId as the drive root and a missing base64 body as empty', async () => {
    const service = driveService();
    const { resolver, context } = buildResolver(service);

    // No itemId: the root listing branch of `params.itemId || null`.
    await resolver.listChildren({}, {}, context);
    expect(service.listChildren).toHaveBeenCalledWith(USER_ID, null, expect.any(Object));

    // No parentId and no contentBase64: the defaulting branches of the upload.
    await resolver.uploadItem({}, { name: 'empty.txt' }, context);
    const [, parentId, , content] = service.uploadItem.mock.calls[0];
    expect(parentId).toBeNull();
    expect(Buffer.isBuffer(content)).toBe(true);
    expect(content.length).toBe(0);
  });

  it('addresses an item by id, or by path, and rejects neither', async () => {
    const service = driveService();
    const { resolver, context } = buildResolver(service);

    await expect(resolver.getItem({}, { itemId: 'ITEM' }, context)).resolves.toMatchObject({ id: 'ITEM' });
    await expect(resolver.getItem({}, { path: 'Reports/a.pdf' }, context)).resolves.toMatchObject({ id: 'BY-PATH' });
    await expect(resolver.getItem({}, {}, context)).rejects.toMatchObject({ code: 'GraphRequestFailed' });

    expect(service.getItemByPath).toHaveBeenCalledWith(
      USER_ID,
      'Reports/a.pdf',
      expect.objectContaining({ driveId: undefined }),
    );
  });

  it('decodes base64 content before uploading and returns booleans for deletes', async () => {
    const service = driveService();
    const { resolver, context } = buildResolver(service);

    await resolver.uploadItem(
      {},
      { parentId: 'PARENT', name: 'a.txt', contentBase64: Buffer.from('hi').toString('base64') },
      context,
    );

    const [userId, parentId, name, content] = service.uploadItem.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(parentId).toBe('PARENT');
    expect(name).toBe('a.txt');
    expect(Buffer.isBuffer(content)).toBe(true);
    expect(content.toString('utf8')).toBe('hi');

    await expect(resolver.deleteItem({}, { itemId: 'ITEM' }, context)).resolves.toBe(true);
    await expect(
      resolver.deletePermission({}, { itemId: 'ITEM', permissionId: 'perm-1' }, context),
    ).resolves.toBe(true);
  });

  it('fails typed when the drive service is not registered', async () => {
    const { resolver } = buildResolver(undefined);

    await expect(
      resolver.getDefaultDrive({}, {}, {
        user: { _id: USER_ID },
        hasRole: () => true,
        getService: (): undefined => undefined,
      }),
    ).rejects.toThrow('Azure Drive Service not available');
  });

  it('derives kind, mimeType, isFolder and childCount from the Graph facets', () => {
    const { resolver } = buildResolver(driveService());

    const folder = { id: 'f', folder: { childCount: 7 } };
    const file = { id: 'i', file: { mimeType: 'application/pdf' } };

    expect(resolver.resolveKind(folder)).toBe('FOLDER');
    expect(resolver.resolveKind(file)).toBe('FILE');
    expect(resolver.resolveKind({ id: 'p', package: { type: 'oneNote' } })).toBe('PACKAGE');
    expect(resolver.resolveKind({ id: 'u' })).toBe('UNKNOWN');
    expect(resolver.resolveIsFolder(folder)).toBe(true);
    expect(resolver.resolveIsFolder(file)).toBe(false);
    expect(resolver.resolveChildCount(folder)).toBe(7);
    expect(resolver.resolveMimeType(file)).toBe('application/pdf');
    expect(resolver.resolveMimeType(folder)).toBeNull();
    expect(resolver.resolveChildCount({})).toBeNull();
  });

  it('collapses a permission principal and an invitation inviter', () => {
    const { resolver } = buildResolver(driveService());

    expect(resolver.resolveGrantedTo({ grantedToV2: { user: { email: 'a@b.test' } } }))
      .toEqual({ email: 'a@b.test' });
    expect(resolver.resolveGrantedTo({})).toBeNull();
    expect(resolver.resolveInvitedBy({ invitedBy: { user: { displayName: 'Inviter' } } }))
      .toEqual({ displayName: 'Inviter' });
    expect(resolver.resolvePublicationLevel({ publication: { level: 'published' } })).toBe('published');
    expect(resolver.resolveInvitedBy({})).toBeNull();
    expect(resolver.resolvePublicationLevel({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transport body shapes (the branches toNodeStream / readBodyAsText take)
// ---------------------------------------------------------------------------

describe('downloadItem - transport body shapes', () => {
  async function downloadBody(body: unknown): Promise<string> {
    const { service } = createHarness();

    scriptedTransport([
      { status: 200, headers: { 'content-type': 'application/octet-stream' }, body },
    ] as any);

    const download = await service.downloadItem(USER_ID, 'ITEM');
    return collect(download.stream);
  }

  it('returns an empty stream when the transport sends no body', async () => {
    await expect(downloadBody(undefined)).resolves.toBe('');
    await expect(downloadBody(null)).resolves.toBe('');
  });

  it('streams a Buffer body', async () => {
    await expect(downloadBody(Buffer.from('from-buffer'))).resolves.toBe('from-buffer');
  });

  it('streams a string body', async () => {
    await expect(downloadBody('from-string')).resolves.toBe('from-string');
  });

  it('streams an async iterable body', async () => {
    async function* chunks() {
      yield Buffer.from('async-');
      yield Buffer.from('iter');
    }

    await expect(downloadBody(chunks())).resolves.toBe('async-iter');
  });

  it('streams a WHATWG stream body through Readable.fromWeb', async () => {
    const web = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from('web-stream')));
        controller.close();
      },
    });

    await expect(downloadBody(web)).resolves.toBe('web-stream');
  });

  it('pumps a WHATWG stream body when Readable.fromWeb is unavailable', async () => {
    const original = (Readable as any).fromWeb;
    (Readable as any).fromWeb = undefined;

    try {
      const web = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from('web-')));
          controller.enqueue(new Uint8Array(Buffer.from('fallback')));
          controller.close();
        },
      });

      await expect(downloadBody(web)).resolves.toBe('web-fallback');
    } finally {
      (Readable as any).fromWeb = original;
    }
  });

  it('stringifies an unexpected body type instead of hanging', async () => {
    await expect(downloadBody(42)).resolves.toBe('42');
  });
});

// ---------------------------------------------------------------------------
// Error body parsing and the guard branches
// ---------------------------------------------------------------------------

describe('drive error bodies and guards', () => {
  it('prefers the Graph message from a body that exposes text()', async () => {
    const { service } = createHarness();

    scriptedTransport([
      {
        status: 404,
        headers: {},
        body: { text: async () => JSON.stringify({ error: { code: 'itemNotFound', message: 'No such item' } }) },
      } as any,
    ]);

    await expect(service.downloadItem(USER_ID, 'ITEM')).rejects.toMatchObject({
      code: 'itemNotFound',
      status: 404,
      message: 'No such item',
    });
  });

  it('falls back to a status message for a non-JSON body', async () => {
    const { service } = createHarness();

    scriptedTransport([
      { status: 503, headers: {}, body: Buffer.from('<html>Service Unavailable</html>') },
    ]);

    const failure: any = await service.downloadItem(USER_ID, 'ITEM').catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe('GraphRequestFailed');
    expect(failure.message).toBe('Microsoft Graph drive.downloadItem failed with status 503');
  });

  it('falls back when the failure carries no body at all', async () => {
    const { service } = createHarness();

    scriptedTransport([{ status: 500, headers: {}, body: undefined }]);

    await expect(service.downloadItem(USER_ID, 'ITEM')).rejects.toMatchObject({
      code: 'GraphRequestFailed',
      status: 500,
    });
  });

  it('parses a string error body that carries the Graph envelope', async () => {
    const { service } = createHarness();

    scriptedTransport([{
      status: 403,
      headers: {},
      body: JSON.stringify({ error: { code: 'accessDenied', message: 'Denied by policy' } }),
    }]);

    await expect(service.downloadItem(USER_ID, 'ITEM')).rejects.toMatchObject({
      code: 'accessDenied',
      status: 403,
      message: 'Denied by policy',
    });
  });

  it('caps the error body it reads so a huge failure page cannot exhaust memory', async () => {
    const { service } = createHarness();
    const huge = Buffer.alloc(1024 * 1024 + 64, 0x41);

    scriptedTransport([{ status: 500, headers: {}, body: huge }]);

    const failure: any = await service.downloadItem(USER_ID, 'ITEM').catch((error) => error);

    // Non-JSON, so the message falls back to the operation + status.
    expect(failure.message).toBe('Microsoft Graph drive.downloadItem failed with status 500');
  });

  it('still produces a typed error when the error body cannot be read', async () => {
    const { service } = createHarness();

    scriptedTransport([{
      status: 502,
      headers: {},
      body: {
        text: async () => {
          throw new Error('connection reset while reading the body');
        },
      },
    } as any]);

    const failure: any = await service.downloadItem(USER_ID, 'ITEM').catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe('GraphRequestFailed');
    expect(failure.status).toBe(502);
  });

  it('rejects an unexpected non-2xx status instead of streaming it', async () => {
    const { service } = createHarness();

    scriptedTransport([{ status: 304, headers: {}, body: undefined }]);

    await expect(service.downloadItem(USER_ID, 'ITEM')).rejects.toMatchObject({
      code: 'GraphRequestFailed',
      status: 304,
    });
  });

  it('translates a transport-level throw', async () => {
    const { service } = createHarness();

    scriptedTransport([new Error('socket hang up')]);

    const failure: any = await service.downloadItem(USER_ID, 'ITEM').catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe('GraphRequestFailed');
    expect(failure.operation).toBe('drive.transport.GET');
  });

  it('refuses to download without an auth service', async () => {
    const provider = { request: jest.fn(), requestAll: jest.fn(), getClient: jest.fn() };
    const service = new AzureDriveService({} as any, {
      user: { _id: USER_ID },
      getService: (id: string) => (id === 'azure.AzureGraphClientProvider@1.0.0' ? provider : undefined),
    } as any);

    service.setGraphProvider(provider);

    await expect(service.downloadItem(USER_ID, 'ITEM')).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('refuses to download when the auth service yields no token', async () => {
    const { service, authService } = createHarness();
    authService.getToken.mockResolvedValue({});

    await expect(service.downloadItem(USER_ID, 'ITEM')).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('rejects a share link that returned no permission', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({});

    await expect(service.createShareLink(USER_ID, 'ITEM')).rejects.toMatchObject({
      code: 'GraphRequestFailed',
    });
  });

  it('rejects a blank permissionId and a blank versionId', async () => {
    const { service } = createHarness();

    await expect(service.deletePermission(USER_ID, 'ITEM', '')).rejects.toMatchObject({
      code: 'InvalidDrivePath',
    });
    await expect(service.restoreVersion(USER_ID, 'ITEM', '')).rejects.toMatchObject({
      code: 'InvalidDrivePath',
    });
  });

  it('rejects an empty itemId before building a request', async () => {
    const { service, provider } = createHarness();

    await expect(service.getItem(USER_ID, '')).rejects.toMatchObject({ code: 'InvalidDrivePath' });
    expect(provider.request).not.toHaveBeenCalled();
  });

  it('translates a paginator failure', async () => {
    const { service, provider } = createHarness();
    provider.requestAll.mockRejectedValue({ statusCode: 500, code: 'serviceNotAvailable', message: 'down' });

    await expect(service.listDrives(USER_ID)).rejects.toMatchObject({ code: 'serviceNotAvailable' });
  });

  it('translates a write failure', async () => {
    const { service, chain } = createHarness();
    chain.post.mockRejectedValue({ statusCode: 403, code: 'accessDenied', message: 'nope' });

    await expect(service.createFolder(USER_ID, 'Reports')).rejects.toMatchObject({ code: 'accessDenied' });
  });

  it('rejects a write that returned no item', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({});

    await expect(service.createFolder(USER_ID, 'Reports')).rejects.toMatchObject({
      code: 'GraphRequestFailed',
    });
  });

  it('rejects a name carrying a path separator', async () => {
    const { service } = createHarness();

    await expect(service.createFolder(USER_ID, 'Reports/2026')).rejects.toMatchObject({
      code: 'InvalidDriveItemName',
    });
    await expect(
      service.uploadItem(USER_ID, null, 'a\\b.txt', Buffer.from('x')),
    ).rejects.toMatchObject({ code: 'InvalidDriveItemName' });
  });

  it('constructs through the exported definition', () => {
    const context: any = { user: { _id: USER_ID }, getService: (): undefined => undefined };
    const instance: any = AzureDriveServiceDefinition.service({} as any, context);

    expect(instance.name).toBe('AzureDriveService');
    expect(AzureDriveServiceDefinition.id).toBe('azure.AzureDriveService@1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Copy monitor: redirects and body draining
// ---------------------------------------------------------------------------

describe('copyItem - monitor redirects and body draining', () => {
  function monitorHarness(postStatus = 202) {
    const harness = createHarness();
    harness.chain.post.mockResolvedValue({
      status: postStatus,
      headers: { location: 'https://graph.microsoft.com/v1.0/monitor/abc' },
      body: undefined,
    });

    return harness;
  }

  it('resolves a monitor 302 by reading the item it points at', async () => {
    const { service, chain, provider } = monitorHarness();

    chain.get.mockResolvedValue({
      status: 302,
      headers: { location: 'https://graph.microsoft.com/v1.0/me/drive/items/copied-1' },
      body: undefined,
    });
    provider.request.mockResolvedValue({ id: 'copied-1', name: 'copy.txt' });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST', { pollIntervalMs: 1 });

    expect(result).toMatchObject({ status: 'completed', itemId: 'copied-1' });
    expect(result.item).toMatchObject({ name: 'copy.txt' });
    expect(provider.request.mock.calls[0][1]).toBe(
      'https://graph.microsoft.com/v1.0/me/drive/items/copied-1',
    );
  });

  it('waits between polls before following a 302 monitor hop', async () => {
    const { service, chain, provider } = monitorHarness();

    chain.get
      .mockResolvedValueOnce({ status: 202, headers: {}, body: undefined })
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'https://graph.microsoft.com/v1.0/me/drive/items/copied-2' },
        body: undefined,
      });
    provider.request.mockResolvedValue({ id: 'copied-2' });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST', { pollIntervalMs: 5 });

    expect(result).toMatchObject({ status: 'completed', itemId: 'copied-2' });
    expect(chain.get).toHaveBeenCalledTimes(2);
  });

  it('stops polling when a monitor 302 has no Location', async () => {
    const { service, chain } = monitorHarness();

    chain.get.mockResolvedValue({ status: 302, headers: {}, body: undefined });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST', { pollIntervalMs: 1 });

    expect(result).toMatchObject({ status: 'inProgress' });
  });

  it('drains a 202 monitor body through cancel()', async () => {
    const { service, chain } = monitorHarness();
    const cancel = jest.fn().mockResolvedValue(undefined);

    chain.get
      .mockResolvedValueOnce({ status: 202, headers: {}, body: { cancel } })
      .mockResolvedValueOnce({ status: 200, headers: {}, json: async () => ({ id: 'copy-9' }) });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST', { pollIntervalMs: 0 });

    expect(result).toMatchObject({ status: 'completed', itemId: 'copy-9' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('drains a 202 monitor body through resume()', async () => {
    const { service, chain } = monitorHarness();
    const body = Readable.from([]);
    const resume = jest.spyOn(body, 'resume');

    chain.get
      .mockResolvedValueOnce({ status: 202, headers: {}, body })
      .mockResolvedValueOnce({ status: 200, headers: {}, json: async () => ({ id: 'copy-10' }) });

    await service.copyItem(USER_ID, 'ITEM', 'DEST', { pollIntervalMs: 0 });

    expect(resume).toHaveBeenCalled();
  });

  it('ignores a 202 monitor body that is not an object', async () => {
    const { service, chain } = monitorHarness();

    chain.get
      .mockResolvedValueOnce({ status: 202, headers: {}, body: 'ignore-me' })
      .mockResolvedValueOnce({ status: 200, headers: {}, json: async () => ({ id: 'copy-11' }) });

    await expect(
      service.copyItem(USER_ID, 'ITEM', 'DEST', { pollIntervalMs: 0 }),
    ).resolves.toMatchObject({ status: 'completed', itemId: 'copy-11' });
  });

  it('reads the completion payload out of a raw response wrapper', async () => {
    const { service, chain } = monitorHarness();

    chain.get
      .mockResolvedValueOnce({ status: 202, headers: {}, body: undefined })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ id: 'copy-12', name: 'wrapped.txt' })),
      });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST', { pollIntervalMs: 0 });

    expect(result.itemId).toBe('copy-12');
  });

  it('treats an empty completion body as a completion with no item', async () => {
    const { service, chain } = monitorHarness();

    chain.get
      .mockResolvedValueOnce({ status: 202, headers: {}, body: undefined })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: Buffer.alloc(0) });

    const result = await service.copyItem(USER_ID, 'ITEM', 'DEST', { pollIntervalMs: 0 });

    expect(result.status).toBe('completed');
    expect(result.itemId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Proxy failure, disconnect and fallback branches
// ---------------------------------------------------------------------------

describe('proxy failure and disconnect branches', () => {
  function buildApp(options: { service?: any; getService?: any } = {}) {
    const app = express();

    app.use((req, _res, next) => {
      (req as any).context = {
        user: { _id: USER_ID },
        getService: options.getService || (() => options.service),
      };
      next();
    });
    app.use('/azure', proxyRoutes);

    return app;
  }

  function fakeService(download: any = {}, item: any = {}) {
    return {
      getItem: jest.fn().mockResolvedValue({
        id: 'ITEM',
        name: 'Report.pdf',
        file: { mimeType: 'application/pdf' },
        ...item,
      }),
      downloadItem: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('file-bytes')]),
        contentType: 'application/pdf',
        contentLength: 10,
        ...download,
      }),
      getThumbnail: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('thumb-bytes')]),
        contentType: 'image/jpeg',
      }),
    };
  }

  it('503s when the service container itself throws', async () => {
    const response = await request(buildApp({
      getService: () => {
        throw new Error('container exploded');
      },
    })).get('/azure/files/ITEM');

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('Azure Drive Service not available');
  });

  it('falls back to name "download" and the octet-stream type', async () => {
    const service = fakeService(
      { contentType: undefined, contentLength: undefined, fileName: undefined },
      { name: undefined, file: undefined },
    );

    const response = await request(buildApp({ service })).get('/azure/files/ITEM');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="download"/);
  });

  it('escapes the RFC 5987 characters encodeURIComponent leaves alone', () => {
    const header = buildContentDisposition("O'Brien (draft)*.txt");

    expect(header).toContain("filename*=UTF-8''O%27Brien%20%28draft%29%2A.txt");
    expect(header).toContain('filename="O\'Brien (draft)*.txt"');
  });

  it('502s when the stream fails before any header is sent', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('upstream exploded'));
      },
    });

    const service = fakeService({ stream: failing, contentLength: undefined });

    const response = await request(buildApp({ service })).get('/azure/files/ITEM');

    expect(response.status).toBe(502);
    // The error must be JSON even though the stream's octet-stream type was set.
    expect(String(response.headers['content-type'])).toContain('application/json');
    expect(response.body.code).toBe('GraphRequestFailed');
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('destroys the response when the stream fails after the headers are sent', async () => {
    const upstream = new Readable({ read() {} });
    const service = fakeService({ stream: upstream, contentLength: undefined });

    const pending = request(buildApp({ service })).get('/azure/files/ITEM');

    setTimeout(() => upstream.push(Buffer.from('partial')), 10);
    setTimeout(() => upstream.destroy(new Error('stream broke mid-flight')), 40);

    // The client must not receive a well-formed 200 for a truncated body.
    await expect(pending).rejects.toThrow();
  });

  it('destroys the upstream stream when the client disconnects', async () => {
    const upstream = new Readable({ read() {} });
    upstream.push(Buffer.from('first-chunk'));

    const service = fakeService({ stream: upstream, contentLength: undefined });
    const server = buildApp({ service }).listen(0);
    const address: any = server.address();

    try {
      await new Promise<void>((resolve) => {
        const req = http.get({ port: address.port, path: '/azure/files/ITEM' }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });

        req.on('error', () => resolve());
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect((upstream as any).destroyed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back to image/jpeg for a thumbnail with no content type', async () => {
    const service = fakeService();
    service.getThumbnail.mockResolvedValue({
      stream: Readable.from([Buffer.from('thumb')]),
      contentType: undefined,
    });

    const response = await request(buildApp({ service })).get('/azure/files/ITEM/thumbnail');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
  });

  it('uses the generic message and code for an unlabelled failure', async () => {
    const service = fakeService();
    service.getItem.mockRejectedValue(new Error(''));

    const response = await request(buildApp({ service })).get('/azure/files/ITEM');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'The drive request failed', code: 'GraphRequestFailed' });
  });
});

// ---------------------------------------------------------------------------
// The identity contract: every identitySet field must be unwrapped
// ---------------------------------------------------------------------------

describe('DriveResolver identity contract', () => {
  const RESOLVER_SOURCE = fs.readFileSync(
    path.resolve(__dirname, '..', 'graphql', 'resolvers', 'DriveResolver.ts'),
    'utf8',
  );
  const SDL = fs.readFileSync(
    path.resolve(__dirname, '..', 'graphql', 'types', 'Drive.graphql'),
    'utf8',
  );

  it('declares an @property resolver for every identitySet field', () => {
    // Graph sends these as identitySet ({ user: {...} }). A missing resolver
    // silently yields all-null subfields, which no query error would reveal.
    for (const declaration of [
      "@property('AzureDrive', 'owner')",
      "@property('AzureDriveSharedFacet', 'owner')",
      "@property('AzureDriveItem', 'createdBy')",
      "@property('AzureDriveItem', 'lastModifiedBy')",
      "@property('AzureDriveVersion', 'lastModifiedBy')",
      "@property('AzureDrivePermission', 'grantedTo')",
    ]) {
      expect(RESOLVER_SOURCE).toContain(declaration);
    }
  });

  it('keeps every one of those fields declared as AzureDriveIdentity in the SDL', () => {
    expect(SDL).toMatch(/type AzureDrive \{[\s\S]*owner: AzureDriveIdentity/);
    expect(SDL).toMatch(/type AzureDriveSharedFacet \{[\s\S]*owner: AzureDriveIdentity/);
    expect(SDL).toMatch(/type AzureDriveVersion \{[\s\S]*lastModifiedBy: AzureDriveIdentity/);
    expect(SDL).toMatch(/type AzureDriveItem \{[\s\S]*createdBy: AzureDriveIdentity/);
  });
});

describe('DriveResolver mutation mapping and identity unwrapping', () => {
  function buildResolver(service: any) {
    const context = {
      user: { _id: USER_ID },
      hasRole: jest.fn(() => true),
      getService: jest.fn((id: string) => (id === 'azure.AzureDriveService@1.0.0' ? service : undefined)),
    };

    return { resolver: new DriveResolver() as any, context };
  }

  function driveService() {
    return {
      createFolder: jest.fn().mockResolvedValue({ id: 'folder' }),
      uploadItem: jest.fn().mockResolvedValue({ id: 'uploaded' }),
      moveItem: jest.fn().mockResolvedValue({ id: 'moved' }),
      copyItem: jest.fn().mockResolvedValue({ status: 'completed' }),
      restoreItem: jest.fn().mockResolvedValue({ id: 'restored' }),
      createShareLink: jest.fn().mockResolvedValue({ id: 'perm-1' }),
      inviteCollaborators: jest.fn().mockResolvedValue([]),
      restoreVersion: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('forwards every argument of the six mutating adapters', async () => {
    const service = driveService();
    const { resolver, context } = buildResolver(service);

    await resolver.createFolder(
      {},
      { name: 'Reports', parentId: 'PARENT', driveId: 'D1', conflictBehavior: 'replace' },
      context,
    );
    await resolver.moveItem(
      {},
      { itemId: 'ITEM', parentId: 'DEST', name: 'renamed.txt', driveId: 'D1' },
      context,
    );
    await resolver.copyItem(
      {},
      { itemId: 'ITEM', parentId: 'DEST', name: 'copy.txt', wait: false, driveId: 'D1' },
      context,
    );
    await resolver.restoreItem({}, { itemId: 'ITEM', driveId: 'D1' }, context);
    await resolver.createShareLink(
      {},
      {
        itemId: 'ITEM',
        type: 'edit',
        scope: 'organization',
        expirationDateTime: '2026-12-31T23:59:59Z',
        password: 's3cret',
        driveId: 'D1',
      },
      context,
    );
    await resolver.inviteCollaborators(
      {},
      {
        itemId: 'ITEM',
        recipients: ['reader@example.test'],
        role: 'write',
        message: 'Please review',
        sendInvitation: false,
        driveId: 'D1',
      },
      context,
    );
    await expect(
      resolver.restoreVersion({}, { itemId: 'ITEM', versionId: '2.0', driveId: 'D1' }, context),
    ).resolves.toBe(true);

    expect(service.createFolder).toHaveBeenCalledWith(USER_ID, 'Reports', 'PARENT', {
      driveId: 'D1',
      conflictBehavior: 'replace',
    });
    expect(service.moveItem).toHaveBeenCalledWith(USER_ID, 'ITEM', 'DEST', {
      driveId: 'D1',
      name: 'renamed.txt',
    });
    expect(service.copyItem).toHaveBeenCalledWith(USER_ID, 'ITEM', 'DEST', {
      driveId: 'D1',
      name: 'copy.txt',
      wait: false,
    });
    expect(service.restoreItem).toHaveBeenCalledWith(USER_ID, 'ITEM', { driveId: 'D1' });
    expect(service.createShareLink).toHaveBeenCalledWith(USER_ID, 'ITEM', {
      driveId: 'D1',
      type: 'edit',
      scope: 'organization',
      expirationDateTime: '2026-12-31T23:59:59Z',
      password: 's3cret',
    });
    expect(service.inviteCollaborators).toHaveBeenCalledWith(USER_ID, 'ITEM', ['reader@example.test'], {
      driveId: 'D1',
      role: 'write',
      message: 'Please review',
      sendInvitation: false,
    });
    expect(service.restoreVersion).toHaveBeenCalledWith(USER_ID, 'ITEM', '2.0', { driveId: 'D1' });
  });

  it('defaults the optional mutation arguments instead of sending undefined parents', async () => {
    const service = driveService();
    const { resolver, context } = buildResolver(service);

    await resolver.createFolder({}, { name: 'Reports' }, context);
    await resolver.inviteCollaborators({}, { itemId: 'ITEM' }, context);

    expect(service.createFolder).toHaveBeenCalledWith(USER_ID, 'Reports', null, {
      driveId: undefined,
      conflictBehavior: undefined,
    });
    // An absent recipient list becomes [], never undefined.
    expect(service.inviteCollaborators).toHaveBeenCalledWith(USER_ID, 'ITEM', [], {
      driveId: undefined,
      role: undefined,
      message: undefined,
      sendInvitation: undefined,
    });
  });

  it('unwraps every identitySet onto the flat AzureDriveIdentity type', () => {
    const { resolver } = buildResolver(driveService());

    const identity = { id: 'u1', displayName: 'Ada Lovelace', email: 'ada@example.test' };

    // AzureDrive.owner
    expect(resolver.resolveDriveOwner({ owner: { user: identity } })).toEqual(identity);
    expect(resolver.resolveDriveOwner({ owner: {} })).toBeNull();
    expect(resolver.resolveDriveOwner({})).toBeNull();

    // AzureDriveSharedFacet.owner
    expect(resolver.resolveSharedOwner({ owner: { user: identity } })).toEqual(identity);
    expect(resolver.resolveSharedOwner({ owner: {} })).toBeNull();
    expect(resolver.resolveSharedOwner({})).toBeNull();

    // AzureDriveVersion.lastModifiedBy
    expect(resolver.resolveVersionLastModifiedBy({ lastModifiedBy: { user: identity } })).toEqual(identity);
    expect(resolver.resolveVersionLastModifiedBy({})).toBeNull();

    // AzureDriveItem.createdBy / lastModifiedBy (the precedent this mirrors)
    expect(resolver.resolveCreatedBy({ createdBy: { user: identity } })).toEqual(identity);
    expect(resolver.resolveCreatedBy({})).toBeNull();
    expect(resolver.resolveLastModifiedBy({ lastModifiedBy: { user: identity } })).toEqual(identity);
    expect(resolver.resolveLastModifiedBy({})).toBeNull();
  });

  it('picks a principal out of every grantedToV2 variant', () => {
    const { resolver } = buildResolver(driveService());

    expect(resolver.resolveGrantedTo({ grantedToV2: { user: { id: 'u' } } })).toEqual({ id: 'u' });
    expect(resolver.resolveGrantedTo({ grantedToV2: { group: { id: 'g' } } })).toEqual({ id: 'g' });
    expect(resolver.resolveGrantedTo({ grantedToV2: { siteGroup: { id: 'sg' } } })).toEqual({ id: 'sg' });
    expect(resolver.resolveGrantedTo({ grantedToV2: { siteUser: { id: 'su' } } })).toEqual({ id: 'su' });
    expect(resolver.resolveGrantedTo({ grantedToV2: { application: { id: 'app' } } })).toEqual({ id: 'app' });
    expect(resolver.resolveGrantedTo({ grantedToV2: {} })).toBeNull();
    expect(resolver.resolveGrantedTo({})).toBeNull();
  });
});

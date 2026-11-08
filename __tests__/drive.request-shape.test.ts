/**
 * `drive.request-shape.test.ts` - the OneDrive **wire contract**.
 *
 * Every assertion here is about what the service asks Microsoft Graph for: the
 * exact path, method, headers and body. Two of these are security requirements,
 * not cosmetics:
 *
 *   - a path segment containing `a b#c?.txt` must be percent-encoded, or a `#`
 *     truncates the request at a fragment and a `?` turns the filename into a
 *     query string;
 *   - an upload above 4 MiB must use `createUploadSession` with 320 KiB-multiple
 *     fragments, and the fragment `PUT`s go to a **pre-authenticated** upload URL
 *     with no `Authorization` header.
 *
 * The Graph SDK is mocked and the raw transport is replaced, so no live Graph
 * call can be made: this repository has no Azure tenant.
 */
jest.mock('@microsoft/microsoft-graph-client', () => ({
  ResponseType: { RAW: 'raw', TEXT: 'text', JSON: 'json' },
}));

// eslint-disable-next-line import/first
import { Readable } from 'stream';
// eslint-disable-next-line import/first
import ApiError from '@reactory/server-core/exceptions';
// eslint-disable-next-line import/first
import { AzureDriveService, getDriveHttpClient, setDriveHttpClient } from '../services/AzureDriveService';
// eslint-disable-next-line import/first
import { readHeader } from '../utils/graph-error';
// eslint-disable-next-line import/first
import {
  DRIVE_SIMPLE_UPLOAD_MAX_BYTES,
  DRIVE_UPLOAD_CHUNK_MULTIPLE,
  DRIVE_UPLOAD_CHUNK_SIZE,
  type IDriveHttpRequest,
  type IDriveHttpResponse,
} from '../types/drive.types';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';

/** The fluent `client.api(path).headers().post()/put()/patch()/delete()` chain. */
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

interface IHarness {
  service: AzureDriveService;
  provider: { request: jest.Mock; requestAll: jest.Mock; getClient: jest.Mock };
  chain: IChainMock;
  authService: { getToken: jest.Mock };
}

function createHarness(): IHarness {
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
  service.setGraphProvider(provider);
  service.setAuthService(authService);

  return { service, provider, chain, authService };
}

/** The path passed to `client.api(...)` for call `index`. */
function apiPath(chain: IChainMock, index = 0): string {
  return String(chain.api.mock.calls[index][0]);
}

/** Record every hop the byte transport is asked to make. */
function recordingTransport(handler: (request: IDriveHttpRequest) => IDriveHttpResponse) {
  const calls: IDriveHttpRequest[] = [];

  setDriveHttpClient(async (request) => {
    calls.push(request);
    return handler(request);
  });

  return calls;
}

afterEach(() => {
  setDriveHttpClient(null);
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

describe('drive addressing and encoding', () => {
  it('reads the default drive from /me/drive', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ id: 'drive-1', driveType: 'personal' });

    await expect(service.getDefaultDrive(USER_ID)).resolves.toMatchObject({ id: 'drive-1' });

    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      '/me/drive',
      expect.objectContaining({ operation: 'drive.getDefaultDrive' }),
    );
  });

  it('lists every drive through the provider paginator', async () => {
    const { service, provider } = createHarness();
    provider.requestAll.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);

    await expect(service.listDrives(USER_ID)).resolves.toHaveLength(2);

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      '/drives',
      expect.objectContaining({ operation: 'drive.listDrives' }),
    );
  });

  it('lists the drive root and a specific folder over their documented paths', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ value: [], '@odata.nextLink': undefined });

    await service.listChildren(USER_ID);
    await service.listChildren(USER_ID, 'ITEM-1');
    await service.listChildren(USER_ID, null, { driveId: 'DRIVE-9', top: 25 });

    expect(apiPathFrom(provider)).toEqual([
      '/me/drive/root/children',
      '/me/drive/items/ITEM-1/children',
      '/drives/DRIVE-9/root/children',
    ]);

    expect(provider.request.mock.calls[2][2]).toMatchObject({ top: 25, operation: 'drive.listChildren' });
  });

  it('continues a children listing from the opaque nextLink', async () => {
    const { service, provider } = createHarness();
    const nextLink = 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc';
    provider.request.mockResolvedValue({ value: [], '@odata.nextLink': undefined });

    await service.listChildren(USER_ID, null, { nextLink });

    expect(provider.request.mock.calls[0][1]).toBe(nextLink);
    expect(provider.request.mock.calls[0][2]).toMatchObject({ url: nextLink });
  });

  it('percent-encodes every segment of a path-addressed item', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ id: 'file-1', name: 'a b#c?.txt' });

    await service.getItemByPath(USER_ID, 'a b#c?.txt');

    const path = apiPathFrom(provider)[0];
    expect(path).toBe('/me/drive/root:/a%20b%23c%3F.txt');
    // The three characters that would otherwise change the shape of the request.
    expect(path).not.toContain('#');
    expect(path).not.toContain('?');
    expect(path).not.toContain(' ');
  });

  it('keeps folder separators but encodes each nested segment', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ id: 'file-2' });

    await service.getItemByPath(USER_ID, '/Folder One/Sub dir/a b#c?.txt');

    expect(apiPathFrom(provider)[0]).toBe(
      '/me/drive/root:/Folder%20One/Sub%20dir/a%20b%23c%3F.txt',
    );
  });

  it('encodes the drive id and refuses an empty path', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ id: 'file-3' });

    await service.getItemByPath(USER_ID, 'a b.txt', { driveId: 'drive id/#1' });

    expect(apiPathFrom(provider)[0]).toBe('/drives/drive%20id%2F%231/root:/a%20b.txt');

    await expect(service.getItemByPath(USER_ID, '   ')).rejects.toMatchObject({
      code: 'InvalidDrivePath',
    });
  });

  it('reads an item by id and encodes the id', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ id: 'ITEM 1' });

    await service.getItem(USER_ID, 'ITEM 1');

    expect(apiPathFrom(provider)[0]).toBe('/me/drive/items/ITEM%201');
  });

  it('quotes and encodes a search term', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ value: [] });

    await service.search(USER_ID, 'budget report');
    await service.search(USER_ID, "O'Brien a#b?c");

    expect(apiPathFrom(provider)).toEqual([
      "/me/drive/root/search(q='budget%20report')",
      "/me/drive/root/search(q='O''Brien%20a%23b%3Fc')",
    ]);

    // A quote must be doubled (OData) rather than left able to close the literal.
    expect(apiPathFrom(provider)[1]).not.toContain("q='O'Brien");
  });

  it('refuses an empty search term', async () => {
    const { service } = createHarness();

    await expect(service.search(USER_ID, '  ')).rejects.toMatchObject({
      code: 'InvalidDriveSearchQuery',
    });
  });
});

// ---------------------------------------------------------------------------
// Structure and sharing
// ---------------------------------------------------------------------------

describe('drive writes', () => {
  it('creates a folder in the root and in a parent', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ id: 'folder-1', name: 'Reports', folder: { childCount: 0 } });

    await service.createFolder(USER_ID, 'Reports');
    await service.createFolder(USER_ID, 'Reports', 'PARENT');

    expect(chain.api.mock.calls.map((call) => call[0])).toEqual([
      '/me/drive/root/children',
      '/me/drive/items/PARENT/children',
    ]);

    expect(chain.post).toHaveBeenCalledWith({
      name: 'Reports',
      folder: {},
      '@microsoft.graph.conflictBehavior': 'rename',
    });
  });

  it('moves an item with a PATCH on the item itself', async () => {
    const { service, chain } = createHarness();
    chain.patch.mockResolvedValue({ id: 'ITEM', name: 'renamed.txt', parentReference: { id: 'DEST' } });

    await service.moveItem(USER_ID, 'ITEM', 'DEST', { name: 'renamed.txt' });

    expect(apiPath(chain)).toBe('/me/drive/items/ITEM');
    expect(chain.patch).toHaveBeenCalledWith({
      parentReference: { id: 'DEST' },
      name: 'renamed.txt',
    });
  });

  it('deletes and restores without inventing a body', async () => {
    const { service, chain } = createHarness();
    chain.delete.mockResolvedValue(undefined);
    chain.post.mockResolvedValue({ id: 'ITEM' });

    await service.deleteItem(USER_ID, 'ITEM');
    await service.restoreItem(USER_ID, 'ITEM');

    expect(apiPath(chain, 0)).toBe('/me/drive/items/ITEM');
    expect(chain.delete).toHaveBeenCalledWith();
    expect(apiPath(chain, 1)).toBe('/me/drive/items/ITEM/restore');
    expect(chain.post).toHaveBeenCalledWith();
  });

  it('creates a view/anonymous share link by default', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ id: 'perm-1', roles: ['read'], link: { webUrl: 'https://x' } });

    await service.createShareLink(USER_ID, 'ITEM');

    expect(apiPath(chain)).toBe('/me/drive/items/ITEM/createLink');
    expect(chain.post).toHaveBeenCalledWith({ type: 'view', scope: 'anonymous' });
  });

  it('passes share-link options through without dropping them', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ id: 'perm-2' });

    await service.createShareLink(USER_ID, 'ITEM', {
      type: 'edit',
      scope: 'organization',
      expirationDateTime: '2026-12-31T23:59:59Z',
      password: 's3cret',
      retainInheritedPermissions: false,
    });

    expect(chain.post).toHaveBeenCalledWith({
      type: 'edit',
      scope: 'organization',
      expirationDateTime: '2026-12-31T23:59:59Z',
      password: 's3cret',
      retainInheritedPermissions: false,
    });
  });

  it('invites collaborators with a normalised recipient list', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ value: [{ id: 'perm-3' }] });

    const result = await service.inviteCollaborators(
      USER_ID,
      'ITEM',
      ['reader@example.test', { email: 'writer@example.test', name: 'Writer' }],
      { role: 'write', message: 'Please review' },
    );

    expect(result).toEqual([{ id: 'perm-3' }]);
    expect(apiPath(chain)).toBe('/me/drive/items/ITEM/invite');
    expect(chain.post).toHaveBeenCalledWith({
      requireSignIn: true,
      sendInvitation: true,
      roles: ['write'],
      recipients: [
        { email: 'reader@example.test' },
        { email: 'writer@example.test', name: 'Writer' },
      ],
      message: 'Please review',
    });
  });

  it('refuses an invite with no usable address', async () => {
    const { service } = createHarness();

    await expect(service.inviteCollaborators(USER_ID, 'ITEM', [])).rejects.toMatchObject({
      code: 'InvalidDrivePath',
    });
  });

  it('lists permissions and deletes one with an encoded id', async () => {
    const { service, provider, chain } = createHarness();
    provider.requestAll.mockResolvedValue([]);
    chain.delete.mockResolvedValue(undefined);

    await service.listPermissions(USER_ID, 'ITEM');
    await service.deletePermission(USER_ID, 'ITEM', 'perm a#b?c');

    expect(provider.requestAll.mock.calls[0][1]).toBe('/me/drive/items/ITEM/permissions');
    expect(apiPath(chain)).toBe('/me/drive/items/ITEM/permissions/perm%20a%23b%3Fc');
  });

  it('lists versions and restores one', async () => {
    const { service, provider, chain } = createHarness();
    provider.requestAll.mockResolvedValue([{ id: '1.0' }]);
    chain.post.mockResolvedValue(undefined);

    await service.listVersions(USER_ID, 'ITEM');
    await service.restoreVersion(USER_ID, 'ITEM', '1.0');

    expect(provider.requestAll.mock.calls[0][1]).toBe('/me/drive/items/ITEM/versions');
    expect(apiPath(chain)).toBe('/me/drive/items/ITEM/versions/1.0/restore');
  });

  it('rejects an item name that could poison a path', async () => {
    const { service } = createHarness();

    await expect(service.createFolder(USER_ID, '  ')).rejects.toMatchObject({
      code: 'InvalidDriveItemName',
    });
    await expect(service.createFolder(USER_ID, 'a\u0000b')).rejects.toMatchObject({
      code: 'InvalidDriveItemName',
    });
  });
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

describe('uploadItem - simple upload below the documented limit', () => {
  it('PUTs …:/{name}:/content with the bytes and the content type', async () => {
    const { service, chain } = createHarness();
    const bytes = Buffer.from('hello onedrive');
    chain.put.mockResolvedValue({ id: 'new-1', name: 'a b.txt', size: bytes.length });

    const item = await service.uploadItem(USER_ID, 'PARENT', 'a b.txt', bytes, {
      contentType: 'text/plain',
    });

    expect(item).toMatchObject({ id: 'new-1' });
    expect(apiPath(chain)).toBe(
      '/me/drive/items/PARENT:/a%20b.txt:/content?@microsoft.graph.conflictBehavior=rename',
    );
    expect(chain.put).toHaveBeenCalledWith(bytes);
    expect(chain.headers).toHaveBeenCalledWith({ 'Content-Type': 'text/plain' });
    // No session was created for a small file.
    expect(chain.post).not.toHaveBeenCalled();
  });

  it('uses the simple path at exactly the 4 MiB boundary', async () => {
    const { service, chain } = createHarness();
    const bytes = Buffer.alloc(DRIVE_SIMPLE_UPLOAD_MAX_BYTES, 1);
    chain.put.mockResolvedValue({ id: 'boundary', name: 'exact.bin' });

    await service.uploadItem(USER_ID, null, 'exact.bin', bytes);

    expect(apiPath(chain)).toBe(
      '/me/drive/root:/exact.bin:/content?@microsoft.graph.conflictBehavior=rename',
    );

    const uploaded = chain.put.mock.calls[0][0];
    expect(Buffer.isBuffer(uploaded)).toBe(true);
    expect(uploaded.length).toBe(DRIVE_SIMPLE_UPLOAD_MAX_BYTES);
    expect(uploaded.equals(bytes)).toBe(true);
    expect(chain.post).not.toHaveBeenCalled();
  });
});

describe('uploadItem - resumable session above the documented limit', () => {
  it('creates a session and sends one fragment when 10 MiB covers the file', async () => {
    const { service, chain } = createHarness();
    const bytes = Buffer.alloc(DRIVE_SIMPLE_UPLOAD_MAX_BYTES + 1, 7);
    chain.post.mockResolvedValue({ uploadUrl: 'https://upload.example/session/1' });

    const calls = recordingTransport(() => ({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ id: 'big-1', name: 'big.bin' })),
    }));

    const item = await service.uploadItem(USER_ID, 'PARENT', 'big.bin', bytes);

    expect(item).toMatchObject({ id: 'big-1' });
    expect(apiPath(chain)).toBe('/me/drive/items/PARENT:/big.bin:/createUploadSession');
    expect(chain.post).toHaveBeenCalledWith({
      item: { '@microsoft.graph.conflictBehavior': 'rename', name: 'big.bin' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://upload.example/session/1');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers['Content-Range']).toBe(
      `bytes 0-${DRIVE_SIMPLE_UPLOAD_MAX_BYTES}/${DRIVE_SIMPLE_UPLOAD_MAX_BYTES + 1}`,
    );
    expect(DRIVE_UPLOAD_CHUNK_SIZE).toBe(DRIVE_UPLOAD_CHUNK_MULTIPLE * 32);
  });

  it('splits the bytes into 320 KiB-multiple fragments with no bearer token', async () => {
    const { service, chain } = createHarness();
    // 8 x 320 KiB = 2.5 MiB, so a 4 MiB + 5 byte file needs exactly two fragments.
    const chunkSize = DRIVE_UPLOAD_CHUNK_MULTIPLE * 8;
    const bytes = Buffer.alloc(DRIVE_SIMPLE_UPLOAD_MAX_BYTES + 5, 3);
    chain.post.mockResolvedValue({ uploadUrl: 'https://upload.example/session/2' });

    const calls = recordingTransport((request) => {
      const range = String(request.headers?.['Content-Range'] || '');
      const end = Number(/bytes \d+-(\d+)\//.exec(range)?.[1] || 0);
      const total = Number(/\/\s*(\d+)$/.exec(range)?.[1] || 0);
      const last = end + 1 >= total;

      return last
        ? {
          status: 201,
          headers: {},
          body: Buffer.from(JSON.stringify({ id: 'big-2', name: 'chunked.bin' })),
        }
        : { status: 202, headers: {}, body: Buffer.from(JSON.stringify({ nextExpectedRanges: [] })) };
    });

    const item = await service.uploadItem(USER_ID, null, 'chunked.bin', bytes, { chunkSize });

    expect(item).toMatchObject({ id: 'big-2' });
    expect(calls).toHaveLength(2);

    expect(calls[0].headers['Content-Range']).toBe(
      `bytes 0-${chunkSize - 1}/${bytes.length}`,
    );
    expect(calls[1].headers['Content-Range']).toBe(
      `bytes ${chunkSize}-${bytes.length - 1}/${bytes.length}`,
    );
    // Every fragment except the last is a full, 320 KiB-aligned chunk.
    expect(chunkSize % DRIVE_UPLOAD_CHUNK_MULTIPLE).toBe(0);

    for (const call of calls) {
      const headerNames = Object.keys(call.headers || {}).map((name) => name.toLowerCase());
      expect(headerNames).not.toContain('authorization');
      // The upload URL is pre-authenticated; forwarding the token would leak it.
      expect(JSON.stringify(call.headers || {})).not.toContain('graph-token');
    }
  });

  it('resumes from nextExpectedRanges after a 416', async () => {
    const { service, chain } = createHarness();
    const chunkSize = DRIVE_UPLOAD_CHUNK_MULTIPLE * 8;
    const bytes = Buffer.alloc(DRIVE_SIMPLE_UPLOAD_MAX_BYTES + 1, 9);
    chain.post.mockResolvedValue({ uploadUrl: 'https://upload.example/session/3' });

    const calls = recordingTransport((request) => {
      if (callsSeen() === 1) {
        return {
          status: 416,
          headers: {},
          body: Buffer.from(JSON.stringify({ nextExpectedRanges: [`${chunkSize}-`] })),
        };
      }

      return {
        status: 201,
        headers: {},
        body: Buffer.from(JSON.stringify({ id: 'resumed', name: 'resumed.bin' })),
      };
    });

    let seen = 0;
    function callsSeen(): number {
      seen += 1;
      return seen;
    }

    const item = await service.uploadItem(USER_ID, null, 'resumed.bin', bytes, { chunkSize });

    expect(item).toMatchObject({ id: 'resumed' });
    expect(calls).toHaveLength(2);
    // Fragment one was refused; the upload resumed at Graph's stated offset.
    expect(calls[0].headers['Content-Range']).toBe(`bytes 0-${chunkSize - 1}/${bytes.length}`);
    expect(calls[1].headers['Content-Range']).toBe(
      `bytes ${chunkSize}-${bytes.length - 1}/${bytes.length}`,
    );
  });

  it('refuses a fragment size that is not a multiple of 320 KiB', async () => {
    const { service, chain } = createHarness();
    const bytes = Buffer.alloc(DRIVE_SIMPLE_UPLOAD_MAX_BYTES + 1, 1);
    chain.post.mockResolvedValue({ uploadUrl: 'https://upload.example/session/4' });

    await expect(
      service.uploadItem(USER_ID, null, 'bad.bin', bytes, { chunkSize: 1000 }),
    ).rejects.toMatchObject({ code: 'InvalidUploadChunkSize' });
  });

  it('treats an unreadable completion body as a failed upload', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ uploadUrl: 'https://upload.example/session/11' });

    recordingTransport(() => ({
      status: 201,
      headers: {},
      body: {
        json: async () => {
          throw new Error('truncated JSON');
        },
      },
    } as any));

    await expect(
      service.uploadItem(USER_ID, null, 'truncated.bin', Buffer.alloc(DRIVE_SIMPLE_UPLOAD_MAX_BYTES + 1, 2)),
    ).rejects.toMatchObject({ code: 'GraphRequestFailed' });
  });

  it('fails rather than looping when a 416 carries an unparseable range', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ uploadUrl: 'https://upload.example/session/12' });

    const calls = recordingTransport(() => ({
      status: 416,
      headers: {},
      body: Buffer.from(JSON.stringify({ nextExpectedRanges: ['not-a-range'] })),
    }));

    await expect(
      service.uploadItem(USER_ID, null, 'garbage.bin', Buffer.alloc(DRIVE_SIMPLE_UPLOAD_MAX_BYTES + 1, 4)),
    ).rejects.toMatchObject({ status: 416 });

    // An unusable range must not rewind or loop: exactly one fragment is sent.
    expect(calls).toHaveLength(1);
  });

  it('fails loudly when Graph returns no uploadUrl', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({});

    await expect(
      service.uploadItem(USER_ID, null, 'nourl.bin', Buffer.alloc(DRIVE_SIMPLE_UPLOAD_MAX_BYTES + 1)),
    ).rejects.toMatchObject({ code: 'UploadSessionMissingUrl' });
  });
});

describe('getThumbnail request shape', () => {
  it('requests the named rendition and streams the bytes', async () => {
    const { service } = createHarness();
    const calls = recordingTransport(() => ({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: Readable.from([Buffer.from('thumb')]),
    }));

    const thumbnail = await service.getThumbnail(USER_ID, 'ITEM', { size: 'medium' });
    const chunks: Buffer[] = [];

    for await (const chunk of thumbnail.stream) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks).toString('utf8')).toBe('thumb');
    expect(calls[0].url).toBe(
      'https://graph.microsoft.com/v1.0/me/drive/items/ITEM/thumbnails/0/medium/content',
    );
  });
});

/** Paths recorded by `provider.request`, in call order. */
function apiPathFrom(provider: { request: jest.Mock }): string[] {
  return provider.request.mock.calls.map((call) => String(call[1]));
}

// ---------------------------------------------------------------------------
// The production byte transport
// ---------------------------------------------------------------------------

/**
 * `defaultDriveHttpClient` is the code that runs in production: it is the only
 * place that touches `fetch`, the only place that translates
 * `redirect: 'manual'` into the fetch option that stops at Graph's 302, and the
 * only place that normalises response headers for `readHeader` to read.
 *
 * Every other test in this module injects a transport, so without this block the
 * security-critical redirect policy would only be asserted on the service side of
 * the seam - a regression that made the transport follow redirects would leave
 * `fetchBinary` staring at a 200 with no `Location`, silently collapsing the
 * deliberate two-hop design.
 */
describe('defaultDriveHttpClient - the production byte transport', () => {
  const globalObject = globalThis as any;
  const originalFetch = globalObject.fetch;

  afterEach(() => {
    globalObject.fetch = originalFetch;
    setDriveHttpClient(null);
  });

  /** A `fetch` stand-in whose `headers` behave like a `Headers` instance. */
  function stubFetch(response: any) {
    const fetchMock = jest.fn().mockResolvedValue(response);
    globalObject.fetch = fetchMock;
    return fetchMock;
  }

  it('is the transport in use after setDriveHttpClient(null)', () => {
    setDriveHttpClient(null);

    expect(typeof getDriveHttpClient()).toBe('function');
  });

  it("passes method and headers through and maps redirect 'manual' to fetch", async () => {
    const fetchMock = stubFetch({
      status: 302,
      headers: new Map([
        ['Location', 'https://storage.example/preauth/file?sig=secret'],
        ['Content-Type', 'application/pdf'],
      ]),
      body: undefined,
    });

    setDriveHttpClient(null);

    const response = await getDriveHttpClient()({
      url: 'https://graph.microsoft.com/v1.0/me/drive/items/ITEM/content',
      method: 'GET',
      headers: { Authorization: 'Bearer graph-token', Accept: '*/*' },
      redirect: 'manual',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/drive/items/ITEM/content');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: 'Bearer graph-token', Accept: '*/*' });
    // The whole point: fetch must NOT follow the 302 itself.
    expect(init.redirect).toBe('manual');
    expect(init).not.toHaveProperty('body');

    // Headers are lowered so readHeader() (mixed-case lookup) finds Location.
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('https://storage.example/preauth/file?sig=secret');
    expect(readHeader(response.headers, 'Location')).toBe('https://storage.example/preauth/file?sig=secret');
  });

  it("maps an explicit 'follow' redirect onto fetch", async () => {
    const fetchMock = stubFetch({ status: 200, headers: new Map(), body: undefined });
    setDriveHttpClient(null);

    await getDriveHttpClient()({
      url: 'https://storage.example/preauth/file',
      method: 'GET',
      headers: { Accept: '*/*' },
      redirect: 'follow',
    });

    expect(fetchMock.mock.calls[0][1].redirect).toBe('follow');
  });

  it("defaults an absent redirect to fetch's 'follow'", async () => {
    const fetchMock = stubFetch({ status: 200, headers: new Map(), body: undefined });
    setDriveHttpClient(null);

    await getDriveHttpClient()({ url: 'https://graph.microsoft.com/v1.0/me/drive', method: 'GET' });

    expect(fetchMock.mock.calls[0][1].redirect).toBe('follow');
  });

  it('forwards a fragment body on a resumable upload PUT', async () => {
    const fetchMock = stubFetch({ status: 202, headers: new Map(), body: undefined });
    setDriveHttpClient(null);

    const fragment = Buffer.from('chunk-bytes');

    await getDriveHttpClient()({
      url: 'https://upload.example/session/1',
      method: 'PUT',
      headers: { 'Content-Range': 'bytes 0-10/11' },
      body: fragment,
    });

    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toBe(fragment);
    expect(init.headers).toEqual({ 'Content-Range': 'bytes 0-10/11' });
  });

  it('fronts a missing headers or status with an empty bag and status 0', async () => {
    stubFetch({ body: undefined });
    setDriveHttpClient(null);

    const response = await getDriveHttpClient()({ url: 'https://graph.microsoft.com/v1.0/me/drive', method: 'GET' });

    expect(response).toEqual({ status: 0, headers: {}, body: undefined });
  });

  it('throws a typed GraphRequestFailed when no fetch implementation exists', async () => {
    globalObject.fetch = undefined;
    setDriveHttpClient(null);

    const failure = await getDriveHttpClient()({
      url: 'https://graph.microsoft.com/v1.0/me/drive/items/ITEM/content',
      method: 'GET',
    }).catch((error: any) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe('GraphRequestFailed');
    expect(failure.message).toContain('fetch');
  });
});

/**
 * AZ-16 acceptance: Azure Blob Storage v12 data plane.
 *
 * No storage account exists and no live call is made: the SDK is mocked here, and
 * the parts that are pure computation - `generateBlobSASQueryParameters`,
 * `StorageSharedKeyCredential` and `BlobSASPermissions` - are the REAL SDK
 * implementations (pulled through `jest.requireActual`), so the assertions on `sig`,
 * `se`, `sp` and `sv` exercise the actual signing code rather than a stub.
 *
 * What this suite proves:
 *
 *  - credential selection: `DefaultAzureCredential` when no key is configured,
 *    `StorageSharedKeyCredential` when one is;
 *  - `listAllBlobs` follows `continuationToken` across three pages;
 *  - a generated SAS URL carries `sig`, `se`, `sp` and `sv`, defaults to 5 minutes,
 *    prefers a user-delegation key and falls back to the account key;
 *  - a 404 from `getBlobProperties` becomes an `ApiError`;
 *  - the module no longer contains the removed v10 client names.
 */
jest.mock('@azure/identity', () => {
  function DefaultAzureCredential(this: any, options?: any) {
    this.kind = 'DefaultAzureCredential';
    this.options = options;
  }

  return {
    __esModule: true,
    DefaultAzureCredential: jest.fn(DefaultAzureCredential),
  };
});

jest.mock('@azure/storage-blob', () => {
  const actual = jest.requireActual('@azure/storage-blob');

  const state: any = {
    /** Every BlobServiceClient the service constructed, with its arguments. */
    clients: [] as Array<{ url: string; credential: any; options: any; client: any }>,
    /** Container clients keyed by container name (getContainerClient is memoised). */
    containers: new Map<string, any>(),
    /** Resolves the single page a `listBlobsFlat(...).byPage()` call returns. */
    blobPages: (_continuationToken?: string): any => ({ segment: { blobItems: [] } }),
    /** Pages returned by `listContainers(...).byPage()` in order. */
    containerPages: [] as any[],
    /** What `getUserDelegationKey` resolves to, or throws. */
    userDelegationKey: undefined as any,
    userDelegationError: undefined as any,
    accountName: 'reactoryblobs',
  };

  const createBlobClient = (containerName: string, blobName: string): any => ({
    name: blobName,
    containerName,
    url: `https://${state.accountName}.blob.core.windows.net/${containerName}/${blobName}`,
    uploadData: jest.fn().mockResolvedValue({
      etag: '"uploaded-etag"',
      lastModified: new Date('2026-02-01T10:00:00.000Z'),
      requestId: 'req-upload',
    }),
    uploadStream: jest.fn().mockResolvedValue({
      etag: '"streamed-etag"',
      lastModified: new Date('2026-02-01T10:00:00.000Z'),
      requestId: 'req-stream',
    }),
    download: jest.fn().mockResolvedValue({
      readableStreamBody: require('stream').Readable.from([Buffer.from('hello')]),
      contentLength: 5,
      contentType: 'text/plain',
      contentEncoding: 'utf-8',
      contentLanguage: 'en',
      contentDisposition: 'inline',
      cacheControl: 'no-cache',
      etag: '"downloaded-etag"',
      lastModified: new Date('2026-02-02T10:00:00.000Z'),
      metadata: { owner: 'reactor' },
      contentRange: 'bytes 0-4/5',
    }),
    getProperties: jest.fn().mockResolvedValue({
      blobType: 'BlockBlob',
      contentLength: 5,
      contentType: 'text/plain',
      contentEncoding: 'utf-8',
      contentLanguage: 'en',
      contentDisposition: 'inline',
      cacheControl: 'no-cache',
      contentMD5: Buffer.from('abc'),
      etag: '"props-etag"',
      lastModified: new Date('2026-02-03T10:00:00.000Z'),
      createdOn: new Date('2026-01-03T10:00:00.000Z'),
      accessTier: 'Hot',
      accessTierChangedOn: new Date('2026-01-04T10:00:00.000Z'),
      leaseStatus: 'unlocked',
      leaseState: 'available',
      isServerEncrypted: true,
      copyId: 'copy-1',
      copyStatus: 'success',
      copySource: 'https://elsewhere/report.pdf',
      metadata: { owner: 'reactor' },
    }),
    delete: jest.fn().mockResolvedValue(undefined),
    setMetadata: jest.fn().mockResolvedValue({
      etag: '"metadata-etag"',
      lastModified: new Date('2026-02-04T10:00:00.000Z'),
      requestId: 'req-metadata',
    }),
  });

  const createContainerClient = (containerName: string): any => {
    const blobs = new Map<string, any>();

    const container: any = {
      containerName,
      blobs,
      create: jest.fn().mockResolvedValue({
        etag: '"container-created"',
        lastModified: new Date('2026-01-01T00:00:00.000Z'),
      }),
      delete: jest.fn().mockResolvedValue(undefined),
      getProperties: jest.fn().mockResolvedValue({
        etag: '"container-etag"',
        lastModified: new Date('2026-01-02T00:00:00.000Z'),
        metadata: { owner: 'reactor' },
        leaseStatus: 'unlocked',
        leaseState: 'available',
        blobPublicAccess: 'blob',
        hasImmutabilityPolicy: false,
        hasLegalHold: false,
      }),
      listBlobsFlat: jest.fn((_listOptions?: any) => ({
        byPage: jest.fn((pageOptions?: any) => {
          const page = state.blobPages(pageOptions && pageOptions.continuationToken);
          const pages = page ? [page] : [];
          let index = 0;

          return {
            next: jest.fn(async () => (
              index < pages.length
                ? { done: false, value: pages[index++] }
                : { done: true, value: undefined }
            )),
          };
        }),
      })),
      getBlobClient: jest.fn((blobName: string) => {
        if (!blobs.has(blobName)) blobs.set(blobName, createBlobClient(containerName, blobName));
        return blobs.get(blobName);
      }),
    };

    container.getBlockBlobClient = jest.fn((blobName: string) => container.getBlobClient(blobName));
    return container;
  };

  const BlobServiceClient: any = jest.fn();
  BlobServiceClient.mockImplementation((urlOrConnectionString: string, credential?: any, options?: any) => {
    let containerPageIndex = 0;

    const client: any = {
      url: String(urlOrConnectionString),
      credential,
      options,
      getUserDelegationKey: jest.fn(async () => {
        if (state.userDelegationError) throw state.userDelegationError;
        return state.userDelegationKey;
      }),
      getContainerClient: jest.fn((containerName: string) => {
        if (!state.containers.has(containerName)) {
          state.containers.set(containerName, createContainerClient(containerName));
        }
        return state.containers.get(containerName);
      }),
      listContainers: jest.fn((_listOptions?: any) => ({
        byPage: jest.fn(() => ({
          next: jest.fn(async () => {
            const pages = state.containerPages;
            return containerPageIndex < pages.length
              ? { done: false, value: pages[containerPageIndex++] }
              : { done: true, value: undefined };
          }),
        })),
      })),
    };

    state.clients.push({ url: String(urlOrConnectionString), credential, options, client });
    return client;
  });

  BlobServiceClient.fromConnectionString = jest.fn((connectionString: string) => BlobServiceClient(connectionString));

  return {
    __esModule: true,
    ...actual,
    BlobServiceClient,
    __state: state,
    __createContainerClient: createContainerClient,
  };
});

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

// eslint-disable-next-line import/first
import ApiError from '@reactory/server-core/exceptions';
// eslint-disable-next-line import/first
import {
  AzureBlobStorageService,
  AzureBlobStorageServiceDefinition,
  BLOB_ERROR_CODE,
  accountNameFromUrl,
  parseStorageConnectionString,
  resolveAccountKeySigner,
  resolveBlobServiceClient,
  toBlobApiError,
} from '../services/AzureBlobStorageService';
// eslint-disable-next-line import/first
import {
  DEFAULT_SAS_EXPIRY_MINUTES,
  MAX_LIST_PAGES,
  MAX_SAS_EXPIRY_MINUTES,
} from '../types/storage.types';

const sdk: any = jest.requireMock('@azure/storage-blob');
const sdkState: any = sdk.__state;
const identity: any = jest.requireMock('@azure/identity');

const MODULE_ROOT = path.resolve(__dirname, '..');
const ACCOUNT = 'reactoryblobs';
const ACCOUNT_URL = `https://${ACCOUNT}.blob.core.windows.net`;
/** A syntactically valid account key (base64); never used against a real account. */
const ACCOUNT_KEY = Buffer.alloc(64, 7).toString('base64');
/** A syntactically valid user delegation key value. */
const DELEGATION_KEY_VALUE = Buffer.alloc(32, 3).toString('base64');

const ENV_KEYS = [
  'AZURE_STORAGE_CONNECTION_STRING',
  'AZURE_STORAGE_ACCOUNT',
  'AZURE_STORAGE_ACCOUNT_URL',
  'AZURE_STORAGE_KEY',
];

function clearStorageEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

/** A Node readable stream with the given chunks - no WHATWG conversion involved. */
function readableOf(...chunks: string[]): Readable {
  const payload = chunks.map((chunk) => Buffer.from(chunk));

  return new Readable({
    read(this: Readable) {
      for (const chunk of payload) this.push(chunk);
      this.push(null);
    },
  });
}

/** Point the service at a fake account; also the only credential input there is. */
function configure(env: Record<string, string | undefined>): void {
  clearStorageEnv();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

function createService(): AzureBlobStorageService {
  return new AzureBlobStorageService(
    {} as any,
    { getService: (): any => undefined, error: jest.fn() } as any,
  );
}

function blobItem(name: string, extra: Record<string, any> = {}): any {
  return {
    name,
    properties: {
      contentLength: 12,
      contentType: 'text/plain',
      etag: `"etag-${name}"`,
      lastModified: new Date('2026-03-01T00:00:00.000Z'),
      createdOn: new Date('2026-02-01T00:00:00.000Z'),
      blobType: 'BlockBlob',
      accessTier: 'Hot',
      serverEncrypted: true,
      ...extra,
    },
    metadata: { owner: 'reactor' },
  };
}

function statusError(statusCode: number, code: string, message: string): any {
  return { statusCode, code, message, name: 'RestError' };
}

/** The query parameters of a generated SAS URL. */
function readSas(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearStorageEnv();
  configure({ AZURE_STORAGE_ACCOUNT: ACCOUNT, AZURE_STORAGE_KEY: ACCOUNT_KEY });

  sdkState.clients.length = 0;
  sdkState.containers.clear();
  sdkState.blobPages = () => ({ segment: { blobItems: [] as any[] } });
  sdkState.containerPages = [];
  sdkState.userDelegationKey = undefined;
  sdkState.userDelegationError = undefined;
  sdkState.accountName = ACCOUNT;
});

afterAll(() => {
  clearStorageEnv();
});

describe('credential resolution', () => {
  it('builds BlobServiceClient with DefaultAzureCredential when no account key is configured', () => {
    const resolved = resolveBlobServiceClient({ AZURE_STORAGE_ACCOUNT: ACCOUNT });

    expect(resolved.mode).toBe('default-credential');
    expect(resolved.accountName).toBe(ACCOUNT);
    expect(resolved.accountUrl).toBe(ACCOUNT_URL);
    expect(resolved.sharedKeyCredential).toBeUndefined();

    expect(identity.DefaultAzureCredential).toHaveBeenCalledTimes(1);
    const credential = identity.DefaultAzureCredential.mock.instances[0];
    expect(sdkState.clients).toHaveLength(1);
    expect(sdkState.clients[0].credential).toBe(credential);
    expect(sdk.BlobServiceClient).toHaveBeenCalledWith(ACCOUNT_URL, credential);
    expect(resolved.client).toBe(sdkState.clients[0].client);
  });

  it('builds BlobServiceClient with a shared-key credential when an account key is configured', () => {
    const resolved = resolveBlobServiceClient({
      AZURE_STORAGE_ACCOUNT: ACCOUNT,
      AZURE_STORAGE_KEY: ACCOUNT_KEY,
    });

    expect(resolved.mode).toBe('shared-key');
    expect(identity.DefaultAzureCredential).not.toHaveBeenCalled();

    const credential = sdkState.clients[0].credential;
    expect(credential).toBeInstanceOf(sdk.StorageSharedKeyCredential);
    expect(credential.accountName).toBe(ACCOUNT);
    expect(sdk.BlobServiceClient).toHaveBeenCalledWith(ACCOUNT_URL, credential);
  });

  it('uses the connection string when one is configured, and still keeps an account-key signer', () => {
    const connectionString = `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT};AccountKey=${ACCOUNT_KEY};EndpointSuffix=core.windows.net`;

    const resolved = resolveBlobServiceClient({ AZURE_STORAGE_CONNECTION_STRING: connectionString });

    expect(resolved.mode).toBe('connection-string');
    expect(resolved.accountName).toBe(ACCOUNT);
    expect(sdk.BlobServiceClient.fromConnectionString).toHaveBeenCalledWith(connectionString);
    expect(resolved.sharedKeyCredential).toBeInstanceOf(sdk.StorageSharedKeyCredential);
  });

  it('derives the account name from the account URL when only the URL is set', () => {
    const resolved = resolveBlobServiceClient({ AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL });

    expect(resolved.accountName).toBe(ACCOUNT);
    expect(resolved.mode).toBe('default-credential');
    expect(sdk.BlobServiceClient).toHaveBeenCalledWith(ACCOUNT_URL, expect.anything());
  });

  it('throws AzureStorageConfigurationMissing when nothing is configured', () => {
    let caught: any;
    try {
      resolveBlobServiceClient({});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe(BLOB_ERROR_CODE.MISSING_CONFIGURATION);
    expect(sdk.BlobServiceClient).not.toHaveBeenCalled();
  });

  it('throws when a key is set but the account name cannot be determined', () => {
    expect(() => resolveBlobServiceClient({ AZURE_STORAGE_KEY: ACCOUNT_KEY }))
      .toThrow(/AZURE_STORAGE_ACCOUNT/);
  });

  it('parses only the parts of a connection string that SAS signing needs', () => {
    expect(parseStorageConnectionString(
      `BlobEndpoint=https://${ACCOUNT}.blob.core.windows.net/;AccountName=${ACCOUNT};AccountKey=${ACCOUNT_KEY}`,
    )).toEqual({
      accountName: ACCOUNT,
      accountKey: ACCOUNT_KEY,
      blobEndpoint: `https://${ACCOUNT}.blob.core.windows.net/`,
    });

    expect(parseStorageConnectionString('SharedAccessSignature=sv%3D2024')).toEqual({});
  });

  it('reads the account name out of a blob endpoint and ignores non-blob hosts', () => {
    expect(accountNameFromUrl(ACCOUNT_URL)).toBe(ACCOUNT);
    expect(accountNameFromUrl('https://example.com/storage')).toBeUndefined();
    expect(accountNameFromUrl(undefined)).toBeUndefined();
  });

  it('builds an account-key signer from the environment only as a fallback', () => {
    const resolved = resolveBlobServiceClient({ AZURE_STORAGE_ACCOUNT: ACCOUNT });
    expect(resolveAccountKeySigner(resolved, {})).toBeUndefined();

    const signer = resolveAccountKeySigner(resolved, { AZURE_STORAGE_KEY: ACCOUNT_KEY });
    expect(signer).toBeInstanceOf(sdk.StorageSharedKeyCredential);
    expect(signer!.accountName).toBe(ACCOUNT);
  });
});

describe('containers', () => {
  it('lists containers across pages and maps metadata and properties', async () => {
    sdkState.containerPages = [
      {
        containerItems: [
          {
            name: 'docs',
            properties: {
              etag: '"docs-etag"',
              lastModified: new Date('2026-01-01T00:00:00.000Z'),
              leaseStatus: 'unlocked',
              leaseState: 'available',
              publicAccess: 'blob',
            },
            metadata: { owner: 'reactor' },
          },
        ],
        continuationToken: 'page-2',
      },
      {
        containerItems: [{ name: 'images', properties: { etag: '"images-etag"', lastModified: new Date('2026-01-02T00:00:00.000Z') } }],
      },
    ];

    const containers = await createService().listContainers({ prefix: 'd' });

    expect(containers.map((container) => container.name)).toEqual(['docs', 'images']);
    expect(containers[0]).toMatchObject({
      name: 'docs',
      metadata: { owner: 'reactor' },
      etag: '"docs-etag"',
      leaseStatus: 'unlocked',
      publicAccess: 'blob',
    });
    expect(sdkState.clients[0].client.listContainers).toHaveBeenCalledWith({
      prefix: 'd',
      abortSignal: undefined,
    });
  });

  it('creates a container with metadata and public access', async () => {
    const signal = new AbortController().signal;

    const created = await createService().createContainer('docs', {
      metadata: { owner: 'reactor' },
      publicAccess: 'blob',
      signal,
    });

    const container = sdkState.containers.get('docs');
    expect(container.create).toHaveBeenCalledWith({
      metadata: { owner: 'reactor' },
      access: 'blob',
      abortSignal: signal,
    });
    expect(created).toMatchObject({ name: 'docs', etag: '"container-created"' });
  });

  it('deletes a container', async () => {
    await createService().deleteContainer('docs');
    expect(sdkState.containers.get('docs').delete).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 404 on container delete as an ApiError', async () => {
    const container = sdk.__createContainerClient('docs');
    sdkState.containers.set('docs', container);
    container.delete.mockRejectedValueOnce(statusError(404, 'ContainerNotFound', 'The specified container does not exist.'));

    const error = await createService().deleteContainer('docs').catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('ContainerNotFound');
    expect(error.meta.status).toBe(404);
  });

  it('reads container properties', async () => {
    const properties = await createService().getContainerProperties('docs');

    expect(properties).toMatchObject({
      name: 'docs',
      metadata: { owner: 'reactor' },
      etag: '"container-etag"',
      publicAccess: 'blob',
      hasImmutabilityPolicy: false,
    });
  });

  it('rejects an empty container name without calling the SDK', async () => {
    const error = await createService().getContainerProperties('  ').catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(BLOB_ERROR_CODE.INVALID_CONTAINER_NAME);
    expect(sdkState.clients).toHaveLength(0);
  });
});

describe('listBlobs paging', () => {
  it('returns one page and the continuationToken the SDK reported', async () => {
    sdkState.blobPages = (token?: string) => (
      token === undefined
        ? { segment: { blobItems: [blobItem('logs/a.txt'), blobItem('logs/b.txt')] }, continuationToken: 'page-2' }
        : { segment: { blobItems: [blobItem('logs/c.txt')] } }
    );

    const page = await createService().listBlobs('docs', {
      prefix: 'logs/',
      maxPageSize: 2,
      includeMetadata: true,
    });

    expect(page.blobs.map((blob) => blob.name)).toEqual(['logs/a.txt', 'logs/b.txt']);
    expect(page.continuationToken).toBe('page-2');
    expect(page.blobs[0]).toMatchObject({
      containerName: 'docs',
      blobType: 'BlockBlob',
      contentLength: 12,
      contentType: 'text/plain',
      metadata: { owner: 'reactor' },
    });

    const container = sdkState.containers.get('docs');
    expect(container.listBlobsFlat).toHaveBeenCalledWith({
      prefix: 'logs/',
      includeMetadata: true,
      includeSnapshots: undefined,
      includeVersions: undefined,
      abortSignal: undefined,
    });
    expect(container.listBlobsFlat.mock.results[0].value.byPage)
      .toHaveBeenCalledWith({ maxPageSize: 2, continuationToken: undefined });
  });

  it('listAllBlobs follows continuationToken across three pages', async () => {
    const first = { segment: { blobItems: [blobItem('logs/1.txt'), blobItem('logs/2.txt')] }, continuationToken: 'page-2' };
    const second = { segment: { blobItems: [blobItem('logs/3.txt'), blobItem('logs/4.txt')] }, continuationToken: 'page-3' };
    const third = { segment: { blobItems: [blobItem('logs/5.txt'), blobItem('logs/6.txt')] } };

    const resolver = jest.fn((token?: string) => {
      if (token === undefined) return first;
      if (token === 'page-2') return second;
      return third;
    });
    sdkState.blobPages = resolver;

    const blobs = await createService().listAllBlobs('docs', 'logs/', { maxPageSize: 2 });

    expect(blobs.map((blob) => blob.name)).toEqual([
      'logs/1.txt',
      'logs/2.txt',
      'logs/3.txt',
      'logs/4.txt',
      'logs/5.txt',
      'logs/6.txt',
    ]);
    expect(resolver.mock.calls.map((call) => call[0])).toEqual([undefined, 'page-2', 'page-3']);

    // The marker coming back from one page is the marker sent to the next.
    const container = sdkState.containers.get('docs');
    const pageTokens = container.listBlobsFlat.mock.results.map(
      (result: any) => result.value.byPage.mock.calls[0][0].continuationToken,
    );
    expect(pageTokens).toEqual([undefined, 'page-2', 'page-3']);
  });

  it('listBlobs follows continuationToken across three pages when the caller drives the loop', async () => {
    const first = { segment: { blobItems: [blobItem('logs/1.txt'), blobItem('logs/2.txt')] }, continuationToken: 'page-2' };
    const second = { segment: { blobItems: [blobItem('logs/3.txt'), blobItem('logs/4.txt')] }, continuationToken: 'page-3' };
    const third = { segment: { blobItems: [blobItem('logs/5.txt'), blobItem('logs/6.txt')] } };

    const resolver = jest.fn((token?: string) => {
      if (token === undefined) return first;
      if (token === 'page-2') return second;
      return third;
    });
    sdkState.blobPages = resolver;

    // A caller-driven loop over the single-page primitive: exactly what the
    // acceptance criterion asks for, with no wrapper in between.
    const service = createService();
    const seen: string[] = [];
    const tokens: Array<string | undefined> = [];
    let continuationToken: string | undefined;
    let pages = 0;

    do {
      const page = await service.listBlobs('docs', { prefix: 'logs/', maxPageSize: 2, continuationToken });

      seen.push(...page.blobs.map((blob) => blob.name));
      tokens.push(page.continuationToken);
      continuationToken = page.continuationToken;
      pages += 1;
    } while (continuationToken);

    expect(pages).toBe(3);
    expect(seen).toEqual([
      'logs/1.txt',
      'logs/2.txt',
      'logs/3.txt',
      'logs/4.txt',
      'logs/5.txt',
      'logs/6.txt',
    ]);
    expect(tokens).toEqual(['page-2', 'page-3', undefined]);
    expect(resolver.mock.calls.map((call) => call[0])).toEqual([undefined, 'page-2', 'page-3']);
  });

  it('resumes from a caller-supplied continuationToken', async () => {
    const resolver = jest.fn(() => ({ segment: { blobItems: [blobItem('logs/3.txt')] } }));
    sdkState.blobPages = resolver;

    const blobs = await createService().listAllBlobs('docs', 'logs/', { continuationToken: 'page-3' });

    expect(blobs.map((blob) => blob.name)).toEqual(['logs/3.txt']);
    expect(resolver).toHaveBeenCalledWith('page-3');
  });

  it('throws BlobPaginationLimitExceeded instead of truncating an endless listing', async () => {
    sdkState.blobPages = () => ({ segment: { blobItems: [blobItem('logs/loop.txt')] }, continuationToken: 'again' });

    const error = await createService().listAllBlobs('docs', 'logs/').catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(BLOB_ERROR_CODE.PAGINATION_LIMIT_EXCEEDED);
    expect(sdkState.containers.get('docs').listBlobsFlat).toHaveBeenCalledTimes(MAX_LIST_PAGES);
  });

  it('maps a 404 while listing to ApiError', async () => {
    const container = sdk.__createContainerClient('docs');
    sdkState.containers.set('docs', container);
    container.listBlobsFlat.mockImplementationOnce(() => {
      throw statusError(404, 'ContainerNotFound', 'The specified container does not exist.');
    });

    const error = await createService().listBlobs('docs').catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('ContainerNotFound');
  });
});

describe('uploadBlob', () => {
  it('uses uploadData for an in-memory buffer', async () => {
    const signal = new AbortController().signal;

    const result = await createService().uploadBlob('docs', 'report.pdf', Buffer.from('pdf-bytes'), {
      contentType: 'application/pdf',
      cacheControl: 'max-age=60',
      metadata: { kind: 'report' },
      tier: 'Cool',
      signal,
    });

    const blobClient = sdkState.containers.get('docs').blobs.get('report.pdf');
    expect(blobClient.uploadData).toHaveBeenCalledTimes(1);
    expect(blobClient.uploadStream).not.toHaveBeenCalled();

    const [payload, options] = blobClient.uploadData.mock.calls[0];
    expect(Buffer.isBuffer(payload)).toBe(true);
    expect(payload.toString('utf8')).toBe('pdf-bytes');
    expect(options.blobHTTPHeaders).toEqual({
      blobContentType: 'application/pdf',
      blobCacheControl: 'max-age=60',
    });
    expect(options.metadata).toEqual({ kind: 'report' });
    expect(options.tier).toBe('Cool');
    expect(options.abortSignal).toBe(signal);
    expect(result).toMatchObject({
      containerName: 'docs',
      blobName: 'report.pdf',
      etag: '"uploaded-etag"',
      contentLength: 9,
    });
  });

  it('uses uploadStream with the documented defaults for a stream', async () => {
    const stream = readableOf('chunk-1', 'chunk-2');

    await createService().uploadBlob('docs', 'log.txt', stream);

    const blobClient = sdkState.containers.get('docs').blobs.get('log.txt');
    expect(blobClient.uploadData).not.toHaveBeenCalled();
    expect(blobClient.uploadStream).toHaveBeenCalledTimes(1);

    const [passedStream, bufferSize, maxConcurrency] = blobClient.uploadStream.mock.calls[0];
    expect(passedStream).toBe(stream);
    expect(bufferSize).toBe(8 * 1024 * 1024);
    expect(maxConcurrency).toBe(5);
  });

  it('honours caller-supplied stream buffering and concurrency', async () => {
    const stream = readableOf('chunk');

    await createService().uploadBlob('docs', 'log.txt', stream, {
      bufferSize: 1024,
      maxConcurrency: 3,
      contentType: 'text/plain',
    });

    const [, bufferSize, maxConcurrency, options] = sdkState.containers
      .get('docs').blobs.get('log.txt').uploadStream.mock.calls[0];
    expect(bufferSize).toBe(1024);
    expect(maxConcurrency).toBe(3);
    expect(options.blobHTTPHeaders).toEqual({ blobContentType: 'text/plain' });
  });

  it('accepts a string payload', async () => {
    await createService().uploadBlob('docs', 'note.txt', 'hello');

    const [payload] = sdkState.containers.get('docs').blobs.get('note.txt').uploadData.mock.calls[0];
    expect(payload.toString('utf8')).toBe('hello');
  });

  it('rejects an empty blob name before touching the SDK', async () => {
    const error = await createService().uploadBlob('docs', '', Buffer.from('x')).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(BLOB_ERROR_CODE.INVALID_BLOB_NAME);
    expect(sdkState.clients).toHaveLength(0);
  });
});

describe('download, properties, delete and metadata', () => {
  it('returns a readable stream and the describing headers', async () => {
    const download = await createService().downloadBlob('docs', 'report.pdf', { offset: 0, count: 5 });

    expect(typeof (download.stream as any).pipe).toBe('function');
    expect(download).toMatchObject({
      contentLength: 5,
      contentType: 'text/plain',
      etag: '"downloaded-etag"',
      contentRange: 'bytes 0-4/5',
      metadata: { owner: 'reactor' },
    });

    const blobClient = sdkState.containers.get('docs').blobs.get('report.pdf');
    expect(blobClient.download).toHaveBeenCalledWith(0, 5, { abortSignal: undefined, conditions: undefined });
  });

  it('throws BlobRequestFailed when the SDK returns no readable body', async () => {
    const container = sdk.__createContainerClient('docs');
    sdkState.containers.set('docs', container);
    container.getBlobClient('empty.bin').download.mockResolvedValueOnce({ contentLength: 0 });

    const error = await createService().downloadBlob('docs', 'empty.bin').catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(BLOB_ERROR_CODE.REQUEST_FAILED);
  });

  it('maps blob properties, including a base64 MD5', async () => {
    const properties = await createService().getBlobProperties('docs', 'report.pdf');

    expect(properties).toMatchObject({
      containerName: 'docs',
      name: 'report.pdf',
      blobType: 'BlockBlob',
      contentLength: 5,
      contentType: 'text/plain',
      etag: '"props-etag"',
      accessTier: 'Hot',
      serverEncrypted: true,
      copyStatus: 'success',
      metadata: { owner: 'reactor' },
    });
    expect(properties.contentMD5).toBe(Buffer.from('abc').toString('base64'));
  });

  it('turns a 404 from getBlobProperties into an ApiError', async () => {
    const container = sdk.__createContainerClient('docs');
    sdkState.containers.set('docs', container);
    const blobClient = container.getBlobClient('missing.txt');
    blobClient.getProperties.mockRejectedValueOnce(
      statusError(404, 'BlobNotFound', 'The specified blob does not exist.'),
    );

    const error = await createService().getBlobProperties('docs', 'missing.txt').catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('BlobNotFound');
    expect(error.meta.status).toBe(404);
    expect(error.meta.operation).toBe('getBlobProperties');
    expect(error.message).toMatch(/does not exist/);
  });

  it('deletes a blob with snapshot and condition options', async () => {
    const ifMatch = '"props-etag"';

    await createService().deleteBlob('docs', 'report.pdf', { deleteSnapshots: 'include', conditions: { ifMatch } });

    const blobClient = sdkState.containers.get('docs').blobs.get('report.pdf');
    expect(blobClient.delete).toHaveBeenCalledWith({
      abortSignal: undefined,
      deleteSnapshots: 'include',
      conditions: { ifMatch },
    });
  });

  it('replaces blob metadata and returns the new etag', async () => {
    const result = await createService().setBlobMetadata('docs', 'report.pdf', { owner: 'reactor', stage: 'final' });

    expect(sdkState.containers.get('docs').blobs.get('report.pdf').setMetadata)
      .toHaveBeenCalledWith({ owner: 'reactor', stage: 'final' }, { abortSignal: undefined });
    expect(result).toMatchObject({
      containerName: 'docs',
      blobName: 'report.pdf',
      metadata: { owner: 'reactor', stage: 'final' },
      etag: '"metadata-etag"',
    });
  });

  it('rejects a non-object metadata dictionary', async () => {
    const error = await createService()
      .setBlobMetadata('docs', 'report.pdf', 'nope' as any)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(BLOB_ERROR_CODE.INVALID_METADATA);
  });

  it('passes the caller signal straight through to the SDK', async () => {
    const controller = new AbortController();

    await createService().deleteBlob('docs', 'report.pdf', { signal: controller.signal });

    expect(sdkState.containers.get('docs').blobs.get('report.pdf').delete.mock.calls[0][0].abortSignal)
      .toBe(controller.signal);
  });
});

describe('generateSasUrl', () => {
  it('signs with the account key and produces sig, se, sp and sv', async () => {
    const url = await createService().generateSasUrl('docs', 'report.pdf', { read: true }, 10);

    const parsed = new URL(url);
    expect(parsed.origin).toBe(ACCOUNT_URL);
    expect(parsed.pathname).toBe('/docs/report.pdf');

    const params = readSas(url);
    expect(params.get('sig')).toBeTruthy();
    expect(params.get('se')).toBeTruthy();
    expect(params.get('sp')).toBe('r');
    expect(params.get('sv')).toBeTruthy();

    const expiresInMs = Date.parse(params.get('se') as string) - Date.now();
    expect(expiresInMs).toBeGreaterThan(9 * 60 * 1000);
    expect(expiresInMs).toBeLessThan(11 * 60 * 1000);

    // A shared-key client cannot ask for a delegation key, so it must not try.
    expect(sdkState.clients[0].client.getUserDelegationKey).not.toHaveBeenCalled();
    // The signature is not a plain rename: it is the HMAC of the permission string.
    expect(params.get('sp')).not.toBe(params.get('sig'));
  });

  it('defaults to the shortest practical expiry (five minutes)', async () => {
    const params = readSas(await createService().generateSasUrl('docs', 'report.pdf', 'r'));

    const expiresInMs = Date.parse(params.get('se') as string) - Date.now();
    expect(expiresInMs).toBeGreaterThan((DEFAULT_SAS_EXPIRY_MINUTES - 1) * 60 * 1000);
    expect(expiresInMs).toBeLessThan((DEFAULT_SAS_EXPIRY_MINUTES + 1) * 60 * 1000);
  });

  it('prefers a user delegation key when the client authenticates with a token credential', async () => {
    configure({ AZURE_STORAGE_ACCOUNT: ACCOUNT });
    sdkState.userDelegationKey = {
      signedObjectId: '11111111-1111-1111-1111-111111111111',
      signedTenantId: '22222222-2222-2222-2222-222222222222',
      signedStartsOn: new Date(Date.now() - 60 * 1000),
      signedExpiresOn: new Date(Date.now() + 15 * 60 * 1000),
      signedService: 'b',
      signedVersion: '2024-11-04',
      value: DELEGATION_KEY_VALUE,
    };

    const url = await createService().generateSasUrl('docs', 'report.pdf', { read: true, write: true }, 15);
    const params = readSas(url);

    expect(sdkState.clients[0].client.getUserDelegationKey).toHaveBeenCalledTimes(1);
    expect(params.get('sig')).toBeTruthy();
    expect(params.get('se')).toBeTruthy();
    expect(params.get('sv')).toBeTruthy();
    expect(params.get('sp')).toContain('r');
    expect(params.get('sp')).toContain('w');
    // Delegation SAS markers: object id and tenant id of the signing identity.
    expect(params.get('skoid')).toBe('11111111-1111-1111-1111-111111111111');
    expect(params.get('sktid')).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('falls back to the account key when the delegation call fails', async () => {
    configure({ AZURE_STORAGE_ACCOUNT: ACCOUNT });
    const service = createService();

    // Force the client to be built with DefaultAzureCredential: no key yet.
    await service.listContainers();
    expect(identity.DefaultAzureCredential).toHaveBeenCalledTimes(1);

    // A key becomes available, and delegation is refused.
    process.env.AZURE_STORAGE_KEY = ACCOUNT_KEY;
    sdkState.userDelegationError = statusError(403, 'AuthorizationFailure', 'User delegation is not permitted.');

    const params = readSas(await service.generateSasUrl('docs', 'report.pdf', { read: true }, 5));

    expect(sdkState.clients[0].client.getUserDelegationKey).toHaveBeenCalledTimes(1);
    expect(params.get('sig')).toBeTruthy();
    // The fallback signed with the account key, so there is no delegation identity.
    expect(params.get('skoid')).toBeNull();
    expect(params.get('sktid')).toBeNull();
  });

  it('throws BlobSasGenerationFailed when delegation fails and no key exists', async () => {
    configure({ AZURE_STORAGE_ACCOUNT: ACCOUNT });
    sdkState.userDelegationError = statusError(403, 'AuthorizationFailure', 'User delegation is not permitted.');

    const error = await createService()
      .generateSasUrl('docs', 'report.pdf', { read: true })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(BLOB_ERROR_CODE.SAS_GENERATION_FAILED);
  });

  it('refuses an expiry outside the allowed window', async () => {
    expect((await createService().generateSasUrl('docs', 'report.pdf', 'r', 0).catch((caught) => caught)).code)
      .toBe(BLOB_ERROR_CODE.INVALID_SAS_EXPIRY);

    expect((await createService()
      .generateSasUrl('docs', 'report.pdf', 'r', MAX_SAS_EXPIRY_MINUTES + 1)
      .catch((caught) => caught)).code).toBe(BLOB_ERROR_CODE.INVALID_SAS_EXPIRY);

    expect((await createService().generateSasUrl('docs', 'report.pdf', 'r', Number.NaN).catch((caught) => caught)).code)
      .toBe(BLOB_ERROR_CODE.INVALID_SAS_EXPIRY);

    expect(sdkState.clients).toHaveLength(0);
  });

  it('refuses an empty or invalid permission set', async () => {
    expect((await createService().generateSasUrl('docs', 'report.pdf', {}).catch((caught) => caught)).code)
      .toBe(BLOB_ERROR_CODE.INVALID_SAS_PERMISSIONS);

    expect((await createService().generateSasUrl('docs', 'report.pdf', 'zzz').catch((caught) => caught)).code)
      .toBe(BLOB_ERROR_CODE.INVALID_SAS_PERMISSIONS);
  });

  it('never returns an unsigned URL', async () => {
    const params = readSas(await createService().generateSasUrl('docs', 'report.pdf', { read: true }));
    expect(params.get('sig')).toHaveLength(44);
  });
});

describe('cancellation reaches the list calls', () => {
  /**
   * A listing can issue up to MAX_LIST_PAGES segment requests, so it is the operation
   * that most needs cancellation. These tests assert the caller's exact signal object
   * arrives on the SDK's list options (`abortSignal`), not merely that an option was
   * passed.
   */
  it('forwards the caller signal to client.listContainers', async () => {
    const controller = new AbortController();

    await createService().listContainers({ prefix: 'd', signal: controller.signal });

    expect(sdkState.clients[0].client.listContainers).toHaveBeenCalledTimes(1);
    const listOptions = sdkState.clients[0].client.listContainers.mock.calls[0][0];
    expect(listOptions.abortSignal).toBe(controller.signal);
    expect(listOptions.prefix).toBe('d');
  });

  it('forwards the caller signal to containerClient.listBlobsFlat', async () => {
    const controller = new AbortController();
    sdkState.blobPages = () => ({ segment: { blobItems: [blobItem('logs/a.txt')] } });

    await createService().listBlobs('docs', { prefix: 'logs/', signal: controller.signal });

    const listOptions = sdkState.containers.get('docs').listBlobsFlat.mock.calls[0][0];
    expect(listOptions.abortSignal).toBe(controller.signal);
    expect(listOptions.prefix).toBe('logs/');
  });

  it('forwards the caller signal to every page of a full listing', async () => {
    const controller = new AbortController();
    const first = { segment: { blobItems: [blobItem('logs/1.txt')] }, continuationToken: 'page-2' };
    const second = { segment: { blobItems: [blobItem('logs/2.txt')] }, continuationToken: 'page-3' };
    const third = { segment: { blobItems: [blobItem('logs/3.txt')] } };

    sdkState.blobPages = (token?: string) => {
      if (token === undefined) return first;
      if (token === 'page-2') return second;
      return third;
    };

    await createService().listAllBlobs('docs', 'logs/', { signal: controller.signal });

    const calls = sdkState.containers.get('docs').listBlobsFlat.mock.calls;
    expect(calls).toHaveLength(3);
    for (const [listOptions] of calls) {
      expect(listOptions.abortSignal).toBe(controller.signal);
    }
  });

  it('leaves abortSignal undefined when the caller supplied no signal', async () => {
    sdkState.blobPages = () => ({ segment: { blobItems: [] as any[] } });

    await createService().listBlobs('docs', 'logs/');

    expect(sdkState.containers.get('docs').listBlobsFlat.mock.calls[0][0].abortSignal).toBeUndefined();
  });
});

describe('blob names are exact keys', () => {
  const PADDED = ' padded.txt ';

  it('uploads to the exact name, spaces included', async () => {
    const result = await createService().uploadBlob('docs', PADDED, Buffer.from('pdf'));

    const container = sdkState.containers.get('docs');
    expect(container.getBlockBlobClient).toHaveBeenCalledWith(PADDED);
    expect(container.blobs.has(PADDED)).toBe(true);
    // The trimmed spelling must not be what the SDK was asked for.
    expect(container.blobs.has('padded.txt')).toBe(false);
    expect(result.blobName).toBe(PADDED);
    expect(result.containerName).toBe('docs');
  });

  it('reads properties of the exact name, spaces included', async () => {
    const properties = await createService().getBlobProperties('docs', PADDED);

    const container = sdkState.containers.get('docs');
    expect(container.getBlobClient).toHaveBeenCalledWith(PADDED);
    expect(properties.name).toBe(PADDED);
  });

  it('deletes the exact name, spaces included', async () => {
    await createService().deleteBlob('docs', PADDED);

    const container = sdkState.containers.get('docs');
    expect(container.getBlobClient).toHaveBeenCalledWith(PADDED);
    expect(container.blobs.has(PADDED)).toBe(true);
    expect(container.blobs.get(PADDED).delete).toHaveBeenCalledTimes(1);
  });

  it('downloads and re-metadata the exact name, spaces included', async () => {
    await createService().downloadBlob('docs', PADDED);
    await createService().setBlobMetadata('docs', PADDED, { owner: 'reactor' });

    const container = sdkState.containers.get('docs');
    const addressed = container.getBlobClient.mock.calls.map((call: any[]) => call[0]);
    expect(addressed).toEqual([PADDED, PADDED]);
  });

  it('still rejects a whitespace-only name without touching the SDK', async () => {
    const error = await createService().uploadBlob('docs', '   ', Buffer.from('x')).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(BLOB_ERROR_CODE.INVALID_BLOB_NAME);
    expect(sdkState.containers.has('docs')).toBe(false);
  });

  it('rejects a non-string name', async () => {
    const error = await createService().deleteBlob('docs', 42 as any).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(BLOB_ERROR_CODE.INVALID_BLOB_NAME);
  });
});

describe('listBlobs second argument', () => {
  it('treats a string second argument as the prefix', async () => {
    sdkState.blobPages = () => ({ segment: { blobItems: [blobItem('logs/a.txt'), blobItem('other.txt')] } });

    const page = await createService().listBlobs('docs', 'logs/');

    const listOptions = sdkState.containers.get('docs').listBlobsFlat.mock.calls[0][0];
    expect(listOptions.prefix).toBe('logs/');
    expect(listOptions.abortSignal).toBeUndefined();
    expect(page.blobs.map((blob) => blob.name)).toEqual(['logs/a.txt', 'other.txt']);
  });

  it('still accepts an options object as the second argument', async () => {
    sdkState.blobPages = () => ({ segment: { blobItems: [] as any[] } });

    await createService().listBlobs('docs', { prefix: 'logs/', maxPageSize: 7, includeMetadata: true });

    const container = sdkState.containers.get('docs');
    expect(container.listBlobsFlat.mock.calls[0][0].prefix).toBe('logs/');
    expect(container.listBlobsFlat.mock.calls[0][0].includeMetadata).toBe(true);
    expect(container.listBlobsFlat.mock.results[0].value.byPage.mock.calls[0][0].maxPageSize).toBe(7);
  });

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['logs/']],
    ['null', null],
    ['a function', () => 'logs/'],
  ])('refuses %s instead of silently listing the whole container', async (_label, bad) => {
    const error = await createService().listBlobs('docs', bad as any).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(BLOB_ERROR_CODE.INVALID_LIST_OPTIONS);
    expect(error.meta.receivedType).toBeTruthy();
    // Nothing was sent: the container client was never even created.
    expect(sdkState.containers.has('docs')).toBe(false);
  });

  it('uses a string prefix through listAllBlobs unchanged', async () => {
    sdkState.blobPages = () => ({ segment: { blobItems: [blobItem('logs/a.txt')] } });

    const blobs = await createService().listAllBlobs('docs', 'logs/');

    expect(sdkState.containers.get('docs').listBlobsFlat.mock.calls[0][0].prefix).toBe('logs/');
    expect(blobs.map((blob) => blob.name)).toEqual(['logs/a.txt']);
  });
});

describe('error translation and remaining edges', () => {
  it('maps statuses, SDK codes and cancellations onto stable ApiError codes', () => {
    const cases: Array<[any, string]> = [
      [statusError(404, 'BlobNotFound', 'x'), 'BlobNotFound'],
      [statusError(404, '', 'x'), BLOB_ERROR_CODE.NOT_FOUND],
      [{ statusCode: 409, message: 'x' }, BLOB_ERROR_CODE.ALREADY_EXISTS],
      [{ statusCode: 412, message: 'x' }, BLOB_ERROR_CODE.PRECONDITION_FAILED],
      [{ statusCode: 401, message: 'x' }, BLOB_ERROR_CODE.UNAUTHENTICATED],
      [{ statusCode: 403, message: 'x' }, BLOB_ERROR_CODE.FORBIDDEN],
      [{ statusCode: 400, message: 'x' }, BLOB_ERROR_CODE.INVALID_REQUEST],
      [{ statusCode: 416, message: 'x' }, BLOB_ERROR_CODE.INVALID_REQUEST],
      [{ statusCode: 500, message: 'x' }, BLOB_ERROR_CODE.REQUEST_FAILED],
      [{ name: 'AbortError', message: 'x' }, BLOB_ERROR_CODE.REQUEST_ABORTED],
      [{ code: 'ABORT_ERR', message: 'x' }, BLOB_ERROR_CODE.REQUEST_ABORTED],
      [{ statusCode: 409, details: { errorCode: 'ContainerAlreadyExists' } }, 'ContainerAlreadyExists'],
    ];

    for (const [input, expected] of cases) {
      const mapped = toBlobApiError(input, 'unit') as any;
      expect(mapped).toBeInstanceOf(ApiError);
      expect(mapped.code).toBe(expected);
      expect(mapped.meta.operation).toBe('unit');
    }

    // No status and no code: still a typed failure with a fallback message.
    const unclassified = toBlobApiError({}, 'unit') as any;
    expect(unclassified.code).toBe(BLOB_ERROR_CODE.REQUEST_FAILED);
    expect(unclassified.message).toMatch(/unit/);

    // An ApiError that is already typed is passed through, not re-wrapped.
    expect(toBlobApiError(unclassified, 'other')).toBe(unclassified);
  });

  it('reports the credential mode only after the client is resolved', async () => {
    const service = createService();
    expect(service.credentialMode).toBeUndefined();

    await service.listContainers();
    expect(service.credentialMode).toBe('shared-key');
  });

  it('wires the service definition to a constructible instance', () => {
    const instance = AzureBlobStorageServiceDefinition.service({} as any, { getService: (): any => undefined, error: jest.fn() } as any);

    expect(instance).toBeInstanceOf(AzureBlobStorageService);
    expect(AzureBlobStorageServiceDefinition.id).toBe('azure.AzureBlobStorageService@1.0.0');
  });

  it('uploads a Uint8Array', async () => {
    await createService().uploadBlob('docs', 'bin.dat', new Uint8Array([1, 2, 3]));

    const [payload, options] = sdkState.containers.get('docs').blobs.get('bin.dat').uploadData.mock.calls[0];
    expect(Array.from(payload as Buffer)).toEqual([1, 2, 3]);
    expect(options.blobHTTPHeaders).toBeUndefined();
  });

  it('sends every content header the caller supplied', async () => {
    await createService().uploadBlob('docs', 'report.pdf', Buffer.from('x'), {
      contentEncoding: 'gzip',
      contentLanguage: 'en-ZA',
      contentDisposition: 'attachment',
    });

    const [, options] = sdkState.containers.get('docs').blobs.get('report.pdf').uploadData.mock.calls[0];
    expect(options.blobHTTPHeaders).toEqual({
      blobContentEncoding: 'gzip',
      blobContentLanguage: 'en-ZA',
      blobContentDisposition: 'attachment',
    });
  });

  it('surfaces failures from each write path as ApiError', async () => {
    const container = sdk.__createContainerClient('docs');
    sdkState.containers.set('docs', container);

    container.create.mockRejectedValueOnce(statusError(409, 'ContainerAlreadyExists', 'exists'));
    expect((await createService().createContainer('docs').catch((caught) => caught)).code)
      .toBe('ContainerAlreadyExists');

    container.getProperties.mockRejectedValueOnce(statusError(403, 'AuthorizationFailure', 'denied'));
    expect((await createService().getContainerProperties('docs').catch((caught) => caught)).code)
      .toBe('AuthorizationFailure');

    const blobClient = container.getBlobClient('report.pdf');

    blobClient.uploadData.mockRejectedValueOnce(statusError(403, 'AuthorizationPermissionMismatch', 'denied'));
    expect((await createService().uploadBlob('docs', 'report.pdf', Buffer.from('x')).catch((caught) => caught)).code)
      .toBe('AuthorizationPermissionMismatch');

    blobClient.uploadStream.mockRejectedValueOnce(statusError(500, 'InternalError', 'boom'));
    expect((await createService().uploadBlob('docs', 'report.pdf', readableOf('x')).catch((caught) => caught)).code)
      .toBe('InternalError');

    blobClient.delete.mockRejectedValueOnce(statusError(412, 'ConditionNotMet', 'stale etag'));
    expect((await createService().deleteBlob('docs', 'report.pdf').catch((caught) => caught)).code)
      .toBe('ConditionNotMet');

    blobClient.setMetadata.mockRejectedValueOnce(statusError(404, 'BlobNotFound', 'gone'));
    expect((await createService().setBlobMetadata('docs', 'report.pdf', { a: 'b' }).catch((caught) => caught)).code)
      .toBe('BlobNotFound');

    blobClient.getProperties.mockRejectedValueOnce({ name: 'AbortError', message: 'aborted' });
    expect((await createService().getBlobProperties('docs', 'report.pdf').catch((caught) => caught)).code)
      .toBe(BLOB_ERROR_CODE.REQUEST_ABORTED);
  });

  it('surfaces a listing failure on listContainers as ApiError', async () => {
    const service = createService();
    await service.listContainers();

    sdkState.clients[0].client.listContainers.mockImplementationOnce(() => {
      throw statusError(500, 'InternalError', 'boom');
    });

    const error = await service.listContainers().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('InternalError');
  });

  it('bounds an endless container listing too', async () => {
    sdkState.containerPages = new Array(MAX_LIST_PAGES + 1).fill({
      containerItems: [],
      continuationToken: 'again',
    });

    const error = await createService().listContainers().catch((caught) => caught);
    expect(error.code).toBe(BLOB_ERROR_CODE.PAGINATION_LIMIT_EXCEEDED);
  });

  it('rejects a connection string that names no account', () => {
    let caught: any;
    try {
      resolveBlobServiceClient({ AZURE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountKey=abc' });
    } catch (error) {
      caught = error;
    }

    expect(caught.code).toBe(BLOB_ERROR_CODE.MISSING_CONFIGURATION);
    expect(sdk.BlobServiceClient.fromConnectionString).not.toHaveBeenCalled();
  });

  it('signs a SAS with the account key from a connection string', async () => {
    configure({
      AZURE_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT};AccountKey=${ACCOUNT_KEY};EndpointSuffix=core.windows.net`,
    });

    const params = readSas(await createService().generateSasUrl('docs', 'report.pdf', 'r'));
    expect(params.get('sig')).toBeTruthy();
    expect(params.get('sv')).toBeTruthy();
  });

  it('cannot sign a SAS from a SAS-only connection string', async () => {
    configure({
      AZURE_STORAGE_CONNECTION_STRING: `BlobEndpoint=${ACCOUNT_URL}/;AccountName=${ACCOUNT};SharedAccessSignature=sv%3D2024`,
    });

    const error = await createService()
      .generateSasUrl('docs', 'report.pdf', 'r')
      .catch((caught) => caught);

    expect(error.code).toBe(BLOB_ERROR_CODE.SAS_GENERATION_FAILED);
  });

  it('applies startsOn, https-only=false and an IP range', async () => {
    const startsOn = new Date(Date.now() - 5 * 60 * 1000);

    const params = readSas(await createService().generateSasUrl('docs', 'report.pdf', 'r', 5, {
      startsOn,
      httpsOnly: false,
      ipRange: { start: '203.0.113.4', end: '203.0.113.9' },
    }));

    expect(params.get('st')).toBeTruthy();
    expect(Math.abs(Date.parse(params.get('st') as string) - startsOn.getTime())).toBeLessThan(2000);
    expect(params.get('spr')).toBe('https,http');
    expect(params.get('sip')).toBe('203.0.113.4-203.0.113.9');
  });

  it('rejects an empty permission string and a non-object permission set', async () => {
    expect((await createService().generateSasUrl('docs', 'b', '  ').catch((caught) => caught)).code)
      .toBe(BLOB_ERROR_CODE.INVALID_SAS_PERMISSIONS);

    expect((await createService().generateSasUrl('docs', 'b', null as any).catch((caught) => caught)).code)
      .toBe(BLOB_ERROR_CODE.INVALID_SAS_PERMISSIONS);
  });

  it('leaves metadata off a listing unless it was requested', async () => {
    sdkState.blobPages = () => ({ segment: { blobItems: [blobItem('logs/a.txt')] } });

    const page = await createService().listBlobs('docs');

    expect(page.blobs[0].metadata).toBeUndefined();
    expect(page.continuationToken).toBeUndefined();
  });

  it('tolerates a download response with only a body', async () => {
    const container = sdk.__createContainerClient('docs');
    sdkState.containers.set('docs', container);
    container.getBlobClient('bare.bin').download.mockResolvedValueOnce({
      readableStreamBody: readableOf('bytes'),
    });

    const download = await createService().downloadBlob('docs', 'bare.bin');

    expect(download.contentLength).toBeUndefined();
    expect(download.metadata).toBeUndefined();
  });

  it('passes container delete conditions through', async () => {
    sdk.__createContainerClient('docs');

    await createService().deleteContainer('docs', { conditions: { ifMatch: '"container-etag"' } });

    expect(sdkState.containers.get('docs').delete).toHaveBeenCalledWith({
      abortSignal: undefined,
      conditions: { ifMatch: '"container-etag"' },
    });
  });
});

describe('no removed v10 client names remain', () => {
  /**
   * The names are assembled from fragments so this file does not itself contain the
   * literals the acceptance grep looks for.
   */
  const REMOVED_V10_NAMES = [
    `${'Abor'}ter`,
    `${'Storage'}URL`,
    `${'Share'}URL`,
    `${'Service'}URL`,
    `${'Container'}URL`,
  ];

  function sourceFiles(directory: string): string[] {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
        files.push(...sourceFiles(full));
      } else if (entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }

    return files;
  }

  it('has no reference to the v10 clients anywhere in the module source', () => {
    const offenders: Array<{ file: string; name: string }> = [];

    for (const file of sourceFiles(MODULE_ROOT)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const name of REMOVED_V10_NAMES) {
        if (source.includes(name)) offenders.push({ file: path.relative(MODULE_ROOT, file), name });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('deletes the commented-out storage stub', () => {
    expect(fs.existsSync(path.join(MODULE_ROOT, 'storage', 'index.ts'))).toBe(false);
  });

  it('uses AbortSignal for cancellation', () => {
    const source = fs.readFileSync(
      path.join(MODULE_ROOT, 'services', 'AzureBlobStorageService.ts'),
      'utf8',
    );

    expect(source).toContain('AbortSignal');
    expect(source).toContain('abortSignal');
  });
});

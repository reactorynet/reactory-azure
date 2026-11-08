import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import ApiError from '@reactory/server-core/exceptions';
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import type {
  BlobDownloadResponseParsed,
  BlobHTTPHeaders,
  BlobItem,
  BlobSASSignatureValues,
  ContainerClient,
  ContainerGetPropertiesResponse,
  ContainerItem,
  UserDelegationKey,
} from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import type { Readable } from 'stream';
import { apiError, extractStatusCode } from '../utils/graph-error';
import {
  DEFAULT_SAS_EXPIRY_MINUTES,
  DEFAULT_UPLOAD_STREAM_BUFFER_SIZE,
  DEFAULT_UPLOAD_STREAM_MAX_CONCURRENCY,
  MAX_LIST_PAGES,
  MAX_SAS_EXPIRY_MINUTES,
  SAS_CLOCK_SKEW_MS,
} from '../types/storage.types';
import type {
  AzureBlobCredentialMode,
  IAzureBlobContainer,
  IAzureBlobCreateContainerOptions,
  IAzureBlobDeleteContainerOptions,
  IAzureBlobDeleteOptions,
  IAzureBlobDownload,
  IAzureBlobDownloadOptions,
  IAzureBlobGetPropertiesOptions,
  IAzureBlobItem,
  IAzureBlobListContainersOptions,
  IAzureBlobListOptions,
  IAzureBlobListPage,
  IAzureBlobMetadataResult,
  IAzureBlobProperties,
  IAzureBlobRequestOptions,
  IAzureBlobSasOptions,
  IAzureBlobSasPermissions,
  IAzureBlobStorageEnvironment,
  IAzureBlobUploadOptions,
  IAzureBlobUploadResult,
} from '../types/storage.types';

/**
 * Azure Blob Storage v12 data-plane service.
 *
 * This file replaces the pre-AZ-01 `storage/index.ts`, which was entirely commented
 * out and written against the long-removed v10 pipeline API, none of which exists in
 * `@azure/storage-blob@12`. Everything below uses the v12 client surface
 * (`BlobServiceClient` -> `ContainerClient` -> `BlobClient`) and cancellation is a
 * standard `AbortSignal`, passed straight through to the SDK.
 *
 * ## Credentials
 *
 * The service never accepts a credential from a caller. It resolves one, once, from
 * the environment:
 *
 *   1. `AZURE_STORAGE_CONNECTION_STRING` - `BlobServiceClient.fromConnectionString`.
 *   2. `AZURE_STORAGE_ACCOUNT` (plus optional `AZURE_STORAGE_ACCOUNT_URL`) and
 *      `AZURE_STORAGE_KEY` - a `StorageSharedKeyCredential`.
 *   3. An account URL and `DefaultAzureCredential` from `@azure/identity` - a
 *      managed identity or workload identity, with no secret in the environment.
 *
 * A misconfiguration is an `ApiError` with `code: 'AzureStorageConfigurationMissing'`,
 * never a half-built client that fails later with an opaque 401.
 *
 * ## Errors
 *
 * Every failure is an `ApiError` whose `code` survives the wrapping (see
 * {@link toBlobApiError}). A missing blob is `BlobNotFound`, expected here: callers
 * branch on the code, so no method returns `[]`/`null` on failure.
 *
 * ## No GraphQL surface
 *
 * This ticket adds no resolver and no schema type; the service is reachable through
 * the Reactory service registry only.
 */

/** Error codes this service raises itself, in addition to the storage SDK's own codes. */
export const BLOB_ERROR_CODE = {
  /** Required `AZURE_STORAGE_*` configuration is missing or incomplete. */
  MISSING_CONFIGURATION: 'AzureStorageConfigurationMissing',
  /** A container name was empty or not a string. */
  INVALID_CONTAINER_NAME: 'InvalidBlobContainerName',
  /** A blob name was empty or not a string. */
  INVALID_BLOB_NAME: 'InvalidBlobName',
  /** `setBlobMetadata` was called without a metadata dictionary. */
  INVALID_METADATA: 'InvalidBlobMetadata',
  /** `listBlobs`' second argument was neither a prefix string nor an options object. */
  INVALID_LIST_OPTIONS: 'InvalidBlobListOptions',
  /** A SAS permission object granted nothing. */
  INVALID_SAS_PERMISSIONS: 'InvalidBlobSasPermissions',
  /** A SAS lifetime was not a positive number of minutes within the ceiling. */
  INVALID_SAS_EXPIRY: 'InvalidBlobSasExpiry',
  /** No credential was available to sign a SAS. */
  SAS_GENERATION_FAILED: 'BlobSasGenerationFailed',
  /** A listing exceeded {@link MAX_LIST_PAGES} pages - the result would be incomplete. */
  PAGINATION_LIMIT_EXCEEDED: 'BlobPaginationLimitExceeded',
  /** 404 - the blob does not exist (or is not visible to this identity). */
  NOT_FOUND: 'BlobNotFound',
  /** 409 - the write conflicts with an existing blob or container. */
  ALREADY_EXISTS: 'BlobAlreadyExists',
  /** 412 - a conditional header did not match. */
  PRECONDITION_FAILED: 'BlobPreconditionFailed',
  /** 401 - the credential was rejected. */
  UNAUTHENTICATED: 'StorageUnauthenticated',
  /** 403 - the identity is authenticated but lacks the data-plane role. */
  FORBIDDEN: 'StorageForbidden',
  /** 400/416 - the request itself was invalid. */
  INVALID_REQUEST: 'BlobInvalidRequest',
  /** The caller's `AbortSignal` fired. */
  REQUEST_ABORTED: 'BlobRequestAborted',
  /** Anything else the SDK raised. */
  REQUEST_FAILED: 'BlobRequestFailed',
} as const;

/** True when the SDK error is a cancellation rather than a service failure. */
function isAbortError(error: any): boolean {
  if (!error) return false;
  return error.name === 'AbortError' || error.code === 'ABORT_ERR';
}

/**
 * Build an `ApiError` that {@link toBlobApiError} passes through untouched.
 *
 * The flag is the same mechanism `utils/graph-error` uses, and keeps a validation
 * failure from being re-wrapped as a generic `BlobRequestFailed`.
 */
function blobError(code: string, message: string, meta: Record<string, unknown> = {}): ApiError {
  const error = apiError(code, message, meta) as ApiError & { __isReactoryApiError?: boolean };
  error.__isReactoryApiError = true;
  return error;
}

/**
 * Translate any storage SDK error into an `ApiError`.
 *
 * The SDK throws `RestError` with `statusCode`, `code` (for example `BlobNotFound`)
 * and `details.errorCode`. The service code maps 404/409/412/401/403 to the codes
 * callers branch on and keeps the SDK code in `meta.sdkCode`; anything unclassified
 * becomes `BlobRequestFailed` rather than escaping as a raw `RestError`.
 */
export function toBlobApiError(error: any, operation: string): ApiError {
  if (error && typeof error === 'object' && (error as any).__isReactoryApiError === true) {
    return error as ApiError;
  }

  const status = extractStatusCode(error) ?? extractStatusCode(error?.details);
  const sdkCode = typeof error?.code === 'string' && error.code.length > 0
    ? error.code
    : typeof error?.details?.errorCode === 'string' && error.details.errorCode.length > 0
      ? error.details.errorCode
      : undefined;

  const message = error?.message || `Azure Blob Storage operation "${operation}" failed`;

  if (isAbortError(error)) {
    return blobError(BLOB_ERROR_CODE.REQUEST_ABORTED, 'The Azure Blob Storage request was aborted.', {
      operation,
      sdkCode,
    });
  }

  let code: string = BLOB_ERROR_CODE.REQUEST_FAILED;
  if (status === 404) code = BLOB_ERROR_CODE.NOT_FOUND;
  else if (status === 409) code = BLOB_ERROR_CODE.ALREADY_EXISTS;
  else if (status === 412) code = BLOB_ERROR_CODE.PRECONDITION_FAILED;
  else if (status === 401) code = BLOB_ERROR_CODE.UNAUTHENTICATED;
  else if (status === 403) code = BLOB_ERROR_CODE.FORBIDDEN;
  else if (status === 400 || status === 416) code = BLOB_ERROR_CODE.INVALID_REQUEST;

  // The SDK's own code is more specific than the status bucket (`ContainerNotFound`,
  // `ContainerAlreadyExists`, `AuthenticationFailed`, ...). Keep it when it is a
  // recognisable service code, otherwise use the bucket.
  if (sdkCode && /^[A-Za-z]+$/.test(sdkCode)) code = sdkCode;

  return blobError(code, message, { operation, status, sdkCode });
}

/** Split a storage connection string into the pieces SAS signing needs. */
export function parseStorageConnectionString(connectionString: string): {
  accountName?: string;
  accountKey?: string;
  blobEndpoint?: string;
} {
  const result: { accountName?: string; accountKey?: string; blobEndpoint?: string } = {};

  for (const segment of String(connectionString).split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;

    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (!value) continue;

    if (key === 'AccountName') result.accountName = value;
    else if (key === 'AccountKey') result.accountKey = value;
    else if (key === 'BlobEndpoint') result.blobEndpoint = value;
  }

  return result;
}

/** `https://myaccount.blob.core.windows.net` -> `myaccount`. */
export function accountNameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^https?:\/\/([^./:]+)\.blob\./i.exec(url);
  return match ? match[1] : undefined;
}

function trimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}

/**
 * A built client plus the facts about how it was authenticated.
 *
 * `sharedKeyCredential` is only present when an account key is configured. It is the
 * fallback signer for {@link AzureBlobStorageService.generateSasUrl} when a
 * user-delegation key cannot be obtained.
 */
export interface IResolvedBlobServiceClient {
  client: BlobServiceClient;
  mode: AzureBlobCredentialMode;
  accountName: string;
  accountUrl: string;
  sharedKeyCredential?: StorageSharedKeyCredential;
}

/**
 * Build the `BlobServiceClient` this service uses, from the environment only.
 *
 * Order: connection string, then account URL + shared key, then account URL +
 * `DefaultAzureCredential`. Exported so the credential decision is unit-testable
 * without a storage account (see `__tests__/blob-service.test.ts`).
 *
 * @throws ApiError `AzureStorageConfigurationMissing` when no account is configured,
 *   or when a key is present but the account name cannot be determined.
 */
export function resolveBlobServiceClient(
  env: IAzureBlobStorageEnvironment = process.env,
): IResolvedBlobServiceClient {
  const connectionString = trimmed(env.AZURE_STORAGE_CONNECTION_STRING);

  if (connectionString) {
    const parts = parseStorageConnectionString(connectionString);
    if (!parts.accountName) {
      throw blobError(
        BLOB_ERROR_CODE.MISSING_CONFIGURATION,
        'AZURE_STORAGE_CONNECTION_STRING does not contain an AccountName, so the storage account cannot be addressed.',
      );
    }

    return {
      client: BlobServiceClient.fromConnectionString(connectionString),
      mode: 'connection-string',
      accountName: parts.accountName,
      accountUrl: parts.blobEndpoint || `https://${parts.accountName}.blob.core.windows.net`,
      // A SAS connection string has no AccountKey - the client still works, but it
      // cannot sign a new SAS. Leave the signer undefined in that case.
      sharedKeyCredential: parts.accountKey
        ? new StorageSharedKeyCredential(parts.accountName, parts.accountKey)
        : undefined,
    };
  }

  const configuredUrl = trimmed(env.AZURE_STORAGE_ACCOUNT_URL);
  const accountName = trimmed(env.AZURE_STORAGE_ACCOUNT) || accountNameFromUrl(configuredUrl);
  const accountUrl = configuredUrl || (accountName ? `https://${accountName}.blob.core.windows.net` : '');

  if (!accountUrl) {
    throw blobError(
      BLOB_ERROR_CODE.MISSING_CONFIGURATION,
      'Azure Blob Storage is not configured. Set AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT (optionally with AZURE_STORAGE_ACCOUNT_URL).',
    );
  }

  const accountKey = trimmed(env.AZURE_STORAGE_KEY);
  if (accountKey) {
    if (!accountName) {
      throw blobError(
        BLOB_ERROR_CODE.MISSING_CONFIGURATION,
        'AZURE_STORAGE_KEY is set but the storage account name could not be determined. Set AZURE_STORAGE_ACCOUNT.',
      );
    }

    const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
    return {
      client: new BlobServiceClient(accountUrl, sharedKeyCredential),
      mode: 'shared-key',
      accountName,
      accountUrl,
      sharedKeyCredential,
    };
  }

  // No key: managed identity / workload identity. DefaultAzureCredential resolves
  // the token lazily, so construction makes no network call.
  const credential = new DefaultAzureCredential();
  return {
    client: new BlobServiceClient(accountUrl, credential),
    mode: 'default-credential',
    accountName: accountName || '',
    accountUrl,
  };
}

/**
 * The account-key signer for SAS generation, if one can be built.
 *
 * The resolved client normally carries one (shared-key or connection-string mode).
 * The environment is consulted as a second chance - a token-credential client can
 * still sign with the account key when delegation is unavailable and `AZURE_STORAGE_KEY`
 * is present. The credential is constructed here; it is never accepted from a caller.
 */
export function resolveAccountKeySigner(
  resolved: Pick<IResolvedBlobServiceClient, 'accountName' | 'sharedKeyCredential'>,
  env: IAzureBlobStorageEnvironment = process.env,
): StorageSharedKeyCredential | undefined {
  if (resolved.sharedKeyCredential) return resolved.sharedKeyCredential;

  const accountKey = trimmed(env.AZURE_STORAGE_KEY);
  const accountName = resolved.accountName || trimmed(env.AZURE_STORAGE_ACCOUNT);
  if (!accountKey || !accountName) return undefined;

  return new StorageSharedKeyCredential(accountName, accountKey);
}

/** Map a listed container into the module's own shape. */
function mapContainerItem(item: ContainerItem): IAzureBlobContainer {
  const properties = item.properties || ({} as ContainerItem['properties']);

  return {
    name: item.name,
    metadata: item.metadata,
    etag: properties.etag,
    lastModified: properties.lastModified,
    leaseStatus: properties.leaseStatus,
    leaseState: properties.leaseState,
    publicAccess: properties.publicAccess,
    hasImmutabilityPolicy: properties.hasImmutabilityPolicy,
    hasLegalHold: properties.hasLegalHold,
  };
}

/** Map a listed blob into the module's own shape. */
function mapBlobItem(containerName: string, item: BlobItem, includeMetadata: boolean): IAzureBlobItem {
  const properties = item.properties || ({} as BlobItem['properties']);

  return {
    name: item.name,
    containerName,
    blobType: properties.blobType,
    contentLength: properties.contentLength,
    contentType: properties.contentType,
    contentEncoding: properties.contentEncoding,
    contentLanguage: properties.contentLanguage,
    contentDisposition: properties.contentDisposition,
    cacheControl: properties.cacheControl,
    etag: properties.etag,
    lastModified: properties.lastModified,
    createdOn: properties.createdOn,
    accessTier: properties.accessTier,
    leaseStatus: properties.leaseStatus,
    serverEncrypted: properties.serverEncrypted,
    metadata: includeMetadata ? item.metadata : undefined,
    snapshot: item.snapshot || undefined,
    versionId: item.versionId,
  };
}

/** Translate the service's header options into the SDK's `blobHTTPHeaders`. */
function buildBlobHttpHeaders(options: IAzureBlobUploadOptions): BlobHTTPHeaders | undefined {
  const headers: BlobHTTPHeaders = {};
  let set = false;

  if (options.contentType) {
    headers.blobContentType = options.contentType;
    set = true;
  }
  if (options.contentEncoding) {
    headers.blobContentEncoding = options.contentEncoding;
    set = true;
  }
  if (options.contentLanguage) {
    headers.blobContentLanguage = options.contentLanguage;
    set = true;
  }
  if (options.contentDisposition) {
    headers.blobContentDisposition = options.contentDisposition;
    set = true;
  }
  if (options.cacheControl) {
    headers.blobCacheControl = options.cacheControl;
    set = true;
  }

  return set ? headers : undefined;
}

/** True for a Node readable stream (and not for a Buffer, which also has `.slice`). */
function isReadableStream(value: unknown): value is Readable {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as any;
  return typeof candidate.pipe === 'function' && typeof candidate.on === 'function';
}

/** Normalise the accepted upload payloads to a Buffer. */
function toUploadBuffer(data: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  throw blobError(
    BLOB_ERROR_CODE.INVALID_REQUEST,
    'uploadBlob expects a Buffer, Uint8Array, string or readable stream.',
  );
}

/**
 * Validate a container name **without rewriting it**.
 *
 * Azure resource names are exact, case- and whitespace-sensitive keys. Validation
 * only rejects a non-string or an all-whitespace value; the caller's original string
 * is what reaches the SDK, so a padded name fails at Azure (400) instead of silently
 * addressing a different container.
 */
function requireContainerName(containerName: string): string {
  if (typeof containerName !== 'string' || containerName.trim().length === 0) {
    throw blobError(BLOB_ERROR_CODE.INVALID_CONTAINER_NAME, 'A non-empty container name is required.');
  }
  return containerName;
}

/**
 * Validate a blob name **without rewriting it**.
 *
 * This is the whole point: `' padded.txt '` and `'padded.txt'` are different blobs.
 * Trimming here would make upload, download, get-properties, delete, metadata and
 * SAS generation silently operate on a key the caller never named. Only a non-string
 * or an all-whitespace name is rejected; everything else is passed through verbatim.
 */
function requireBlobName(blobName: string): string {
  if (typeof blobName !== 'string' || blobName.trim().length === 0) {
    throw blobError(BLOB_ERROR_CODE.INVALID_BLOB_NAME, 'A non-empty blob name is required.');
  }
  return blobName;
}

/**
 * Normalise `listBlobs`' second argument.
 *
 * The ticket specifies `listBlobs(container, prefix?)`, so a **string is the prefix**.
 * A plain object is the options bag. Anything else - a number, a boolean, an array,
 * `null`, a function - is a caller mistake, and the one thing it must not do is
 * silently become "list the whole container": that turns a scoped read into a
 * full-container scan with no error. It throws `InvalidBlobListOptions` instead.
 */
function normalizeListBlobsArgument(
  prefixOrOptions: string | IAzureBlobListOptions | undefined,
): IAzureBlobListOptions {
  if (prefixOrOptions === undefined) return {};
  if (typeof prefixOrOptions === 'string') return { prefix: prefixOrOptions };

  if (
    prefixOrOptions !== null
    && typeof prefixOrOptions === 'object'
    && !Array.isArray(prefixOrOptions)
  ) {
    return prefixOrOptions;
  }

  throw blobError(
    BLOB_ERROR_CODE.INVALID_LIST_OPTIONS,
    'listBlobs expects a prefix string or an options object as its second argument.',
    { receivedType: prefixOrOptions === null ? 'null' : typeof prefixOrOptions },
  );
}

/** Validate a SAS lifetime and turn it into minutes. */
function requireExpiryMinutes(expiresInMinutes: number): number {
  if (
    typeof expiresInMinutes !== 'number'
    || !Number.isFinite(expiresInMinutes)
    || expiresInMinutes <= 0
    || expiresInMinutes > MAX_SAS_EXPIRY_MINUTES
  ) {
    throw blobError(
      BLOB_ERROR_CODE.INVALID_SAS_EXPIRY,
      `A SAS expiry must be a positive number of minutes no greater than ${MAX_SAS_EXPIRY_MINUTES} (24 hours); received ${String(expiresInMinutes)}.`,
      { expiresInMinutes },
    );
  }
  return expiresInMinutes;
}

/** Accept either the permission object or its letter string (`"r"`, `"racwd"`). */
function toBlobSasPermissions(permissions: IAzureBlobSasPermissions | string): BlobSASPermissions {
  if (typeof permissions === 'string') {
    const letters = permissions.trim();
    if (!letters) {
      throw blobError(BLOB_ERROR_CODE.INVALID_SAS_PERMISSIONS, 'A SAS permission string may not be empty.');
    }

    try {
      return BlobSASPermissions.parse(letters);
    } catch (error: any) {
      throw blobError(
        BLOB_ERROR_CODE.INVALID_SAS_PERMISSIONS,
        `"${letters}" is not a valid blob SAS permission string.`,
        { permissions: letters },
      );
    }
  }

  if (!permissions || typeof permissions !== 'object') {
    throw blobError(BLOB_ERROR_CODE.INVALID_SAS_PERMISSIONS, 'A SAS permission object is required.');
  }

  const parsed = BlobSASPermissions.from(permissions as any);
  if (!parsed.toString()) {
    throw blobError(
      BLOB_ERROR_CODE.INVALID_SAS_PERMISSIONS,
      'The SAS permission object grants nothing. Set at least one permission.',
    );
  }
  return parsed;
}

/**
 * Azure Blob Storage v12 data-plane access.
 *
 * All methods take an optional `AbortSignal` (the v12 cancellation mechanism) and
 * throw `ApiError` on failure. The signal is forwarded onto the SDK call that
 * carries `abortSignal` in every method, including the two paged listings
 * (`listContainers` and `listBlobs`), so a cancellation covers every segment
 * request a pager issues rather than only the first one.
 */
@service({
  id: 'azure.AzureBlobStorageService@1.0.0',
  name: 'AzureBlobStorageService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Azure Blob Storage v12 data plane: containers, blobs, streams and SAS URLs',
  serviceType: 'integration',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureBlobStorageService implements Reactory.Service.IReactoryService {
  name: string = 'AzureBlobStorageService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  /** Resolved on first use, so constructing the service never needs configuration. */
  private resolved?: IResolvedBlobServiceClient;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** How the client was authenticated - `undefined` until the first call resolves it. */
  get credentialMode(): AzureBlobCredentialMode | undefined {
    return this.resolved?.mode;
  }

  private get storage(): IResolvedBlobServiceClient {
    if (!this.resolved) this.resolved = resolveBlobServiceClient(process.env);
    return this.resolved;
  }

  private containerClient(containerName: string): ContainerClient {
    return this.storage.client.getContainerClient(containerName);
  }

  /**
   * List the containers in the account, following `continuationToken` internally.
   *
   * The service walks pages for the caller; a listing that exceeds
   * {@link MAX_LIST_PAGES} throws `BlobPaginationLimitExceeded` rather than
   * returning a silently truncated array.
   *
   * A listing is the operation that can issue up to {@link MAX_LIST_PAGES}
   * requests, so `options.signal` is forwarded onto the SDK's
   * `listContainers` options (where `abortSignal` lives) and therefore onto every
   * segment request the pager makes - not just the first page.
   */
  async listContainers(options: IAzureBlobListContainersOptions = {}): Promise<IAzureBlobContainer[]> {
    try {
      const containers: IAzureBlobContainer[] = [];
      const iterator = this.storage.client
        .listContainers({ prefix: options.prefix, abortSignal: options.signal })
        .byPage({ maxPageSize: options.maxPageSize });

      let pages = 0;
      let continuationToken: string | undefined;

      do {
        if (pages >= MAX_LIST_PAGES) {
          throw blobError(
            BLOB_ERROR_CODE.PAGINATION_LIMIT_EXCEEDED,
            `The container listing exceeded ${MAX_LIST_PAGES} pages; narrow the prefix.`,
            { pages },
          );
        }

        const page = await iterator.next();
        if (page.done || !page.value) break;

        continuationToken = page.value.continuationToken;
        containers.push(...(page.value.containerItems || []).map(mapContainerItem));
        pages += 1;
      } while (continuationToken);

      return containers;
    } catch (error) {
      throw toBlobApiError(error, 'listContainers');
    }
  }

  /** Create a container. A 409 becomes `ContainerAlreadyExists` (or the SDK's own code). */
  async createContainer(
    containerName: string,
    options: IAzureBlobCreateContainerOptions = {},
  ): Promise<IAzureBlobContainer> {
    const name = requireContainerName(containerName);

    try {
      const response = await this.containerClient(name).create({
        metadata: options.metadata,
        access: options.publicAccess,
        abortSignal: options.signal,
      });

      return {
        name,
        metadata: options.metadata,
        etag: (response as any)?.etag,
        lastModified: (response as any)?.lastModified,
      };
    } catch (error) {
      throw toBlobApiError(error, 'createContainer');
    }
  }

  /** Delete a container and everything in it. */
  async deleteContainer(
    containerName: string,
    options: IAzureBlobDeleteContainerOptions = {},
  ): Promise<void> {
    const name = requireContainerName(containerName);

    try {
      await this.containerClient(name).delete({
        abortSignal: options.signal,
        conditions: options.conditions,
      });
    } catch (error) {
      throw toBlobApiError(error, 'deleteContainer');
    }
  }

  /** Container properties and metadata. A 404 becomes `ContainerNotFound`/`BlobNotFound`. */
  async getContainerProperties(
    containerName: string,
    options: IAzureBlobRequestOptions = {},
  ): Promise<IAzureBlobContainer> {
    const name = requireContainerName(containerName);

    try {
      const response: ContainerGetPropertiesResponse = await this.containerClient(name).getProperties({
        abortSignal: options.signal,
      });

      return {
        name,
        metadata: response.metadata,
        etag: response.etag,
        lastModified: response.lastModified,
        leaseStatus: response.leaseStatus,
        leaseState: response.leaseState,
        publicAccess: (response as any).blobPublicAccess,
        hasImmutabilityPolicy: (response as any).hasImmutabilityPolicy,
        hasLegalHold: (response as any).hasLegalHold,
      };
    } catch (error) {
      throw toBlobApiError(error, 'getContainerProperties');
    }
  }

  /**
   * Read **one page** of blobs from a container, flat (names include `/`).
   *
   * **This is the single-page primitive.** `listAllBlobs` is the token-following
   * wrapper: it calls this method in a loop until the marker runs out.
   *
   * Paging is explicit: pass `continuationToken` back in to get the next page, and
   * stop when the returned `continuationToken` is `undefined`.
   *
   * The second argument accepts either form:
   *
   * ```ts
   * await listBlobs('docs', 'logs/');                              // prefix
   * await listBlobs('docs', { prefix: 'logs/', maxPageSize: 100 }); // options
   * ```
   *
   * A string is taken as `prefix`. Anything that is neither a string nor a plain
   * object throws `InvalidBlobListOptions`; it is never treated as "no prefix".
   *
   * `options.signal` is forwarded to the SDK's `listBlobsFlat` options, so both a
   * single page and a caller-driven paging loop are cancellable.
   */
  async listBlobs(
    containerName: string,
    prefixOrOptions: string | IAzureBlobListOptions = {},
  ): Promise<IAzureBlobListPage> {
    const name = requireContainerName(containerName);
    const options = normalizeListBlobsArgument(prefixOrOptions);

    try {
      const iterator = this.containerClient(name)
        .listBlobsFlat({
          prefix: options.prefix,
          includeMetadata: options.includeMetadata,
          includeSnapshots: options.includeSnapshots,
          includeVersions: options.includeVersions,
          abortSignal: options.signal,
        })
        .byPage({
          maxPageSize: options.maxPageSize,
          continuationToken: options.continuationToken,
        });

      const page = await iterator.next();
      if (page.done || !page.value) return { blobs: [], continuationToken: undefined };

      const segment = (page.value as any).segment;
      const items: BlobItem[] = (segment && segment.blobItems) || [];

      return {
        blobs: items.map((item) => mapBlobItem(name, item, Boolean(options.includeMetadata))),
        continuationToken: (page.value as any).continuationToken,
      };
    } catch (error) {
      throw toBlobApiError(error, 'listBlobs');
    }
  }

  /**
   * List **all** blobs under `prefix`, following `continuationToken` until the
   * listing ends. `maxPageSize` and a starting `continuationToken` may be supplied
   * through `options`; resuming mid-listing is supported.
   *
   * This is the token-following wrapper around {@link listBlobs} (the single-page
   * primitive), capped at {@link MAX_LIST_PAGES} pages. `options.signal` is passed
   * to every page, so aborting a long walk stops it mid-listing.
   */
  async listAllBlobs(
    containerName: string,
    prefix?: string,
    options: Omit<IAzureBlobListOptions, 'prefix' | 'continuationToken'> & { continuationToken?: string } = {},
  ): Promise<IAzureBlobItem[]> {
    const name = requireContainerName(containerName);

    try {
      const blobs: IAzureBlobItem[] = [];
      let continuationToken = options.continuationToken;
      let pages = 0;

      do {
        if (pages >= MAX_LIST_PAGES) {
          throw blobError(
            BLOB_ERROR_CODE.PAGINATION_LIMIT_EXCEEDED,
            `The blob listing exceeded ${MAX_LIST_PAGES} pages; narrow the prefix.`,
            { pages, containerName: name, prefix },
          );
        }

        const page = await this.listBlobs(name, { ...options, prefix, continuationToken });
        blobs.push(...page.blobs);
        continuationToken = page.continuationToken;
        pages += 1;
      } while (continuationToken);

      return blobs;
    } catch (error) {
      throw toBlobApiError(error, 'listAllBlobs');
    }
  }

  /**
   * Upload a blob.
   *
   * `uploadData` is used for a Buffer, Uint8Array or string - one request, so the
   * whole payload must already be in memory. A readable stream goes through
   * `uploadStream`, which splits it into blocks and uploads them in parallel:
   * `bufferSize` defaults to 8 MiB and `maxConcurrency` to 5 (the SDK defaults),
   * so peak in-flight memory is about 40 MiB. Both are caller-tunable; raising
   * concurrency raises throughput and memory together. The stream must be a Node
   * `Readable`; a WHATWG stream has to be converted first.
   */
  async uploadBlob(
    containerName: string,
    blobName: string,
    data: Buffer | Uint8Array | string | Readable,
    options: IAzureBlobUploadOptions = {},
  ): Promise<IAzureBlobUploadResult> {
    const container = requireContainerName(containerName);
    const name = requireBlobName(blobName);

    try {
      const blobClient = this.containerClient(container).getBlockBlobClient(name);
      const blobHTTPHeaders = buildBlobHttpHeaders(options);
      const commonOptions = {
        abortSignal: options.signal,
        metadata: options.metadata,
        blobHTTPHeaders,
        tier: options.tier,
        conditions: options.conditions,
      };

      if (isReadableStream(data)) {
        const response = await blobClient.uploadStream(
          data,
          options.bufferSize ?? DEFAULT_UPLOAD_STREAM_BUFFER_SIZE,
          options.maxConcurrency ?? DEFAULT_UPLOAD_STREAM_MAX_CONCURRENCY,
          commonOptions,
        );

        return {
          containerName: container,
          blobName: name,
          etag: (response as any)?.etag,
          lastModified: (response as any)?.lastModified,
          requestId: (response as any)?.requestId,
          versionId: (response as any)?.versionId,
        };
      }

      const buffer = toUploadBuffer(data);
      const response = await blobClient.uploadData(buffer, commonOptions);

      return {
        containerName: container,
        blobName: name,
        etag: (response as any)?.etag,
        lastModified: (response as any)?.lastModified,
        requestId: (response as any)?.requestId,
        versionId: (response as any)?.versionId,
        contentLength: buffer.byteLength,
      };
    } catch (error) {
      throw toBlobApiError(error, 'uploadBlob');
    }
  }

  /**
   * Download a blob as a readable stream.
   *
   * The bytes are returned as a stream and the blob URL is deliberately not exposed.
   * `offset`/`count` request a range; the caller must consume or destroy the stream.
   */
  async downloadBlob(
    containerName: string,
    blobName: string,
    options: IAzureBlobDownloadOptions = {},
  ): Promise<IAzureBlobDownload> {
    const container = requireContainerName(containerName);
    const name = requireBlobName(blobName);

    try {
      const response: BlobDownloadResponseParsed = await this.containerClient(container)
        .getBlobClient(name)
        .download(options.offset, options.count, {
          abortSignal: options.signal,
          conditions: options.conditions,
        });

      if (!response.readableStreamBody) {
        throw blobError(
          BLOB_ERROR_CODE.REQUEST_FAILED,
          `The download of ${container}/${name} returned no readable body.`,
          { containerName: container, blobName: name },
        );
      }

      return {
        // The SDK types this as a Node stream in the Node runtime; in the browser
        // build it is a browser stream, which this server never uses.
        stream: response.readableStreamBody as unknown as Readable,
        contentLength: response.contentLength,
        contentType: response.contentType,
        contentEncoding: response.contentEncoding,
        contentLanguage: response.contentLanguage,
        contentDisposition: response.contentDisposition,
        cacheControl: response.cacheControl,
        etag: response.etag,
        lastModified: response.lastModified,
        metadata: response.metadata,
        contentRange: response.contentRange,
      };
    } catch (error) {
      throw toBlobApiError(error, 'downloadBlob');
    }
  }

  /**
   * Blob properties and metadata. A 404 (missing blob) becomes an `ApiError` with
   * code `BlobNotFound` - it is not swallowed into an empty object.
   */
  async getBlobProperties(
    containerName: string,
    blobName: string,
    options: IAzureBlobGetPropertiesOptions = {},
  ): Promise<IAzureBlobProperties> {
    const container = requireContainerName(containerName);
    const name = requireBlobName(blobName);

    try {
      const response = await this.containerClient(container).getBlobClient(name).getProperties({
        abortSignal: options.signal,
      });

      return {
        containerName: container,
        name,
        blobType: response.blobType,
        contentLength: response.contentLength,
        contentType: response.contentType,
        contentEncoding: response.contentEncoding,
        contentLanguage: response.contentLanguage,
        contentDisposition: response.contentDisposition,
        cacheControl: response.cacheControl,
        contentMD5: response.contentMD5
          ? Buffer.from(response.contentMD5).toString('base64')
          : undefined,
        etag: response.etag,
        lastModified: response.lastModified,
        createdOn: response.createdOn,
        accessTier: response.accessTier,
        accessTierChangedOn: response.accessTierChangedOn,
        leaseStatus: response.leaseStatus,
        leaseState: response.leaseState,
        serverEncrypted: response.isServerEncrypted,
        copyId: response.copyId,
        copyStatus: response.copyStatus,
        copySource: response.copySource,
        metadata: response.metadata,
      };
    } catch (error) {
      throw toBlobApiError(error, 'getBlobProperties');
    }
  }

  /** Delete a blob. 404 becomes `BlobNotFound`; 412 surfaces as `BlobPreconditionFailed`. */
  async deleteBlob(
    containerName: string,
    blobName: string,
    options: IAzureBlobDeleteOptions = {},
  ): Promise<void> {
    const container = requireContainerName(containerName);
    const name = requireBlobName(blobName);

    try {
      await this.containerClient(container).getBlobClient(name).delete({
        abortSignal: options.signal,
        deleteSnapshots: options.deleteSnapshots,
        conditions: options.conditions,
      });
    } catch (error) {
      throw toBlobApiError(error, 'deleteBlob');
    }
  }

  /**
   * Replace a blob's metadata.
   *
   * Azure replaces the whole dictionary - keys absent from `metadata` are removed -
   * so this is a set, not a merge.
   */
  async setBlobMetadata(
    containerName: string,
    blobName: string,
    metadata: Record<string, string>,
    options: { signal?: AbortSignal } = {},
  ): Promise<IAzureBlobMetadataResult> {
    const container = requireContainerName(containerName);
    const name = requireBlobName(blobName);

    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw blobError(
        BLOB_ERROR_CODE.INVALID_METADATA,
        'setBlobMetadata expects a metadata dictionary (string values).',
        { containerName: container, blobName: name },
      );
    }

    try {
      const response = await this.containerClient(container).getBlobClient(name).setMetadata(metadata, {
        abortSignal: options.signal,
      });

      return {
        containerName: container,
        blobName: name,
        metadata,
        etag: (response as any)?.etag,
        lastModified: (response as any)?.lastModified,
        requestId: (response as any)?.requestId,
      };
    } catch (error) {
      throw toBlobApiError(error, 'setBlobMetadata');
    }
  }

  /**
   * Create a short-lived, blob-scoped SAS URL.
   *
   * **A SAS URL is a bearer credential.** Anyone holding the string can perform the
   * granted permission until it expires; there is no second factor and revocation is
   * "rotate the account key / wait for expiry". Therefore:
   *
   * - the default lifetime is {@link DEFAULT_SAS_EXPIRY_MINUTES} (5 minutes), the
   *   shortest window that still tolerates a redirect and one retry;
   * - the maximum accepted lifetime is {@link MAX_SAS_EXPIRY_MINUTES} (24 hours);
   * - generated URLs must never be logged, persisted, or sent anywhere other than
   *   the client that requested them;
   * - permissions should be the minimum that works - prefer `read` over `racwd`.
   *
   * Signing prefers a **user delegation key** (`getUserDelegationKey`, available when
   * the client authenticates with a token credential such as `DefaultAzureCredential`),
   * because a delegation SAS is tied to an Entra identity and can be revoked by
   * revoking that identity. When delegation is unavailable - shared-key
   * authentication, or the delegation call fails - it falls back to signing with the
   * account key, which requires `AZURE_STORAGE_KEY` (or an AccountKey in the
   * connection string). If neither signer exists the method throws
   * `BlobSasGenerationFailed` rather than returning an unsigned URL.
   *
   * @param containerName - container the SAS is scoped to
   * @param blobName - blob the SAS is scoped to (this method never issues a
   *   container-wide SAS)
   * @param permissions - {@link IAzureBlobSasPermissions} or a permission string (`"r"`)
   * @param expiresInMinutes - lifetime in minutes; defaults to 5, capped at 1440
   * @param options - `signal`, custom `startsOn`, `httpsOnly` (leave true) and `ipRange`
   * @returns the full URL, including the query string with `sig`, `se`, `sp` and `sv`
   */
  async generateSasUrl(
    containerName: string,
    blobName: string,
    permissions: IAzureBlobSasPermissions | string,
    expiresInMinutes: number = DEFAULT_SAS_EXPIRY_MINUTES,
    options: IAzureBlobSasOptions = {},
  ): Promise<string> {
    const container = requireContainerName(containerName);
    const name = requireBlobName(blobName);
    const minutes = requireExpiryMinutes(expiresInMinutes);
    const parsedPermissions = toBlobSasPermissions(permissions);

    try {
      const resolved = this.storage;
      const now = Date.now();
      const expiresOn = new Date(now + minutes * 60 * 1000);
      const startsOn = options.startsOn ?? new Date(now - SAS_CLOCK_SKEW_MS);

      const values: BlobSASSignatureValues = {
        containerName: container,
        blobName: name,
        permissions: parsedPermissions,
        expiresOn,
        startsOn,
        protocol: options.httpsOnly === false ? SASProtocol.HttpsAndHttp : SASProtocol.Https,
        ipRange: options.ipRange,
      };

      let userDelegationKey: UserDelegationKey | undefined;
      if (resolved.mode === 'default-credential') {
        try {
          userDelegationKey = await resolved.client.getUserDelegationKey(startsOn, expiresOn, {
            abortSignal: options.signal,
          });
        } catch (error) {
          // A cancelled request is a cancellation, not a reason to fall back.
          if (isAbortError(error)) throw error;
          userDelegationKey = undefined;
        }
      }

      let sas;
      if (userDelegationKey) {
        if (!resolved.accountName) {
          throw blobError(
            BLOB_ERROR_CODE.SAS_GENERATION_FAILED,
            'A user delegation key was returned but the storage account name is unknown, so the SAS cannot be signed. Set AZURE_STORAGE_ACCOUNT.',
            { containerName: container, blobName: name },
          );
        }
        sas = generateBlobSASQueryParameters(values, userDelegationKey, resolved.accountName);
      } else {
        // No delegation key: fall back to the account key. This is the documented
        // "shared key or delegation" split - a key-authenticated client cannot ask
        // for a delegation key at all, so the key is the only signer available.
        const accountKeySigner = resolveAccountKeySigner(resolved);
        if (!accountKeySigner) {
          throw blobError(
            BLOB_ERROR_CODE.SAS_GENERATION_FAILED,
            'No credential is available to sign a SAS: configure AZURE_STORAGE_KEY (or a connection string with an AccountKey), or authenticate with a token credential that can request a user delegation key.',
            { containerName: container, blobName: name, credentialMode: resolved.mode },
          );
        }

        sas = generateBlobSASQueryParameters(values, accountKeySigner);
      }

      if (!sas || !sas.signature) {
        throw blobError(
          BLOB_ERROR_CODE.SAS_GENERATION_FAILED,
          'The SDK returned a SAS without a signature.',
          { containerName: container, blobName: name },
        );
      }

      const blobClient = resolved.client.getContainerClient(container).getBlobClient(name);
      const baseUrl = typeof (blobClient as any)?.url === 'string' && (blobClient as any).url
        ? String((blobClient as any).url).split('?')[0]
        : `${resolved.accountUrl.replace(/\/+$/, '')}/${encodeURIComponent(container)}/${name.split('/').map(encodeURIComponent).join('/')}`;

      return `${baseUrl}?${sas.toString()}`;
    } catch (error) {
      throw toBlobApiError(error, 'generateSasUrl');
    }
  }
}

export const AzureBlobStorageServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureBlobStorageService> = {
  service: (props: any, context: any) => new AzureBlobStorageService(props, context),
  id: 'azure.AzureBlobStorageService@1.0.0',
  name: 'AzureBlobStorageService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Azure Blob Storage v12 data plane: containers, blobs, streams and SAS URLs',
  serviceType: 'integration',
  dependencies: [],
};

export { AzureBlobStorageService };

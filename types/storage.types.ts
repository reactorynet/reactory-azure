/**
 * Azure Blob Storage - public contract for `azure.AzureBlobStorageService@1.0.0`.
 *
 * The types here describe the *data plane* only (blobs and containers). They are
 * deliberately free of `@azure/storage-blob` types so a caller never has to import
 * the SDK, and so a test can build fixtures without a storage account. The service
 * is the only file that translates SDK shapes into these.
 */

import type { Readable } from 'stream';

/**
 * How the service authenticated its `BlobServiceClient`.
 *
 * Reported (never accepted from a caller) so an operator can tell which route the
 * process picked up, and so the SAS generator knows whether a user-delegation key
 * is even obtainable.
 */
export type AzureBlobCredentialMode =
  /** `AZURE_STORAGE_CONNECTION_STRING` - the SDK parsed the account name and key. */
  | 'connection-string'
  /** `AZURE_STORAGE_ACCOUNT` + `AZURE_STORAGE_KEY` - a shared-key credential. */
  | 'shared-key'
  /** Account URL plus `DefaultAzureCredential` from `@azure/identity`. */
  | 'default-credential';

/** Options every data-plane call accepts. */
export interface IAzureBlobRequestOptions {
  /**
   * Cancels the in-flight request. The storage SDK takes an `AbortSignal` on every
   * operation; the service passes this straight through and never constructs its
   * own controller. Absent means "no cancellation".
   */
  signal?: AbortSignal;
}

/** A container as returned by `listContainers` / `createContainer` / `getContainerProperties`. */
export interface IAzureBlobContainer {
  name: string;
  /** Container metadata, if any was set. */
  metadata?: Record<string, string>;
  etag?: string;
  lastModified?: Date;
  leaseStatus?: string;
  leaseState?: string;
  /** `container`, `blob` or `unknown` when public access is configured on the container. */
  publicAccess?: string;
  /** True when the container has an immutability policy configured. */
  hasImmutabilityPolicy?: boolean;
  /** True when the container has a legal hold. */
  hasLegalHold?: boolean;
}

/** Options for {@link AzureBlobStorageService.listContainers}. */
export interface IAzureBlobListContainersOptions extends IAzureBlobRequestOptions {
  /** Return only containers whose name starts with this prefix. */
  prefix?: string;
  /** Containers requested per page (1-5000). Paging is internal to the method. */
  maxPageSize?: number;
}

/**
 * Options for reading one page of blobs from a container.
 *
 * `listBlobs(container, prefix?)` also accepts a bare string in this position, which
 * is read as {@link prefix}. Any second argument that is neither a string nor a
 * plain object of this shape is rejected with `InvalidBlobListOptions` rather than
 * being ignored.
 */
export interface IAzureBlobListOptions extends IAzureBlobRequestOptions {
  /** Return only blobs whose name starts with this prefix. */
  prefix?: string;
  /** Requested page size (1-5000). The service does not grow it for you. */
  maxPageSize?: number;
  /**
   * Marker returned by a previous call. Opaque: do not parse, only echo it back.
   * Absent starts at the first page.
   */
  continuationToken?: string;
  /** Include the blob metadata dictionary on each item. */
  includeMetadata?: boolean;
  /** Include blob snapshots in the result. */
  includeSnapshots?: boolean;
  /** Include previous blob versions (requires versioning on the account). */
  includeVersions?: boolean;
}

/** A blob as returned by the list operations. */
export interface IAzureBlobItem {
  name: string;
  containerName: string;
  blobType?: string;
  contentLength?: number;
  contentType?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  cacheControl?: string;
  etag?: string;
  lastModified?: Date;
  createdOn?: Date;
  accessTier?: string;
  leaseStatus?: string;
  serverEncrypted?: boolean;
  metadata?: Record<string, string>;
  /** Snapshot timestamp, when the item is a snapshot. */
  snapshot?: string;
  /** Version id, when versioning is enabled. */
  versionId?: string;
}

/** One page of a flat blob listing, plus the marker for the next page. */
export interface IAzureBlobListPage {
  blobs: IAzureBlobItem[];
  /**
   * Marker to pass back as `continuationToken`. `undefined` means this was the
   * last page - the SDK returns an empty value at the end of the listing.
   */
  continuationToken?: string;
}

/** Options for {@link AzureBlobStorageService.createContainer}. */
export interface IAzureBlobCreateContainerOptions extends IAzureBlobRequestOptions {
  metadata?: Record<string, string>;
  /** `container` or `blob`; omitted leaves the container private (the default). */
  publicAccess?: 'container' | 'blob';
}

/** Options for {@link AzureBlobStorageService.deleteContainer}. */
export interface IAzureBlobDeleteContainerOptions extends IAzureBlobRequestOptions {
  /** Conditions (for example an etag match) the service must satisfy before deleting. */
  conditions?: { ifModifiedSince?: Date; ifUnmodifiedSince?: Date; ifMatch?: string; ifNoneMatch?: string };
}

/** Options shared by the write operations. */
export interface IAzureBlobWriteOptions extends IAzureBlobRequestOptions {
  metadata?: Record<string, string>;
  contentType?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  cacheControl?: string;
  /** Target access tier for the upload (`Hot`, `Cool`, `Cold`, `Archive`). */
  tier?: string;
  /** Conditions the service must satisfy before the write. */
  conditions?: { ifModifiedSince?: Date; ifUnmodifiedSince?: Date; ifMatch?: string; ifNoneMatch?: string };
}

/** Options for {@link AzureBlobStorageService.uploadBlob}. */
export interface IAzureBlobUploadOptions extends IAzureBlobWriteOptions {
  /**
   * Bytes buffered per block when `data` is a stream. Defaults to 8 MiB - the SDK
   * default - and exists so a caller can trade memory for fewer, larger blocks.
   */
  bufferSize?: number;
  /**
   * Blocks uploaded in parallel when `data` is a stream. Defaults to 5 - the SDK
   * default. Peak in-flight memory is roughly `bufferSize * maxConcurrency`
   * (8 MiB x 5 = 40 MiB) with the defaults.
   */
  maxConcurrency?: number;
}

/** Result of a blob upload. */
export interface IAzureBlobUploadResult {
  containerName: string;
  blobName: string;
  etag?: string;
  lastModified?: Date;
  requestId?: string;
  versionId?: string;
  /** Size actually written, when the SDK reported it (stream uploads may omit it). */
  contentLength?: number;
}

/** Options for {@link AzureBlobStorageService.downloadBlob}. */
export interface IAzureBlobDownloadOptions extends IAzureBlobRequestOptions {
  /** First byte to read (inclusive). Omitted reads from the start. */
  offset?: number;
  /** Number of bytes to read. Omitted reads to the end. */
  count?: number;
  /** Conditions the service must satisfy before returning the body. */
  conditions?: { ifModifiedSince?: Date; ifUnmodifiedSince?: Date; ifMatch?: string; ifNoneMatch?: string };
}

/** A streamed blob body plus the headers that describe it. */
export interface IAzureBlobDownload {
  /** Node readable stream. The caller owns it and must consume or destroy it. */
  stream: Readable;
  contentLength?: number;
  contentType?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  cacheControl?: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
  /** `bytes start-end/total` for a ranged read. */
  contentRange?: string;
}

/** Options for {@link AzureBlobStorageService.getBlobProperties}. */
export type IAzureBlobGetPropertiesOptions = IAzureBlobRequestOptions;

/** The full property set of one blob. */
export interface IAzureBlobProperties {
  containerName: string;
  name: string;
  blobType?: string;
  contentLength?: number;
  contentType?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  cacheControl?: string;
  contentMD5?: string;
  etag?: string;
  lastModified?: Date;
  createdOn?: Date;
  accessTier?: string;
  accessTierChangedOn?: Date;
  leaseStatus?: string;
  leaseState?: string;
  serverEncrypted?: boolean;
  copyId?: string;
  copyStatus?: string;
  copySource?: string;
  metadata?: Record<string, string>;
}

/** Options for {@link AzureBlobStorageService.deleteBlob}. */
export interface IAzureBlobDeleteOptions extends IAzureBlobRequestOptions {
  /** `include` deletes snapshots with the base blob; `only` deletes just the snapshots. */
  deleteSnapshots?: 'include' | 'only';
  conditions?: { ifModifiedSince?: Date; ifUnmodifiedSince?: Date; ifMatch?: string; ifNoneMatch?: string };
}

/** Result of {@link AzureBlobStorageService.setBlobMetadata}. */
export interface IAzureBlobMetadataResult {
  containerName: string;
  blobName: string;
  metadata: Record<string, string>;
  etag?: string;
  lastModified?: Date;
  requestId?: string;
}

/**
 * Blob-level permissions a SAS may grant. Mirrors the SDK's `BlobSASPermissionsLike`
 * so a caller can pass the object straight through without importing the SDK.
 *
 * Keep the set minimal: a SAS is a bearer credential, so every extra letter widens
 * the blast radius of a leaked URL.
 */
export interface IAzureBlobSasPermissions {
  /** Read the blob's content, properties and metadata. */
  read?: boolean;
  /** Append blocks (append blobs). */
  add?: boolean;
  /** Create a new blob. */
  create?: boolean;
  /** Write to an existing blob. */
  write?: boolean;
  /** Delete the blob. */
  delete?: boolean;
  /** Delete a version of the blob. */
  deleteVersion?: boolean;
  /** Read/write blob index tags. */
  tag?: boolean;
  /** Move the blob (rename). */
  move?: boolean;
  /** Execute (for hierarchical-namespace data lake workloads). */
  execute?: boolean;
  /** Set the immutability policy. */
  setImmutabilityPolicy?: boolean;
  /** Permanently delete a soft-deleted snapshot or version. */
  permanentDelete?: boolean;
}

/** Options for {@link AzureBlobStorageService.generateSasUrl} (the fifth argument). */
export interface IAzureBlobSasOptions extends IAzureBlobRequestOptions {
  /**
   * Start of the validity window. Defaults to one minute *before* "now" so a small
   * clock difference between this host and Azure Storage cannot invalidate a
   * fresh URL.
   */
  startsOn?: Date;
  /** Restrict the SAS to HTTPS. Defaults to `true` - never downgrade this. */
  httpsOnly?: boolean;
  /**
   * Optional IP range the SAS is valid from. `start` alone pins one address;
   * `start`+`end` allows an inclusive range (for example
   * `{ start: '203.0.113.0', end: '203.0.113.255' }`).
   */
  ipRange?: { start: string; end?: string };
}

/** The environment the service reads its account configuration from. */
export interface IAzureBlobStorageEnvironment {
  AZURE_STORAGE_CONNECTION_STRING?: string;
  AZURE_STORAGE_ACCOUNT?: string;
  AZURE_STORAGE_ACCOUNT_URL?: string;
  AZURE_STORAGE_KEY?: string;
}

/**
 * Default SAS validity in minutes.
 *
 * Five minutes is the shortest window that still tolerates a browser doing a
 * redirect plus one retry. A SAS grants its permission to *whoever holds the URL*;
 * see {@link AzureBlobStorageService.generateSasUrl}.
 */
export const DEFAULT_SAS_EXPIRY_MINUTES = 5;

/** Hard ceiling on a SAS lifetime: 24 hours. Longer-lived SAS URLs are a policy smell. */
export const MAX_SAS_EXPIRY_MINUTES = 24 * 60;

/** Clock-skew allowance subtracted from `startsOn` when the caller does not set one. */
export const SAS_CLOCK_SKEW_MS = 60 * 1000;

/** SDK default for `uploadStream` buffering: 8 MiB per block. */
export const DEFAULT_UPLOAD_STREAM_BUFFER_SIZE = 8 * 1024 * 1024;

/** SDK default for `uploadStream` parallelism: 5 blocks in flight. */
export const DEFAULT_UPLOAD_STREAM_MAX_CONCURRENCY = 5;

/**
 * Upper bound on pages the service will walk while following continuation tokens.
 *
 * A listing that exceeds this is almost certainly a bug in the caller's prefix, not
 * a legitimate result: the method throws rather than silently truncating. 1000 pages
 * at the maximum 5000 items per page is 5 million blobs.
 */
export const MAX_LIST_PAGES = 1000;

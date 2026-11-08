/**
 * OneDrive (Microsoft Graph drive) domain types and the `AzureDriveService` contract.
 *
 * Two rules shape this file:
 *
 *  1. **A pre-authenticated URL never leaves the service.** Graph answers
 *     `/items/{id}/content` and `/thumbnails/.../content` with a 302 to a
 *     short-lived storage URL that needs no credential. Handing that URL to a
 *     browser turns a scoped, revocable Graph grant into an anonymous download
 *     handle. `IDriveDownload` and `IDriveThumbnail` therefore expose a *stream*
 *     plus metadata, never a URL - the HTTP proxy in `routes/proxy.ts` pipes the
 *     bytes instead.
 *  2. **Every identifier and path segment is encoded by the service**, not by the
 *     caller. Two encoders are used deliberately: `IDriveItem#id` (and every
 *     other opaque id) goes through `encodeDriveId`, a full `encodeURIComponent`
 *     so a `/` inside an id cannot invent a path level, while a *path*
 *     (`getItemByPath`) goes through `encodePathSegment`, which preserves the
 *     separators it is meant to walk. Either way a filename such as
 *     `a b#c?.txt` must not be able to change the request path.
 */
import type { Readable } from 'stream';

/** One page of a Graph collection, normalised away from `@odata` casing. */
export interface IDrivePage<T> {
  items: T[];
  /** `@odata.nextLink` - the opaque cursor for the next page, when one exists. */
  nextLink?: string;
  /** `@odata.count` - only present when the caller asked for it. */
  count?: number;
}

/** Storage quota of a drive. */
export interface IDriveQuota {
  deleted?: number;
  remaining?: number;
  state?: string;
  total?: number;
  used?: number;
}

/** An identity (owner, last modifier, granted-to principal). */
export interface IDriveIdentity {
  id?: string;
  displayName?: string;
  email?: string;
}

/** A drive (`/me/drive` or one entry of `/drives`). */
export interface IDrive {
  id: string;
  name?: string;
  description?: string;
  driveType?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  owner?: IDriveIdentity;
  quota?: IDriveQuota;
}

/** The `folder` facet - its presence marks an item as a folder. */
export interface IDriveFolderFacet {
  childCount?: number;
}

/** The `file` facet - its presence marks an item as a file. */
export interface IDriveFileFacet {
  mimeType?: string;
  hashes?: {
    quickXorHash?: string;
    sha1Hash?: string;
    sha256Hash?: string;
    crc32Hash?: string;
  };
}

/** Where an item lives. */
export interface IDriveParentReference {
  id?: string;
  driveId?: string;
  driveType?: string;
  name?: string;
  path?: string;
  siteId?: string;
  shareId?: string;
}

/** A thumbnail rendition link. The `url` is stripped before the item is returned. */
export interface IDriveThumbnailLink {
  url?: string;
  width?: number;
  height?: number;
}

/** A set of thumbnail renditions (`small`, `medium`, `large`). */
export interface IDriveThumbnailSet {
  id?: string;
  small?: IDriveThumbnailLink;
  medium?: IDriveThumbnailLink;
  large?: IDriveThumbnailLink;
}

/**
 * A drive item (file, folder or package).
 *
 * `@microsoft.graph.downloadUrl` is deliberately typed as *never requested* and
 * is scrubbed by the service when Graph volunteers it - see
 * `AzureDriveService#sanitiseItem`.
 */
export interface IDriveItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  eTag?: string;
  cTag?: string;
  createdBy?: { user?: IDriveIdentity };
  lastModifiedBy?: { user?: IDriveIdentity };
  parentReference?: IDriveParentReference;
  folder?: IDriveFolderFacet;
  file?: IDriveFileFacet;
  deleted?: { state?: string };
  shared?: { scope?: string; owner?: IDriveIdentity };
  package?: { type?: string };
  thumbnails?: IDriveThumbnailSet[];
}

/** A sharing permission on an item (also the shape of a share link). */
export interface IDrivePermission {
  id: string;
  roles?: string[];
  shareId?: string;
  hasPassword?: boolean;
  expirationDateTime?: string;
  grantedToV2?: {
    user?: IDriveIdentity;
    group?: IDriveIdentity;
    siteGroup?: IDriveIdentity;
    siteUser?: IDriveIdentity;
    application?: IDriveIdentity;
  };
  grantedToIdentitiesV2?: Array<{
    user?: IDriveIdentity;
    group?: IDriveIdentity;
    siteGroup?: IDriveIdentity;
    siteUser?: IDriveIdentity;
  }>;
  invitedBy?: { user?: IDriveIdentity };
  invitation?: {
    invitedBy?: { user?: IDriveIdentity };
    invitedDateTime?: string;
    email?: string;
    signInRequired?: boolean;
  };
  link?: {
    type?: string;
    scope?: string;
    webUrl?: string;
  };
  inheritedFrom?: IDriveParentReference;
}

/** A previous version of a file. */
export interface IDriveVersion {
  id: string;
  lastModifiedDateTime?: string;
  size?: number;
  lastModifiedBy?: { user?: IDriveIdentity };
  publication?: { level?: string; versionId?: string };
}

/** A recipient accepted by `inviteCollaborators`. */
export interface IDriveInviteRecipient {
  email: string;
  name?: string;
}

/** The outcome of `copyItem` - Graph copies asynchronously and returns a monitor. */
export interface IDriveCopyResult {
  status: 'completed' | 'inProgress' | 'failed';
  /** The Graph monitor URL; safe to expose (it carries no credential of its own). */
  monitorUrl?: string;
  itemId?: string;
  item?: IDriveItem;
  /** Populated when the copy failed or the monitor timed out. */
  message?: string;
}

/** A streamed download. There is intentionally no `url` property. */
export interface IDriveDownload {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
  /** The `Content-Disposition` Graph returned, when it returned one. */
  contentDisposition?: string;
  fileName?: string;
}

/** A streamed thumbnail rendition. There is intentionally no `url` property. */
export interface IDriveThumbnail {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
}

/** The upload session Graph hands back above the simple-upload limit. */
export interface IDriveUploadSession {
  uploadUrl: string;
  expirationDateTime?: string;
  nextExpectedRanges?: string[];
}

/** Addressing options shared by every item-scoped method. */
export interface IDriveRequestOptions {
  /** Target a specific drive (`/drives/{id}`) instead of the user's default drive. */
  driveId?: string;
}

/** Options for `listChildren`. */
export interface IDriveListOptions extends IDriveRequestOptions {
  top?: number;
  select?: string | string[];
  orderBy?: string | string[];
  /** Opaque `@odata.nextLink` returned by a previous page. */
  nextLink?: string;
}

/** Options for `search`. */
export interface IDriveSearchOptions extends IDriveRequestOptions {
  top?: number;
  select?: string | string[];
  nextLink?: string;
}

/** Options for `downloadItem`. */
export interface IDriveDownloadOptions extends IDriveRequestOptions {
  /** Override the `Content-Disposition` produced by the proxy route. */
  fileName?: string;
}

/** Options for `getThumbnail`. */
export interface IDriveThumbnailOptions extends IDriveRequestOptions {
  /** Rendition to fetch. Defaults to `large`. */
  size?: 'small' | 'medium' | 'large';
  /** Thumbnail set index; Graph returns `0` for the first set. */
  thumbId?: number | string;
}

/** Options for `uploadItem`. */
export interface IDriveUploadOptions extends IDriveRequestOptions {
  contentType?: string;
  /** What Graph should do when the name already exists. Defaults to `rename`. */
  conflictBehavior?: 'rename' | 'replace' | 'fail';
  /**
   * Fragment size for a resumable upload. Must be a multiple of
   * {@link DRIVE_UPLOAD_CHUNK_MULTIPLE} and at most 60 MiB, per Graph.
   */
  chunkSize?: number;
}

/** Options for `copyItem`. */
export interface IDriveCopyOptions extends IDriveRequestOptions {
  name?: string;
  /** Wait for the asynchronous copy to finish. Defaults to `true`. */
  wait?: boolean;
  /** Delay between monitor polls, in milliseconds. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Maximum monitor polls before returning `inProgress`. Defaults to 30. */
  maxPollAttempts?: number;
}

/** Options for `moveItem`. */
export interface IDriveMoveOptions extends IDriveRequestOptions {
  name?: string;
}

/** Options for `createShareLink`. */
export interface IDriveShareLinkOptions {
  type?: 'view' | 'edit' | 'embed';
  scope?: 'anonymous' | 'organization';
  expirationDateTime?: string;
  password?: string;
  retainInheritedPermissions?: boolean;
}

/** Options for `inviteCollaborators`. */
export interface IDriveInviteOptions {
  role?: 'read' | 'write';
  message?: string;
  sendInvitation?: boolean;
  requireSignIn?: boolean;
}

/**
 * Graph's **simple upload** ceiling: 4 MiB.
 *
 * At or below it a single `PUT …:/content` carries the bytes; above it Graph
 * requires a resumable upload session. The boundary is inclusive of 4 MiB
 * because the limit is documented as "up to 4 MB".
 */
export const DRIVE_SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Graph requires every upload fragment to be a multiple of **320 KiB**
 * (327,680 bytes).
 */
export const DRIVE_UPLOAD_CHUNK_MULTIPLE = 320 * 1024;

/**
 * The fragment size used for resumable uploads: 10 MiB = 32 x 320 KiB.
 *
 * Microsoft's documented example uses 10 MiB, and it stays well below the 60 MiB
 * per-fragment ceiling, so a retry only ever costs one fragment.
 */
export const DRIVE_UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024;

/** A single HTTP hop issued by the service's binary transport. */
export interface IDriveHttpRequest {
  url: string;
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  /**
   * `manual` stops at the 3xx so the caller can inspect `Location` and make a
   * second, credential-free request. `follow` lets the runtime follow redirects.
   */
  redirect?: 'manual' | 'follow';
  body?: Buffer | string;
}

/** A single HTTP response returned by the service's binary transport. */
export interface IDriveHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** A Node stream, a WHATWG stream, an async iterable or a Buffer. */
  body?: unknown;
}

/**
 * The seam the service uses for byte transfers.
 *
 * It exists (rather than routing everything through the Graph SDK) for two
 * reasons, both security-driven: the SDK cannot be told to *stop* at a 302, and
 * its auth middleware would attach the bearer token to whatever host the
 * redirect names. Tests replace this implementation; production uses `fetch`.
 */
export type DriveHttpClient = (request: IDriveHttpRequest) => Promise<IDriveHttpResponse>;

/**
 * The public contract of `azure.AzureDriveService@1.0.0`.
 *
 * Every method is `userId`-first, fails with an `ApiError` carrying the Graph
 * `code`, and never returns an empty placeholder in place of an error.
 */
export interface IAzureDriveService {
  /** `GET /me/drive`. */
  getDefaultDrive(userId: string): Promise<IDrive>;

  /** `GET /drives` - every drive the user can reach. */
  listDrives(userId: string): Promise<IDrive[]>;

  /** `GET /me/drive/root/children` or `…/items/{itemId}/children`, paged. */
  listChildren(
    userId: string,
    itemId?: string | null,
    options?: IDriveListOptions,
  ): Promise<IDrivePage<IDriveItem>>;

  /** `GET …/items/{itemId}`. */
  getItem(
    userId: string,
    itemId: string,
    options?: IDriveRequestOptions,
  ): Promise<IDriveItem>;

  /** `GET /me/drive/root:/{path}` with every path segment percent-encoded. */
  getItemByPath(
    userId: string,
    path: string,
    options?: IDriveRequestOptions,
  ): Promise<IDriveItem>;

  /** `GET /me/drive/root/search(q='{query}')` with the query encoded. */
  search(
    userId: string,
    query: string,
    options?: IDriveSearchOptions,
  ): Promise<IDrivePage<IDriveItem>>;

  /**
   * Download the bytes of an item.
   *
   * Issues `GET …/items/{itemId}/content`; when Graph answers 302, the
   * pre-authenticated storage URL is fetched **without** an `Authorization`
   * header. The bytes are returned as a stream and the URL is never returned.
   */
  downloadItem(
    userId: string,
    itemId: string,
    options?: IDriveDownloadOptions,
  ): Promise<IDriveDownload>;

  /**
   * Upload bytes to `parentId` (or the drive root).
   *
   * At or below {@link DRIVE_SIMPLE_UPLOAD_MAX_BYTES} this is a single
   * `PUT …:/{name}:/content`; above it a resumable `createUploadSession` with
   * {@link DRIVE_UPLOAD_CHUNK_SIZE} fragments is used.
   */
  uploadItem(
    userId: string,
    parentId: string | null,
    fileName: string,
    content: Buffer | string,
    options?: IDriveUploadOptions,
  ): Promise<IDriveItem>;

  /** Create a folder under `parentId` (or the drive root). */
  createFolder(
    userId: string,
    name: string,
    parentId?: string | null,
    options?: IDriveRequestOptions & { conflictBehavior?: 'rename' | 'replace' | 'fail' },
  ): Promise<IDriveItem>;

  /** Move an item (and optionally rename it) to another folder. */
  moveItem(
    userId: string,
    itemId: string,
    parentId: string,
    options?: IDriveMoveOptions,
  ): Promise<IDriveItem>;

  /** Copy an item and follow Graph's asynchronous monitor to completion. */
  copyItem(
    userId: string,
    itemId: string,
    parentId: string,
    options?: IDriveCopyOptions,
  ): Promise<IDriveCopyResult>;

  /** `DELETE …/items/{itemId}` - moves the item to the recycle bin. */
  deleteItem(userId: string, itemId: string, options?: IDriveRequestOptions): Promise<void>;

  /** `POST …/items/{itemId}/restore` - restores a recycled item. */
  restoreItem(userId: string, itemId: string, options?: IDriveRequestOptions): Promise<IDriveItem>;

  /** Create an anonymous or organisation-scoped sharing link. */
  createShareLink(
    userId: string,
    itemId: string,
    options?: IDriveShareLinkOptions & IDriveRequestOptions,
  ): Promise<IDrivePermission>;

  /** Grant read or write access to a list of recipients. */
  inviteCollaborators(
    userId: string,
    itemId: string,
    recipients: Array<string | IDriveInviteRecipient>,
    options?: IDriveInviteOptions & IDriveRequestOptions,
  ): Promise<IDrivePermission[]>;

  /** `GET …/items/{itemId}/permissions`. */
  listPermissions(
    userId: string,
    itemId: string,
    options?: IDriveRequestOptions,
  ): Promise<IDrivePermission[]>;

  /** `DELETE …/items/{itemId}/permissions/{permissionId}`. */
  deletePermission(
    userId: string,
    itemId: string,
    permissionId: string,
    options?: IDriveRequestOptions,
  ): Promise<void>;

  /** `GET …/items/{itemId}/versions`. */
  listVersions(
    userId: string,
    itemId: string,
    options?: IDriveRequestOptions,
  ): Promise<IDriveVersion[]>;

  /** `POST …/items/{itemId}/versions/{versionId}/restore`. */
  restoreVersion(
    userId: string,
    itemId: string,
    versionId: string,
    options?: IDriveRequestOptions,
  ): Promise<void>;

  /** Fetch a thumbnail rendition as a stream (the URL is never returned). */
  getThumbnail(
    userId: string,
    itemId: string,
    options?: IDriveThumbnailOptions,
  ): Promise<IDriveThumbnail>;
}

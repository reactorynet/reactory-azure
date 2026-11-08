import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import { Readable } from 'stream';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import type ApiError from '@reactory/server-core/exceptions';
import type { AzureTokenSource } from '../types/azure.types';
import {
  DRIVE_SIMPLE_UPLOAD_MAX_BYTES,
  DRIVE_UPLOAD_CHUNK_MULTIPLE,
  DRIVE_UPLOAD_CHUNK_SIZE,
  type DriveHttpClient,
  type IAzureDriveService,
  type IDrive,
  type IDriveCopyOptions,
  type IDriveCopyResult,
  type IDriveDownload,
  type IDriveDownloadOptions,
  type IDriveHttpRequest,
  type IDriveHttpResponse,
  type IDriveInviteOptions,
  type IDriveInviteRecipient,
  type IDriveItem,
  type IDriveListOptions,
  type IDriveMoveOptions,
  type IDrivePage,
  type IDrivePermission,
  type IDriveRequestOptions,
  type IDriveSearchOptions,
  type IDriveShareLinkOptions,
  type IDriveThumbnail,
  type IDriveThumbnailOptions,
  type IDriveUploadOptions,
  type IDriveUploadSession,
  type IDriveVersion,
} from '../types/drive.types';
import { GRAPH_BASE_URL } from './graph/AzureGraphClientProvider';
import { encodePathSegment, escapeODataString } from '../utils/odata';
import { GraphErrorCode, apiError, readHeader, toGraphApiError } from '../utils/graph-error';

/**
 * Error codes the drive service raises itself.
 *
 * Graph's own codes (`itemNotFound`, `accessDenied`, ...) arrive unchanged
 * through `toGraphApiError`; these cover the four failures that never reach
 * Graph: a missing name, an unaddressable path, an invalid fragment size and a
 * redirect Graph would not explain.
 */
export const DRIVE_ERROR_CODES = {
  INVALID_NAME: 'InvalidDriveItemName',
  INVALID_PATH: 'InvalidDrivePath',
  INVALID_SEARCH_QUERY: 'InvalidDriveSearchQuery',
  INVALID_UPLOAD_CHUNK_SIZE: 'InvalidUploadChunkSize',
  INVALID_REDIRECT: 'InvalidDriveRedirect',
  MISSING_UPLOAD_URL: 'UploadSessionMissingUrl',
} as const;

/** Graph's v1.0 root. The SDK prepends this itself; the raw transport must be told. */
const GRAPH_V1 = `${GRAPH_BASE_URL}/v1.0`;

/** Largest fragment Graph accepts for a resumable upload. */
const DRIVE_UPLOAD_CHUNK_MAX = 60 * 1024 * 1024;

/** Cap on a JSON/text body read from the raw transport (an error page, a monitor). */
const RAW_BODY_LIMIT = 1024 * 1024;

/** Statuses that can carry a `Location` to a pre-authenticated URL. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The subset of a Graph collection payload this service reads. */
interface IGraphCollection<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.count'?: number;
}

/** Options the drive service accepts for its raw transport calls. */
interface IBinaryOptions {
  operation: string;
  fileName?: string;
}

/**
 * The slice of `AzureGraphClientProvider` this service calls.
 *
 * Declaring it (rather than reaching for `any`) keeps the type arguments on
 * `request`/`requestAll` meaningful and documents that drive reads always go
 * through the module's single provider.
 */
interface IDriveGraphProvider {
  request<T>(userId: string, path: string, options?: Record<string, unknown>): Promise<T>;
  requestAll<T>(userId: string, path: string, options?: Record<string, unknown>): Promise<T[]>;
  getClient(userId: string): any;
}

/** The slice of `AzureAuthService` used by the authenticated download hop. */
interface IDriveAuthService {
  getToken(userId: string): Promise<{ token: string; source?: AzureTokenSource }>;
}
/**
 * The production transport: `fetch` with an explicit redirect policy.
 *
 * `redirect: 'manual'` is what makes the two-hop download safe: the runtime
 * hands the 302 back instead of following it, so the service decides - and
 * decides *without* the `Authorization` header - whether the storage host is
 * contacted.
 */
const defaultDriveHttpClient: DriveHttpClient = async (request: IDriveHttpRequest) => {
  const fetchImpl: any = (globalThis as any).fetch;

  if (typeof fetchImpl !== 'function') {
    throw apiError(
      GraphErrorCode.GRAPH_REQUEST_FAILED,
      'No fetch implementation is available for drive byte transfers',
    );
  }

  const init: Record<string, unknown> = {
    method: request.method,
    headers: request.headers || {},
    redirect: request.redirect === 'manual' ? 'manual' : 'follow',
  };

  if (request.body !== undefined) {
    init.body = request.body;
  }

  const response: any = await fetchImpl(request.url, init);

  const headers: Record<string, string> = {};
  if (response?.headers && typeof response.headers.forEach === 'function') {
    response.headers.forEach((value: string, key: string) => {
      headers[String(key).toLowerCase()] = String(value);
    });
  }

  return {
    status: Number(response?.status) || 0,
    headers,
    body: response?.body ?? undefined,
  };
};

/**
 * The active transport. Replaced in tests, which is why the seam exists: the
 * repository has no Azure tenant, so no live Graph call may be made.
 */
let activeDriveHttpClient: DriveHttpClient = defaultDriveHttpClient;

/** Install a transport for byte transfers; `null` restores the `fetch` default. */
export function setDriveHttpClient(client?: DriveHttpClient | null): void {
  activeDriveHttpClient = client || defaultDriveHttpClient;
}

/** The active byte-transfer transport. */
export function getDriveHttpClient(): DriveHttpClient {
  return activeDriveHttpClient;
}

/**
 * `Readable.from` behind a typed alias.
 *
 * The repository pins `@types/node` 10.17.60, whose `stream` module predates
 * `Readable.from`, even though every runtime this server supports (Node 18+) has
 * it. Aliasing keeps this module type-buildable without hand-rolling a pump for
 * the Buffer, string, async-iterable and empty cases - and the two cases that do
 * need a pump (a WHATWG stream when `Readable.fromWeb` is unavailable) have one.
 */
const readableFrom: (source: any) => Readable = (Readable as any).from.bind(Readable);

/**
 * Percent-encode a single **identifier** (item id, drive id, permission id).
 *
 * `encodePathSegment` deliberately keeps `/` so a *path* can be addressed; an id
 * is a single segment, so a `/` in one must be encoded or it would invent an
 * extra path level. Graph ids are opaque, and `!` (which `encodeURIComponent`
 * leaves alone) is legal in them.
 */
export function encodeDriveId(id: string): string {
  return encodeURIComponent(String(id ?? ''));
}

/**
 * Percent-encode an OData `$search`-style function argument.
 *
 * The single quote is OData's string delimiter and is escaped by doubling it
 * *before* percent-encoding, so `O'Brien` becomes `O%27%27Brien`-equivalent
 * (`''`, left literal by `encodeURIComponent`) rather than terminating the
 * literal. Spaces, `#`, `?`, `&` and `=` are all encoded, so a query can never
 * change the request path.
 */
export function encodeDriveSearchTerm(query: string): string {
  return encodeURIComponent(escapeODataString(String(query ?? '').trim()));
}

/**
 * `azure.AzureDriveService@1.0.0` - OneDrive over Microsoft Graph.
 *
 * Reads go through `AzureGraphClientProvider` (the module's single Graph client
 * factory, which owns auth, retry, pagination and error translation). Small
 * writes go through the client it hands out. Byte transfers use an explicit
 * transport, because that is the only way to honour the two non-negotiables:
 * stop at the 302 and never send the bearer token to the storage host, and
 * percent-encode every path segment. Nothing here logs a token or returns a
 * pre-authenticated URL.
 */
@service({
  id: 'azure.AzureDriveService@1.0.0',
  name: 'AzureDriveService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'OneDrive drive, file, upload, sharing and version operations over Microsoft Graph',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphProvider' },
    { id: 'azure.AzureAuthService@1.0.0', alias: 'authService' },
  ],
})
class AzureDriveService implements IAzureDriveService, Reactory.Service.IReactoryService {
  name: string = 'AzureDriveService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphProvider: any;
  private _authService: any;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `graphProvider` dependency alias. */
  setGraphProvider(serviceInstance: any): void {
    this._graphProvider = serviceInstance;
  }

  /** Bound by the Reactory service container from the `authService` dependency alias. */
  setAuthService(serviceInstance: any): void {
    this._authService = serviceInstance;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** `GET /me/drive` - the signed-in user's default drive. */
  async getDefaultDrive(userId: string): Promise<IDrive> {
    const uid = this.resolveUserId(userId);

    return this.requestJson<IDrive>(uid, '/me/drive', { operation: 'drive.getDefaultDrive' });
  }

  /** `GET /drives` - every drive the user can reach. */
  async listDrives(userId: string): Promise<IDrive[]> {
    const uid = this.resolveUserId(userId);

    return this.requestAll<IDrive>(uid, '/drives', { operation: 'drive.listDrives' });
  }

  /**
   * `GET …/root/children` or `GET …/items/{itemId}/children`, one page at a time.
   *
   * Pass the returned `nextLink` back in `options.nextLink` to continue. Paging is
   * deliberately explicit here (rather than `requestAll`) because a folder can
   * legitimately hold tens of thousands of entries and a caller must be able to
   * stream them rather than materialise them.
   */
  async listChildren(
    userId: string,
    itemId?: string | null,
    options: IDriveListOptions = {},
  ): Promise<IDrivePage<IDriveItem>> {
    const uid = this.resolveUserId(userId);
    const base = this.driveBase(options);

    const target = options.nextLink
      || (itemId
        ? `${base}/items/${encodeDriveId(itemId)}/children`
        : `${base}/root/children`);

    const page = await this.requestJson<IGraphCollection<IDriveItem>>(uid, target, {
      operation: 'drive.listChildren',
      ...(options.nextLink ? { url: options.nextLink } : {}),
      ...(options.top !== undefined ? { top: options.top } : {}),
      ...(options.select !== undefined ? { select: options.select } : {}),
      ...(options.orderBy !== undefined ? { orderBy: options.orderBy } : {}),
    });

    return this.toPage(page);
  }

  /** `GET …/items/{itemId}`. */
  async getItem(
    userId: string,
    itemId: string,
    options: IDriveRequestOptions = {},
  ): Promise<IDriveItem> {
    const uid = this.resolveUserId(userId);
    const item = await this.requestJson<IDriveItem>(
      uid,
      this.itemPath(itemId, options),
      { operation: 'drive.getItem' },
    );

    return this.requireItem(item, 'drive.getItem');
  }

  /**
   * `GET …/root:/{path}` - address an item by its human-readable path.
   *
   * Every segment is percent-encoded, so `a b#c?.txt` becomes
   * `a%20b%23c%3F.txt`: a `#` can no longer truncate the request at a fragment
   * and a `?` can no longer be read as the start of a query string.
   */
  async getItemByPath(
    userId: string,
    path: string,
    options: IDriveRequestOptions = {},
  ): Promise<IDriveItem> {
    const uid = this.resolveUserId(userId);
    const relative = String(path ?? '').replace(/^\/+/, '');

    if (!relative.trim()) {
      throw apiError(DRIVE_ERROR_CODES.INVALID_PATH, 'A drive item path is required', {
        operation: 'drive.getItemByPath',
      });
    }

    const item = await this.requestJson<IDriveItem>(
      uid,
      `${this.driveBase(options)}/root:/${encodePathSegment(relative)}`,
      { operation: 'drive.getItemByPath' },
    );

    return this.requireItem(item, 'drive.getItemByPath');
  }

  /**
   * `GET …/root/search(q='{query}')`.
   *
   * The term is quoted as an OData literal (embedded quotes doubled) and then
   * percent-encoded, so neither the quotes nor a `#`/`?`/space can escape the
   * function argument.
   */
  async search(
    userId: string,
    query: string,
    options: IDriveSearchOptions = {},
  ): Promise<IDrivePage<IDriveItem>> {
    const uid = this.resolveUserId(userId);
    const term = String(query ?? '').trim();

    if (!term) {
      throw apiError(
        DRIVE_ERROR_CODES.INVALID_SEARCH_QUERY,
        'A drive search query is required',
        { operation: 'drive.search' },
      );
    }

    const target = options.nextLink
      || `${this.driveBase(options)}/root/search(q='${encodeDriveSearchTerm(term)}')`;

    const page = await this.requestJson<IGraphCollection<IDriveItem>>(uid, target, {
      operation: 'drive.search',
      ...(options.nextLink ? { url: options.nextLink } : {}),
      ...(options.top !== undefined ? { top: options.top } : {}),
      ...(options.select !== undefined ? { select: options.select } : {}),
    });

    return this.toPage(page);
  }

  // ---------------------------------------------------------------------------
  // Byte transfers
  // ---------------------------------------------------------------------------

  /**
   * Download the bytes of an item as a stream.
   *
   * Hop 1 is `GET …/items/{itemId}/content` against Graph, authenticated and
   * with `redirect: 'manual'`. Hop 2 is the `Location` Graph returned, fetched
   * **with no `Authorization` header at all** - forwarding it would hand the
   * user's Graph bearer token to the storage host. The pre-authenticated URL is
   * returned to nobody: the caller gets a stream and the response metadata.
   */
  async downloadItem(
    userId: string,
    itemId: string,
    options: IDriveDownloadOptions = {},
  ): Promise<IDriveDownload> {
    const uid = this.resolveUserId(userId);

    return this.fetchBinary(uid, this.itemPath(itemId, options, 'content'), {
      operation: 'drive.downloadItem',
      fileName: options.fileName,
    });
  }

  /**
   * Fetch a thumbnail rendition as a stream.
   *
   * Same redirect discipline as {@link downloadItem}: Graph's thumbnail URLs are
   * pre-authenticated too, so the bytes are proxied and the URL is never exposed.
   */
  async getThumbnail(
    userId: string,
    itemId: string,
    options: IDriveThumbnailOptions = {},
  ): Promise<IDriveThumbnail> {
    const uid = this.resolveUserId(userId);
    const size = options.size || 'large';
    const thumbId = options.thumbId === undefined || options.thumbId === null ? 0 : options.thumbId;

    const path = `${this.itemPath(itemId, options)}/thumbnails/`
      + `${encodeDriveId(String(thumbId))}/${encodeDriveId(size)}/content`;

    const binary = await this.fetchBinary(uid, path, { operation: 'drive.getThumbnail' });

    return {
      stream: binary.stream,
      contentType: binary.contentType,
      contentLength: binary.contentLength,
    };
  }

  /**
   * Upload bytes into `parentId` (or the drive root).
   *
   * At or below 4 MiB Graph accepts a single `PUT …:/{name}:/content`. Above it
   * the service creates a resumable session and sends
   * {@link DRIVE_UPLOAD_CHUNK_SIZE} (10 MiB = 32 x 320 KiB) fragments, resuming
   * from `nextExpectedRanges` when Graph answers 416.
   */
  async uploadItem(
    userId: string,
    parentId: string | null,
    fileName: string,
    content: Buffer | string,
    options: IDriveUploadOptions = {},
  ): Promise<IDriveItem> {
    const uid = this.resolveUserId(userId);
    const name = this.validateName(fileName, 'drive.uploadItem');
    const buffer = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content === undefined || content === null ? '' : String(content), 'utf8');
    const contentType = options.contentType || 'application/octet-stream';
    const conflictBehavior = options.conflictBehavior || 'rename';
    const addressed = this.addressedItemPath(parentId, name, options);

    if (buffer.length <= DRIVE_SIMPLE_UPLOAD_MAX_BYTES) {
      const target = `${addressed}/content?@microsoft.graph.conflictBehavior=`
        + encodeURIComponent(conflictBehavior);

      const item = await this.graphWrite<IDriveItem>(
        uid,
        'drive.uploadItem.simple',
        target,
        'put',
        buffer,
        { headers: { 'Content-Type': contentType } },
      );

      return this.requireItem(item, 'drive.uploadItem.simple');
    }

    return this.uploadInSession(uid, addressed, name, buffer, {
      operation: 'drive.uploadItem.session',
      contentType,
      conflictBehavior,
      chunkSize: options.chunkSize,
    });
  }

  // ---------------------------------------------------------------------------
  // Structure
  // ---------------------------------------------------------------------------

  /** Create a folder under `parentId` (or the drive root). */
  async createFolder(
    userId: string,
    name: string,
    parentId?: string | null,
    options: IDriveRequestOptions & { conflictBehavior?: 'rename' | 'replace' | 'fail' } = {},
  ): Promise<IDriveItem> {
    const uid = this.resolveUserId(userId);
    const folderName = this.validateName(name, 'drive.createFolder');
    const base = this.driveBase(options);
    const target = parentId
      ? `${base}/items/${encodeDriveId(parentId)}/children`
      : `${base}/root/children`;

    const item = await this.graphWrite<IDriveItem>(uid, 'drive.createFolder', target, 'post', {
      name: folderName,
      folder: {},
      '@microsoft.graph.conflictBehavior': options.conflictBehavior || 'rename',
    });

    return this.requireItem(item, 'drive.createFolder');
  }

  /** Move an item (and optionally rename it) into `parentId`. */
  async moveItem(
    userId: string,
    itemId: string,
    parentId: string,
    options: IDriveMoveOptions = {},
  ): Promise<IDriveItem> {
    const uid = this.resolveUserId(userId);
    const body: Record<string, unknown> = { parentReference: { id: parentId } };

    if (options.name) body.name = this.validateName(options.name, 'drive.moveItem');

    const item = await this.graphWrite<IDriveItem>(
      uid,
      'drive.moveItem',
      this.itemPath(itemId, options),
      'patch',
      body,
    );

    return this.requireItem(item, 'drive.moveItem');
  }

  /**
   * Copy an item into `parentId` and follow Graph's asynchronous monitor.
   *
   * Graph always answers `POST …/copy` with a monitor URL (`Location`) rather
   * than the new item, so "copy succeeded" is only knowable by polling. Polling
   * is bounded: a slow copy returns `inProgress` with the monitor URL instead of
   * hanging the request. Set `options.wait === false` to skip polling entirely.
   */
  async copyItem(
    userId: string,
    itemId: string,
    parentId: string,
    options: IDriveCopyOptions = {},
  ): Promise<IDriveCopyResult> {
    const uid = this.resolveUserId(userId);
    const body: Record<string, unknown> = { parentReference: { id: parentId } };

    if (options.name) body.name = this.validateName(options.name, 'drive.copyItem');

    const response = await this.graphWrite<any>(
      uid,
      'drive.copyItem',
      this.itemPath(itemId, options, 'copy'),
      'post',
      body,
      { headers: { Prefer: 'respond-async' }, raw: true },
    );

    const status = Number(response?.status) || 0;
    const monitorUrl = readHeader(response?.headers, 'location');

    if (!monitorUrl) {
      // A same-drive copy of a tiny item can complete inline: Graph then returns
      // 200 with the new item instead of a monitor.
      const payload = await this.readBodyAsJson(response).catch(() => undefined);
      const item = this.sanitiseItem(payload);

      if (item?.id) {
        return { status: 'completed', itemId: item.id, item };
      }

      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph accepted the copy but returned neither an item nor a monitor URL',
        { operation: 'drive.copyItem', status },
      );
    }

    const result: IDriveCopyResult = { status: 'inProgress', monitorUrl };
    if (options.wait === false) return result;

    return this.awaitCopy(uid, monitorUrl, options);
  }

  /** `DELETE …/items/{itemId}` - moves the item to the recycle bin. */
  async deleteItem(
    userId: string,
    itemId: string,
    options: IDriveRequestOptions = {},
  ): Promise<void> {
    const uid = this.resolveUserId(userId);

    await this.graphWrite<void>(uid, 'drive.deleteItem', this.itemPath(itemId, options), 'delete');
  }

  /** `POST …/items/{itemId}/restore` - restores an item from the recycle bin. */
  async restoreItem(
    userId: string,
    itemId: string,
    options: IDriveRequestOptions = {},
  ): Promise<IDriveItem> {
    const uid = this.resolveUserId(userId);
    const item = await this.graphWrite<IDriveItem>(
      uid,
      'drive.restoreItem',
      `${this.itemPath(itemId, options)}/restore`,
      'post',
    );

    return this.requireItem(item, 'drive.restoreItem');
  }

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  /** Create a sharing link (`POST …/items/{itemId}/createLink`). */
  async createShareLink(
    userId: string,
    itemId: string,
    options: IDriveShareLinkOptions & IDriveRequestOptions = {},
  ): Promise<IDrivePermission> {
    const uid = this.resolveUserId(userId);
    const body: Record<string, unknown> = {
      type: options.type || 'view',
      scope: options.scope || 'anonymous',
    };

    if (options.expirationDateTime) body.expirationDateTime = options.expirationDateTime;
    if (options.password) body.password = options.password;
    if (typeof options.retainInheritedPermissions === 'boolean') {
      body.retainInheritedPermissions = options.retainInheritedPermissions;
    }

    const permission = await this.graphWrite<IDrivePermission>(
      uid,
      'drive.createShareLink',
      `${this.itemPath(itemId, options)}/createLink`,
      'post',
      body,
    );

    if (!permission?.id) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned no permission for the share link',
        { operation: 'drive.createShareLink' },
      );
    }

    return permission;
  }

  /** Grant read/write access to recipients (`POST …/items/{itemId}/invite`). */
  async inviteCollaborators(
    userId: string,
    itemId: string,
    recipients: Array<string | IDriveInviteRecipient>,
    options: IDriveInviteOptions & IDriveRequestOptions = {},
  ): Promise<IDrivePermission[]> {
    const uid = this.resolveUserId(userId);

    const list = (Array.isArray(recipients) ? recipients : [])
      .map((recipient) => (typeof recipient === 'string'
        ? { email: recipient }
        : { email: recipient?.email, ...(recipient?.name ? { name: recipient.name } : {}) }))
      .filter((recipient) => Boolean(recipient.email));

    if (!list.length) {
      throw apiError(
        DRIVE_ERROR_CODES.INVALID_PATH,
        'At least one recipient email address is required to invite collaborators',
        { operation: 'drive.inviteCollaborators' },
      );
    }

    const response = await this.graphWrite<{ value?: IDrivePermission[] }>(
      uid,
      'drive.inviteCollaborators',
      `${this.itemPath(itemId, options)}/invite`,
      'post',
      {
        requireSignIn: options.requireSignIn !== false,
        sendInvitation: options.sendInvitation !== false,
        roles: [options.role || 'read'],
        recipients: list,
        ...(options.message ? { message: options.message } : {}),
      },
    );

    return Array.isArray(response?.value) ? response.value : [];
  }

  /** `GET …/items/{itemId}/permissions`. */
  async listPermissions(
    userId: string,
    itemId: string,
    options: IDriveRequestOptions = {},
  ): Promise<IDrivePermission[]> {
    const uid = this.resolveUserId(userId);

    return this.requestAll<IDrivePermission>(
      uid,
      `${this.itemPath(itemId, options)}/permissions`,
      { operation: 'drive.listPermissions' },
    );
  }

  /** `DELETE …/items/{itemId}/permissions/{permissionId}`. */
  async deletePermission(
    userId: string,
    itemId: string,
    permissionId: string,
    options: IDriveRequestOptions = {},
  ): Promise<void> {
    const uid = this.resolveUserId(userId);

    if (!permissionId) {
      throw apiError(DRIVE_ERROR_CODES.INVALID_PATH, 'A permissionId is required', {
        operation: 'drive.deletePermission',
      });
    }

    await this.graphWrite<void>(
      uid,
      'drive.deletePermission',
      `${this.itemPath(itemId, options)}/permissions/${encodeDriveId(permissionId)}`,
      'delete',
    );
  }

  // ---------------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------------

  /** `GET …/items/{itemId}/versions`. */
  async listVersions(
    userId: string,
    itemId: string,
    options: IDriveRequestOptions = {},
  ): Promise<IDriveVersion[]> {
    const uid = this.resolveUserId(userId);

    return this.requestAll<IDriveVersion>(
      uid,
      `${this.itemPath(itemId, options)}/versions`,
      { operation: 'drive.listVersions' },
    );
  }

  /** `POST …/items/{itemId}/versions/{versionId}/restore`. */
  async restoreVersion(
    userId: string,
    itemId: string,
    versionId: string,
    options: IDriveRequestOptions = {},
  ): Promise<void> {
    const uid = this.resolveUserId(userId);

    if (!versionId) {
      throw apiError(DRIVE_ERROR_CODES.INVALID_PATH, 'A versionId is required', {
        operation: 'drive.restoreVersion',
      });
    }

    await this.graphWrite<void>(
      uid,
      'drive.restoreVersion',
      `${this.itemPath(itemId, options)}/versions/${encodeDriveId(versionId)}/restore`,
      'post',
    );
  }

  // ---------------------------------------------------------------------------
  // Graph plumbing
  // ---------------------------------------------------------------------------

  /** The provider, bound by the container or resolved from the request context. */
  private get provider(): IDriveGraphProvider {
    const provider = (this._graphProvider
      || this.context?.getService?.('azure.AzureGraphClientProvider@1.0.0')) as IDriveGraphProvider | undefined;

    if (!provider) {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Azure Graph Client Provider is not available',
        { operation: 'drive.getProvider' },
      );
    }

    return provider;
  }

  /** The auth service, used only for the raw download hop. */
  private get authService(): IDriveAuthService | undefined {
    return (this._authService
      || this.context?.getService?.('azure.AzureAuthService@1.0.0')) as IDriveAuthService | undefined;
  }

  /** A `userId` is mandatory; fall back to the request context when omitted. */
  private resolveUserId(userId?: string): string {
    const uid = String(userId || (this.context as any)?.user?._id || '');

    if (!uid) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required for a drive operation', {
        operation: 'drive.resolveUserId',
      });
    }

    return uid;
  }

  /** `/me/drive` or `/drives/{driveId}`. */
  private driveBase(options?: IDriveRequestOptions): string {
    return options?.driveId ? `/drives/${encodeDriveId(options.driveId)}` : '/me/drive';
  }

  /** `…/items/{itemId}` plus an optional tail (`content`, `children`, ...). */
  private itemPath(itemId: string, options?: IDriveRequestOptions, tail?: string): string {
    if (!itemId) {
      throw apiError(DRIVE_ERROR_CODES.INVALID_PATH, 'A drive itemId is required', {
        operation: 'drive.itemPath',
      });
    }

    const item = `${this.driveBase(options)}/items/${encodeDriveId(itemId)}`;
    return tail ? `${item}/${tail}` : item;
  }

  /** `…/root:/{name}:` or `…/items/{parentId}:/{name}:` - the upload addressing form. */
  private addressedItemPath(
    parentId: string | null | undefined,
    name: string,
    options?: IDriveRequestOptions,
  ): string {
    const base = this.driveBase(options);
    const parent = parentId ? `${base}/items/${encodeDriveId(parentId)}` : `${base}/root`;

    return `${parent}:/${encodePathSegment(name)}:`;
  }

  /** One GET through the provider (retry, pagination-free). */
  private async requestJson<T>(userId: string, path: string, options: Record<string, unknown> = {}): Promise<T> {
    const operation = String(options.operation || 'drive.request');

    try {
      return await this.provider.request<T>(userId, path, options) as T;
    } catch (error) {
      throw this.translate(error, operation);
    }
  }

  /** Every page of a collection through the provider (bounded, throws at the bound). */
  private async requestAll<T>(userId: string, path: string, options: Record<string, unknown> = {}): Promise<T[]> {
    const operation = String(options.operation || 'drive.requestAll');

    try {
      const items = await this.provider.requestAll<T>(userId, path, options) as T[];
      return Array.isArray(items) ? items : [];
    } catch (error) {
      throw this.translate(error, operation);
    }
  }

  /**
   * One non-GET Graph call through the provider's client.
   *
   * Small JSON writes, and the `Prefer: respond-async` copy, do not benefit from
   * the raw transport - they need the module's single authenticated client and
   * nothing about redirects.
   */
  private async graphWrite<T>(
    userId: string,
    operation: string,
    path: string,
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    body?: unknown,
    options: { headers?: Record<string, string>; raw?: boolean } = {},
  ): Promise<T> {
    let request: any;

    try {
      request = this.provider.getClient(userId).api(path);
      if (options.headers) request = request.headers(options.headers);
      if (options.raw) request = request.responseType(ResponseType.RAW);

      const response = body === undefined
        ? await request[method]()
        : await request[method](body);

      return response as T;
    } catch (error) {
      throw this.translate(error, operation);
    }
  }

  /**
   * The two-hop binary fetch.
   *
   * Hop 1 carries the bearer token and `redirect: 'manual'`. If Graph answers
   * with a redirect, hop 2 goes to the `Location` with **no `Authorization`
   * header** - the URL is already pre-authenticated, and the token belongs to
   * `graph.microsoft.com`, not to the storage host.
   */
  private async fetchBinary(userId: string, path: string, options: IBinaryOptions): Promise<IDriveDownload> {
    const { token, source } = await this.getAccessToken(userId);

    let response = await this.send({
      url: `${GRAPH_V1}${path}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
      redirect: 'manual',
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = readHeader(response.headers, 'location');
      await this.discard(response.body);

      if (!location) {
        throw apiError(
          DRIVE_ERROR_CODES.INVALID_REDIRECT,
          `Microsoft Graph returned ${response.status} without a Location header`,
          { operation: options.operation, status: response.status },
        );
      }

      // No Authorization, no cookies: the storage URL must be contacted as an
      // anonymous consumer. This is the line the whole ticket hinges on.
      response = await this.send({
        url: location,
        method: 'GET',
        headers: { Accept: '*/*' },
        redirect: 'follow',
      });
    }

    if (response.status >= 400) {
      throw await this.httpFailure(response, options.operation, source);
    }

    if (response.status < 200 || response.status >= 300) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Unexpected status ${response.status} while transferring drive content`,
        { operation: options.operation, status: response.status },
      );
    }

    return {
      stream: this.toNodeStream(response.body),
      contentType: readHeader(response.headers, 'content-type'),
      contentLength: this.parseLength(readHeader(response.headers, 'content-length')),
      contentDisposition: readHeader(response.headers, 'content-disposition'),
      fileName: options.fileName,
    };
  }

  /** Upload bytes through a resumable session, fragment by fragment. */
  private async uploadInSession(
    userId: string,
    addressedPath: string,
    name: string,
    buffer: Buffer,
    options: {
      operation: string;
      contentType: string;
      conflictBehavior: 'rename' | 'replace' | 'fail';
      chunkSize?: number;
    },
  ): Promise<IDriveItem> {
    const session = await this.graphWrite<IDriveUploadSession>(
      userId,
      `${options.operation}.create`,
      `${addressedPath}/createUploadSession`,
      'post',
      {
        item: {
          '@microsoft.graph.conflictBehavior': options.conflictBehavior,
          name,
        },
      },
    );

    const uploadUrl = session?.uploadUrl;

    if (!uploadUrl) {
      throw apiError(
        DRIVE_ERROR_CODES.MISSING_UPLOAD_URL,
        'Microsoft Graph did not return an uploadUrl for the upload session',
        { operation: options.operation },
      );
    }

    const chunkSize = this.resolveChunkSize(options.chunkSize);
    let offset = 0;

    while (offset < buffer.length) {
      const end = Math.min(offset + chunkSize, buffer.length);
      const chunk = buffer.subarray(offset, end) as Buffer;

      const response = await this.send({
        url: uploadUrl,
        method: 'PUT',
        // The upload URL is pre-authenticated: it must not receive the bearer
        // token. `Content-Range` is what makes the upload resumable.
        headers: {
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${offset}-${end - 1}/${buffer.length}`,
          'Content-Type': options.contentType,
        },
        body: chunk,
      });

      if (response.status === 200 || response.status === 201) {
        const payload = await this.readBodyAsJson(response).catch(() => undefined);
        return this.requireItem(payload, options.operation);
      }

      if (response.status === 202) {
        const payload = await this.readBodyAsJson(response).catch(() => undefined);
        const next = this.parseNextExpectedRange(payload?.nextExpectedRanges);

        // Only ever move forward: a stale `nextExpectedRanges` must not rewind
        // the upload into an infinite loop.
        offset = next !== undefined && next > offset ? next : end;
        continue;
      }

      if (response.status === 416) {
        // Graph refuses an out-of-order fragment and tells us where it is: resume
        // from there rather than restarting a multi-gigabyte upload.
        const payload = await this.readBodyAsJson(response).catch(() => undefined);
        const next = this.parseNextExpectedRange(payload?.nextExpectedRanges);

        if (next !== undefined && next > offset) {
          offset = next;
          continue;
        }
      }

      throw await this.httpFailure(response, `${options.operation}.chunk`);
    }

    // Some tenants answer the final fragment with 202 instead of the item. Read
    // the addressed item back so a successful upload never looks like a failure.
    const item = await this.requestJson<IDriveItem>(userId, addressedPath, {
      operation: `${options.operation}.verify`,
    });

    return this.requireItem(item, options.operation);
  }

  /** Poll Graph's copy monitor, bounded. */
  private async awaitCopy(
    userId: string,
    monitorUrl: string,
    options: IDriveCopyOptions,
  ): Promise<IDriveCopyResult> {
    const maxAttempts = options.maxPollAttempts && options.maxPollAttempts > 0
      ? Math.trunc(options.maxPollAttempts)
      : 30;
    const interval = options.pollIntervalMs !== undefined && options.pollIntervalMs >= 0
      ? options.pollIntervalMs
      : 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await this.graphWrite<any>(
        userId,
        'drive.copyItem.monitor',
        monitorUrl,
        'get',
        undefined,
        { raw: true },
      );

      const status = Number(response?.status) || 0;

      if (status === 202) {
        await this.discard(response?.body);
        if (attempt === maxAttempts - 1) break;
        await this.sleep(interval);
        continue;
      }

      if (status >= 400) {
        throw await this.httpFailure(response, 'drive.copyItem.monitor');
      }

      if (REDIRECT_STATUSES.has(status)) {
        const location = readHeader(response?.headers, 'location');
        if (!location) break;

        const item = await this.requestJson<any>(userId, location, {
          operation: 'drive.copyItem.monitor',
          url: location,
        });

        const sanitised = this.sanitiseItem(item);
        return { status: 'completed', monitorUrl, itemId: sanitised?.id, item: sanitised || undefined };
      }

      const payload = await this.readBodyAsJson(response).catch(() => undefined);
      const itemId = payload?.id || payload?.resourceId;
      const sanitised = this.sanitiseItem(payload);

      return {
        status: 'completed',
        monitorUrl,
        itemId: itemId || sanitised?.id,
        item: sanitised?.id ? sanitised : undefined,
      };
    }

    logger.debug(`AzureDriveService: copy monitor still running after ${maxAttempts} poll(s); returning inProgress`);

    return { status: 'inProgress', monitorUrl };
  }

  /** Issue one raw HTTP request through the active transport. */
  private async send(request: IDriveHttpRequest): Promise<IDriveHttpResponse> {
    try {
      return await activeDriveHttpClient(request);
    } catch (error) {
      throw this.translate(error, `drive.transport.${request.method}`);
    }
  }

  /** Resolve the bearer token used by the first download hop. */
  private async getAccessToken(userId: string): Promise<{ token: string; source?: AzureTokenSource }> {
    const authService = this.authService;

    if (!authService || typeof authService.getToken !== 'function') {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Azure Auth Service is not available; a drive download cannot be authenticated',
        { operation: 'drive.getToken' },
      );
    }

    try {
      const result = await authService.getToken(userId);

      if (!result?.token) {
        throw apiError(
          GraphErrorCode.NOT_CONNECTED,
          'No Microsoft Graph token is available for this user',
          { operation: 'drive.getToken' },
        );
      }

      return { token: result.token, source: result.source };
    } catch (error) {
      throw this.translate(error, 'drive.getToken');
    }
  }

  /** Translate any failure into an `ApiError`, preserving the Graph `code`. */
  private translate(error: any, operation: string, tokenSource?: AzureTokenSource): ApiError {
    if (error && error.__isReactoryApiError === true) return error as ApiError;

    const translated = toGraphApiError(error, { operation, tokenSource });
    (translated as any).__isReactoryApiError = true;
    return translated;
  }

  /** Turn a failed raw response into an `ApiError` carrying Graph's `code`. */
  private async httpFailure(
    response: IDriveHttpResponse,
    operation: string,
    tokenSource?: AzureTokenSource,
  ): Promise<ApiError> {
    const body = await this.readBodyAsText(response?.body).catch(() => '');
    let message = '';

    try {
      const parsed = body ? JSON.parse(body) : undefined;
      message = parsed?.error?.message || parsed?.message || '';
    } catch {
      message = '';
    }

    return toGraphApiError(
      {
        statusCode: response?.status,
        message: message || `Microsoft Graph ${operation} failed with status ${response?.status}`,
        body,
      },
      { operation, tokenSource },
    );
  }

  /** Normalise a Graph collection page (and scrub pre-authenticated URLs). */
  private toPage(page: IGraphCollection<IDriveItem> | undefined): IDrivePage<IDriveItem> {
    const items = Array.isArray(page?.value)
      ? page!.value.map((item) => this.sanitiseItem(item)).filter((item): item is IDriveItem => Boolean(item))
      : [];

    return {
      items,
      nextLink: page?.['@odata.nextLink'],
      count: page?.['@odata.count'],
    };
  }

  /**
   * Remove fields that would hand a client an unauthenticated download handle.
   *
   * Graph volunteers `@microsoft.graph.downloadUrl` on some payloads and
   * thumbnail renditions always carry `url`. Both are pre-authenticated, so both
   * are dropped: the proxy route streams the bytes instead.
   */
  private sanitiseItem(item: any): IDriveItem | null {
    if (!item || typeof item !== 'object') return null;

    const clone: any = { ...item };
    delete clone['@microsoft.graph.downloadUrl'];

    if (Array.isArray(clone.thumbnails)) {
      clone.thumbnails = clone.thumbnails.map((set: any) => {
        if (!set || typeof set !== 'object') return set;

        const copy: any = { ...set };
        for (const size of ['small', 'medium', 'large']) {
          if (copy[size] && typeof copy[size] === 'object') {
            copy[size] = { ...copy[size] };
            delete copy[size].url;
          }
        }
        return copy;
      });
    }

    return clone as IDriveItem;
  }

  /** A write must return an item; anything else is a Graph contract failure. */
  private requireItem(value: any, operation: string): IDriveItem {
    const item = this.sanitiseItem(value);

    if (!item?.id) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Microsoft Graph returned no drive item for ${operation}`,
        { operation },
      );
    }

    return item;
  }

  /** Coerce a transport body into a Node readable without buffering it. */
  private toNodeStream(body: unknown): Readable {
    if (body === undefined || body === null) return readableFrom([]);

    const candidate: any = body;

    if (typeof candidate.pipe === 'function' && typeof candidate.on === 'function') {
      return candidate as Readable;
    }

    if (typeof candidate.getReader === 'function') {
      const fromWeb = (Readable as any).fromWeb;

      if (typeof fromWeb === 'function') {
        return fromWeb.call(Readable, candidate);
      }

      return readableFrom((async function* pump() {
        const reader = candidate.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield Buffer.from(value);
        }
      })());
    }

    if (typeof candidate[Symbol.asyncIterator] === 'function') {
      return readableFrom(candidate);
    }

    if (Buffer.isBuffer(candidate)) return readableFrom([candidate]);
    if (typeof candidate === 'string') return readableFrom([Buffer.from(candidate)]);

    return readableFrom([Buffer.from(String(candidate))]);
  }

  /** Read a (small) transport body as text, bounded. */
  private async readBodyAsText(body: unknown): Promise<string> {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body.slice(0, RAW_BODY_LIMIT);
    if (Buffer.isBuffer(body)) return body.toString('utf8', 0, Math.min(body.length, RAW_BODY_LIMIT));

    const candidate: any = body;
    if (typeof candidate.text === 'function') {
      const text = await candidate.text();
      return String(text ?? '').slice(0, RAW_BODY_LIMIT);
    }

    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of this.toNodeStream(candidate)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
      chunks.push(buffer);
      size += buffer.length;
      if (size >= RAW_BODY_LIMIT) break;
    }

    return Buffer.concat(chunks).toString('utf8', 0, Math.min(size, RAW_BODY_LIMIT));
  }

  /** Read a (small) transport body as JSON. */
  private async readBodyAsJson(body: any): Promise<any> {
    if (body === undefined || body === null) return undefined;
    if (typeof body.json === 'function') return await body.json();

    const text = await this.readBodyAsText(body?.body === undefined ? body : body.body);
    return text ? JSON.parse(text) : undefined;
  }

  /** Release a response body we do not intend to read. */
  private async discard(body: unknown): Promise<void> {
    const candidate: any = body;
    if (!candidate || typeof candidate !== 'object') return;

    try {
      if (typeof candidate.cancel === 'function') {
        await candidate.cancel();
        return;
      }

      if (typeof candidate.resume === 'function') {
        candidate.resume();
      }
    } catch {
      /* a body that cannot be drained is not a reason to fail the request */
    }
  }

  /** `Content-Length` as a number, when it is one. */
  private parseLength(value: string | undefined): number | undefined {
    if (!value) return undefined;

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  /** The first byte offset of `nextExpectedRanges`, if Graph supplied one. */
  private parseNextExpectedRange(ranges?: string[]): number | undefined {
    if (!Array.isArray(ranges) || !ranges.length) return undefined;

    const match = /^(\d+)-/.exec(String(ranges[0]));
    if (!match) return undefined;

    const offset = Number(match[1]);
    return Number.isFinite(offset) ? offset : undefined;
  }

  /** Validate a fragment size against Graph's documented constraints. */
  private resolveChunkSize(requested?: number): number {
    const size = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : DRIVE_UPLOAD_CHUNK_SIZE;

    if (size % DRIVE_UPLOAD_CHUNK_MULTIPLE !== 0 || size > DRIVE_UPLOAD_CHUNK_MAX) {
      throw apiError(
        DRIVE_ERROR_CODES.INVALID_UPLOAD_CHUNK_SIZE,
        'A resumable upload fragment must be a multiple of 320 KiB and at most 60 MiB',
        { chunkSize: size, multiple: DRIVE_UPLOAD_CHUNK_MULTIPLE, max: DRIVE_UPLOAD_CHUNK_MAX },
      );
    }

    return size;
  }

  /** A name is required and may not carry control characters or path separators. */
  private validateName(name: string, operation: string): string {
    const value = String(name ?? '').trim();

    if (!value) {
      throw apiError(DRIVE_ERROR_CODES.INVALID_NAME, 'A drive item name is required', { operation });
    }

    if (/[\u0000-\u001f]/.test(value) || value === '.' || value === '..') {
      throw apiError(
        DRIVE_ERROR_CODES.INVALID_NAME,
        'A drive item name must not contain control characters, "." or ".."',
        { operation },
      );
    }

    // `addressedItemPath` encodes the name with `encodePathSegment`, which
    // deliberately preserves `/` so a *path* can be addressed. A name is not a
    // path: allowing a separator here would let `uploadItem(…, 'a/b.txt', …)`
    // silently address a nested location the caller never asked for, and would
    // make `createFolder('a/b')` depend on Graph's own 400.
    if (/[\\/]/.test(value)) {
      throw apiError(
        DRIVE_ERROR_CODES.INVALID_NAME,
        'A drive item name must not contain a path separator ("/" or "\\")',
        { operation },
      );
    }

    return value;
  }

  /** Pause between copy-monitor polls. */
  private sleep(ms: number): Promise<void> {
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const AzureDriveServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureDriveService> = {
  service: (props: any, context: any) => new AzureDriveService(props, context),
  id: 'azure.AzureDriveService@1.0.0',
  name: 'AzureDriveService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'OneDrive drive, file, upload, sharing and version operations over Microsoft Graph',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphProvider' },
    { id: 'azure.AzureAuthService@1.0.0', alias: 'authService' },
  ],
};

export { AzureDriveService };

export default AzureDriveService;

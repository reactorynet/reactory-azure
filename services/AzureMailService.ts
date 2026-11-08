import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { encodePathSegment, escapeODataString } from '../utils/odata';
import { azureCacheKey, AzureCacheDomain } from '../utils/cache-keys';
import { apiError, GraphErrorCode, toGraphApiError } from '../utils/graph-error';
import type { IGraphProviderOptions } from './graph/AzureGraphClientProvider';
import type {
  IAzureMailService,
  IMailAddress,
  IMailAttachment,
  IMailBody,
  IMailCategory,
  IMailFolder,
  IMailGetOptions,
  IMailListOptions,
  IMailMessage,
  IMailPage,
} from '../types/mail.types';
import {
  DEFAULT_CONVERSATION_ORDER_BY,
  DEFAULT_MAIL_CATEGORY_SELECT,
  DEFAULT_MAIL_FOLDER_SELECT,
  DEFAULT_MAIL_MESSAGE_DETAIL_SELECT,
  DEFAULT_MAIL_MESSAGE_SELECT,
  DEFAULT_MAIL_ORDER_BY,
  DEFAULT_MAIL_PAGE_SIZE,
  MAIL_FOLDERS_CACHE_TTL_SECONDS,
  SUPPORTED_MAIL_EXPAND,
} from '../types/mail.types';

/** The raw Graph collection envelope (only the parts this service reads). */
interface IGraphCollection<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.count'?: number;
}

/**
 * Provider options plus the mail-only `Prefer: IdType="ImmutableId"` switch.
 *
 * `IGraphRequestOptions` deliberately has no `immutableIds` property (it is a
 * transport type shared by every domain and owned by AZ-01), while
 * `buildHeaders` already honours it. Declaring it here keeps the mail contract
 * typed without editing a shared file.
 */
interface IMailGraphOptions extends IGraphProviderOptions {
  immutableIds?: boolean;
}

/** The provider surface this service depends on - typed so generic calls are checked. */
interface IMailGraphProvider {
  request<T>(userId: string, path: string, options?: IMailGraphOptions): Promise<T>;
  requestAll<T>(userId: string, path: string, options?: IMailGraphOptions): Promise<T[]>;
  getClient(userId: string): any;
}

/** Where a message collection lives. All three read paths share one request shape. */
const MESSAGES_PATH = '/me/messages';
const FOLDERS_PATH = '/me/mailFolders';
const MASTER_CATEGORIES_PATH = '/me/outlook/masterCategories';

/**
 * Flatten one Graph address (`{ emailAddress: { name, address } }`) into the
 * domain `{ name, address }` shape. A value that is already flat passes through,
 * so a caller can round-trip a normalised message back into the service.
 */
function normaliseAddress(value: any): IMailAddress | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const inner = value.emailAddress && typeof value.emailAddress === 'object'
    ? value.emailAddress
    : value;

  const name = typeof inner.name === 'string' && inner.name.length > 0 ? inner.name : undefined;
  const address = typeof inner.address === 'string' && inner.address.length > 0
    ? inner.address
    : undefined;

  if (name === undefined && address === undefined) return undefined;

  const result: IMailAddress = {};
  if (name !== undefined) result.name = name;
  if (address !== undefined) result.address = address;
  return result;
}

/** Flatten a Graph recipient list; absent/malformed input is an empty list. */
function normaliseAddressList(value: any): IMailAddress[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normaliseAddress(entry))
    .filter((entry): entry is IMailAddress => entry !== undefined);
}

/** Normalise Graph's `body`; a message with no body reads as an empty text body. */
function normaliseBody(value: any): IMailBody {
  const contentType = typeof value?.contentType === 'string' && value.contentType.length > 0
    ? value.contentType
    : 'text';
  const content = typeof value?.content === 'string' ? value.content : '';

  return { contentType, content };
}

/** Keep the attachment fields the schema exposes, and nothing runtime-specific. */
function normaliseAttachment(value: any, index: number): IMailAttachment {
  const attachment: IMailAttachment = {
    id: String(value?.id ?? `attachment-${index}`),
  };

  if (typeof value?.name === 'string') attachment.name = value.name;
  if (typeof value?.contentType === 'string') attachment.contentType = value.contentType;
  if (typeof value?.size === 'number') attachment.size = value.size;
  if (value?.isInline === true) attachment.isInline = true;
  if (typeof value?.contentBytes === 'string') attachment.contentBytes = value.contentBytes;
  if (typeof value?.lastModifiedDateTime === 'string') {
    attachment.lastModifiedDateTime = value.lastModifiedDateTime;
  }
  if (typeof value?.['@odata.type'] === 'string') attachment['@odata.type'] = value['@odata.type'];

  return attachment;
}

/**
 * Normalise one Graph message into {@link IMailMessage}.
 *
 * Every collection and single-read path funnels through here, so the mapping is
 * guaranteed to be identical no matter which endpoint returned the message.
 */
function normaliseMessage(raw: any): IMailMessage {
  const message: IMailMessage = {
    id: String(raw?.id ?? ''),
    body: normaliseBody(raw?.body),
    toRecipients: normaliseAddressList(raw?.toRecipients),
    ccRecipients: normaliseAddressList(raw?.ccRecipients),
    bccRecipients: normaliseAddressList(raw?.bccRecipients),
    replyTo: normaliseAddressList(raw?.replyTo),
    categories: Array.isArray(raw?.categories)
      ? raw.categories.filter((category: unknown): category is string => typeof category === 'string')
      : [],
  };

  if (typeof raw?.conversationId === 'string') message.conversationId = raw.conversationId;
  if (typeof raw?.subject === 'string') message.subject = raw.subject;
  if (typeof raw?.bodyPreview === 'string') message.bodyPreview = raw.bodyPreview;

  const from = normaliseAddress(raw?.from);
  if (from) message.from = from;
  const sender = normaliseAddress(raw?.sender);
  if (sender) message.sender = sender;

  if (typeof raw?.receivedDateTime === 'string') message.receivedDateTime = raw.receivedDateTime;
  if (typeof raw?.sentDateTime === 'string') message.sentDateTime = raw.sentDateTime;
  if (typeof raw?.isRead === 'boolean') message.isRead = raw.isRead;
  if (typeof raw?.isDraft === 'boolean') message.isDraft = raw.isDraft;
  if (typeof raw?.hasAttachments === 'boolean') message.hasAttachments = raw.hasAttachments;
  if (typeof raw?.importance === 'string') message.importance = raw.importance;
  if (typeof raw?.parentFolderId === 'string') message.parentFolderId = raw.parentFolderId;
  if (typeof raw?.webLink === 'string') message.webLink = raw.webLink;

  if (Array.isArray(raw?.attachments)) {
    message.attachments = raw.attachments.map((entry: any, index: number) =>
      normaliseAttachment(entry, index));
  }

  return message;
}

/** Normalise a folder, keeping the counters the ticket requires as numbers. */
function normaliseFolder(raw: any): IMailFolder {
  const folder: IMailFolder = {
    id: String(raw?.id ?? ''),
    childFolderCount: typeof raw?.childFolderCount === 'number' ? raw.childFolderCount : 0,
    unreadItemCount: typeof raw?.unreadItemCount === 'number' ? raw.unreadItemCount : 0,
  };

  if (typeof raw?.displayName === 'string') folder.displayName = raw.displayName;
  if (typeof raw?.parentFolderId === 'string') folder.parentFolderId = raw.parentFolderId;
  if (typeof raw?.totalItemCount === 'number') folder.totalItemCount = raw.totalItemCount;
  if (typeof raw?.wellKnownName === 'string') folder.wellKnownName = raw.wellKnownName;

  return folder;
}

/** Normalise a master category. */
function normaliseCategory(raw: any): IMailCategory {
  const category: IMailCategory = {
    displayName: String(raw?.displayName ?? raw?.name ?? ''),
  };

  if (typeof raw?.id === 'string') category.id = raw.id;
  if (typeof raw?.color === 'string') category.color = raw.color;

  return category;
}

/** True when the caller explicitly supplied an `$orderby`. */
function hasExplicitOrderBy(orderBy: IMailListOptions['orderBy']): boolean {
  if (orderBy === undefined || orderBy === null) return false;
  if (Array.isArray(orderBy)) {
    return orderBy.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
  }
  return typeof orderBy === 'string' && orderBy.trim().length > 0;
}

/**
 * AzureMailService - Microsoft Graph mail reads.
 *
 * The service is a thin, typed adapter over `AzureGraphClientProvider`:
 *
 *   - the provider owns the Graph `Client`, retries, `@odata.nextLink`
 *     pagination and error translation, so this service never re-implements
 *     transport policy;
 *   - every failure propagates as an `ApiError` carrying the Graph `code`
 *     (`ErrorInvalidRequest`, `InvalidAuthenticationToken`, `itemNotFound`, ...).
 *     No method returns `[]`, `null` or a placeholder on failure - the legacy
 *     `getEmails` behaviour this ticket replaces;
 *   - reads are normalised (flattened recipients, guaranteed body, promoted
 *     `nextLink`) so a Graph shape change stops at this boundary.
 */
@service({
  id: 'azure.AzureMailService@1.0.0',
  name: 'AzureMailService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph mail reads - messages, folders, categories, conversations',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'core.RedisService@1.0.0', alias: 'redisService' },
  ],
})
class AzureMailService implements Reactory.Service.IReactoryService, IAzureMailService {
  name: string = 'AzureMailService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphClientProvider: IMailGraphProvider;
  private _redisService: any;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `graphClientProvider` alias. */
  setGraphClientProvider(serviceInstance: any): void {
    this._graphClientProvider = serviceInstance;
  }

  /** Bound by the Reactory service container from the `redisService` alias. */
  setRedisService(serviceInstance: any): void {
    this._redisService = serviceInstance;
  }

  private get graphClientProvider(): IMailGraphProvider {
    if (this._graphClientProvider) return this._graphClientProvider;
    return this.context.getService('azure.AzureGraphClientProvider@1.0.0');
  }

  private get redisService(): any {
    if (this._redisService) return this._redisService;
    return this.context.getService('core.RedisService@1.0.0');
  }

  /**
   * List messages from the signed-in user's mailbox.
   *
   * `GET /me/messages` with `$select` / `$filter` / `$search` / `$top` /
   * `$orderby`. Without `options.all` the first page is returned together with
   * the opaque `@odata.nextLink`; with `options.all` the provider follows every
   * `@odata.nextLink` (bounded by `maxPages`) and the whole list is returned.
   *
   * ## `$search` contract
   *
   * `$search` on the mail resource is **not** Gmail syntax. It is OData `$search`
   * over Outlook's KQL-like grammar (`from:`, `to:`, `subject:`, `received>=`, a
   * bare term, with AQS quirks), and it is **resource-dependent**: each entity
   * only supports the properties it declares, and an unsupported property raises
   * `ErrorInvalidRequest`. Gmail operators (`in:inbox`, `is:unread`) fail.
   *
   * `$search` also requires `ConsistencyLevel: eventual`; the provider adds that
   * header automatically whenever a search expression is present.
   *
   * The `$search` + `$orderby` / `$count` interaction is **not asserted here** -
   * it is documented by Microsoft as unsupported on several resources, but the
   * exact behaviour on `/me/messages` was not verified against a tenant. Until it
   * is verified, this method therefore sends **no `$orderby` and no `$count`**
   * whenever a search is supplied and the caller did not explicitly set
   * `orderBy`. An explicit `orderBy` is honoured (the caller has taken
   * responsibility for the interaction), and `count` is only sent when explicitly
   * requested in that same case.
   *
   * `$filter` + `$search` is also **unverified** on `/me/messages`: the pair is
   * passed through as supplied rather than rejected, so a caller combining them
   * owns the outcome. Let Graph's `ErrorInvalidRequest` be the arbiter - it is
   * preserved verbatim on the `ApiError`.
   *
   * `options.count` is ignored when `options.all` is set: an all-pages read
   * returns `{ items }` only (see {@link IMailListOptions.count}).
   *
   * @param userId - the vault owner whose mailbox is read
   * @param options - page size, filter, search, ordering, immutable ids, all-pages
   * @returns one page (`{ items, nextLink, count? }`) or every page when `all` is set
   * @throws ApiError carrying the Graph `code`
   */
  async listMessages(userId: string, options: IMailListOptions = {}): Promise<IMailPage> {
    return this.listMessagePage(userId, MESSAGES_PATH, options, DEFAULT_MAIL_ORDER_BY, 'listMessages');
  }

  /**
   * Read one message.
   *
   * `GET /me/messages/{id}`, optionally `$expand=attachments`. The returned
   * message is typed and normalised (see {@link IMailMessage}).
   *
   * `options.immutableIds` sends `Prefer: IdType="ImmutableId"`; note that
   * immutable ids **change shape** versus the default ids - treat them as opaque
   * and never mix ids obtained with and without the header.
   *
   * @throws ApiError carrying the Graph `code` (e.g. `itemNotFound`)
   */
  async getMessage(
    userId: string,
    id: string,
    options: IMailGetOptions = {},
  ): Promise<IMailMessage> {
    this.requireMessageId(id);

    const requestOptions: IMailGraphOptions = {
      select: options.select ?? DEFAULT_MAIL_MESSAGE_DETAIL_SELECT,
      operation: 'getMessage',
    };

    // `$expand` is validated, not passed through: Graph rejects an unknown
    // navigation property with an opaque 400, and the only one this contract
    // promises is `attachments`. Failing here names the bad value instead.
    if (options.expand !== undefined) {
      this.requireSupportedExpand(options.expand);
      requestOptions.expand = options.expand;
    }
    if (options.immutableIds === true) requestOptions.immutableIds = true;

    const message = await this.graphClientProvider.request<any>(
      userId,
      `${MESSAGES_PATH}/${encodePathSegment(String(id))}`,
      requestOptions,
    );

    return normaliseMessage(message);
  }

  /**
   * List the user's mail folders.
   *
   * `GET /me/mailFolders`, including `childFolderCount` and `unreadItemCount`.
   * The result is cached in Redis for ten minutes
   * (`azure:{userId}:mail:folders`, TTL 600 s). A cache read or write failure is
   * only a cache miss: it never fails the call and never hides a Graph error.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listFolders(userId: string): Promise<IMailFolder[]> {
    const cacheKey = azureCacheKey(String(userId), AzureCacheDomain.MAIL_FOLDERS);
    const cached = await this.readFolderCache(cacheKey);
    if (cached !== undefined) return cached;

    const folders = await this.graphClientProvider.requestAll<any>(
      userId,
      FOLDERS_PATH,
      {
        select: DEFAULT_MAIL_FOLDER_SELECT,
        operation: 'listFolders',
      },
    );

    const items = (Array.isArray(folders) ? folders : []).map(normaliseFolder);
    await this.writeFolderCache(cacheKey, items);

    return items;
  }

  /**
   * List the messages in one folder.
   *
   * `GET /me/mailFolders/{folderId}/messages`; identical options and request
   * shape to {@link listMessages}, including the `$search` rules documented there.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listMessagesInFolder(
    userId: string,
    folderId: string,
    options: IMailListOptions = {},
  ): Promise<IMailPage> {
    if (!folderId) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'A folderId is required to list messages in a folder',
      );
    }

    const path = `${FOLDERS_PATH}/${encodePathSegment(String(folderId))}/messages`;
    return this.listMessagePage(userId, path, options, DEFAULT_MAIL_ORDER_BY, 'listMessagesInFolder');
  }

  /**
   * List the user's Outlook master categories.
   *
   * `GET /me/outlook/masterCategories`. Categories are mailbox-level (not
   * message-level) and are what `setCategories` assigns to a message.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listCategories(userId: string): Promise<IMailCategory[]> {
    const categories = await this.graphClientProvider.requestAll<any>(
      userId,
      MASTER_CATEGORIES_PATH,
      {
        select: DEFAULT_MAIL_CATEGORY_SELECT,
        operation: 'listCategories',
      },
    );

    return (Array.isArray(categories) ? categories : []).map(normaliseCategory);
  }

  /**
   * Replace the categories on one message.
   *
   * `PATCH /me/messages/{messageId}` with `{ categories: [...] }`. An empty array
   * removes every category. The updated message is returned.
   *
   * The PATCH is issued through the provider's client (the provider owns client
   * construction and authentication) and any failure is translated to an
   * `ApiError` with the Graph code, exactly like the read paths.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async setCategories(
    userId: string,
    messageId: string,
    categories: string[],
  ): Promise<IMailMessage> {
    this.requireMessageId(messageId);

    if (!Array.isArray(categories) || categories.some((entry) => typeof entry !== 'string')) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'categories must be an array of category display names',
      );
    }

    const client = this.graphClientProvider.getClient(userId);

    let updated: any;
    try {
      updated = await client
        .api(`${MESSAGES_PATH}/${encodePathSegment(String(messageId))}`)
        .patch({ categories });
    } catch (error: any) {
      throw toGraphApiError(error, { operation: 'setCategories' });
    }

    // A PATCH answers with the updated message. An empty/204 body is not a
    // message, and mapping it would hand the caller a synthetic `id: ''` - the
    // class contract is "never a placeholder", so say so instead.
    if (!updated || typeof updated !== 'object' || typeof updated.id !== 'string' || updated.id === '') {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned no message body for the categories update',
        { operation: 'setCategories', messageId: String(messageId) },
      );
    }

    return normaliseMessage(updated);
  }

  /**
   * List every message in one conversation.
   *
   * `GET /me/messages` filtered by `conversationId`, ordered oldest-first by
   * default so the thread reads in sequence. `options.filter` is combined with
   * the conversation predicate using `and`.
   *
   * There is deliberately **no `getThread`**: Microsoft Graph exposes no thread
   * resource (`/me/messages/{id}/thread` does not exist). A conversation read is
   * a filtered message listing - `conversationId` is the only thread identity
   * Graph provides.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listByConversation(
    userId: string,
    conversationId: string,
    options: IMailListOptions = {},
  ): Promise<IMailPage> {
    if (!conversationId) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'A conversationId is required to list a conversation',
      );
    }

    const conversationFilter = `conversationId eq '${escapeODataString(String(conversationId))}'`;
    const filter = options.filter
      ? `(${options.filter}) and ${conversationFilter}`
      : conversationFilter;

    return this.listMessagePage(
      userId,
      MESSAGES_PATH,
      { ...options, filter },
      DEFAULT_CONVERSATION_ORDER_BY,
      'listByConversation',
    );
  }

  /**
   * The shared message-collection read: build the request, then either take the
   * first page or drain `@odata.nextLink`.
   */
  private async listMessagePage(
    userId: string,
    path: string,
    options: IMailListOptions,
    defaultOrderBy: string,
    operation: string,
  ): Promise<IMailPage> {
    const requestOptions = this.buildListRequestOptions(options, defaultOrderBy, operation);

    if (options.all === true) {
      const requestAllOptions: IMailGraphOptions = { ...requestOptions };
      if (options.maxPages !== undefined) requestAllOptions.maxPages = options.maxPages;

      const all = await this.graphClientProvider.requestAll<any>(userId, path, requestAllOptions);
      return { items: (Array.isArray(all) ? all : []).map(normaliseMessage) };
    }

    const page = await this.graphClientProvider.request<IGraphCollection<any>>(
      userId,
      path,
      requestOptions,
    );

    const items = Array.isArray(page?.value) ? page.value.map(normaliseMessage) : [];
    const result: IMailPage = { items };

    if (typeof page?.['@odata.nextLink'] === 'string') result.nextLink = page['@odata.nextLink'];
    if (typeof page?.['@odata.count'] === 'number') result.count = page['@odata.count'];

    return result;
  }

  /**
   * Translate domain options into provider options, applying the two rules the
   * ticket makes mandatory:
   *
   *   1. a search without an explicit `orderBy` carries neither `$orderby` nor
   *      `$count` (the interaction is unverified - see {@link listMessages});
   *   2. `$top` always has a deterministic value so a caller cannot accidentally
   *      request an unbounded mailbox.
   */
  private buildListRequestOptions(
    options: IMailListOptions,
    defaultOrderBy: string,
    operation: string,
  ): IMailGraphOptions {
    const search = typeof options.search === 'string' && options.search.trim().length > 0
      ? options.search.trim()
      : undefined;
    const explicitOrderBy = hasExplicitOrderBy(options.orderBy);

    const orderBy = explicitOrderBy
      ? options.orderBy
      : (search ? undefined : defaultOrderBy);

    // The search + count interaction is unverified, so it is only sent when the
    // caller explicitly ordered the request - i.e. took ownership of the shape.
    const count = search && !explicitOrderBy
      ? undefined
      : (options.count === true ? true : undefined);

    const requestOptions: IMailGraphOptions = {
      select: options.select ?? DEFAULT_MAIL_MESSAGE_SELECT,
      top: typeof options.top === 'number' && Number.isFinite(options.top)
        ? options.top
        : DEFAULT_MAIL_PAGE_SIZE,
      operation,
    };

    if (options.filter) requestOptions.filter = options.filter;
    if (search) requestOptions.search = search;
    if (orderBy !== undefined) requestOptions.orderBy = orderBy;
    if (typeof options.skip === 'number' && Number.isFinite(options.skip)) {
      requestOptions.skip = options.skip;
    }
    if (options.expand !== undefined) requestOptions.expand = options.expand;
    if (count !== undefined) requestOptions.count = count;

    // `requestAll` rebuilds page 2+ options as `{ operation, apiVersion, headers }`,
    // so a provider option is NOT carried forward - only `headers` are. Anything
    // that travels as a header must therefore be set on `headers` explicitly or it
    // silently disappears after page 1:
    //   - `$search` requires `ConsistencyLevel: eventual` on EVERY page;
    //   - `immutableIds` requires `Prefer: IdType="ImmutableId"` on EVERY page,
    //     otherwise a paginated read returns page-1 ids in one shape and later ids
    //     in another - the exact mixture IMailListOptions forbids callers to make.
    // One merged bag, so both coexist on a paged search.
    const headers: Record<string, string> = {};
    if (search) headers.ConsistencyLevel = 'eventual';
    if (options.immutableIds === true) headers.Prefer = 'IdType="ImmutableId"';

    if (Object.keys(headers).length > 0) {
      requestOptions.headers = { ...(requestOptions.headers || {}), ...headers };
    }

    // Set as well so page 1 is shaped by the provider's own header builder too.
    if (options.immutableIds === true) requestOptions.immutableIds = true;

    return requestOptions;
  }

  /**
   * Only the `$expand` values this contract documents are accepted.
   *
   * @throws ApiError naming the unsupported value, before any request is made.
   */
  private requireSupportedExpand(expand: string | string[]): void {
    const requested = (Array.isArray(expand) ? expand : [expand])
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);

    const unsupported = requested.filter(
      (entry) => !SUPPORTED_MAIL_EXPAND.includes(entry as any),
    );

    if (unsupported.length > 0) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Unsupported mail $expand value(s): ${unsupported.join(', ')}`,
        { supported: [...SUPPORTED_MAIL_EXPAND], requested: unsupported },
      );
    }
  }

  /** A message id must be a non-empty string before it reaches a path. */
  private requireMessageId(id: string): void {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'A message id is required',
      );
    }
  }

  /**
   * Read the folder list from Redis. A miss, a malformed payload or a Redis
   * failure all read as "not cached" - the cache is never authoritative.
   */
  private async readFolderCache(cacheKey: string): Promise<IMailFolder[] | undefined> {
    try {
      const redis = this.redisService;
      if (!redis || typeof redis.get !== 'function') return undefined;

      const raw = await redis.get(cacheKey);
      if (!raw) return undefined;

      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(parsed?.items)) return undefined;

      return parsed.items as IMailFolder[];
    } catch {
      return undefined;
    }
  }

  /** Write the folder list to Redis for ten minutes. A failure is swallowed. */
  private async writeFolderCache(cacheKey: string, items: IMailFolder[]): Promise<void> {
    try {
      const redis = this.redisService;
      if (!redis || typeof redis.set !== 'function') return;

      await redis.set(
        cacheKey,
        JSON.stringify({ items, cachedAt: new Date().toISOString() }),
        MAIL_FOLDERS_CACHE_TTL_SECONDS,
      );
    } catch {
      // Cache writes are best-effort: a Redis outage must not fail a mail read.
    }
  }
}

export const AzureMailServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureMailService> = {
  service: (props: any, context: any) => new AzureMailService(props, context),
  id: 'azure.AzureMailService@1.0.0',
  name: 'AzureMailService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph mail reads - messages, folders, categories, conversations',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'core.RedisService@1.0.0', alias: 'redisService' },
  ],
};

export { AzureMailService };

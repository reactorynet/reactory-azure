import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { encodePathSegment, escapeODataString } from '../utils/odata';
import { azureCacheKey, AzureCacheDomain } from '../utils/cache-keys';
import type ApiError from '@reactory/server-core/exceptions';
import { apiError, GraphErrorCode, toGraphApiError } from '../utils/graph-error';
import type { IGraphProviderOptions } from './graph/AzureGraphClientProvider';
import type {
  IAzureMailService,
  IMailAddress,
  IMailAttachment,
  IMailAttachmentContent,
  IMailAttachmentInfo,
  IMailAttachmentInput,
  IMailBody,
  IMailCategory,
  IMailDraftPatch,
  IMailFolder,
  IMailGetOptions,
  IMailHttpRequest,
  IMailHttpResponse,
  IMailListOptions,
  IMailMessage,
  IMailMessageInput,
  IMailPage,
  IMailRecipient,
  IMailReplyInput,
  IMailSendOptions,
  MailBodyContentType,
  MailHttpClient,
} from '../types/mail.types';
import {
  DEFAULT_CONVERSATION_ORDER_BY,
  DEFAULT_MAIL_CATEGORY_SELECT,
  DEFAULT_MAIL_FOLDER_SELECT,
  DEFAULT_MAIL_MESSAGE_DETAIL_SELECT,
  DEFAULT_MAIL_MESSAGE_SELECT,
  DEFAULT_MAIL_ORDER_BY,
  DEFAULT_MAIL_PAGE_SIZE,
  MAIL_ATTACHMENT_CONTENT_SELECT,
  MAIL_ATTACHMENT_SELECT,
  MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES,
  MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE,
  MAIL_DEFAULT_SAVE_TO_SENT_ITEMS,
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

/** `POST /me/sendMail` - the one-shot send endpoint. */
const SEND_MAIL_PATH = '/me/sendMail';

/** `…/messages/{id}/attachments` - metadata, content and upload sessions. */
const ATTACHMENTS_SEGMENT = 'attachments';

/**
 * Error codes the mail write paths raise themselves.
 *
 * Graph's own codes (`ErrorInvalidRecipients`, `ErrorInvalidRequest`,
 * `itemNotFound`, ...) arrive unchanged through `toGraphApiError`; these cover the
 * failures that never reach Graph - malformed input and an upload Graph would not
 * confirm.
 */
export const MAIL_ERROR_CODES = {
  /** The message input itself is unusable (missing body, bad contentType, ...). */
  INVALID_MESSAGE: 'InvalidMailMessage',
  /** A recipient has no address, or a reply was given forward-only recipients. */
  INVALID_RECIPIENT: 'InvalidMailRecipient',
  /** An attachment has no name, no contentBytes, or bytes that are not base64. */
  INVALID_ATTACHMENT: 'InvalidMailAttachment',
  /** The upload exceeded a limit this service enforces itself. */
  ATTACHMENT_TOO_LARGE: 'MailAttachmentTooLarge',
  /**
   * `saveToSentItems: false` was asked for on a send that must go through a draft
   * (because an attachment needs a resumable upload), and Graph has no equivalent
   * switch on the draft-send endpoint. Distinct from {@link ATTACHMENT_TOO_LARGE}
   * on purpose: nothing is too large here - the caller asked for a behaviour this
   * route cannot provide - so a client switching on `error.code` must not tell the
   * user to shrink the file.
   */
  SAVE_TO_SENT_ITEMS_UNSUPPORTED: 'MailSaveToSentItemsUnsupported',
  /** `createUploadSession` answered without an `uploadUrl`. */
  MISSING_UPLOAD_URL: 'MailUploadSessionMissingUrl',
  /** The upload session never reached a terminal 2xx, or Graph lost the attachment. */
  UPLOAD_FAILED: 'MailAttachmentUploadFailed',
} as const;

/**
 * The production transport for resumable attachment uploads: `fetch`.
 *
 * It exists (rather than routing the fragments through the Graph SDK) because the
 * `uploadUrl` returned by `createUploadSession` is **pre-authenticated**: it must
 * be contacted without an `Authorization` header, and the SDK's auth middleware
 * would attach the bearer token to whatever host that URL names. Tests replace
 * this implementation - the module has no Azure tenant and must never make a
 * live Graph call.
 */
const defaultMailHttpClient: MailHttpClient = async (request: IMailHttpRequest) => {
  const fetchImpl: any = (globalThis as any).fetch;

  if (typeof fetchImpl !== 'function') {
    throw apiError(
      GraphErrorCode.GRAPH_REQUEST_FAILED,
      'No fetch implementation is available for mail attachment uploads',
    );
  }

  const init: Record<string, unknown> = {
    method: request.method,
    headers: request.headers || {},
  };

  if (request.body !== undefined) init.body = request.body;

  const response: any = await fetchImpl(request.url, init);

  // A real fetch `Response` exposes its payload through `text()`/`json()`, not as
  // a property: `response.body` is a ReadableStream, which `readResponsePayload`
  // cannot parse. Reading it here is what preserves the Graph error `code` and
  // message - and the 202 `nextExpectedRanges` cursor - on the only transport
  // that runs in production. `text()` also drains the body, so a multi-fragment
  // upload releases the connection instead of stranding it.
  const responseBody = typeof response?.text === 'function'
    ? await response.text()
    : response?.body;

  const headers: Record<string, string> = {};
  if (response?.headers && typeof response.headers.forEach === 'function') {
    response.headers.forEach((value: string, key: string) => {
      headers[String(key).toLowerCase()] = String(value);
    });
  }

  return {
    status: Number(response?.status) || 0,
    headers,
    body: responseBody ?? undefined,
  };
};

/**
 * The active attachment transport. Replaced in tests, which is why the seam
 * exists: no live Graph call may be made from this module.
 */
let activeMailHttpClient: MailHttpClient = defaultMailHttpClient;

/** Install a transport for attachment uploads; `null` restores the `fetch` default. */
export function setMailHttpClient(client?: MailHttpClient | null): void {
  activeMailHttpClient = client || defaultMailHttpClient;
}

/** The active attachment transport. */
export function getMailHttpClient(): MailHttpClient {
  return activeMailHttpClient;
}

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

/* -------------------------------------------------------------------------- */
/* Write helpers (AZ-05)                                                      */
/* -------------------------------------------------------------------------- */

/** Graph's fileAttachment discriminator; `sendMail` will not accept a bare object. */
const FILE_ATTACHMENT_TYPE = '#microsoft.graph.fileAttachment';

/** Graph's three importance values. */
const MAIL_IMPORTANCE_VALUES = ['low', 'normal', 'high'] as const;

/** The base64 payload of an attachment, without whitespace. */
function attachmentBase64(attachment: IMailAttachmentInput): string {
  return typeof attachment.contentBytes === 'string'
    ? attachment.contentBytes.replace(/\s+/g, '')
    : '';
}

/**
 * Decode one base64 attachment payload and return its bytes.
 *
 * Decoding happens **before any request**, which is what makes the simple versus
 * resumable decision honest: the byte length comes from the payload, never from a
 * caller-supplied `size`, and an attachment that cannot be decoded is rejected
 * instead of being quietly left out of the send.
 */
function decodeAttachmentBytes(attachment: IMailAttachmentInput): Buffer {
  if (!attachment || typeof attachment !== 'object') {
    throw apiError(MAIL_ERROR_CODES.INVALID_ATTACHMENT, 'An attachment must be an object');
  }

  const name = typeof attachment.name === 'string' ? attachment.name.trim() : '';
  if (name.length === 0) {
    throw apiError(
      MAIL_ERROR_CODES.INVALID_ATTACHMENT,
      'Every attachment requires a non-empty name',
    );
  }

  const raw = attachmentBase64(attachment);
  if (raw.length === 0) {
    throw apiError(
      MAIL_ERROR_CODES.INVALID_ATTACHMENT,
      `Attachment [${name}] has no contentBytes; it cannot be sent and will not be dropped silently`,
      { attachment: name },
    );
  }

  // Base64 alphabet only, correctly padded. `Buffer.from(raw, 'base64')` would
  // otherwise succeed on garbage and send zero bytes or half a file.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    throw apiError(
      MAIL_ERROR_CODES.INVALID_ATTACHMENT,
      `Attachment [${name}] is not valid base64`,
      { attachment: name },
    );
  }

  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 0) {
    throw apiError(
      MAIL_ERROR_CODES.INVALID_ATTACHMENT,
      `Attachment [${name}] decoded to zero bytes`,
      { attachment: name },
    );
  }

  return bytes;
}

/** Build one Graph `fileAttachment` for the inline (simple-upload) path. */
function buildAttachmentPayload(attachment: IMailAttachmentInput): Record<string, unknown> {
  // Validate (including base64 and byte count) before emitting a payload.
  decodeAttachmentBytes(attachment);

  const payload: Record<string, unknown> = {
    '@odata.type': FILE_ATTACHMENT_TYPE,
    name: String(attachment.name).trim(),
    contentType: typeof attachment.contentType === 'string' && attachment.contentType.trim().length > 0
      ? attachment.contentType.trim()
      : 'application/octet-stream',
    contentBytes: attachmentBase64(attachment),
  };

  if (attachment.isInline === true) payload.isInline = true;

  return payload;
}

/** Build one Graph recipient envelope, rejecting an address-less entry. */
function buildRecipient(value: IMailRecipient): Record<string, unknown> {
  const flat: IMailAddress = typeof value === 'string' ? { address: value } : (value || {});
  const address = typeof flat.address === 'string' ? flat.address.trim() : '';

  if (address.length === 0) {
    throw apiError(
      MAIL_ERROR_CODES.INVALID_RECIPIENT,
      'Every mail recipient requires a non-empty address',
    );
  }

  const emailAddress: Record<string, string> = { address };
  const name = typeof flat.name === 'string' ? flat.name.trim() : '';
  if (name.length > 0) emailAddress.name = name;

  return { emailAddress };
}

/** Build a Graph recipient list; `undefined` and `null` mean "not supplied". */
function buildRecipientList(
  values: IMailRecipient[] | undefined,
  field: string,
): Record<string, unknown>[] | undefined {
  if (values === undefined || values === null) return undefined;

  if (!Array.isArray(values)) {
    throw apiError(MAIL_ERROR_CODES.INVALID_RECIPIENT, `${field} must be an array of recipients`);
  }

  return values.map((value) => buildRecipient(value));
}

/** Accept `text`/`Text` and `html`/`HTML`, and emit the documented spelling. */
function normaliseBodyContentType(value: string | undefined): MailBodyContentType {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (raw === 'text') return 'Text';
  if (raw === 'html') return 'HTML';

  throw apiError(
    MAIL_ERROR_CODES.INVALID_MESSAGE,
    `Unsupported message body contentType [${String(value)}]; expected Text or HTML`,
    { supported: ['Text', 'HTML'] },
  );
}

/** Validate `importance` against Graph's three values. */
function normaliseImportance(value: string): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if ((MAIL_IMPORTANCE_VALUES as readonly string[]).includes(raw)) return raw;

  throw apiError(
    MAIL_ERROR_CODES.INVALID_MESSAGE,
    `Unsupported importance [${String(value)}]`,
    { supported: [...MAIL_IMPORTANCE_VALUES] },
  );
}

/**
 * Build the Graph `message` object for a send, draft create or draft patch.
 *
 * Only properties the caller actually supplied are emitted: an absent `subject`
 * must not be sent as an empty string (Graph would clear it on a PATCH), and an
 * empty attachment list must not be sent as `attachments: []` - the wire body is
 * asserted exactly, so nothing is invented.
 */
function buildMessagePayload(
  input: IMailMessageInput,
  attachments: IMailAttachmentInput[] | undefined,
  requireRecipients: boolean,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    throw apiError(MAIL_ERROR_CODES.INVALID_MESSAGE, 'A message is required');
  }

  if (!input.body || typeof input.body !== 'object') {
    throw apiError(MAIL_ERROR_CODES.INVALID_MESSAGE, 'message.body is required');
  }

  const toRecipients = buildRecipientList(input.toRecipients, 'toRecipients');

  if (requireRecipients === true && (toRecipients === undefined || toRecipients.length === 0)) {
    throw apiError(
      MAIL_ERROR_CODES.INVALID_RECIPIENT,
      'A message requires at least one toRecipients entry',
    );
  }

  const message: Record<string, unknown> = {
    body: {
      contentType: normaliseBodyContentType(input.body.contentType),
      content: typeof input.body.content === 'string' ? input.body.content : '',
    },
  };

  if (typeof input.subject === 'string') message.subject = input.subject;
  if (toRecipients !== undefined) message.toRecipients = toRecipients;

  const ccRecipients = buildRecipientList(input.ccRecipients, 'ccRecipients');
  if (ccRecipients !== undefined) message.ccRecipients = ccRecipients;

  const bccRecipients = buildRecipientList(input.bccRecipients, 'bccRecipients');
  if (bccRecipients !== undefined) message.bccRecipients = bccRecipients;

  const replyTo = buildRecipientList(input.replyTo, 'replyTo');
  if (replyTo !== undefined) message.replyTo = replyTo;

  if (input.importance !== undefined) message.importance = normaliseImportance(input.importance);

  if (attachments !== undefined && attachments.length > 0) {
    message.attachments = attachments.map((attachment) => buildAttachmentPayload(attachment));
  }

  return message;
}

/**
 * Build the body of `PATCH /me/messages/{id}` from a partial message.
 *
 * Only the properties the caller supplied are emitted: a PATCH is a merge, so a
 * defaulted empty `subject` or an invented `body` would clear data on the draft.
 */
function buildDraftPatch(patch: IMailDraftPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (typeof patch.subject === 'string') body.subject = patch.subject;

  if (patch.body !== undefined && patch.body !== null) {
    body.body = {
      contentType: normaliseBodyContentType(patch.body.contentType),
      content: typeof patch.body.content === 'string' ? patch.body.content : '',
    };
  }

  const toRecipients = buildRecipientList(patch.toRecipients, 'toRecipients');
  if (toRecipients !== undefined) body.toRecipients = toRecipients;

  const ccRecipients = buildRecipientList(patch.ccRecipients, 'ccRecipients');
  if (ccRecipients !== undefined) body.ccRecipients = ccRecipients;

  const bccRecipients = buildRecipientList(patch.bccRecipients, 'bccRecipients');
  if (bccRecipients !== undefined) body.bccRecipients = bccRecipients;

  const replyTo = buildRecipientList(patch.replyTo, 'replyTo');
  if (replyTo !== undefined) body.replyTo = replyTo;

  if (patch.importance !== undefined) body.importance = normaliseImportance(patch.importance);

  if (patch.attachments !== undefined && patch.attachments.length > 0) {
    body.attachments = patch.attachments.map((attachment) => buildAttachmentPayload(attachment));
  }

  return body;
}

/**
 * Build the body of a `reply` / `replyAll` / `forward` action.
 *
 * There is deliberately **no quoting here**: Graph's sub-paths quote the original
 * message (and set the recipients) themselves. A locally-built `> ...` or
 * `From:/Sent:` block would duplicate that and is exactly what this ticket
 * forbids.
 */
function buildResponseActionBody(
  action: 'reply' | 'replyAll' | 'forward',
  input: IMailReplyInput | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  const comment = typeof input?.comment === 'string' ? input.comment : '';
  if (comment.length > 0) body.comment = comment;

  const toRecipients = buildRecipientList(input?.toRecipients, 'toRecipients');

  if (action === 'forward') {
    // Graph's `/forward` requires at least one recipient; without one it answers
    // 400 ErrorInvalidRequest. Failing here mirrors the `requireRecipients` path
    // of {@link buildMessagePayload}: the neighbouring mistake (recipients on a
    // reply) is already rejected before any request, and a named error is more
    // useful to a caller than Graph's generic 400.
    if (toRecipients === undefined || toRecipients.length === 0) {
      throw apiError(
        MAIL_ERROR_CODES.INVALID_RECIPIENT,
        'forwardMessage requires at least one toRecipients entry',
        { action },
      );
    }

    body.toRecipients = toRecipients;
  } else if (toRecipients !== undefined) {
    throw apiError(
      MAIL_ERROR_CODES.INVALID_RECIPIENT,
      `toRecipients is only valid on forward; ${action} addresses the original participants`,
      { action },
    );
  }

  return body;
}

/** Attachment metadata (never the bytes), used by `listAttachments`. */
function normaliseAttachmentInfo(value: any, index: number): IMailAttachmentInfo {
  const info: IMailAttachmentInfo = { id: String(value?.id ?? `attachment-${index}`) };

  if (typeof value?.name === 'string') info.name = value.name;
  if (typeof value?.contentType === 'string') info.contentType = value.contentType;
  if (typeof value?.size === 'number') info.size = value.size;
  if (value?.isInline === true) info.isInline = true;
  if (typeof value?.lastModifiedDateTime === 'string') {
    info.lastModifiedDateTime = value.lastModifiedDateTime;
  }

  return info;
}

/**
 * AzureMailService - Microsoft Graph mail.
 *
 * AZ-04 delivered the read surface; AZ-05 adds the write surface (send, reply,
 * forward, drafts and attachments). The service is a thin, typed adapter over
 * `AzureGraphClientProvider`:
 *
 *   - the provider owns the Graph `Client`, retries, `@odata.nextLink`
 *     pagination and error translation, so this service never re-implements
 *     transport policy;
 *   - every failure propagates as an `ApiError` carrying the Graph `code`
 *     (`ErrorInvalidRequest`, `InvalidAuthenticationToken`, `itemNotFound`, ...).
 *     No method returns `[]`, `null` or a placeholder on failure - the legacy
 *     `getEmails` behaviour this ticket replaces;
 *   - reads are normalised (flattened recipients, guaranteed body, promoted
 *     `nextLink`) so a Graph shape change stops at this boundary;
 *   - **writes fail loudly**. A failed send rejects with the `ApiError` from
 *     Graph; no write path can resolve to a truthy non-boolean/non-message value.
 *     The legacy `sendEmail` caught its own failure and returned Express's
 *     `response` module export - a truthy object - so a failed send looked like a
 *     successful one (audit D6). That code path does not exist here.
 */
@service({
  id: 'azure.AzureMailService@1.0.0',
  name: 'AzureMailService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph mail - messages, folders, categories, conversations, send/reply/forward, drafts and attachments',
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

  /* ---------------------------------------------------------------------- */
  /* Writes (AZ-05)                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * `POST /me/sendMail` - send a message in one request.
   *
   * The wire body is exactly `{ message, saveToSentItems }`. The message carries
   * `body { contentType, content }`, the recipient lists, `subject`, optional
   * `importance`, and the attachments that fit Graph's 3 MB simple-upload
   * ceiling.
   *
   * ## Attachments
   *
   * Graph cannot accept an attachment above its simple-upload limit inside
   * `sendMail`. Rather than dropping it - the behaviour this ticket forbids - one
   * oversized attachment switches the whole send to the supported resumable
   * route:
   *
   *   1. `POST /me/messages` creates a draft carrying the inline attachments;
   *   2. every oversized attachment is streamed through
   *      `POST …/attachments/createUploadSession` in 320 KiB-multiple fragments;
   *   3. `POST /me/messages/{id}/send` sends the completed draft.
   *
   * Any failure on that path rejects with the `ApiError` from Graph, and the draft
   * is deleted best-effort: the message is never sent with an attachment missing.
   *
   * @returns `true` once Graph accepted the send. A failure always rejects: this
   * method never resolves to a placeholder, and never to Express's `response`
   * module export (the audit D6 defect).
   * @throws ApiError carrying the Graph `code`
   */
  async sendMessage(
    userId: string,
    input: IMailMessageInput,
    options: IMailSendOptions = {},
  ): Promise<boolean> {
    const uid = this.requireUserId(userId, 'mail.sendMessage');

    const saveToSentItems = options?.saveToSentItems === undefined
      ? MAIL_DEFAULT_SAVE_TO_SENT_ITEMS
      : options.saveToSentItems !== false;

    const { inline, oversized } = this.partitionAttachments(input?.attachments);
    const inlineAttachments = inline.length > 0 ? inline : undefined;

    if (oversized.length === 0) {
      const message = buildMessagePayload(input, inlineAttachments, true);

      await this.send(uid, 'mail.sendMessage', (client) =>
        client.api(SEND_MAIL_PATH).post({ message, saveToSentItems }));

      return true;
    }

    // Graph has no `saveToSentItems` switch on the draft-send endpoint, so a
    // caller asking for `false` cannot be honoured on this path. Refusing beats
    // sending a copy the caller explicitly did not want.
    if (saveToSentItems === false) {
      throw apiError(
        MAIL_ERROR_CODES.SAVE_TO_SENT_ITEMS_UNSUPPORTED,
        'Graph cannot suppress Sent Items when an attachment needs a resumable upload; '
          + 'send with saveToSentItems defaulted, or attach the file by reference',
        {
          operation: 'mail.sendMessage',
          oversizedAttachments: oversized.map((attachment) => String(attachment?.name ?? '')),
          simpleUploadMaxBytes: MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES,
        },
      );
    }

    const draftBody = buildMessagePayload(input, inlineAttachments, true);

    const draft = await this.send<any>(uid, 'mail.sendMessage.createDraft', (client) =>
      client.api(MESSAGES_PATH).post(draftBody));

    const draftId = this.requireGraphMessageId(draft, 'mail.sendMessage.createDraft');

    try {
      for (const attachment of oversized) {
        await this.uploadAttachmentInSession(uid, draftId, attachment, 'mail.sendMessage.attachment');
      }

      await this.send(uid, 'mail.sendMessage.sendDraft', (client) =>
        client.api(`${MESSAGES_PATH}/${encodePathSegment(draftId)}/send`).post());
    } catch (error) {
      // The draft may already hold some uploaded fragments; remove it so a failed
      // send leaves no half-built message behind. Cleanup never masks the failure.
      await this.discardDraft(uid, draftId);
      throw error;
    }

    return true;
  }

  /**
   * `POST /me/messages/{id}/reply` with an optional `comment`.
   *
   * Graph quotes the original message and addresses the sender itself; no
   * quoting is generated here (see {@link buildResponseActionBody}).
   *
   * @throws ApiError carrying the Graph `code`
   */
  async replyToMessage(
    userId: string,
    messageId: string,
    input: IMailReplyInput = {},
  ): Promise<boolean> {
    return this.respondToMessage(userId, messageId, 'reply', input);
  }

  /**
   * `POST /me/messages/{id}/replyAll` with an optional `comment`.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async replyAll(
    userId: string,
    messageId: string,
    input: IMailReplyInput = {},
  ): Promise<boolean> {
    return this.respondToMessage(userId, messageId, 'replyAll', input);
  }

  /**
   * `POST /me/messages/{id}/forward` with an optional `comment` and the
   * recipients to forward to (`toRecipients`).
   *
   * @throws ApiError carrying the Graph `code`
   */
  async forwardMessage(
    userId: string,
    messageId: string,
    input: IMailReplyInput = {},
  ): Promise<boolean> {
    return this.respondToMessage(userId, messageId, 'forward', input);
  }

  /**
   * `POST /me/messages` - create a draft.
   *
   * `isDraft` is deliberately **not sent**: Graph already creates the message as a
   * draft, and setting the flag by hand is a well-known way to create a message
   * that cannot be sent. The created message is returned normalised.
   *
   * Attachments are inlined here, so this call is bounded by Graph's 3 MB
   * simple-upload ceiling: a larger file makes Graph reject the create, and that
   * rejection is preserved. Resumable attachment handling lives on
   * {@link sendMessage}, which is the only path that must never lose a file.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async createDraft(userId: string, input: IMailMessageInput): Promise<IMailMessage> {
    const uid = this.requireUserId(userId, 'mail.createDraft');
    const body = buildMessagePayload(input, input?.attachments, false);

    const draft = await this.send<any>(uid, 'mail.createDraft', (client) =>
      client.api(MESSAGES_PATH).post(body));

    this.requireGraphMessageId(draft, 'mail.createDraft');

    return normaliseMessage(draft);
  }

  /**
   * `PATCH /me/messages/{id}` - update a draft.
   *
   * Only supplied properties are sent. An empty patch is rejected rather than
   * issued as a no-op, and a reply without a message body rejects instead of
   * handing back a synthetic `id: ''`.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async updateDraft(
    userId: string,
    messageId: string,
    patch: IMailDraftPatch,
  ): Promise<IMailMessage> {
    const uid = this.requireUserId(userId, 'mail.updateDraft');
    this.requireMessageId(messageId);

    if (!patch || typeof patch !== 'object') {
      throw apiError(MAIL_ERROR_CODES.INVALID_MESSAGE, 'A draft patch is required');
    }

    const body = buildDraftPatch(patch);

    if (Object.keys(body).length === 0) {
      throw apiError(
        MAIL_ERROR_CODES.INVALID_MESSAGE,
        'updateDraft requires at least one field to change',
        { messageId: String(messageId) },
      );
    }

    const updated = await this.send<any>(uid, 'mail.updateDraft', (client) =>
      client.api(`${MESSAGES_PATH}/${encodePathSegment(String(messageId))}`).patch(body));

    this.requireGraphMessageId(updated, 'mail.updateDraft');

    return normaliseMessage(updated);
  }

  /**
   * `POST /me/messages/{id}/send` - send an existing draft.
   *
   * @returns `true` only when Graph accepted the send.
   * @throws ApiError carrying the Graph `code`
   */
  async sendDraft(userId: string, messageId: string): Promise<boolean> {
    const uid = this.requireUserId(userId, 'mail.sendDraft');
    this.requireMessageId(messageId);

    await this.send(uid, 'mail.sendDraft', (client) =>
      client.api(`${MESSAGES_PATH}/${encodePathSegment(String(messageId))}/send`).post());

    return true;
  }

  /**
   * `DELETE /me/messages/{id}` - delete a draft.
   *
   * @returns `true` only when Graph accepted the delete.
   * @throws ApiError carrying the Graph `code`
   */
  async deleteDraft(userId: string, messageId: string): Promise<boolean> {
    const uid = this.requireUserId(userId, 'mail.deleteDraft');
    this.requireMessageId(messageId);

    await this.send(uid, 'mail.deleteDraft', (client) =>
      client.api(`${MESSAGES_PATH}/${encodePathSegment(String(messageId))}`).delete());

    return true;
  }

  /**
   * `GET /me/messages/{id}/attachments` - metadata only.
   *
   * `contentBytes` is excluded from the projection: a mailbox listing must never
   * pull megabytes of base64 per attachment. Use {@link getAttachment} for the
   * bytes of one attachment.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listAttachments(
    userId: string,
    messageId: string,
  ): Promise<IMailAttachmentInfo[]> {
    const uid = this.requireUserId(userId, 'mail.listAttachments');
    this.requireMessageId(messageId);

    const attachments = await this.graphClientProvider.requestAll<any>(
      uid,
      `${MESSAGES_PATH}/${encodePathSegment(String(messageId))}/${ATTACHMENTS_SEGMENT}`,
      {
        select: MAIL_ATTACHMENT_SELECT,
        operation: 'listAttachments',
      },
    );

    return (Array.isArray(attachments) ? attachments : [])
      .map((entry, index) => normaliseAttachmentInfo(entry, index));
  }

  /**
   * `GET /me/messages/{id}/attachments/{attachmentId}` - one attachment,
   * including its base64 `contentBytes`.
   *
   * `{ name, contentType, size, contentBytes }` is returned exactly as the ticket
   * specifies. `contentBytes` is required: a base type that carries none
   * (`itemAttachment`, `referenceAttachment`) is reported as a failure, not as an
   * attachment with missing content.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async getAttachment(
    userId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<IMailAttachmentContent> {
    const uid = this.requireUserId(userId, 'mail.getAttachment');
    this.requireMessageId(messageId);

    if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
      throw apiError(MAIL_ERROR_CODES.INVALID_ATTACHMENT, 'An attachment id is required');
    }

    const raw = await this.graphClientProvider.request<any>(
      uid,
      `${MESSAGES_PATH}/${encodePathSegment(String(messageId))}/${ATTACHMENTS_SEGMENT}/`
        + `${encodePathSegment(String(attachmentId))}`,
      {
        select: MAIL_ATTACHMENT_CONTENT_SELECT,
        operation: 'getAttachment',
      },
    );

    const contentBytes = typeof raw?.contentBytes === 'string' ? raw.contentBytes : '';

    if (contentBytes.length === 0) {
      throw apiError(
        MAIL_ERROR_CODES.INVALID_ATTACHMENT,
        'Microsoft Graph returned no contentBytes for this attachment; it cannot be downloaded',
        { attachmentId: String(attachmentId), odataType: raw?.['@odata.type'] },
      );
    }

    const attachment: IMailAttachmentContent = {
      name: typeof raw?.name === 'string' ? raw.name : '',
      contentBytes,
    };

    if (typeof raw?.contentType === 'string') attachment.contentType = raw.contentType;
    if (typeof raw?.size === 'number') attachment.size = raw.size;

    return attachment;
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

  /* ---------------------------------------------------------------------- */
  /* Write helpers (AZ-05)                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolve and validate the mailbox owner for a write.
   *
   * A write is authenticated with that user's vaulted token, so an empty id can
   * only produce a confusing `NotConnected` from the provider - name it here.
   */
  private requireUserId(userId: string, operation: string): string {
    const uid = typeof userId === 'string' ? userId.trim() : '';

    if (uid.length === 0) {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        `A userId is required for ${operation}`,
        { operation },
      );
    }

    return uid;
  }

  /**
   * Graph must answer a write with a real message id.
   *
   * A 204/empty body is not a message; mapping it would hand the caller a
   * synthetic `id: ''` - the "never a placeholder" rule applies to writes too.
   */
  private requireGraphMessageId(message: any, operation: string): string {
    const id = typeof message?.id === 'string' ? message.id : '';

    if (id.length === 0) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned no message id for the write',
        { operation },
      );
    }

    return id;
  }

  /**
   * Split attachments into the inline (simple-upload) and resumable sets.
   *
   * The boundary is {@link MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}, closed at the
   * top so a 3 MB attachment takes the upload-session path. Every attachment is
   * decoded here, so a malformed one rejects the send before any request is made -
   * it is never silently left out.
   */
  private partitionAttachments(
    attachments: IMailAttachmentInput[] | undefined,
  ): { inline: IMailAttachmentInput[]; oversized: IMailAttachmentInput[] } {
    const inline: IMailAttachmentInput[] = [];
    const oversized: IMailAttachmentInput[] = [];

    if (attachments === undefined || attachments === null) return { inline, oversized };

    if (!Array.isArray(attachments)) {
      throw apiError(MAIL_ERROR_CODES.INVALID_ATTACHMENT, 'attachments must be an array');
    }

    for (const attachment of attachments) {
      const bytes = decodeAttachmentBytes(attachment);

      if (bytes.length >= MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES) oversized.push(attachment);
      else inline.push(attachment);
    }

    return { inline, oversized };
  }

  /** Reply, reply-all and forward share one sub-path shape; only the action differs. */
  private async respondToMessage(
    userId: string,
    messageId: string,
    action: 'reply' | 'replyAll' | 'forward',
    input: IMailReplyInput | undefined,
  ): Promise<boolean> {
    const uid = this.requireUserId(userId, `mail.${action}`);
    this.requireMessageId(messageId);

    const body = buildResponseActionBody(action, input);

    await this.send(uid, `mail.${action}`, (client) =>
      client.api(`${MESSAGES_PATH}/${encodePathSegment(String(messageId))}/${action}`).post(body));

    return true;
  }

  /**
   * Stream one attachment through a resumable upload session.
   *
   * `createUploadSession` is the only route Graph offers above the simple-upload
   * ceiling. Fragments are `Content-Range`-addressed PUTs of
   * {@link MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE} bytes, and the upload URL is
   * contacted **without** the bearer token because it is already authorised.
   *
   * @throws ApiError when the session has no `uploadUrl`, a fragment is refused,
   * or Graph never confirms the attachment
   */
  private async uploadAttachmentInSession(
    userId: string,
    messageId: string,
    attachment: IMailAttachmentInput,
    operation: string,
  ): Promise<void> {
    const bytes = decodeAttachmentBytes(attachment);
    const size = bytes.length;
    const name = String(attachment.name).trim();
    const contentType = typeof attachment.contentType === 'string'
      && attachment.contentType.trim().length > 0
      ? attachment.contentType.trim()
      : 'application/octet-stream';

    const sessionPath = `${MESSAGES_PATH}/${encodePathSegment(messageId)}`
      + `/${ATTACHMENTS_SEGMENT}/createUploadSession`;

    const session = await this.send<any>(userId, `${operation}.createUploadSession`, (client) =>
      client.api(sessionPath).post({
        AttachmentItem: {
          attachmentType: 'file',
          name,
          size,
          contentType,
        },
      }));

    const uploadUrl = typeof session?.uploadUrl === 'string' ? session.uploadUrl : '';

    if (uploadUrl.length === 0) {
      throw apiError(
        MAIL_ERROR_CODES.MISSING_UPLOAD_URL,
        'Microsoft Graph did not return an uploadUrl for the attachment upload session',
        { operation, attachment: name },
      );
    }

    let offset = 0;

    while (offset < size) {
      const end = Math.min(offset + MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE, size);
      // `subarray` is a view (no copy); the Node type for it is `Uint8Array`, but
      // at runtime it is the same Buffer.
      const chunk: Buffer = bytes.subarray(offset, end) as Buffer;

      const response = await this.transfer({
        url: uploadUrl,
        method: 'PUT',
        // No `Content-Length`: it is a forbidden request header in the Fetch
        // spec (undici silently drops it, computing the length itself), so
        // sending it would only be dead configuration.
        headers: {
          'Content-Range': `bytes ${offset}-${end - 1}/${size}`,
          'Content-Type': contentType,
        },
        body: chunk,
      });

      if (response.status === 200 || response.status === 201) {
        // Graph answers the *last* fragment with 201. A 201 before the end means
        // the file it stored is shorter than the one we were asked to send; say so
        // instead of reporting a successful upload.
        if (end >= size) return;

        throw apiError(
          MAIL_ERROR_CODES.UPLOAD_FAILED,
          `Microsoft Graph reported attachment [${name}] complete after ${end} of ${size} bytes`,
          { operation, attachment: name, uploadedBytes: end, size },
        );
      }

      if (response.status === 202 || response.status === 416) {
        const payload = await this.readResponsePayload(response.body);
        const next = this.parseNextExpectedRange(payload?.nextExpectedRanges);

        if (response.status === 202) {
          // Only ever move forward: a stale range must not rewind the upload.
          offset = next !== undefined && next > offset ? next : end;
          continue;
        }

        if (next !== undefined && next > offset) {
          offset = next;
          continue;
        }
      }

      throw await this.httpFailure(response, `${operation}.fragment`);
    }

    // The final fragment answered 202 rather than 201, so Graph has not confirmed
    // the attachment. Read it back instead of assuming the draft is complete.
    const metadata = await this.listAttachments(userId, messageId);
    const landed = metadata.some((entry) => entry.name === name);

    if (!landed) {
      throw apiError(
        MAIL_ERROR_CODES.UPLOAD_FAILED,
        `Microsoft Graph did not confirm attachment [${name}] after the upload session completed`,
        { operation, attachment: name, size },
      );
    }
  }

  /** Send one fragment to the pre-authenticated upload URL. */
  private async transfer(request: IMailHttpRequest): Promise<IMailHttpResponse> {
    try {
      return await activeMailHttpClient(request);
    } catch (error: any) {
      throw toGraphApiError(error, { operation: `mail.transfer.${request.method}` });
    }
  }

  /** Parse a raw response body that may be JSON text, a Buffer or an object. */
  private async readResponsePayload(body: unknown): Promise<any> {
    if (body === undefined || body === null) return undefined;

    const candidate: any = body;

    if (typeof candidate === 'string') return this.tryParseJson(candidate);
    if (Buffer.isBuffer(candidate)) return this.tryParseJson(candidate.toString('utf8'));

    try {
      if (typeof candidate.json === 'function') return await candidate.json();
      if (typeof candidate.text === 'function') return this.tryParseJson(await candidate.text());
    } catch {
      return undefined;
    }

    return candidate;
  }

  /** JSON, or a `{ message }` object when the payload was plain text. */
  private tryParseJson(value: string): any {
    if (!value) return undefined;

    try {
      return JSON.parse(value);
    } catch {
      return { message: value };
    }
  }

  /** Translate a non-2xx fragment response into an `ApiError` with the Graph code. */
  private async httpFailure(
    response: IMailHttpResponse,
    operation: string,
  ): Promise<ApiError> {
    const payload = await this.readResponsePayload(response.body);
    const graphCode = payload?.error?.code ?? payload?.code;
    const message = payload?.error?.message
      || payload?.message
      || `Microsoft Graph attachment upload failed with status ${response.status}`;

    return toGraphApiError(
      { statusCode: response.status, code: graphCode, message, body: payload },
      { operation },
    );
  }

  /** The first byte offset of `nextExpectedRanges`, if Graph supplied one. */
  private parseNextExpectedRange(ranges: unknown): number | undefined {
    if (!Array.isArray(ranges) || ranges.length === 0) return undefined;

    const match = /^(\d+)-/.exec(String(ranges[0]));
    if (!match) return undefined;

    const next = Number(match[1]);
    return Number.isFinite(next) ? next : undefined;
  }

  /**
   * Best-effort removal of the transient draft behind a failed resumable send.
   *
   * A cleanup failure is swallowed on purpose: the caller must receive the
   * original Graph error, which is the failure that matters. An orphaned draft is
   * a nuisance; a swallowed send failure is the defect this ticket exists to kill.
   */
  private async discardDraft(userId: string, draftId: string): Promise<void> {
    try {
      await this.send(userId, 'mail.sendMessage.discardDraft', (client) =>
        client.api(`${MESSAGES_PATH}/${encodePathSegment(draftId)}`).delete());
    } catch {
      // Nothing to add: the original failure is rethrown by the caller.
    }
  }

  /**
   * Run one Graph write and translate every failure to an `ApiError`.
   *
   * This is the single exit from every write path, which is what makes the
   * contract enforceable: `run` either resolves with Graph's answer, or this
   * method throws a typed `ApiError`. There is no branch that returns a
   * placeholder - in particular it can never return Express's `response` module
   * export, which is what made the legacy `sendEmail` report a failed send as a
   * success (audit D6).
   */
  private async send<T>(
    userId: string,
    operation: string,
    run: (client: any) => Promise<T>,
  ): Promise<T> {
    const provider = this.graphClientProvider;

    if (!provider || typeof provider.getClient !== 'function') {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Microsoft Graph client provider cannot build a client for a mail write',
        { operation },
      );
    }

    const client = provider.getClient(userId);

    try {
      return await run(client);
    } catch (error: any) {
      const tokenSource = typeof client?.__azureTokenSource === 'function'
        ? client.__azureTokenSource()
        : undefined;

      throw toGraphApiError(error, { operation, tokenSource });
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
  description: 'Microsoft Graph mail - messages, folders, categories, conversations, send/reply/forward, drafts and attachments',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'core.RedisService@1.0.0', alias: 'redisService' },
  ],
};

export { AzureMailService };

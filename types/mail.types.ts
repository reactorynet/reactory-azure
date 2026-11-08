/**
 * Mail domain types (AZ-04).
 *
 * This file is the whole public contract of `AzureMailService`. It is a domain
 * file, not a transport file: `types/graph.types.ts` describes the provider
 * (paging, retries, `$select`/`$search`), and everything here describes an
 * Outlook *message*, *folder* or *category* after normalisation.
 *
 * Normalisation is deliberate and is part of the contract:
 *
 *   - Graph nests every address inside `emailAddress`, i.e.
 *     `{ emailAddress: { name, address } }`. The service flattens it to
 *     `{ name, address }` so a caller never has to know Graph's envelope.
 *   - Graph returns `body` as `{ contentType, content }` or omits it entirely.
 *     The service always returns `{ contentType, content }` (empty text body when
 *     Graph sent none), so `message.body.content` is never `undefined`.
 *   - `@odata.nextLink` is promoted from the OData envelope to the typed
 *     `nextLink` property. It is an opaque absolute URL: pass it back to the
 *     provider, never parse it.
 */

/** A single mail address, flattened out of Graph's `emailAddress` envelope. */
export interface IMailAddress {
  name?: string;
  address?: string;
}

/** A message body. `contentType` is Graph's (`text` or `html`). */
export interface IMailBody {
  contentType: string;
  content: string;
}

/** An attachment as returned by `$expand=attachments`. */
export interface IMailAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  /** Base64 payload - present only for small, file-backed attachments. */
  contentBytes?: string;
  lastModifiedDateTime?: string;
  '@odata.type'?: string;
}

/** A normalised Outlook message. */
export interface IMailMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  /** Always present - see the normalisation note at the top of this file. */
  body: IMailBody;
  from?: IMailAddress;
  sender?: IMailAddress;
  toRecipients: IMailAddress[];
  ccRecipients: IMailAddress[];
  bccRecipients: IMailAddress[];
  replyTo: IMailAddress[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  importance?: string;
  categories: string[];
  parentFolderId?: string;
  webLink?: string;
  /** Present when `options.expand` included `attachments`. */
  attachments?: IMailAttachment[];
}

/** A mail folder, including the two counters the ticket requires. */
export interface IMailFolder {
  id: string;
  displayName?: string;
  parentFolderId?: string;
  /** Number of direct child folders - Graph's `childFolderCount`. */
  childFolderCount: number;
  /** Unread items in this folder - Graph's `unreadItemCount`. */
  unreadItemCount: number;
  totalItemCount?: number;
  wellKnownName?: string;
}

/** An Outlook master category. */
export interface IMailCategory {
  id?: string;
  displayName: string;
  color?: string;
}

/**
 * Options for `listMessages`, `listMessagesInFolder` and `listByConversation`.
 *
 * `search` is NOT Gmail syntax - see the `$search` documentation on
 * `AzureMailService#listMessages`.
 */
export interface IMailListOptions {
  /** `$top` - page size. Defaults to {@link DEFAULT_MAIL_PAGE_SIZE}. */
  top?: number;
  /** `$filter` - a raw OData expression (mailbox properties only). */
  filter?: string;
  /** `$search` - a quoted KQL expression (see the service JSDoc). */
  search?: string;
  /**
   * `$orderby`. Only sent when explicitly supplied alongside `search`: the
   * `$search` + `$orderby` interaction is unverified, so it is never defaulted
   * into a search request.
   */
  orderBy?: string | string[];
  /** `$select` override. Defaults to the module's message projection. */
  select?: string | string[];
  /** `$skip` - offset. Not supported with `$search`. */
  skip?: number;
  /** `$expand` - e.g. `attachments`. */
  expand?: string | string[];
  /** `$count`. Suppressed for an unverified search + default-order request. */
  count?: boolean;
  /**
   * Send `Prefer: IdType="ImmutableId"`.
   *
   * Immutable ids survive a message being moved between folders. They change
   * *shape* (`AAkALgAAAAAA...` rather than `AAMkAD...`): treat them as opaque,
   * never parse or truncate them, and do not mix them with ids obtained without
   * this header.
   */
  immutableIds?: boolean;
  /**
   * Follow `@odata.nextLink` to exhaustion and return every page.
   *
   * The result is `{ items }` - no `nextLink` (the chain is finished) and no
   * `count`, because `requestAll` does not surface the first page's
   * `@odata.count`. Ask for a single page when the total is needed.
   */
  all?: boolean;
  /** Hard page bound for `all`; defaults to the provider's bound. */
  maxPages?: number;
}

/** Options for `getMessage`. */
export interface IMailGetOptions {
  /** `$select` override. */
  select?: string | string[];
  /** `$expand`; the only accepted value is `attachments` (validated). */
  expand?: string | string[];
  /** See {@link IMailListOptions.immutableIds}. */
  immutableIds?: boolean;
}

/** One page of messages plus the opaque cursor for the next one. */
export interface IMailPage {
  items: IMailMessage[];
  /** `@odata.nextLink` - absent on the last page. */
  nextLink?: string;
  /** `@odata.count` - present only when `$count=true` was sent. */
  count?: number;
}

/* -------------------------------------------------------------------------- */
/* Write domain (AZ-05)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A recipient accepted by a write call: a bare address (`'a@b.test'`) or the
 * flattened `{ name, address }` shape. Both are converted to Graph's
 * `{ emailAddress: { name, address } }` envelope by the service, so a caller
 * never builds Graph's nesting by hand.
 */
export type IMailRecipient = string | IMailAddress;

/**
 * The body content type on a message being written.
 *
 * Graph accepts `Text`/`HTML` (and the lower-case variants); the service accepts
 * either casing and emits the documented `Text` / `HTML` spelling, so the wire
 * body is deterministic.
 */
export type MailBodyContentType = 'Text' | 'HTML';

/** A message body being written. */
export interface IMailBodyInput {
  contentType: MailBodyContentType | string;
  content: string;
}

/** Graph's three importance values. */
export type MailImportance = 'low' | 'normal' | 'high';

/**
 * An attachment being written.
 *
 * `contentBytes` is **base64** (Graph's fileAttachment wire encoding), never a
 * path or a URL. The service decodes it to learn the real byte length: that
 * length decides between the inline (`sendMail`) path and the resumable
 * `createUploadSession` path - it is never inferred from the caller's `size`.
 */
export interface IMailAttachmentInput {
  name: string;
  contentType?: string;
  contentBytes: string;
  isInline?: boolean;
}

/** A message being sent, drafted or patched. */
export interface IMailMessageInput {
  subject?: string;
  body: IMailBodyInput;
  toRecipients?: IMailRecipient[];
  ccRecipients?: IMailRecipient[];
  bccRecipients?: IMailRecipient[];
  replyTo?: IMailRecipient[];
  attachments?: IMailAttachmentInput[];
  importance?: MailImportance | string;
}

/**
 * A partial message for `PATCH /me/messages/{id}`.
 *
 * At least one property must be present; an empty patch is rejected rather than
 * sent as a no-op.
 */
export type IMailDraftPatch = Partial<IMailMessageInput>;

/**
 * The body of `reply`, `replyAll` and `forward`.
 *
 * `comment` is the only content the caller supplies. The service never builds
 * the quoted thread itself: Graph's `/reply`, `/replyAll` and `/forward`
 * sub-paths quote the original message and set the recipients, and a
 * locally-generated quote would duplicate (and corrupt) that.
 *
 * `toRecipients` is valid for `forward` only - Graph's reply actions address the
 * original participants themselves.
 */
export interface IMailReplyInput {
  comment?: string;
  toRecipients?: IMailRecipient[];
}

/** Options for `sendMessage`. */
export interface IMailSendOptions {
  /**
   * `saveToSentItems` on `POST /me/sendMail`. Defaults to `true`.
   *
   * Graph has no equivalent switch on `POST /me/messages/{id}/send`, so a send
   * that has to create a draft (because an attachment needs an upload session)
   * always leaves a Sent Items copy. Asking for `false` on that path is rejected
   * instead of being silently ignored.
   */
  saveToSentItems?: boolean;
}

/** Attachment metadata - never the bytes. */
export interface IMailAttachmentInfo {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  lastModifiedDateTime?: string;
}

/** One attachment's metadata **and** its base64 content. */
export interface IMailAttachmentContent {
  name: string;
  contentType?: string;
  size?: number;
  contentBytes: string;
}

/* -------------------------------------------------------------------------- */
/* Attachment transfer seam                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One raw HTTP request to a **pre-authenticated** Graph upload URL.
 *
 * `createUploadSession` returns an `uploadUrl` that must be contacted *without* a
 * bearer token: the URL is already authorised, and the token belongs to
 * `graph.microsoft.com`, not to the upload host. The Graph SDK cannot express
 * that, which is why a small transport seam exists here.
 */
export interface IMailHttpRequest {
  url: string;
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: Buffer | string;
}

/** A raw HTTP response returned by the attachment transport. */
export interface IMailHttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

/** The transport used for resumable attachment uploads. Tests replace it. */
export type MailHttpClient = (request: IMailHttpRequest) => Promise<IMailHttpResponse>;

/** The complete public surface of `AzureMailService`. */
export interface IAzureMailService {
  /* Reads (AZ-04). */
  listMessages(userId: string, options?: IMailListOptions): Promise<IMailPage>;
  getMessage(userId: string, id: string, options?: IMailGetOptions): Promise<IMailMessage>;
  listFolders(userId: string): Promise<IMailFolder[]>;
  listMessagesInFolder(
    userId: string,
    folderId: string,
    options?: IMailListOptions,
  ): Promise<IMailPage>;
  listCategories(userId: string): Promise<IMailCategory[]>;
  setCategories(userId: string, messageId: string, categories: string[]): Promise<IMailMessage>;
  listByConversation(
    userId: string,
    conversationId: string,
    options?: IMailListOptions,
  ): Promise<IMailPage>;

  /* Writes (AZ-05). Every failure rejects with an `ApiError`; no method below
   * ever resolves a placeholder in place of a failure. */
  sendMessage(
    userId: string,
    input: IMailMessageInput,
    options?: IMailSendOptions,
  ): Promise<boolean>;
  replyToMessage(
    userId: string,
    messageId: string,
    input?: IMailReplyInput,
  ): Promise<boolean>;
  replyAll(
    userId: string,
    messageId: string,
    input?: IMailReplyInput,
  ): Promise<boolean>;
  forwardMessage(
    userId: string,
    messageId: string,
    input?: IMailReplyInput,
  ): Promise<boolean>;
  createDraft(userId: string, input: IMailMessageInput): Promise<IMailMessage>;
  updateDraft(
    userId: string,
    messageId: string,
    patch: IMailDraftPatch,
  ): Promise<IMailMessage>;
  sendDraft(userId: string, messageId: string): Promise<boolean>;
  deleteDraft(userId: string, messageId: string): Promise<boolean>;
  listAttachments(userId: string, messageId: string): Promise<IMailAttachmentInfo[]>;
  getAttachment(
    userId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<IMailAttachmentContent>;
}

/** Default page size, so a caller never accidentally asks for a whole mailbox. */
export const DEFAULT_MAIL_PAGE_SIZE = 25;

/** Default ordering when no `$search` is in play. */
export const DEFAULT_MAIL_ORDER_BY = 'receivedDateTime desc';

/** Conversation reads are chronological. */
export const DEFAULT_CONVERSATION_ORDER_BY = 'receivedDateTime asc';

/**
 * Message projection for list reads.
 *
 * Graph only returns properties named in `$select`, so every field the normaliser
 * maps and the schema exposes MUST appear here. `bccRecipients` in particular is
 * easy to forget and its absence is silent: the message still resolves, with
 * `bccRecipients: []`, which is indistinguishable from a message that genuinely
 * had no BCC. Sent Items is exactly where BCC is expected, so it is selected on
 * the list projection too - not only on the detail projection.
 *
 * `replyTo` is the same class of field (required on `IMailMessage`, exposed in the
 * schema), so it lives here as well rather than only on the detail projection: a
 * list read must not report an empty reply-to when the message has one.
 */
export const DEFAULT_MAIL_MESSAGE_SELECT = [
  'id',
  'conversationId',
  'subject',
  'bodyPreview',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'isRead',
  'isDraft',
  'hasAttachments',
  'importance',
  'categories',
  'parentFolderId',
  'webLink',
].join(',');

/**
 * Message projection for a single read - inherits the list projection (so every
 * recipient list, including `bccRecipients` and `replyTo`, is included) and adds
 * the full body.
 */
export const DEFAULT_MAIL_MESSAGE_DETAIL_SELECT = [
  DEFAULT_MAIL_MESSAGE_SELECT,
  'body',
].join(',');

/** Folder projection - includes the counters the ticket calls out. */
export const DEFAULT_MAIL_FOLDER_SELECT = [
  'id',
  'displayName',
  'parentFolderId',
  'childFolderCount',
  'unreadItemCount',
  'totalItemCount',
  'wellKnownName',
].join(',');

/** Category projection. */
export const DEFAULT_MAIL_CATEGORY_SELECT = 'id,displayName,color';

/** The only `$expand` value `getMessage` accepts on the mail resource. */
export const SUPPORTED_MAIL_EXPAND = ['attachments'] as const;

/** `listFolders` cache lifetime: ten minutes, as specified by the ticket. */
export const MAIL_FOLDERS_CACHE_TTL_SECONDS = 600;

/**
 * Graph's ceiling for an attachment that can travel inline on `sendMail` / `POST
 * .../attachments`: 3 MB.
 *
 * The boundary is treated as **closed at the top**: an attachment of exactly 3 MB
 * takes the resumable upload-session path. Graph documents 3 MB as the maximum
 * simple-upload size, so sending the boundary value inline is at best a coin
 * flip; a conservative boundary can only cost an extra round-trip, while the
 * optimistic one fails a legitimate send. 100 KB stays inline either way.
 */
export const MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

/** Graph requires every upload fragment to be a multiple of 320 KiB. */
export const MAIL_ATTACHMENT_UPLOAD_CHUNK_MULTIPLE = 320 * 1024;

/** One fragment: four 320 KiB units (1.25 MiB), comfortably under Graph's 4 MiB cap. */
export const MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE = 4 * MAIL_ATTACHMENT_UPLOAD_CHUNK_MULTIPLE;

/** `POST /me/sendMail` saves to Sent Items unless the caller says otherwise. */
export const MAIL_DEFAULT_SAVE_TO_SENT_ITEMS = true;

/** Attachment metadata projection - deliberately excludes `contentBytes`. */
export const MAIL_ATTACHMENT_SELECT = [
  'id',
  'name',
  'contentType',
  'size',
  'isInline',
  'lastModifiedDateTime',
].join(',');

/** Single-attachment projection, including the base64 payload. */
export const MAIL_ATTACHMENT_CONTENT_SELECT = [
  MAIL_ATTACHMENT_SELECT,
  'contentBytes',
].join(',');

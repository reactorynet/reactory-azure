/**
 * Microsoft Teams domain types (AZ-14).
 *
 * These mirror the **v1.0** Microsoft Graph resources reached by:
 *
 *   /me/chats                        -> {@link IAzureTeamsChat}
 *   /chats/{id}/messages             -> {@link IAzureTeamsChatMessage}
 *   /me/joinedTeams                  -> {@link IAzureTeamsTeam}
 *   /teams/{teamId}/channels         -> {@link IAzureTeamsChannel}
 *   /teams/{teamId}/channels/{channelId}/messages
 *                                    -> {@link IAzureTeamsChatMessage} (with `channelIdentity`)
 *   /communications/getPresencesByUserId
 *                                    -> {@link IAzureTeamsPresence}
 *
 * Every exported name is prefixed `IAzureTeams*` / `AzureTeams*` because
 * `types/index.ts` re-exports every domain file with `export *`.
 *
 * ### Identifiers are opaque - encode them, never parse them
 *
 * A Teams id is an opaque string. Chat, channel and message ids commonly look like
 * `19:abc=@thread.tacv2`: they contain `:`, `@`, `.` and `=` padding. `=` in a path
 * segment is padding, not decoration - left literal it can truncate the segment, so
 * `services/AzureTeamsService.ts` percent-encodes every id in full before it builds a
 * request path (see `encodeTeamsId`). No code here splits an id on `:` or `=`, and no
 * caller should.
 *
 * ### Presence is near-real-time
 *
 * {@link IAzureTeamsPresence} is a *snapshot*, not a resource. It changes while a page
 * is open, so `AzureTeamsService.getPresence` reads Graph on every call and never
 * consults (or writes) the Redis cache. Caching presence would report someone as
 * `Available` minutes after they went offline - worse than having no presence at all.
 */

/** How a Teams message body is rendered. The only two values Graph accepts. */
export type AzureTeamsMessageContentType = 'html' | 'text';

/** The only values Graph accepts for `chatMessage.body.contentType`, in schema order. */
export const AZURE_TEAMS_MESSAGE_CONTENT_TYPES: readonly AzureTeamsMessageContentType[] = ['html', 'text'];

/**
 * Graph's documented ceiling for `POST /communications/getPresencesByUserId`.
 *
 * The operation accepts up to 650 ids per request. Enforced before the request is
 * sent so an oversized batch fails with a typed error instead of an opaque 400 from
 * Graph - and, crucially, instead of a partial presence list.
 */
export const TEAMS_PRESENCE_MAX_IDS = 650;

/** A Graph `chatMessage.body`: `content` plus how it should be rendered. */
export interface IAzureTeamsMessageBody {
  content: string;
  contentType: AzureTeamsMessageContentType;
}

/**
 * The caller-facing message payload.
 *
 * `contentType` is optional and defaults to `text`; the service validates it against
 * {@link AZURE_TEAMS_MESSAGE_CONTENT_TYPES} before any request is sent, so an
 * unsupported value never reaches Graph (which would silently render the content as
 * plain text).
 */
export interface IAzureTeamsMessageInput {
  /** Message content. HTML when `contentType` is `html`, plain text otherwise. */
  content: string;
  /** `html` or `text`. Omitted means `text`. */
  contentType?: AzureTeamsMessageContentType | string;
}

/**
 * A Graph `identitySet` entry - who sent a message.
 *
 * Graph always populates exactly one of `user`, `application` or `device`; the
 * resource is modelled with all three optional so a message forwarded by a bot or a
 * connector is represented faithfully rather than with a guessed `user`.
 */
export interface IAzureTeamsIdentity {
  id?: string;
  displayName?: string;
  user?: {
    id?: string;
    displayName?: string;
    userIdentityType?: string;
  };
  application?: {
    id?: string;
    displayName?: string;
  };
  device?: {
    id?: string;
    displayName?: string;
  };
}

/** A file or card attachment on a message (`chatMessage.attachments[]`). */
export interface IAzureTeamsAttachment {
  id?: string;
  contentType?: string;
  contentUrl?: string;
  name?: string;
  thumbnailUrl?: string;
}

/** A mention on a message (`chatMessage.mentions[]`). */
export interface IAzureTeamsMention {
  id?: number;
  mentionText?: string;
  mentioned?: IAzureTeamsIdentity;
}

/** A reaction on a message (`chatMessage.reactions[]`). */
export interface IAzureTeamsReaction {
  reactionType?: string;
  createdDateTime?: string;
  user?: IAzureTeamsIdentity;
}

/** The team/channel a message belongs to (`chatMessage.channelIdentity`). */
export interface IAzureTeamsChannelIdentity {
  teamId?: string;
  channelId?: string;
}

/**
 * A Teams message - the same resource for a chat and a channel.
 *
 * A chat message carries `chatId`; a channel message carries `channelIdentity`. Both
 * are optional here because Graph returns one shape (`chatMessage`) for both routes.
 */
export interface IAzureTeamsChatMessage {
  id: string;
  replyToId?: string;
  etag?: string;
  messageType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  deletedDateTime?: string;
  subject?: string;
  summary?: string;
  importance?: string;
  locale?: string;
  webUrl?: string;
  from?: IAzureTeamsIdentity;
  body?: IAzureTeamsMessageBody;
  attachments?: IAzureTeamsAttachment[];
  mentions?: IAzureTeamsMention[];
  reactions?: IAzureTeamsReaction[];
  /** Present on `/chats/{id}/messages` results. */
  chatId?: string;
  /** Present on `/teams/{teamId}/channels/{channelId}/messages` results. */
  channelIdentity?: IAzureTeamsChannelIdentity;
}

/** A member of a chat (`chat.members[]`). */
export interface IAzureTeamsChatMember {
  id?: string;
  roles?: string[];
  displayName?: string;
  userId?: string;
  email?: string | null;
  tenantId?: string;
}

/** A compact preview of the newest message in a chat (`chat.lastMessagePreview`). */
export interface IAzureTeamsChatMessagePreview {
  id?: string;
  createdDateTime?: string;
  isDeleted?: boolean;
  messageType?: string;
  body?: IAzureTeamsMessageBody;
  from?: IAzureTeamsIdentity;
}

/** A chat (`/me/chats`, `/chats/{id}`). */
export interface IAzureTeamsChat {
  id: string;
  topic?: string | null;
  /** `oneOnOne`, `group` or `meeting`. */
  chatType?: string;
  createdDateTime?: string;
  lastUpdatedDateTime?: string;
  webUrl?: string;
  tenantId?: string;
  /** Populated only when the request expanded `members`. */
  members?: IAzureTeamsChatMember[];
  lastMessagePreview?: IAzureTeamsChatMessagePreview;
}

/** A team the signed-in user has joined (`/me/joinedTeams`). */
export interface IAzureTeamsTeam {
  id: string;
  displayName?: string;
  description?: string;
  isArchived?: boolean;
  /** `private`, `public` or `hiddenMembership`. */
  visibility?: string;
  webUrl?: string;
  tenantId?: string;
}

/** A channel in a team (`/teams/{teamId}/channels`). */
export interface IAzureTeamsChannel {
  id: string;
  displayName?: string;
  description?: string | null;
  /** `standard`, `private` or `shared`. */
  membershipType?: string;
  webUrl?: string;
  email?: string;
  createdDateTime?: string;
}

/** A user's presence snapshot (`/communications/getPresencesByUserId`). */
export interface IAzureTeamsPresence {
  /** The Microsoft Graph user id the presence belongs to. */
  id: string;
  /** `Available`, `Busy`, `Away`, `Offline`, ... */
  availability?: string;
  /** `Available`, `InACall`, `InAMeeting`, `Away`, `OffWork`, ... */
  activity?: string;
  outOfOfficeSettings?: {
    isOutOfOffice?: boolean;
    message?: string | null;
  };
  statusMessage?: {
    message?: {
      content?: string;
      contentType?: string;
    } | null;
    expiryDateTime?: string | null;
  };
  workLocation?: {
    displayName?: string;
  } | null;
}

/**
 * Projection options for a single-resource read (`getChat`).
 *
 * Deliberately narrower than {@link IAzureTeamsQueryOptions}: paging and filtering
 * mean nothing on `/chats/{id}`, and accepting them would silently ignore them.
 */
export interface IAzureTeamsGetOptions {
  /** `$select` projection. */
  select?: string[];
  /** `$expand` navigation properties (for example `members`). */
  expand?: string[];
}

/**
 * Paging / projection options shared by every list operation in the service.
 *
 * `maxPages` is the provider's hard page bound: reaching it throws
 * `PaginationLimitExceeded` instead of returning a silently truncated list.
 */
export interface IAzureTeamsQueryOptions {
  /** `$top` per page. */
  top?: number;
  /** `$skip`. */
  skip?: number;
  /** `$filter` expression, passed through unchanged. */
  filter?: string;
  /** `$select` projection. */
  select?: string[];
  /** `$expand` navigation properties (for example `members` on a chat). */
  expand?: string[];
  /** Page bound. Defaults to the provider's own bound (10). */
  maxPages?: number;
}

import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import type { AzureGraphClientProvider } from './graph/AzureGraphClientProvider';
import type {
  IAzureTeamsChannel,
  IAzureTeamsChat,
  IAzureTeamsChatMessage,
  IAzureTeamsGetOptions,
  IAzureTeamsMessageBody,
  IAzureTeamsMessageInput,
  IAzureTeamsPresence,
  IAzureTeamsQueryOptions,
  IAzureTeamsTeam,
} from '../types/teams.types';
import {
  AZURE_TEAMS_MESSAGE_CONTENT_TYPES,
  TEAMS_PRESENCE_MAX_IDS,
} from '../types/teams.types';
import type { AzureTeamsMessageContentType } from '../types/teams.types';
import { GraphErrorCode, apiError, toGraphApiError } from '../utils/graph-error';

/**
 * Graph REST version used by this service.
 *
 * Only the generally available version is ever requested. Teams presence and channel
 * messages are fully available on v1.0; no request below can select a preview version.
 */
const GRAPH_API_VERSION = 'v1.0';

/** The signed-in user's chats. */
const CHATS_PATH = '/me/chats';

/** Chats are addressed by id from the root, not from `/me/chats`. */
const CHAT_ROOT_PATH = '/chats';

/** Teams the signed-in user has joined. */
const JOINED_TEAMS_PATH = '/me/joinedTeams';

/** Teams are addressed from the root collection. */
const TEAMS_ROOT_PATH = '/teams';

/** Bulk presence lookup - a POST, not a GET. */
const PRESENCE_PATH = '/communications/getPresencesByUserId';

/**
 * Error codes this service raises itself, in addition to Graph's own codes.
 *
 * Graph's codes are preserved untouched by the provider (a 403 surfaces as
 * `error.code === 'Forbidden'`); these are only for failures detected before a
 * request is sent.
 */
export const TEAMS_ERROR_CODE = {
  /** A required id or body field is missing or empty. */
  MISSING_PARAMETER: 'MissingTeamsParameter',
  /** `contentType` is neither `html` nor `text`. */
  INVALID_CONTENT_TYPE: 'InvalidTeamsMessageContentType',
  /** A message body was empty or whitespace only. Graph would reject it. */
  EMPTY_MESSAGE: 'EmptyTeamsMessageContent',
  /** `userIds` is not a non-empty array of non-empty strings. */
  INVALID_PRESENCE_IDS: 'InvalidTeamsPresenceIds',
  /** More ids than Graph accepts in one presence call (650). */
  PRESENCE_BATCH_TOO_LARGE: 'TeamsPresenceBatchTooLarge',
  /** A paging/projection option (`top`, `skip`, `filter`, `select`, `expand`) is malformed. */
  INVALID_QUERY: 'InvalidTeamsQuery',
} as const;

/** Validate a required, non-empty string identifier. */
function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw apiError(
      TEAMS_ERROR_CODE.MISSING_PARAMETER,
      `Microsoft Teams requires a non-empty "${field}"`,
      { field },
    );
  }
  return value;
}

/**
 * Fully percent-encode one Teams identifier for use as a path segment.
 *
 * **This is deliberately not `utils/odata.encodePathSegment`.** That helper restores
 * `:` and `$` after encoding so drive and SharePoint paths stay readable. Teams ids
 * must be encoded in full:
 *
 *   - chat, channel and message ids are opaque `19:...@thread.tacv2` strings;
 *   - they can carry `=` padding (for example `19:abc=@thread.tacv2`). In a path
 *     segment `=` is padding and can truncate the segment, so it must become `%3D`;
 *   - `:` and `@` are equally unsafe: a bare `:` in a Graph path is a drive/SharePoint
 *     addressing marker, and `@` is not a legal path character.
 *
 * So: `encodeURIComponent`, nothing restored. Applied to every id this service puts in
 * a path - team, channel, chat and message - because all of them share the same shape.
 */
export function encodeTeamsId(value: unknown, field: string): string {
  return encodeURIComponent(requireId(value, field));
}

/** A validated, normalised set of list options. */
interface INormalisedTeamsQuery {
  top?: number;
  skip?: number;
  filter?: string;
  select?: string[];
  expand?: string[];
  maxPages?: number;
}

/** Validate one non-negative integer paging option. */
function normaliseInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;

  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw apiError(
      TEAMS_ERROR_CODE.INVALID_QUERY,
      `"${field}" must be a non-negative integer`,
      { field, value },
    );
  }

  return parsed;
}

/** Validate an array-of-strings projection option. */
function normaliseStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw apiError(
      TEAMS_ERROR_CODE.INVALID_QUERY,
      `"${field}" must be an array of non-empty strings`,
      { field },
    );
  }

  return value as string[];
}

/**
 * Validate and normalise the list options.
 *
 * Everything is checked before a request is built, so a malformed `top` or `select`
 * never reaches Graph as an opaque 400.
 */
function normaliseQuery(options: IAzureTeamsQueryOptions = {}): INormalisedTeamsQuery {
  if (!options || typeof options !== 'object') {
    throw apiError(TEAMS_ERROR_CODE.INVALID_QUERY, 'List options must be an object', {});
  }

  let filter: string | undefined;
  if (options.filter !== undefined && options.filter !== null) {
    if (typeof options.filter !== 'string' || options.filter.trim().length === 0) {
      throw apiError(
        TEAMS_ERROR_CODE.INVALID_QUERY,
        '"filter" must be a non-empty OData expression string',
        { field: 'filter' },
      );
    }
    filter = options.filter;
  }

  return {
    top: normaliseInteger(options.top, 'top'),
    skip: normaliseInteger(options.skip, 'skip'),
    filter,
    select: normaliseStringArray(options.select, 'select'),
    expand: normaliseStringArray(options.expand, 'expand'),
    maxPages: normaliseInteger(options.maxPages, 'maxPages'),
  };
}

/**
 * Build the Graph request body for a new message.
 *
 * Graph wraps the content descriptor in a `body` property - the payload is
 * `{ body: { contentType, content } }`, not `{ contentType, content }`. Sending the
 * flat form produces `400 BadRequest` because `body` is the required property.
 *
 * `contentType` defaults to `text` and is validated here: Graph would accept any
 * string and silently render unknown types as plain text, so an `markdown` typo would
 * publish literal tags instead of failing.
 */
export function buildTeamsMessageBody(
  input?: IAzureTeamsMessageInput,
): { body: IAzureTeamsMessageBody } {
  if (!input || typeof input !== 'object') {
    throw apiError(
      TEAMS_ERROR_CODE.MISSING_PARAMETER,
      'A Teams message requires an input object with "content"',
      {},
    );
  }

  const content = input.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw apiError(
      TEAMS_ERROR_CODE.EMPTY_MESSAGE,
      'A Teams message requires non-empty "content"; Graph rejects an empty body',
      { field: 'content' },
    );
  }

  const contentType = (input.contentType === undefined || input.contentType === null
    ? 'text'
    : input.contentType) as AzureTeamsMessageContentType;

  if (!(AZURE_TEAMS_MESSAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw apiError(
      TEAMS_ERROR_CODE.INVALID_CONTENT_TYPE,
      `Invalid Teams message contentType "${String(input.contentType)}"; expected one of `
        + AZURE_TEAMS_MESSAGE_CONTENT_TYPES.join(', '),
      { field: 'contentType', value: input.contentType, supported: [...AZURE_TEAMS_MESSAGE_CONTENT_TYPES] },
    );
  }

  return { body: { contentType, content } };
}

/**
 * Validate the ids for a presence lookup.
 *
 * Graph accepts at most {@link TEAMS_PRESENCE_MAX_IDS} ids per call; a larger batch is
 * refused here rather than split silently (a caller that asked for 700 presences must
 * not receive 650 and no warning).
 */
function normalisePresenceIds(userIds: unknown): string[] {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw apiError(
      TEAMS_ERROR_CODE.INVALID_PRESENCE_IDS,
      'getPresence requires a non-empty "userIds" array',
      {},
    );
  }

  if (userIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    throw apiError(
      TEAMS_ERROR_CODE.INVALID_PRESENCE_IDS,
      '"userIds" must contain only non-empty Microsoft Graph user id strings',
      {},
    );
  }

  if (userIds.length > TEAMS_PRESENCE_MAX_IDS) {
    throw apiError(
      TEAMS_ERROR_CODE.PRESENCE_BATCH_TOO_LARGE,
      `Graph accepts at most ${TEAMS_PRESENCE_MAX_IDS} user ids per presence request; received ${userIds.length}`,
      { count: userIds.length, limit: TEAMS_PRESENCE_MAX_IDS },
    );
  }

  return userIds as string[];
}

/**
 * AzureTeamsService - Microsoft Teams over Microsoft Graph **v1.0**.
 *
 * Teams has no counterpart in the Google module, so this is the first genuinely
 * Azure-native capability in the rebuild rather than parity work.
 *
 * ### Scope
 *
 * - **Chats** - `listChats`, `getChat`, `listChatMessages`, `sendChatMessage` over
 *   `/me/chats`, `/chats/{id}` and `/chats/{id}/messages`.
 * - **Teams and channels** - `listJoinedTeams`, `listChannels`, `listChannelMessages`,
 *   `sendChannelMessage` over `/me/joinedTeams`, `/teams/{teamId}/channels` and
 *   `/teams/{teamId}/channels/{channelId}/messages`.
 * - **Presence** - `getPresence` over `POST /communications/getPresencesByUserId`.
 *
 * ### Three rules this service will not bend
 *
 * 1. **Ids are encoded in full.** Chat, channel and message ids are opaque
 *    `19:...@thread.tacv2` strings that can carry `=` padding. Every id in a path goes
 *    through {@link encodeTeamsId} (`encodeURIComponent`, nothing restored), so
 *    `19:abc=@thread.tacv2` becomes `19%3Aabc%3D%40thread.tacv2` and cannot truncate
 *    the segment. See the class-level test `__tests__/teams-service.test.ts`.
 * 2. **Presence is never cached.** Presence is near-real-time. There is no Redis
 *    dependency on this service and no presence cache key in `utils/cache-keys.ts`:
 *    every `getPresence` call is a Graph call. A cached availability is a lie that
 *    outlives its truth.
 * 3. **A refusal is an error, never an empty list.** A 403 on a channel the user cannot
 *    read reaches the caller as an `ApiError` whose `code` is Graph's (`Forbidden`,
 *    `accessDenied`, ...). No method catches a failure and returns `[]`: an empty
 *    message list is indistinguishable from "no messages", which is exactly the
 *    ambiguity a permission error must not create.
 *
 * ### Transport
 *
 * Reads go through {@link AzureGraphClientProvider#requestAll}, which follows
 * `@odata.nextLink` to its page bound and **throws** rather than truncating. Writes
 * (the two send operations and the presence POST) use the provider's fluent client
 * and are wrapped so a failed POST is still an `ApiError` carrying the Graph `code`.
 */
@service({
  id: 'azure.AzureTeamsService@1.0.0',
  name: 'AzureTeamsService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Teams - chats, teams, channels, messages and presence over Graph v1.0',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
  ],
})
class AzureTeamsService implements Reactory.Service.IReactoryService {
  name: string = 'AzureTeamsService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphClientProvider?: AzureGraphClientProvider;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the service container from the `graphClientProvider` dependency alias. */
  setGraphClientProvider(provider: AzureGraphClientProvider): void {
    this._graphClientProvider = provider;
  }

  private get provider(): AzureGraphClientProvider {
    const resolved = this._graphClientProvider
      || (this.context?.getService?.('azure.AzureGraphClientProvider@1.0.0') as AzureGraphClientProvider | undefined);

    if (!resolved) {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'AzureGraphClientProvider is not available; the Microsoft Graph client cannot be built',
        { service: 'azure.AzureGraphClientProvider@1.0.0' },
      );
    }

    return resolved;
  }

  /* ------------------------------------------------------------------ paths */

  /** `/me/chats` */
  private get chatsPath(): string {
    return CHATS_PATH;
  }

  /** `/chats/{chatId}` */
  private chatPath(chatId: string): string {
    return `${CHAT_ROOT_PATH}/${encodeTeamsId(chatId, 'chatId')}`;
  }

  /** `/chats/{chatId}/messages` */
  private chatMessagesPath(chatId: string): string {
    return `${this.chatPath(chatId)}/messages`;
  }

  /** `/me/joinedTeams` */
  private get joinedTeamsPath(): string {
    return JOINED_TEAMS_PATH;
  }

  /** `/teams/{teamId}/channels` */
  private channelsPath(teamId: string): string {
    return `${TEAMS_ROOT_PATH}/${encodeTeamsId(teamId, 'teamId')}/channels`;
  }

  /** `/teams/{teamId}/channels/{channelId}/messages` */
  private channelMessagesPath(teamId: string, channelId: string): string {
    return `${this.channelsPath(teamId)}/${encodeTeamsId(channelId, 'channelId')}/messages`;
  }

  /* -------------------------------------------------------------- transport */

  /**
   * Issue a POST through the provider's Graph client.
   *
   * The provider exposes GET helpers only, so the fluent client is used directly; the
   * catch block reproduces the provider's error contract - a failed write is an
   * `ApiError` carrying the Graph `code` (including a 403's `Forbidden`), never a
   * resolved placeholder. Token provenance is forwarded so a 401 on a legacy token is
   * reported as `LegacyTokenExpired`.
   */
  private async post<T>(userId: string, path: string, body: unknown, operation: string): Promise<T> {
    const client: any = this.provider.getClient(userId, GRAPH_API_VERSION);

    try {
      const result: any = await client
        .api(path)
        .version(GRAPH_API_VERSION)
        .headers({ Accept: 'application/json' })
        .post(body ?? {});

      return result as T;
    } catch (error) {
      const tokenSource = typeof client?.__azureTokenSource === 'function'
        ? client.__azureTokenSource()
        : undefined;

      throw toGraphApiError(error, { operation, tokenSource });
    }
  }

  /** Read every page of a collection, failing loudly at the provider's page bound. */
  private async readAll<T>(
    userId: string,
    path: string,
    operation: string,
    options: IAzureTeamsQueryOptions = {},
  ): Promise<T[]> {
    const query = normaliseQuery(options);

    return this.provider.requestAll<T>(userId, path, {
      operation,
      top: query.top,
      skip: query.skip,
      filter: query.filter,
      select: query.select,
      expand: query.expand,
      maxPages: query.maxPages,
    });
  }

  /* ------------------------------------------------------------------ chats */

  /**
   * The signed-in user's chats: `GET /me/chats`.
   *
   * `expand: ['members']` adds chat participants; `expand: ['lastMessagePreview']` adds
   * the newest message preview. Both are caller-selected - a default projection would
   * silently drop fields a caller asked for.
   */
  async listChats(userId: string, options: IAzureTeamsQueryOptions = {}): Promise<IAzureTeamsChat[]> {
    return this.readAll<IAzureTeamsChat>(userId, this.chatsPath, 'listChats', options);
  }

  /**
   * One chat: `GET /chats/{chatId}`.
   *
   * Takes only `select`/`expand` - paging and filtering have no meaning on a single
   * resource, and accepting them would silently ignore them.
   */
  async getChat(userId: string, chatId: string, options: IAzureTeamsGetOptions = {}): Promise<IAzureTeamsChat> {
    const query = normaliseQuery(options);

    return this.provider.request<IAzureTeamsChat>(userId, this.chatPath(chatId), {
      operation: 'getChat',
      select: query.select,
      expand: query.expand,
    });
  }

  /** Messages in a chat: `GET /chats/{chatId}/messages` (newest first). */
  async listChatMessages(
    userId: string,
    chatId: string,
    options: IAzureTeamsQueryOptions = {},
  ): Promise<IAzureTeamsChatMessage[]> {
    return this.readAll<IAzureTeamsChatMessage>(
      userId,
      this.chatMessagesPath(chatId),
      'listChatMessages',
      options,
    );
  }

  /**
   * Send a chat message: `POST /chats/{chatId}/messages`.
   *
   * The Graph payload is `{ body: { contentType, content } }`; see
   * {@link buildTeamsMessageBody}, which validates `contentType` (`html` or `text`,
   * default `text`) and refuses an empty body before the request is sent.
   */
  async sendChatMessage(
    userId: string,
    chatId: string,
    input: IAzureTeamsMessageInput,
  ): Promise<IAzureTeamsChatMessage> {
    const payload = buildTeamsMessageBody(input);

    return this.post<IAzureTeamsChatMessage>(
      userId,
      this.chatMessagesPath(chatId),
      payload,
      'sendChatMessage',
    );
  }

  /* ---------------------------------------------------- teams and channels */

  /** Teams the signed-in user has joined: `GET /me/joinedTeams`. */
  async listJoinedTeams(userId: string, options: IAzureTeamsQueryOptions = {}): Promise<IAzureTeamsTeam[]> {
    return this.readAll<IAzureTeamsTeam>(userId, this.joinedTeamsPath, 'listJoinedTeams', options);
  }

  /** Channels in one team: `GET /teams/{teamId}/channels`. */
  async listChannels(
    userId: string,
    teamId: string,
    options: IAzureTeamsQueryOptions = {},
  ): Promise<IAzureTeamsChannel[]> {
    return this.readAll<IAzureTeamsChannel>(
      userId,
      this.channelsPath(teamId),
      'listChannels',
      options,
    );
  }

  /**
   * Messages in one channel: `GET /teams/{teamId}/channels/{channelId}/messages`.
   *
   * Both ids are fully percent-encoded (see {@link encodeTeamsId}). A 403 - the user is
   * a member of the team but cannot read this channel - propagates as an `ApiError`
   * carrying Graph's code; it is never converted into an empty list, because "you may
   * not read this" and "there are no messages" must stay distinguishable.
   */
  async listChannelMessages(
    userId: string,
    teamId: string,
    channelId: string,
    options: IAzureTeamsQueryOptions = {},
  ): Promise<IAzureTeamsChatMessage[]> {
    return this.readAll<IAzureTeamsChatMessage>(
      userId,
      this.channelMessagesPath(teamId, channelId),
      'listChannelMessages',
      options,
    );
  }

  /**
   * Send a channel message: `POST /teams/{teamId}/channels/{channelId}/messages`.
   *
   * Same payload contract and validation as {@link sendChatMessage}. A 403 (no write
   * access to the channel) surfaces as an `ApiError` with Graph's code.
   */
  async sendChannelMessage(
    userId: string,
    teamId: string,
    channelId: string,
    input: IAzureTeamsMessageInput,
  ): Promise<IAzureTeamsChatMessage> {
    const payload = buildTeamsMessageBody(input);

    return this.post<IAzureTeamsChatMessage>(
      userId,
      this.channelMessagesPath(teamId, channelId),
      payload,
      'sendChannelMessage',
    );
  }

  /* --------------------------------------------------------------- presence */

  /**
   * Presence for one or more users: `POST /communications/getPresencesByUserId`.
   *
   * `userId` is the authenticated caller (whose token makes the request); `userIds`
   * are the users whose presence is wanted. Graph returns one entry per id in
   * `{ value: [...] }`.
   *
   * **Never cached.** Presence is near-real-time: a user goes `Available` -> `Busy` ->
   * `Offline` while a screen is open. This method therefore consults no cache, writes
   * no cache and has no Redis dependency - a cached availability would outlive the
   * state it describes. The suite asserts this by pre-seeding a Redis double with a
   * stale payload and requiring the Graph value to be returned anyway.
   */
  async getPresence(userId: string, userIds: string[]): Promise<IAzureTeamsPresence[]> {
    const ids = normalisePresenceIds(userIds);

    const response = await this.post<{ value?: IAzureTeamsPresence[] }>(
      userId,
      PRESENCE_PATH,
      { ids },
      'getPresence',
    );

    if (!response || !Array.isArray(response.value)) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned no presence collection for getPresencesByUserId',
        { operation: 'getPresence' },
      );
    }

    return response.value;
  }
}

export const AzureTeamsServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureTeamsService> = {
  service: (props: any, context: any) => new AzureTeamsService(props, context),
  id: 'azure.AzureTeamsService@1.0.0',
  name: 'AzureTeamsService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Teams - chats, teams, channels, messages and presence over Graph v1.0',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
  ],
};

export { AzureTeamsService };

import fs from 'fs';
import path from 'path';
import ApiError from '@reactory/server-core/exceptions';

/**
 * AZ-14 (Microsoft Teams) suite.
 *
 * The Graph SDK is mocked, so every assertion is about the *request this module would
 * send* - never a live call. There is no Azure tenant in this repository, so a suite
 * that needed one could not run at all.
 *
 * Three sharp edges are covered explicitly, because each one fails silently in
 * production if it regresses:
 *
 *  1. **`=` in an id.** Chat, channel and message ids are opaque
 *     `19:...@thread.tacv2` strings that can carry `=` padding. Left literal in a path
 *     segment, `=` can truncate the segment - so the id is asserted to be percent-
 *     encoded *in full* and the path is asserted to still have the right segment count.
 *  2. **Presence is near-real-time.** A Redis double is seeded with a stale payload
 *     and every `getPresence` call is asserted to reach Graph anyway, with no cache
 *     read and no cache write.
 *  3. **A 403 is an error, not an empty list.** A channel the caller cannot read must
 *     surface as an `ApiError` carrying Graph's code - "no permission" and "no
 *     messages" must never look the same to a client.
 *
 * The suite also proves the GraphQL schema and the resolver agree, and that
 * `azure_send_teams_message` is registered as the single `TEAMS_MACROS` entry and
 * therefore appears in `AZURE_MACROS` without any barrel edit.
 */
jest.mock('@microsoft/microsoft-graph-client', () => {
  const chain: any = {};
  chain.api = jest.fn(() => chain);
  chain.version = jest.fn(() => chain);
  chain.query = jest.fn(() => chain);
  chain.headers = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.responseType = jest.fn(() => chain);
  chain.get = jest.fn();
  chain.post = jest.fn();
  chain.patch = jest.fn();
  chain.delete = jest.fn();

  const client: any = {
    api: jest.fn(() => chain),
    __azureTokenSource: () => 'vault',
  };

  return {
    Client: { init: jest.fn(() => client) },
    ResponseType: { RAW: 'raw' },
    __chain: chain,
    __client: client,
  };
});

// eslint-disable-next-line import/first
import { Client } from '@microsoft/microsoft-graph-client';
// eslint-disable-next-line import/first
import { AzureGraphClientProvider } from '../services/graph/AzureGraphClientProvider';
// eslint-disable-next-line import/first
import {
  AzureTeamsService,
  TEAMS_ERROR_CODE,
  buildTeamsMessageBody,
  encodeTeamsId,
} from '../services/AzureTeamsService';
// eslint-disable-next-line import/first
import { TEAMS_MACROS } from '../ai/macros/teams.macros';
// eslint-disable-next-line import/first
import { AZURE_MACROS } from '../ai';

const sdk: any = jest.requireMock('@microsoft/microsoft-graph-client');
const chain = sdk.__chain;
const client = sdk.__client;

const MODULE_ROOT = path.resolve(__dirname, '..');

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';

/** Chat, channel and message ids are opaque graph ids - none of them is a GUID. */
const CHAT_ID = '19:chat=abc@thread.v2';
const TEAM_ID = '02bd9fd6-8f93-4758-87c3-1fb73740a315';
const CHANNEL_ID = '19:abc=def@thread.tacv2';

/** The documented sharp edge: a channel message id with `=` padding. */
const MESSAGE_ID = '19:abc=@thread.tacv2';

const enc = (value: string) => encodeURIComponent(value);

const CHATS_PATH = '/me/chats';
const CHAT_PATH = `/chats/${enc(CHAT_ID)}`;
const CHAT_MESSAGES_PATH = `${CHAT_PATH}/messages`;
const JOINED_TEAMS_PATH = '/me/joinedTeams';
const CHANNELS_PATH = `/teams/${enc(TEAM_ID)}/channels`;
const CHANNEL_MESSAGES_PATH = `${CHANNELS_PATH}/${enc(CHANNEL_ID)}/messages`;
const PRESENCE_PATH = '/communications/getPresencesByUserId';

/**
 * Build the real provider around the mocked SDK and hand it to the service.
 *
 * `services` is exposed to `context.getService`, which is how a test injects a Redis
 * double (or any other collaborator) the service is *not* supposed to use.
 */
function createService(services: Record<string, any> = {}): AzureTeamsService {
  const authService = {
    getToken: jest.fn().mockResolvedValue({ token: 'vault-token', source: 'vault' }),
  };

  const provider = new AzureGraphClientProvider({} as any, {
    getService: jest.fn((id: string) => (id === 'azure.AzureAuthService@1.0.0' ? authService : services[id])),
    error: jest.fn(),
  } as any);
  provider.setAzureAuthService(authService);

  const service = new AzureTeamsService({} as any, {
    getService: jest.fn((id: string) => services[id]),
    error: jest.fn(),
  } as any);
  service.setGraphClientProvider(provider);

  return service;
}

/** The path of the most recent Graph request. */
function lastPath(): string {
  const calls = client.api.mock.calls;
  return String(calls[calls.length - 1][0]);
}

/** Every path requested during a test. */
function requestedPaths(): string[] {
  return client.api.mock.calls.map((call: any[]) => String(call[0]));
}

/** The version selected for the most recent request. */
function lastVersion(): string | undefined {
  const calls = chain.version.mock.calls;
  return calls.length ? String(calls[calls.length - 1][0]) : undefined;
}

/** The query string applied to the most recent request. */
function lastQuery(): string | undefined {
  const calls = chain.query.mock.calls;
  return calls.length ? String(calls[calls.length - 1][0]) : undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

describe('Graph client selection', () => {
  it('builds the client on the generally available version with debug logging off', async () => {
    chain.get.mockResolvedValue({ value: [] });

    await createService().listChats(USER_ID);

    const options = (Client.init as jest.Mock).mock.calls[0][0];
    expect(options.defaultVersion).toBe('v1.0');
    expect(options.debugLogging).toBe(false);
    expect(options.baseUrl).toBe('https://graph.microsoft.com');
  });

  it('fails with NotConnected when the provider is unavailable', async () => {
    const service = new AzureTeamsService({} as any, { getService: jest.fn(() => undefined), error: jest.fn() } as any);

    await expect(service.listChats(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
  });
});

/* -------------------------------------------------------------------------- */
/* Chats                                                                      */
/* -------------------------------------------------------------------------- */

describe('chat request shapes', () => {
  it('listChats: GET /me/chats', async () => {
    chain.get.mockResolvedValue({ value: [{ id: CHAT_ID, chatType: 'group' }] });

    const chats = await createService().listChats(USER_ID);

    expect(lastPath()).toBe(CHATS_PATH);
    expect(chats).toEqual([{ id: CHAT_ID, chatType: 'group' }]);
  });

  it('listChats: forwards $top, $select, $expand and $filter', async () => {
    chain.get.mockResolvedValue({ value: [] });

    await createService().listChats(USER_ID, {
      top: 20,
      expand: ['members'],
      select: ['id', 'topic', 'chatType'],
      filter: "startswith(topic,'Release')",
    });

    expect(lastPath()).toBe(CHATS_PATH);
    expect(lastQuery()).toContain('$top=20');
    expect(lastQuery()).toContain('$expand=members');
    expect(lastQuery()).toContain('$select=id%2Ctopic%2CchatType');
    expect(lastQuery()).toContain('$filter=startswith(topic');
  });

  it('listChats: follows @odata.nextLink instead of truncating the first page', async () => {
    chain.get
      .mockResolvedValueOnce({
        value: [{ id: 'chat-1' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/chats?page2',
      })
      .mockResolvedValueOnce({ value: [{ id: 'chat-2' }] });

    const chats = await createService().listChats(USER_ID);

    expect(chats).toEqual([{ id: 'chat-1' }, { id: 'chat-2' }]);
    expect(requestedPaths()[1]).toContain('page2');
  });

  it('getChat: GET /chats/{chatId}', async () => {
    chain.get.mockResolvedValue({ id: CHAT_ID, topic: 'Release planning' });

    await createService().getChat(USER_ID, CHAT_ID);

    expect(lastPath()).toBe(CHAT_PATH);
    // The id is opaque: `:` and `=` never appear literally in the path.
    expect(lastPath()).not.toContain(':');
    expect(lastPath()).not.toContain('=');
    expect(lastPath()).not.toContain('@');
  });

  it('listChatMessages: GET /chats/{chatId}/messages', async () => {
    chain.get.mockResolvedValue({ value: [{ id: MESSAGE_ID, chatId: CHAT_ID }] });

    const messages = await createService().listChatMessages(USER_ID, CHAT_ID);

    expect(lastPath()).toBe(CHAT_MESSAGES_PATH);
    expect(messages).toHaveLength(1);
  });

  it('sendChatMessage: POST /chats/{chatId}/messages with the nested Graph body', async () => {
    chain.post.mockResolvedValue({ id: MESSAGE_ID, chatId: CHAT_ID });

    await createService().sendChatMessage(USER_ID, CHAT_ID, {
      contentType: 'html',
      content: '<p>Deploy is green</p>',
    });

    expect(lastPath()).toBe(CHAT_MESSAGES_PATH);
    expect(lastVersion()).toBe('v1.0');
    // Graph requires `body` to be a content descriptor, not a flat {contentType, content}.
    expect(chain.post).toHaveBeenCalledWith({
      body: { contentType: 'html', content: '<p>Deploy is green</p>' },
    });
  });

  it('sendChatMessage: defaults contentType to text', async () => {
    chain.post.mockResolvedValue({ id: MESSAGE_ID });

    await createService().sendChatMessage(USER_ID, CHAT_ID, { content: 'plain' });

    expect(chain.post).toHaveBeenCalledWith({ body: { contentType: 'text', content: 'plain' } });
  });
});

/* -------------------------------------------------------------------------- */
/* Teams, channels and messages                                               */
/* -------------------------------------------------------------------------- */

describe('teams and channels request shapes', () => {
  it('listJoinedTeams: GET /me/joinedTeams', async () => {
    chain.get.mockResolvedValue({ value: [{ id: TEAM_ID, displayName: 'Platform' }] });

    const teams = await createService().listJoinedTeams(USER_ID);

    expect(lastPath()).toBe(JOINED_TEAMS_PATH);
    expect(teams).toEqual([{ id: TEAM_ID, displayName: 'Platform' }]);
  });

  it('listChannels: GET /teams/{teamId}/channels', async () => {
    chain.get.mockResolvedValue({ value: [{ id: CHANNEL_ID, displayName: 'General' }] });

    await createService().listChannels(USER_ID, TEAM_ID);

    expect(lastPath()).toBe(CHANNELS_PATH);
  });

  it('listChannelMessages: GET /teams/{teamId}/channels/{channelId}/messages', async () => {
    chain.get.mockResolvedValue({ value: [{ id: MESSAGE_ID, channelIdentity: { teamId: TEAM_ID, channelId: CHANNEL_ID } }] });

    const messages = await createService().listChannelMessages(USER_ID, TEAM_ID, CHANNEL_ID);

    expect(lastPath()).toBe(CHANNEL_MESSAGES_PATH);
    expect(messages).toHaveLength(1);
  });

  it('sendChannelMessage: POST /teams/{teamId}/channels/{channelId}/messages', async () => {
    chain.post.mockResolvedValue({ id: MESSAGE_ID });

    await createService().sendChannelMessage(USER_ID, TEAM_ID, CHANNEL_ID, {
      content: 'Build finished',
    });

    expect(lastPath()).toBe(CHANNEL_MESSAGES_PATH);
    expect(lastVersion()).toBe('v1.0');
    expect(chain.post).toHaveBeenCalledWith({
      body: { contentType: 'text', content: 'Build finished' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Sharp edge 1: '=' padding in ids                                           */
/* -------------------------------------------------------------------------- */

describe('id encoding (a "=" in a channel message id)', () => {
  it('encodeTeamsId percent-encodes ":" "@" and "=" in full', () => {
    expect(encodeTeamsId(MESSAGE_ID, 'messageId')).toBe('19%3Aabc%3D%40thread.tacv2');
    expect(encodeTeamsId(MESSAGE_ID, 'messageId')).toBe(enc(MESSAGE_ID));
    expect(encodeTeamsId(CHANNEL_ID, 'channelId')).toBe('19%3Aabc%3Ddef%40thread.tacv2');
  });

  it('listChannelMessages percent-encodes an id containing "=" and keeps every segment', async () => {
    chain.get.mockResolvedValue({ value: [] });

    await createService().listChannelMessages(USER_ID, TEAM_ID, CHANNEL_ID);

    const requested = lastPath();

    expect(requested).toBe(CHANNEL_MESSAGES_PATH);
    expect(requested).toContain('%3D');
    expect(requested).toContain('%40');

    // Nothing that could truncate or redirect the segment survives raw.
    expect(requested).not.toContain('=');
    expect(requested).not.toContain(':');
    expect(requested).not.toContain('@');

    // /teams/{team}/channels/{channel}/messages -> exactly six parts. A raw "="
    // would cut the last segment short and change this count.
    expect(requested.split('/')).toEqual([
      '',
      'teams',
      enc(TEAM_ID),
      'channels',
      enc(CHANNEL_ID),
      'messages',
    ]);
    expect(requested.endsWith('/messages')).toBe(true);
  });

  it('sendChannelMessage keeps the padded channel id intact in the POST path', async () => {
    chain.post.mockResolvedValue({ id: MESSAGE_ID });

    await createService().sendChannelMessage(USER_ID, TEAM_ID, CHANNEL_ID, { content: 'hi' });

    expect(lastPath()).toBe(CHANNEL_MESSAGES_PATH);
    expect(lastPath().split('/')).toHaveLength(6);
    expect(lastPath()).not.toContain('=');
  });

  it('encodes a chat id containing "=" as well', async () => {
    chain.get.mockResolvedValue({ id: CHAT_ID });

    await createService().getChat(USER_ID, CHAT_ID);

    expect(lastPath()).toBe('/chats/19%3Achat%3Dabc%40thread.v2');
  });
});

/* -------------------------------------------------------------------------- */
/* Sharp edge 2: presence is never cached                                     */
/* -------------------------------------------------------------------------- */

describe('presence', () => {
  const STALE_PRESENCE = [{ id: 'user-1', availability: 'Available', activity: 'Available' }];

  it('getPresence: POST /communications/getPresencesByUserId with { ids }', async () => {
    chain.post.mockResolvedValue({
      value: [
        { id: 'user-1', availability: 'Busy', activity: 'InACall' },
        { id: 'user-2', availability: 'Offline', activity: 'Offline' },
      ],
    });

    const presence = await createService().getPresence(USER_ID, ['user-1', 'user-2']);

    expect(lastPath()).toBe(PRESENCE_PATH);
    expect(lastVersion()).toBe('v1.0');
    expect(chain.post).toHaveBeenCalledWith({ ids: ['user-1', 'user-2'] });
    expect(presence).toEqual([
      { id: 'user-1', availability: 'Busy', activity: 'InACall' },
      { id: 'user-2', availability: 'Offline', activity: 'Offline' },
    ]);
  });

  it('is never served from Redis: a seeded cache is ignored and Graph is asked every time', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(JSON.stringify(STALE_PRESENCE)),
      set: jest.fn().mockResolvedValue('OK'),
    };

    chain.post
      .mockResolvedValueOnce({ value: [{ id: 'user-1', availability: 'Busy', activity: 'InACall' }] })
      .mockResolvedValueOnce({ value: [{ id: 'user-1', availability: 'Offline', activity: 'Offline' }] });

    const service = createService({ 'core.RedisService@1.0.0': redis });

    const first = await service.getPresence(USER_ID, ['user-1']);
    const second = await service.getPresence(USER_ID, ['user-1']);

    // Both calls are Graph calls, and each reflects the state at that moment.
    expect(chain.post).toHaveBeenCalledTimes(2);
    expect(first[0].availability).toBe('Busy');
    expect(second[0].availability).toBe('Offline');

    // The stale value was never read, and nothing was written for a later caller.
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects an empty or malformed userIds list before any request is sent', async () => {
    const service = createService();

    await expect(service.getPresence(USER_ID, [])).rejects.toMatchObject({
      code: TEAMS_ERROR_CODE.INVALID_PRESENCE_IDS,
    });
    await expect(service.getPresence(USER_ID, undefined as any)).rejects.toMatchObject({
      code: TEAMS_ERROR_CODE.INVALID_PRESENCE_IDS,
    });
    await expect(service.getPresence(USER_ID, ['user-1', '   '])).rejects.toMatchObject({
      code: TEAMS_ERROR_CODE.INVALID_PRESENCE_IDS,
    });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('refuses more ids than Graph accepts in one call instead of splitting silently', async () => {
    const ids = Array.from({ length: 651 }, (_, index) => `user-${index}`);

    await expect(createService().getPresence(USER_ID, ids)).rejects.toMatchObject({
      code: TEAMS_ERROR_CODE.PRESENCE_BATCH_TOO_LARGE,
      limit: 650,
    });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('has no presence cache domain in the cache-key contract', () => {
    // A structural guard: presence must have nowhere to be cached FROM. If a later
    // ticket adds a `TEAMS_PRESENCE` domain to utils/cache-keys.ts, this fails and
    // forces the conversation instead of quietly reintroducing a stale availability.
    const cacheKeys = fs.readFileSync(path.join(MODULE_ROOT, 'utils', 'cache-keys.ts'), 'utf8');

    expect(cacheKeys.toLowerCase()).not.toContain('presence');
  });

  it('fails loudly when Graph returns no presence collection', async () => {
    chain.post.mockResolvedValue({});

    await expect(createService().getPresence(USER_ID, ['user-1'])).rejects.toMatchObject({
      code: 'GraphRequestFailed',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Sharp edge 3: a 403 is an ApiError, never an empty list                    */
/* -------------------------------------------------------------------------- */

describe('error contract', () => {
  it('a 403 on a channel read surfaces as an ApiError with the Graph code and no list', async () => {
    chain.get.mockRejectedValue(
      Object.assign(new Error('Forbidden'), {
        statusCode: 403,
        code: 'Forbidden',
      }),
    );

    let resolved: unknown;
    let caught: any;

    try {
      resolved = await createService().listChannelMessages(USER_ID, TEAM_ID, CHANNEL_ID);
    } catch (error) {
      caught = error;
    }

    expect(resolved).toBeUndefined();
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('Forbidden');
    expect(caught.status).toBe(403);
    // The failure must not be mistakable for "this channel has no messages".
    expect(Array.isArray(resolved)).toBe(false);
  });

  it('a 403 with a Graph error body keeps accessDenied as the code', async () => {
    chain.get.mockRejectedValue({
      statusCode: 403,
      body: JSON.stringify({
        error: { code: 'accessDenied', message: 'The user is not a member of this channel' },
      }),
    });

    let caught: any;
    try {
      await createService().listChannelMessages(USER_ID, TEAM_ID, CHANNEL_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('accessDenied');
    expect(caught.status).toBe(403);
  });

  it('a 403 on a chat read is likewise an error, not an empty page', async () => {
    chain.get.mockRejectedValue({ statusCode: 403, code: 'Forbidden' });

    await expect(createService().listChatMessages(USER_ID, CHAT_ID)).rejects.toMatchObject({
      code: 'Forbidden',
      status: 403,
    });
  });

  it('a failed send is an ApiError carrying the Graph code', async () => {
    chain.post.mockRejectedValue({ statusCode: 400, code: 'BadRequest', message: 'Invalid body' });

    await expect(
      createService().sendChannelMessage(USER_ID, TEAM_ID, CHANNEL_ID, { content: 'hi' }),
    ).rejects.toMatchObject({ code: 'BadRequest', status: 400 });
  });

  it('never requests a preview API version or a non-Teams path', async () => {
    chain.get.mockResolvedValue({ value: [] });
    chain.post.mockResolvedValue({ value: [], id: MESSAGE_ID });

    const service = createService();

    await service.listChats(USER_ID);
    await service.getChat(USER_ID, CHAT_ID);
    await service.listChatMessages(USER_ID, CHAT_ID);
    await service.listJoinedTeams(USER_ID);
    await service.listChannels(USER_ID, TEAM_ID);
    await service.listChannelMessages(USER_ID, TEAM_ID, CHANNEL_ID);
    await service.sendChatMessage(USER_ID, CHAT_ID, { content: 'hi' });
    await service.sendChannelMessage(USER_ID, TEAM_ID, CHANNEL_ID, { content: 'hi' });
    await service.getPresence(USER_ID, ['user-1']);

    for (const requested of requestedPaths()) {
      expect(requested.toLowerCase()).not.toContain('beta');
    }
    for (const call of chain.version.mock.calls) {
      expect(String(call[0])).toBe('v1.0');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Message payload validation                                                 */
/* -------------------------------------------------------------------------- */

describe('message payload contract', () => {
  it('buildTeamsMessageBody wraps content in the Graph body descriptor', () => {
    expect(buildTeamsMessageBody({ content: '<b>hi</b>', contentType: 'html' })).toEqual({
      body: { contentType: 'html', content: '<b>hi</b>' },
    });
    expect(buildTeamsMessageBody({ content: 'hi' })).toEqual({
      body: { contentType: 'text', content: 'hi' },
    });
  });

  it('rejects an unsupported contentType before a request is sent', async () => {
    const service = createService();

    await expect(
      service.sendChatMessage(USER_ID, CHAT_ID, { content: 'hi', contentType: 'markdown' }),
    ).rejects.toMatchObject({ code: TEAMS_ERROR_CODE.INVALID_CONTENT_TYPE });

    await expect(
      service.sendChannelMessage(USER_ID, TEAM_ID, CHANNEL_ID, { content: 'hi', contentType: 'HTML' }),
    ).rejects.toMatchObject({ code: TEAMS_ERROR_CODE.INVALID_CONTENT_TYPE });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('rejects an empty body and a missing id before a request is sent', async () => {
    const service = createService();

    await expect(
      service.sendChatMessage(USER_ID, CHAT_ID, { content: '   ' }),
    ).rejects.toMatchObject({ code: TEAMS_ERROR_CODE.EMPTY_MESSAGE });

    await expect(
      service.sendChatMessage(USER_ID, '', { content: 'hi' }),
    ).rejects.toMatchObject({ code: TEAMS_ERROR_CODE.MISSING_PARAMETER });

    await expect(
      service.listChannelMessages(USER_ID, TEAM_ID, '  '),
    ).rejects.toMatchObject({ code: TEAMS_ERROR_CODE.MISSING_PARAMETER });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('rejects a missing input object and non-object list options', async () => {
    const service = createService();

    await expect(service.sendChatMessage(USER_ID, CHAT_ID, null as any)).rejects.toMatchObject({
      code: TEAMS_ERROR_CODE.MISSING_PARAMETER,
    });
    await expect(service.listChats(USER_ID, null as any)).rejects.toMatchObject({
      code: TEAMS_ERROR_CODE.INVALID_QUERY,
    });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('rejects malformed paging options before a request is sent', async () => {
    const service = createService();

    await expect(service.listChats(USER_ID, { top: -1 })).rejects.toMatchObject({
      code: TEAMS_ERROR_CODE.INVALID_QUERY,
    });
    await expect(service.listChats(USER_ID, { select: [1 as any] })).rejects.toMatchObject({
      code: TEAMS_ERROR_CODE.INVALID_QUERY,
    });
    await expect(service.listChats(USER_ID, { filter: '  ' })).rejects.toMatchObject({
      code: TEAMS_ERROR_CODE.INVALID_QUERY,
    });

    expect(client.api).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* GraphQL surface                                                            */
/* -------------------------------------------------------------------------- */

describe('GraphQL surface', () => {
  const schema = fs.readFileSync(path.join(MODULE_ROOT, 'graphql', 'types', 'Teams.graphql'), 'utf8');
  const resolverSource = fs.readFileSync(
    path.join(MODULE_ROOT, 'graphql', 'resolvers', 'TeamsResolver.ts'),
    'utf8',
  );

  const QUERY_FIELDS = [
    'azureChats',
    'azureChatMessages',
    'azureTeams',
    'azureChannels',
    'azureChannelMessages',
    'azurePresence',
  ];
  const MUTATION_FIELDS = ['azureSendChatMessage', 'azureSendChannelMessage'];

  it('declares the six required queries and two required mutations', () => {
    for (const field of QUERY_FIELDS) {
      expect(schema).toMatch(new RegExp(`^\\s*${field}\\(`, 'm'));
    }
    for (const field of MUTATION_FIELDS) {
      expect(schema).toMatch(new RegExp(`^\\s*${field}\\(`, 'm'));
    }
  });

  it('resolves every declared field, and no placeholder field remains', () => {
    for (const field of QUERY_FIELDS) {
      expect(resolverSource).toContain(`@query('${field}')`);
    }
    for (const field of MUTATION_FIELDS) {
      expect(resolverSource).toContain(`@mutation('${field}')`);
    }

    expect(schema).not.toContain('_azureTeamsPlaceholder');
    expect(resolverSource).not.toContain('_azureTeamsPlaceholder');
    expect(resolverSource).not.toContain("'not implemented'");
  });

  it('exposes presence as a list of user ids and messages as an input object', () => {
    expect(schema).toContain('azurePresence(userIds: [String!]!): [AzureTeamsPresence!]!');
    expect(schema).toContain('input AzureTeamsMessageInput');
    expect(schema).toMatch(/enum AzureTeamsMessageContentType \{\s*html\s*text\s*\}/);
  });
});

/* -------------------------------------------------------------------------- */
/* AI macro                                                                   */
/* -------------------------------------------------------------------------- */

describe('azure_send_teams_message macro', () => {
  /** A state whose context resolves the Teams service to `service`. */
  function macroState(service: any) {
    return {
      context: {
        user: { _id: USER_ID },
        getService: jest.fn((id: string) => (id === 'azure.AzureTeamsService@1.0.0' ? service : undefined)),
      },
    } as any;
  }

  function fakeService() {
    return {
      sendChatMessage: jest.fn().mockResolvedValue({ id: MESSAGE_ID, chatId: CHAT_ID }),
      sendChannelMessage: jest.fn().mockResolvedValue({
        id: MESSAGE_ID,
        channelIdentity: { teamId: TEAM_ID, channelId: CHANNEL_ID },
      }),
    };
  }

  it('TEAMS_MACROS contains exactly one entry, named azure_send_teams_message', () => {
    expect(TEAMS_MACROS).toHaveLength(1);
    expect(TEAMS_MACROS[0].name).toBe('azure_send_teams_message');
    expect(TEAMS_MACROS[0].nameSpace).toBe('azure');
    expect(TEAMS_MACROS[0].version).toBe('1.0.0');
    expect(typeof TEAMS_MACROS[0].component).toBe('function');
    expect(TEAMS_MACROS[0].tools).toHaveLength(1);
    expect(TEAMS_MACROS[0].tools![0].function.name).toBe('azure_send_teams_message');
  });

  it('appears in AZURE_MACROS without editing the barrel (subset assertion)', () => {
    expect(AZURE_MACROS).toEqual(expect.arrayContaining([TEAMS_MACROS[0]]));
    expect(AZURE_MACROS.filter((macro: any) => macro.name === 'azure_send_teams_message')).toHaveLength(1);
  });

  it('sends a chat message when chatId is supplied', async () => {
    const service = fakeService();

    const result: any = await TEAMS_MACROS[0].component(
      { chatId: CHAT_ID, content: '<p>Hi</p>', contentType: 'html' },
      macroState(service),
    );

    expect(service.sendChatMessage).toHaveBeenCalledWith(USER_ID, CHAT_ID, {
      content: '<p>Hi</p>',
      contentType: 'html',
    });
    expect(service.sendChannelMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, tool: 'azure_send_teams_message' });
  });

  it('sends a channel message when teamId and channelId are supplied', async () => {
    const service = fakeService();

    const result: any = await TEAMS_MACROS[0].component(
      { teamId: TEAM_ID, channelId: CHANNEL_ID, content: 'Deployed' },
      macroState(service),
    );

    expect(service.sendChannelMessage).toHaveBeenCalledWith(USER_ID, TEAM_ID, CHANNEL_ID, {
      content: 'Deployed',
      contentType: undefined,
    });
    expect(service.sendChatMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, tool: 'azure_send_teams_message' });
  });

  it('refuses an ambiguous or missing destination without calling the service', async () => {
    const service = fakeService();

    const both: any = await TEAMS_MACROS[0].component(
      { chatId: CHAT_ID, teamId: TEAM_ID, channelId: CHANNEL_ID, content: 'hi' },
      macroState(service),
    );
    const neither: any = await TEAMS_MACROS[0].component(
      { content: 'hi' },
      macroState(service),
    );
    const halfChannel: any = await TEAMS_MACROS[0].component(
      { teamId: TEAM_ID, content: 'hi' },
      macroState(service),
    );

    expect(both.success).toBe(false);
    expect(neither.success).toBe(false);
    expect(halfChannel.success).toBe(false);
    expect(service.sendChatMessage).not.toHaveBeenCalled();
    expect(service.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('surfaces a service refusal as a structured failure, not a throw', async () => {
    const service = fakeService();
    service.sendChatMessage.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { code: 'Forbidden', status: 403 }),
    );

    const result: any = await TEAMS_MACROS[0].component(
      { chatId: CHAT_ID, content: 'hi' },
      macroState(service),
    );

    expect(result).toMatchObject({ success: false, tool: 'azure_send_teams_message', error: 'Forbidden' });
  });

  it('refuses to send without an authenticated user', async () => {
    const service = fakeService();

    const result: any = await TEAMS_MACROS[0].component(
      { chatId: CHAT_ID, content: 'hi' },
      { context: { user: {}, getService: jest.fn(() => service) } } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No authenticated user');
    expect(service.sendChatMessage).not.toHaveBeenCalled();
  });

  it('fails cleanly when the Teams service is not registered', async () => {
    const result: any = await TEAMS_MACROS[0].component(
      { chatId: CHAT_ID, content: 'hi' },
      macroState(undefined),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Azure Teams Service not available');
  });
});

import fs from 'fs';
import path from 'path';
import { buildSchema } from 'graphql';
import ApiError, { InsufficientPermissions } from '@reactory/server-core/exceptions';

import graphResolvers from '../graphql/resolvers';
import MailResolver from '../graphql/resolvers/MailResolver';
import { AzureMailService } from '../services/AzureMailService';
import { apiError } from '../utils/graph-error';
import {
  DEFAULT_MAIL_FOLDER_SELECT,
  DEFAULT_MAIL_MESSAGE_SELECT,
  MAIL_FOLDERS_CACHE_TTL_SECONDS,
} from '../types/mail.types';

/**
 * Behavioural suite for AzureMailService.
 *
 * The Graph provider is faked here on purpose: this suite is about the service's
 * own contract - normalisation, caching, path construction and the error
 * contract. The exact OData/HTTP shape the provider emits is asserted separately
 * in `mail.request-shape.test.ts`, against the real provider and a mocked SDK.
 */

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';

function graphMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'AAMkAGI2',
    conversationId: 'conv-1',
    subject: 'Quarterly report',
    bodyPreview: 'Please review',
    body: { contentType: 'html', content: '<p>Please review</p>' },
    from: { emailAddress: { name: 'Alice', address: 'alice@example.test' } },
    sender: { emailAddress: { name: 'Alice', address: 'alice@example.test' } },
    toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@example.test' } }],
    ccRecipients: [],
    bccRecipients: [{ emailAddress: { name: 'Audit', address: 'audit@example.test' } }],
    receivedDateTime: '2026-11-01T09:00:00Z',
    sentDateTime: '2026-11-01T08:59:00Z',
    isRead: false,
    isDraft: false,
    hasAttachments: true,
    importance: 'normal',
    categories: ['Finance', 'Q4'],
    parentFolderId: 'inbox',
    webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGI2',
    ...overrides,
  };
}

interface IFakes {
  service: AzureMailService;
  provider: any;
  redis: any;
}

function createFakes(redisValue?: any): IFakes {
  const provider: any = {
    request: jest.fn(),
    requestAll: jest.fn(),
    getClient: jest.fn(),
  };

  const redis: any = {
    get: jest.fn().mockResolvedValue(redisValue ?? null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const context: any = {
    getService: jest.fn(() => undefined),
  };

  const service = new AzureMailService({} as any, context);
  service.setGraphClientProvider(provider);
  service.setRedisService(redis);

  return { service, provider, redis };
}

/** A Graph-shaped rejection as the provider would produce it. */
function invalidRequest(): ApiError {
  return apiError('ErrorInvalidRequest', 'Invalid filter clause', { status: 400 });
}

describe('AzureMailService — message normalisation', () => {
  it('returns { items, nextLink, count } and flattens every recipient shape', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValue({
      value: [graphMessage()],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page-2',
      '@odata.count': 42,
    });

    const page = await service.listMessages(USER_ID, { top: 10 });

    expect(page.items).toHaveLength(1);
    expect(page.nextLink).toBe('https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page-2');
    expect(page.count).toBe(42);

    const [message] = page.items;
    expect(message.id).toBe('AAMkAGI2');
    // `emailAddress` is gone: the domain shape is flat.
    expect(message.from).toEqual({ name: 'Alice', address: 'alice@example.test' });
    expect(message.toRecipients).toEqual([{ name: 'Bob', address: 'bob@example.test' }]);
    expect(message.ccRecipients).toEqual([]);
    // bccRecipients is required on the type and exposed in the schema, so it must
    // round-trip: the projection has to select it and the normaliser has to map it.
    expect(message.bccRecipients).toEqual([{ name: 'Audit', address: 'audit@example.test' }]);
    expect(message.body).toEqual({ contentType: 'html', content: '<p>Please review</p>' });
    expect(message.categories).toEqual(['Finance', 'Q4']);
  });

  it('keeps BCC recipients on a Sent Items read instead of silently emptying them', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValue({
      value: [graphMessage({
        parentFolderId: 'sentitems',
        ccRecipients: [],
        bccRecipients: [
          { emailAddress: { name: 'Audit', address: 'audit@example.test' } },
          { emailAddress: { address: 'archive@example.test' } },
        ],
      })],
    });

    const page = await service.listMessagesInFolder(USER_ID, 'sentitems');

    expect(page.items[0].bccRecipients).toEqual([
      { name: 'Audit', address: 'audit@example.test' },
      { address: 'archive@example.test' },
    ]);
  });

  it('always returns a body object, even when Graph sent none', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ value: [{ id: 'm1' }] });

    const page = await service.listMessages(USER_ID);

    expect(page.items[0].body).toEqual({ contentType: 'text', content: '' });
    expect(page.items[0].categories).toEqual([]);
    expect(page.items[0].toRecipients).toEqual([]);
    expect(page.nextLink).toBeUndefined();
  });

  it('does not invent a nextLink or a count that Graph did not send', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ value: [] });

    const page = await service.listMessages(USER_ID);

    expect(page).toEqual({ items: [] });
    expect('nextLink' in page).toBe(false);
    expect('count' in page).toBe(false);
  });
});

describe('AzureMailService — getMessage', () => {
  it('reads one message and normalises it, including attachments', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValue(graphMessage({
      body: { contentType: 'text', content: 'Please review' },
      attachments: [{
        id: 'att-1',
        name: 'report.pdf',
        contentType: 'application/pdf',
        size: 1234,
        isInline: false,
      }],
    }));

    const message = await service.getMessage(USER_ID, 'AAMkAGI2', { expand: 'attachments' });

    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      '/me/messages/AAMkAGI2',
      expect.objectContaining({ expand: 'attachments' }),
    );
    expect(message.body).toEqual({ contentType: 'text', content: 'Please review' });
    expect(message.bccRecipients).toEqual([{ name: 'Audit', address: 'audit@example.test' }]);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ id: 'att-1', name: 'report.pdf', size: 1234 });
  });

  it('rejects an empty message id without calling Graph', async () => {
    const { service, provider } = createFakes();

    await expect(service.getMessage(USER_ID, '   ')).rejects.toBeInstanceOf(ApiError);
    expect(provider.request).not.toHaveBeenCalled();
  });
});

describe('AzureMailService — folders', () => {
  it('reads /me/mailFolders with the counters and caches the result for ten minutes', async () => {
    const { service, provider, redis } = createFakes();

    provider.requestAll.mockResolvedValue([
      {
        id: 'inbox',
        displayName: 'Inbox',
        childFolderCount: 2,
        unreadItemCount: 5,
        totalItemCount: 40,
      },
      { id: 'sentitems', displayName: 'Sent Items', childFolderCount: 0, unreadItemCount: 0 },
    ]);

    const folders = await service.listFolders(USER_ID);

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      '/me/mailFolders',
      expect.objectContaining({ select: DEFAULT_MAIL_FOLDER_SELECT }),
    );
    expect(DEFAULT_MAIL_FOLDER_SELECT).toContain('childFolderCount');
    expect(DEFAULT_MAIL_FOLDER_SELECT).toContain('unreadItemCount');

    expect(folders[0]).toMatchObject({ id: 'inbox', childFolderCount: 2, unreadItemCount: 5 });
    expect(folders[1]).toMatchObject({ id: 'sentitems', childFolderCount: 0, unreadItemCount: 0 });

    expect(redis.set).toHaveBeenCalledWith(
      `azure:${USER_ID}:mail:folders`,
      expect.any(String),
      MAIL_FOLDERS_CACHE_TTL_SECONDS,
    );
    expect(MAIL_FOLDERS_CACHE_TTL_SECONDS).toBe(600);
  });

  it('serves a second read from Redis without calling Graph again', async () => {
    const cached = {
      items: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 1, unreadItemCount: 3 }],
      cachedAt: '2026-11-08T10:00:00Z',
    };

    const { service, provider } = createFakes(JSON.stringify(cached));

    const folders = await service.listFolders(USER_ID);

    expect(folders).toEqual(cached.items);
    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('treats a malformed cache entry as a miss', async () => {
    const { service, provider } = createFakes('{not-json');
    provider.requestAll.mockResolvedValue([{ id: 'inbox' }]);

    const folders = await service.listFolders(USER_ID);

    expect(provider.requestAll).toHaveBeenCalledTimes(1);
    expect(folders[0].id).toBe('inbox');
  });

  it('does not fail the read when Redis is unavailable', async () => {
    const { service, provider, redis } = createFakes();
    redis.get.mockRejectedValue(new Error('redis down'));
    redis.set.mockRejectedValue(new Error('redis down'));
    provider.requestAll.mockResolvedValue([{ id: 'inbox', unreadItemCount: 2 }]);

    await expect(service.listFolders(USER_ID)).resolves.toEqual([
      { id: 'inbox', childFolderCount: 0, unreadItemCount: 2 },
    ]);
  });
});

describe('AzureMailService — folder and conversation listings', () => {
  it('lists messages in a folder using the folder path', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ value: [graphMessage()] });

    const page = await service.listMessagesInFolder(USER_ID, 'AAMkAD==', { top: 5 });

    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      '/me/mailFolders/AAMkAD%3D%3D/messages',
      expect.objectContaining({ top: 5 }),
    );
    expect(page.items).toHaveLength(1);
  });

  it('lists a conversation as a filtered message query, oldest first', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ value: [graphMessage()] });

    await service.listByConversation(USER_ID, "conv-1'quote", { filter: 'isDraft eq false' });

    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      '/me/messages',
      expect.objectContaining({
        filter: "(isDraft eq false) and conversationId eq 'conv-1''quote'",
        orderBy: 'receivedDateTime asc',
      }),
    );
  });

  it('escapes a conversation id that contains a single quote', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ value: [] });

    await service.listByConversation(USER_ID, "a'b");

    const [, , options] = provider.request.mock.calls[0];
    expect(options.filter).toBe("conversationId eq 'a''b'");
  });

  it('exposes no getThread method - Graph has no thread resource', () => {
    const { service } = createFakes();
    expect((service as any).getThread).toBeUndefined();
  });
});

describe('AzureMailService — categories', () => {
  it('lists master categories with their display name and colour', async () => {
    const { service, provider } = createFakes();
    provider.requestAll.mockResolvedValue([
      { id: 'cat-1', displayName: 'Finance', color: 'preset0' },
      { id: 'cat-2', displayName: 'Q4' },
    ]);

    const categories = await service.listCategories(USER_ID);

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      '/me/outlook/masterCategories',
      expect.objectContaining({ select: 'id,displayName,color' }),
    );
    expect(categories).toEqual([
      { id: 'cat-1', displayName: 'Finance', color: 'preset0' },
      { id: 'cat-2', displayName: 'Q4' },
    ]);
  });

  it('PATCHes the message with the category list and returns the updated message', async () => {
    const patch = jest.fn().mockResolvedValue(graphMessage({ categories: ['Finance'] }));
    const api = jest.fn(() => ({ patch }));

    const { service, provider } = createFakes();
    provider.getClient.mockReturnValue({ api });

    const message = await service.setCategories(USER_ID, 'AAMkAGI2', ['Finance']);

    expect(api).toHaveBeenCalledWith('/me/messages/AAMkAGI2');
    expect(patch).toHaveBeenCalledWith({ categories: ['Finance'] });
    expect(message.categories).toEqual(['Finance']);
  });

  it('translates a PATCH failure into an ApiError with the Graph code', async () => {
    const patch = jest.fn().mockRejectedValue({ statusCode: 400, code: 'ErrorInvalidRequest' });

    const { service, provider } = createFakes();
    provider.getClient.mockReturnValue({ api: () => ({ patch }) });

    await expect(service.setCategories(USER_ID, 'AAMkAGI2', ['Finance'])).rejects.toMatchObject({
      code: 'ErrorInvalidRequest',
    });
  });

  it('refuses a non-array category payload without calling Graph', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.setCategories(USER_ID, 'AAMkAGI2', 'Finance' as any),
    ).rejects.toBeInstanceOf(ApiError);
    expect(provider.getClient).not.toHaveBeenCalled();
  });
});

describe('AzureMailService — error contract', () => {
  it('surfaces a 400 ErrorInvalidRequest as ApiError, never as an empty page', async () => {
    const { service, provider } = createFakes();
    provider.request.mockRejectedValue(invalidRequest());

    let caught: any;
    try {
      await service.listMessages(USER_ID, { filter: 'bogus eq true' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('ErrorInvalidRequest');
    expect(caught).not.toEqual([]);
    expect(caught).not.toBeNull();
  });

  it('propagates the Graph failure from the all-pages path', async () => {
    const { service, provider } = createFakes();
    provider.requestAll.mockRejectedValue(invalidRequest());

    await expect(service.listMessages(USER_ID, { all: true })).rejects.toMatchObject({
      code: 'ErrorInvalidRequest',
    });
  });

  it('propagates the Graph failure from every read path', async () => {
    const { service, provider } = createFakes();
    provider.request.mockRejectedValue(invalidRequest());
    provider.requestAll.mockRejectedValue(invalidRequest());

    const calls = [
      () => service.listMessages(USER_ID),
      () => service.getMessage(USER_ID, 'm1'),
      () => service.listFolders(USER_ID),
      () => service.listMessagesInFolder(USER_ID, 'inbox'),
      () => service.listCategories(USER_ID),
      () => service.listByConversation(USER_ID, 'conv-1'),
    ];

    for (const call of calls) {
      let caught: any;
      try {
        await call();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ApiError);
      expect(caught.code).toBe('ErrorInvalidRequest');
      // The legacy getEmails bug: a failure must never look like an empty list.
      expect(caught).not.toEqual([]);
    }
  });

  it('uses the module message projection by default', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ value: [] });

    await service.listMessages(USER_ID);

    expect(provider.request.mock.calls[0][2].select).toBe(DEFAULT_MAIL_MESSAGE_SELECT);
  });

  it('selects bccRecipients so BCC data is never silently dropped', () => {
    // The reviewer caught this: Graph only returns $select-ed properties, so a
    // projection that omitted bccRecipients made every read report [] - a silent
    // data loss for Sent Items, where BCC is expected.
    expect(DEFAULT_MAIL_MESSAGE_SELECT.split(',')).toContain('bccRecipients');
  });
});

/**
 * Requirement 9 has no other committed coverage: without these tests an edit to
 * MailResolver.ts or Mail.graphql would break the API surface silently, so both
 * the merged resolver map and the SDL itself are asserted here.
 */
describe('Mail GraphQL surface (requirement 9)', () => {
  const MAIL_QUERIES = [
    'azureMailMessages',
    'azureMailMessage',
    'azureMailFolders',
    'azureMailCategories',
    'azureMailConversation',
  ];

  /** The SDL is built from the real .graphql file, not from a copy of it. */
  function buildMailSchema() {
    const sdl = fs.readFileSync(
      path.join(__dirname, '..', 'graphql', 'types', 'Mail.graphql'),
      'utf8',
    );

    // Mail.graphql only *extends* Query/Mutation, as every module type file does.
    return buildSchema(`
type Query { _empty: Boolean }
type Mutation { _empty: Boolean }
${sdl}
`);
  }

  function fakeService(): any {
    return {
      listMessages: jest.fn(async () => ({ items: [] })),
      getMessage: jest.fn(async () => ({ id: 'm1' })),
      listFolders: jest.fn(async () => []),
      listCategories: jest.fn(async () => []),
      listByConversation: jest.fn(async () => ({ items: [] })),
      setCategories: jest.fn(async () => ({ id: 'm1' })),
    };
  }

  function fakeContext(service: any, userId?: string, roles: string[] = ['USER']): any {
    return {
      user: userId === undefined ? { _id: 'user-from-context' } : { _id: userId },
      // The @roles decorator calls this.
      hasRole: jest.fn((role: string) => roles.includes(role)),
      getService: jest.fn((id: string) =>
        (id === 'azure.AzureMailService@1.0.0' ? service : undefined)),
    };
  }

  it('merges every mail field into the module resolver map, and no thread field', () => {
    const query: any = (graphResolvers as any).Query;
    const mutation: any = (graphResolvers as any).Mutation;

    for (const field of MAIL_QUERIES) {
      expect(typeof query[field]).toBe('function');
    }

    expect(typeof mutation.azureSetMailCategories).toBe('function');

    // Graph has no thread resource, so no thread field may appear - ever.
    expect(query.azureMailThread).toBeUndefined();
    expect(mutation.azureSetMailThread).toBeUndefined();
    expect(Object.keys(query).filter((key) => /thread/i.test(key))).toEqual([]);
  });

  it('delegates to azure.AzureMailService with the authenticated user when userId is omitted', async () => {
    const service = fakeService();
    const context = fakeContext(service);
    const resolver: any = new MailResolver();

    await resolver.listMessages({}, { options: { top: 5 } }, context);
    await resolver.getMessage({}, { id: 'm1', options: { expand: 'attachments' } }, context);
    await resolver.listFolders({}, {}, context);
    await resolver.listCategories({}, {}, context);
    await resolver.listByConversation({}, { conversationId: 'c1' }, context);
    await resolver.setCategories({}, { messageId: 'm1', categories: ['Finance'] }, context);

    expect(context.getService).toHaveBeenCalledWith('azure.AzureMailService@1.0.0');
    expect(service.listMessages).toHaveBeenCalledWith('user-from-context', { top: 5 });
    expect(service.getMessage).toHaveBeenCalledWith(
      'user-from-context',
      'm1',
      { expand: 'attachments' },
    );
    expect(service.listFolders).toHaveBeenCalledWith('user-from-context');
    expect(service.listCategories).toHaveBeenCalledWith('user-from-context');
    expect(service.listByConversation).toHaveBeenCalledWith('user-from-context', 'c1', {});
    expect(service.setCategories).toHaveBeenCalledWith('user-from-context', 'm1', ['Finance']);
  });

  it('rejects a foreign userId from a USER-only caller and never touches the service', async () => {
    // IDOR guard. The service authenticates with the vaulted Microsoft token of
    // whichever userId it is handed, so @roles(['USER']) alone is not enough:
    // that only proves the caller is a user, not that the mailbox is theirs.
    const service = fakeService();
    const context = fakeContext(service, 'caller-id', ['USER']);
    const resolver: any = new MailResolver();

    const attempts: Array<() => Promise<unknown>> = [
      () => resolver.listMessages({}, { userId: 'target-id', options: {} }, context),
      () => resolver.getMessage({}, { userId: 'target-id', id: 'm1' }, context),
      () => resolver.listFolders({}, { userId: 'target-id' }, context),
      () => resolver.listCategories({}, { userId: 'target-id' }, context),
      () => resolver.listByConversation(
        {},
        { userId: 'target-id', conversationId: 'c1' },
        context,
      ),
      () => resolver.setCategories(
        {},
        { userId: 'target-id', messageId: 'm1', categories: ['A'] },
        context,
      ),
    ];

    for (const attempt of attempts) {
      let caught: any;
      try {
        await attempt();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InsufficientPermissions);
      expect(caught.code).toBe('USER-401');
      expect(caught.message).toContain('target-id');
    }

    // The decisive assertion: a foreign mailbox read is refused BEFORE any token
    // is resolved, so no service method ran at all.
    expect(service.listMessages).not.toHaveBeenCalled();
    expect(service.getMessage).not.toHaveBeenCalled();
    expect(service.listFolders).not.toHaveBeenCalled();
    expect(service.listCategories).not.toHaveBeenCalled();
    expect(service.listByConversation).not.toHaveBeenCalled();
    expect(service.setCategories).not.toHaveBeenCalled();
  });

  it('delegates an explicit SELF id to the service', async () => {
    const service = fakeService();
    const context = fakeContext(service, 'caller-id', ['USER']);
    const resolver: any = new MailResolver();

    await resolver.listMessages({}, { userId: 'caller-id', options: { top: 2 } }, context);
    await resolver.getMessage({}, { userId: 'caller-id', id: 'm1' }, context);
    await resolver.listFolders({}, { userId: 'caller-id' }, context);
    await resolver.listCategories({}, { userId: 'caller-id' }, context);
    await resolver.listByConversation(
      {},
      { userId: 'caller-id', conversationId: 'c1' },
      context,
    );
    await resolver.setCategories(
      {},
      { userId: 'caller-id', messageId: 'm1', categories: ['A'] },
      context,
    );

    expect(service.listMessages).toHaveBeenCalledWith('caller-id', { top: 2 });
    expect(service.getMessage).toHaveBeenCalledWith('caller-id', 'm1', {});
    expect(service.listFolders).toHaveBeenCalledWith('caller-id');
    expect(service.listCategories).toHaveBeenCalledWith('caller-id');
    expect(service.listByConversation).toHaveBeenCalledWith('caller-id', 'c1', {});
    expect(service.setCategories).toHaveBeenCalledWith('caller-id', 'm1', ['A']);
  });

  it('lets an ADMIN target another user', async () => {
    const service = fakeService();
    const context = fakeContext(service, 'admin-id', ['USER', 'ADMIN']);
    const resolver: any = new MailResolver();

    await resolver.listMessages({}, { userId: 'target-id', options: {} }, context);
    await resolver.getMessage({}, { userId: 'target-id', id: 'm1' }, context);
    await resolver.listFolders({}, { userId: 'target-id' }, context);
    await resolver.listCategories({}, { userId: 'target-id' }, context);
    await resolver.listByConversation(
      {},
      { userId: 'target-id', conversationId: 'c1' },
      context,
    );
    await resolver.setCategories(
      {},
      { userId: 'target-id', messageId: 'm1', categories: ['A'] },
      context,
    );

    expect(service.listMessages).toHaveBeenCalledWith('target-id', {});
    expect(service.getMessage).toHaveBeenCalledWith('target-id', 'm1', {});
    expect(service.listFolders).toHaveBeenCalledWith('target-id');
    expect(service.listCategories).toHaveBeenCalledWith('target-id');
    expect(service.listByConversation).toHaveBeenCalledWith('target-id', 'c1', {});
    expect(service.setCategories).toHaveBeenCalledWith('target-id', 'm1', ['A']);
  });

  it('treats an empty userId argument as "my own mailbox", not as a foreign target', async () => {
    const service = fakeService();
    const context = fakeContext(service, 'caller-id', ['USER']);
    const resolver: any = new MailResolver();

    await resolver.listMessages({}, { userId: '', options: {} }, context);

    expect(service.listMessages).toHaveBeenCalledWith('caller-id', {});
  });

  it('forwards the service error untouched - the resolver never swallows or re-wraps it', async () => {
    const service = fakeService();
    service.listMessages.mockRejectedValueOnce(apiError('ErrorInvalidRequest', 'bad filter'));

    const resolver: any = new MailResolver();

    await expect(
      resolver.listMessages({}, {}, fakeContext(service)),
    ).rejects.toMatchObject({ code: 'ErrorInvalidRequest' });
  });

  it('parses Mail.graphql and declares the five queries, the mutation and no thread field', () => {
    const schema = buildMailSchema();
    const queryFields = schema.getQueryType().getFields();
    const mutationFields = schema.getMutationType().getFields();

    expect(queryFields.azureMailMessages.type.toString()).toBe('AzureMailPage!');
    expect(queryFields.azureMailMessage.type.toString()).toBe('AzureMailMessage!');
    expect(queryFields.azureMailFolders.type.toString()).toBe('[AzureMailFolder!]!');
    expect(queryFields.azureMailCategories.type.toString()).toBe('[AzureMailCategory!]!');
    expect(queryFields.azureMailConversation.type.toString()).toBe('AzureMailPage!');
    expect(mutationFields.azureSetMailCategories.type.toString()).toBe('AzureMailMessage!');

    expect(Object.keys(queryFields)).not.toContain('azureMailThread');

    // The message type must expose every field the service normalises, including
    // bccRecipients and the guaranteed body.
    const messageType = schema.getType('AzureMailMessage') as any;
    const messageFields = messageType.getFields();

    for (const field of ['id', 'subject', 'body', 'from', 'sender', 'toRecipients', 'ccRecipients', 'bccRecipients', 'replyTo', 'categories']) {
      expect(messageFields[field]).toBeDefined();
    }
    expect(messageFields.body.type.toString()).toBe('AzureMailBody!');

    // And the type the projection and normaliser agree on is the same one the
    // request-shape suite asserts in $select.
    expect(Object.keys(messageFields)).toContain('bccRecipients');
    expect(DEFAULT_MAIL_MESSAGE_SELECT.split(',')).toContain('bccRecipients');
  });
});
/**
 * Guards, option handling and dependency fallbacks.
 *
 * These are the branches the reviewer flagged at 79.24%: the two argument guards,
 * `skip`, `orderBy` supplied as an array, the `$expand` allow-list, a PATCH that
 * returns no body, and the `context.getService` fallbacks used when the container
 * has not bound the setters.
 */
describe('AzureMailService — argument guards', () => {
  it('rejects a missing folderId without calling Graph', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.listMessagesInFolder(USER_ID, ''),
    ).rejects.toMatchObject({ code: 'GraphRequestFailed' });

    expect(provider.request).not.toHaveBeenCalled();
    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('rejects a missing conversationId without calling Graph', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.listByConversation(USER_ID, ''),
    ).rejects.toMatchObject({ code: 'GraphRequestFailed' });

    expect(provider.request).not.toHaveBeenCalled();
  });

  it('rejects a message id that is only whitespace, for read and write alike', async () => {
    const { service, provider } = createFakes();

    await expect(service.getMessage(USER_ID, '  ')).rejects.toMatchObject({
      code: 'GraphRequestFailed',
    });
    await expect(service.setCategories(USER_ID, '  ', ['A'])).rejects.toMatchObject({
      code: 'GraphRequestFailed',
    });

    expect(provider.request).not.toHaveBeenCalled();
    expect(provider.getClient).not.toHaveBeenCalled();
  });
});

describe('AzureMailService — option handling', () => {
  it('forwards $skip and an array $orderby', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ value: [] });

    await service.listMessages(USER_ID, {
      skip: 40,
      orderBy: ['subject asc', 'receivedDateTime desc'],
    });

    const [, , options] = provider.request.mock.calls[0];
    expect(options.skip).toBe(40);
    expect(options.orderBy).toEqual(['subject asc', 'receivedDateTime desc']);
  });

  it('ignores a non-finite $skip and falls back to the default page size', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ value: [] });

    await service.listMessages(USER_ID, { skip: Number.NaN, top: Number.POSITIVE_INFINITY });

    const [, , options] = provider.request.mock.calls[0];
    expect(options.skip).toBeUndefined();
    expect(options.top).toBe(25);
  });

  it('accepts $expand=attachments and rejects anything else before the request', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue(graphMessage());

    await expect(
      service.getMessage(USER_ID, 'm1', { expand: 'attachments' }),
    ).resolves.toMatchObject({ id: 'AAMkAGI2' });

    provider.request.mockClear();

    await expect(
      service.getMessage(USER_ID, 'm1', { expand: 'extensions' }),
    ).rejects.toMatchObject({ code: 'GraphRequestFailed' });

    expect(provider.request).not.toHaveBeenCalled();
  });

  it('treats a PATCH that returns no body as a failure, not a synthetic message', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    const { service, provider } = createFakes();
    provider.getClient.mockReturnValue({ api: () => ({ patch }) });

    await expect(
      service.setCategories(USER_ID, 'm1', ['Finance']),
    ).rejects.toMatchObject({ code: 'GraphRequestFailed' });
  });

  it('treats a PATCH response without an id as a failure', async () => {
    const patch = jest.fn().mockResolvedValue({ categories: ['Finance'] });
    const { service, provider } = createFakes();
    provider.getClient.mockReturnValue({ api: () => ({ patch }) });

    await expect(
      service.setCategories(USER_ID, 'm1', ['Finance']),
    ).rejects.toMatchObject({ code: 'GraphRequestFailed' });
  });
});

describe('AzureMailService — dependency fallbacks', () => {
  /**
   * Construct without setters: the service must resolve both dependencies from
   * `context.getService`, which is the path a macro or a lazily-built facade
   * takes.
   */
  function contextOnlyService(): { service: AzureMailService; context: any } {
    const provider = {
      request: jest.fn().mockResolvedValue({ value: [] }),
      requestAll: jest.fn().mockResolvedValue([]),
    };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };

    const context: any = {
      getService: jest.fn((id: string) => {
        if (id === 'azure.AzureGraphClientProvider@1.0.0') return provider;
        if (id === 'core.RedisService@1.0.0') return redis;
        return undefined;
      }),
    };

    return { service: new AzureMailService({} as any, context), context };
  }

  it('resolves the graph provider and Redis through context.getService', async () => {
    const { service, context } = contextOnlyService();

    await expect(service.listMessages(USER_ID)).resolves.toEqual({ items: [] });
    // Redis is only reached by the folder read, so exercise that path as well.
    await expect(service.listFolders(USER_ID)).resolves.toEqual([]);

    expect(context.getService).toHaveBeenCalledWith('azure.AzureGraphClientProvider@1.0.0');
    expect(context.getService).toHaveBeenCalledWith('core.RedisService@1.0.0');
  });

  it('still reads Graph when the container provides no Redis at all', async () => {
    const provider = { requestAll: jest.fn().mockResolvedValue([{ id: 'inbox' }]) };
    const context: any = {
      getService: jest.fn((id: string) =>
        (id === 'azure.AzureGraphClientProvider@1.0.0' ? provider : undefined)),
    };

    const service = new AzureMailService({} as any, context);

    await expect(service.listFolders(USER_ID)).resolves.toEqual([
      { id: 'inbox', childFolderCount: 0, unreadItemCount: 0 },
    ]);
  });
});

import fs from 'fs';
import path from 'path';
import { buildSchema, GraphQLSchema } from 'graphql';

import graphResolvers from '../graphql/resolvers';
import SyncResolver from '../graphql/resolvers/SyncResolver';

/**
 * GraphQL surface for AZ-12 (requirement 7).
 *
 * Follows `mail-write.graphql.test.ts`: build the REAL `Sync.graphql`, assert the
 * four fields the plan names with their return types and argument types, assert
 * the merged resolver map carries them, and assert each one delegates to the
 * right service with the caller's id.
 *
 * Two properties are worth more than the rest:
 *
 *   - **No `userId` argument anywhere.** These services authenticate with the
 *     caller's vaulted Microsoft token, so an exposed `userId` would be an IDOR.
 *     The SDL assertion makes reintroducing one a red test.
 *   - **`azureRenewSubscriptions` forwards `force`.** The scheduler must renew
 *     only what is due (80% of the granted lifetime); the argument exists for a
 *     deliberate manual renewal and must not be assumed.
 */

const CALLER_ID = 'user-from-context';

/** The four fields the plan specifies, with their documented return types. */
const QUERY_FIELDS: Array<[string, string]> = [
  ['azureSyncState', 'AzureSyncState'],
  ['azureSubscriptions', '[AzureSubscription!]!'],
];

const MUTATION_FIELDS: Array<[string, string]> = [
  ['azureSync', 'AzureSyncResult!'],
  ['azureRenewSubscriptions', '[AzureSubscriptionRenewal!]!'],
];

const OBJECT_TYPES = [
  'AzureSyncState',
  'AzureSyncBatch',
  'AzureSyncResult',
  'AzureSubscription',
  'AzureSubscriptionRenewal',
];

function schema(): GraphQLSchema {
  const sdl = fs.readFileSync(
    path.join(__dirname, '..', 'graphql', 'types', 'Sync.graphql'),
    'utf8',
  );

  // Sync.graphql only *extends* Query/Mutation, like every module type file.
  return buildSchema(`
scalar DateTime
type Query { _empty: Boolean }
type Mutation { _empty: Boolean }
${sdl}
`);
}

function argsOf(field: any): Record<string, string> {
  return Object.fromEntries(
    (field?.args || []).map((arg: any) => [arg.name, String(arg.type)]),
  );
}

function fakeSyncService(): any {
  return {
    getSyncState: jest.fn(async () => ({
      userId: CALLER_ID,
      resource: 'messages',
      deltaLink: 'https://graph.test/delta?$deltatoken=1',
      lastSyncedAt: new Date('2026-11-08T00:00:00Z'),
      cursor: 'm9',
      status: 'synced',
      lastError: null,
      fullResyncCount: 2,
      lastFullResyncAt: null,
      lastSyncWasFullResync: false,
    })),
    sync: jest.fn(async () => ({
      userId: CALLER_ID,
      resource: 'events',
      pages: 2,
      added: [{ id: 'a' }, { id: 'b' }],
      updated: [{ id: 'c' }],
      deleted: [{ id: 'd' }, { id: 'e' }, { id: 'f' }],
      deltaLink: 'https://graph.test/delta?$deltatoken=2',
      fullResync: true,
      status: 'resync',
      cursor: 'f',
      batches: [
        { page: 1, added: [{ id: 'a' }], updated: [], deleted: [{ id: 'd' }], deltaLink: undefined },
        {
          page: 2,
          added: [{ id: 'b' }],
          updated: [{ id: 'c' }],
          deleted: [{ id: 'e' }, { id: 'f' }],
          deltaLink: 'https://graph.test/delta?$deltatoken=2',
        },
      ],
    })),
  };
}

function fakeSubscriptionService(): any {
  return {
    listSubscriptions: jest.fn(async () => [
      {
        userId: CALLER_ID,
        subscriptionId: 'sub-1',
        resource: 'messages',
        graphResource: '/me/messages',
        changeType: ['created', 'updated'],
        notificationUrl: 'https://app.test/azure/webhooks/graph',
        expirationDateTime: new Date('2026-11-08T06:00:00Z'),
        renewedAt: new Date('2026-11-08T00:00:00Z'),
        nextRenewAt: new Date('2026-11-08T04:48:00Z'),
        active: true,
      },
    ]),
    renewSubscriptions: jest.fn(async () => [
      {
        userId: CALLER_ID,
        subscriptionId: 'sub-1',
        expirationDateTime: new Date('2026-11-08T06:00:00Z'),
        grantedLifetimeMs: 21_600_000,
        renewalTime: new Date('2026-11-08T04:48:00Z'),
        nextRenewAt: new Date('2026-11-08T04:48:00Z'),
      },
    ]),
  };
}

function fakeContext(syncService: any, subscriptionService: any, roles: string[] = ['USER']): any {
  return {
    user: { _id: CALLER_ID },
    hasRole: jest.fn((role: string) => roles.includes(role)),
    getService: jest.fn((id: string) => {
      if (id === 'azure.AzureSyncService@1.0.0') return syncService;
      if (id === 'azure.AzureSubscriptionService@1.0.0') return subscriptionService;
      return undefined;
    }),
  };
}

function resolver(): any {
  return new (SyncResolver as any)();
}

describe('Sync GraphQL surface (AZ-12)', () => {
  it('builds the real Sync.graphql and declares the four fields with their return types', () => {
    const built = schema();
    const query: any = built.getQueryType()?.getFields();
    const mutation: any = built.getMutationType()?.getFields();

    expect(query).toBeTruthy();
    expect(mutation).toBeTruthy();

    for (const [field, returnType] of QUERY_FIELDS) {
      expect(query[field]).toBeTruthy();
      expect(String(query[field].type)).toBe(returnType);
    }

    for (const [field, returnType] of MUTATION_FIELDS) {
      expect(mutation[field]).toBeTruthy();
      expect(String(mutation[field].type)).toBe(returnType);
    }
  });

  it('declares the five object types the surface needs', () => {
    const built = schema();

    for (const name of OBJECT_TYPES) {
      const type = built.getType(name);
      expect(type).toBeTruthy();
      expect(type?.astNode?.kind).toBe('ObjectTypeDefinition');
    }

    const syncResult = built.getType('AzureSyncResult') as any;
    expect(Object.keys(syncResult.getFields()).sort()).toEqual([
      'added',
      'batches',
      'cursor',
      'deleted',
      'deltaLink',
      'fullResync',
      'pages',
      'resource',
      'status',
      'updated',
      'userId',
    ]);
  });

  it('pins the required arguments and exposes NO userId on any field', () => {
    const built = schema();
    const query: any = built.getQueryType()?.getFields();
    const mutation: any = built.getMutationType()?.getFields();

    expect(argsOf(query.azureSyncState)).toEqual({ resource: 'String!' });
    expect(argsOf(query.azureSubscriptions)).toEqual({});

    expect(argsOf(mutation.azureSync)).toEqual({ resource: 'String!' });
    // `force` is the manual-renewal escape hatch the scheduler must not use.
    expect(argsOf(mutation.azureRenewSubscriptions)).toEqual({ force: 'Boolean' });

    // No IDOR surface: these services act with the caller's token, so naming a
    // user must not be expressible.
    for (const field of [query.azureSyncState, query.azureSubscriptions]) {
      expect(argsOf(field).userId).toBeUndefined();
    }
    for (const field of [mutation.azureSync, mutation.azureRenewSubscriptions]) {
      expect(argsOf(field).userId).toBeUndefined();
    }
  });

  it('merges all four fields into the module resolver map', () => {
    const query: any = (graphResolvers as any).Query;
    const mutation: any = (graphResolvers as any).Mutation;

    for (const [field] of QUERY_FIELDS) expect(typeof query[field]).toBe('function');
    for (const [field] of MUTATION_FIELDS) expect(typeof mutation[field]).toBe('function');

    // The AZ-01 stub field must be gone.
    expect(query._azureSyncPlaceholder).toBeUndefined();
  });

  describe('delegation', () => {
    it('azureSyncState delegates with the caller id and maps the row', async () => {
      const syncService = fakeSyncService();
      const context = fakeContext(syncService, fakeSubscriptionService());

      const result = await resolver().getSyncState({}, { resource: 'messages' }, context);

      expect(syncService.getSyncState).toHaveBeenCalledWith(CALLER_ID, 'messages');
      expect(result).toEqual({
        userId: CALLER_ID,
        resource: 'messages',
        deltaLink: 'https://graph.test/delta?$deltatoken=1',
        lastSyncedAt: new Date('2026-11-08T00:00:00Z'),
        cursor: 'm9',
        status: 'synced',
        lastError: null,
        fullResyncCount: 2,
        lastFullResyncAt: null,
        lastSyncWasFullResync: false,
      });
    });

    it('azureSyncState returns null when the resource was never synced', async () => {
      const syncService = fakeSyncService();
      syncService.getSyncState.mockResolvedValueOnce(null);

      const result = await resolver().getSyncState(
        {},
        { resource: 'drive' },
        fakeContext(syncService, fakeSubscriptionService()),
      );

      expect(result).toBeNull();
    });

    it('maps an ObjectId userId to a string (GraphQL String rejects an ObjectId)', async () => {
      const syncService = fakeSyncService();
      const objectId = { toString: () => '68a1b2c3d4e5f60718293a4b' };
      syncService.getSyncState.mockResolvedValueOnce({
        userId: objectId,
        resource: 'messages',
        status: 'synced',
        fullResyncCount: 0,
      });

      const result = await resolver().getSyncState(
        {},
        { resource: 'messages' },
        fakeContext(syncService, fakeSubscriptionService()),
      );

      expect(typeof result.userId).toBe('string');
      expect(result.userId).toBe('68a1b2c3d4e5f60718293a4b');
      // Defaults are filled in so the non-null SDL fields never see undefined.
      expect(result.status).toBe('synced');
      expect(result.fullResyncCount).toBe(0);
      expect(result.lastSyncWasFullResync).toBe(false);
      expect(result.deltaLink).toBeNull();
    });

    it('azureSync delegates and projects batches to per-page counts', async () => {
      const syncService = fakeSyncService();
      const context = fakeContext(syncService, fakeSubscriptionService());

      const result = await resolver().sync({}, { resource: 'events' }, context);

      expect(syncService.sync).toHaveBeenCalledWith(CALLER_ID, 'events');
      expect(result).toMatchObject({
        userId: CALLER_ID,
        resource: 'events',
        pages: 2,
        added: 2,
        updated: 1,
        deleted: 3,
        fullResync: true,
        status: 'resync',
        cursor: 'f',
        deltaLink: 'https://graph.test/delta?$deltatoken=2',
      });
      expect(result.batches).toEqual([
        { page: 1, added: 1, updated: 0, deleted: 1, deltaLink: null },
        {
          page: 2,
          added: 1,
          updated: 1,
          deleted: 2,
          deltaLink: 'https://graph.test/delta?$deltatoken=2',
        },
      ]);
    });

    it('tolerates a sparse service response without emitting undefined', async () => {
      const syncService = fakeSyncService();
      syncService.sync.mockResolvedValueOnce({ batches: [{}] });
      syncService.getSyncState.mockResolvedValueOnce({ userId: CALLER_ID });
      const subscriptionService = fakeSubscriptionService();
      subscriptionService.listSubscriptions.mockResolvedValueOnce([{ subscriptionId: 'sub-1' }]);

      const context = fakeContext(syncService, subscriptionService);

      const result = await resolver().sync({}, { resource: 'messages' }, context);
      expect(result).toMatchObject({
        resource: '',
        pages: 0,
        added: 0,
        updated: 0,
        deleted: 0,
        deltaLink: null,
        fullResync: false,
        status: 'synced',
        cursor: null,
      });
      expect(result.batches[0]).toEqual({
        page: 0,
        added: 0,
        updated: 0,
        deleted: 0,
        deltaLink: null,
      });

      const state = await resolver().getSyncState({}, { resource: 'messages' }, context);
      expect(state).toMatchObject({ status: 'idle', fullResyncCount: 0, lastSyncWasFullResync: false });

      const subscriptions = await resolver().subscriptions({}, {}, context);
      expect(subscriptions[0]).toMatchObject({ changeType: [], notificationUrl: '', active: true });
    });

    it('azureSubscriptions delegates with the caller id and maps every row', async () => {
      const subscriptionService = fakeSubscriptionService();
      const context = fakeContext(fakeSyncService(), subscriptionService);

      const result = await resolver().subscriptions({}, {}, context);

      expect(subscriptionService.listSubscriptions).toHaveBeenCalledWith(CALLER_ID);
      expect(result).toEqual([
        {
          userId: CALLER_ID,
          subscriptionId: 'sub-1',
          resource: 'messages',
          graphResource: '/me/messages',
          changeType: ['created', 'updated'],
          notificationUrl: 'https://app.test/azure/webhooks/graph',
          expirationDateTime: new Date('2026-11-08T06:00:00Z'),
          renewedAt: new Date('2026-11-08T00:00:00Z'),
          nextRenewAt: new Date('2026-11-08T04:48:00Z'),
          active: true,
        },
      ]);
    });

    it('azureRenewSubscriptions forwards force:false by default', async () => {
      const subscriptionService = fakeSubscriptionService();
      const context = fakeContext(fakeSyncService(), subscriptionService);

      const result = await resolver().renewSubscriptions({}, {}, context);

      // The scheduler path: only due rows, so no force.
      expect(subscriptionService.renewSubscriptions).toHaveBeenCalledWith(CALLER_ID, {
        force: false,
      });
      expect(result).toEqual([
        {
          userId: CALLER_ID,
          subscriptionId: 'sub-1',
          expirationDateTime: new Date('2026-11-08T06:00:00Z'),
          grantedLifetimeMs: 21_600_000,
          renewalTime: new Date('2026-11-08T04:48:00Z'),
          nextRenewAt: new Date('2026-11-08T04:48:00Z'),
        },
      ]);
    });

    it('azureRenewSubscriptions forwards force:true for a manual renewal', async () => {
      const subscriptionService = fakeSubscriptionService();

      await resolver().renewSubscriptions(
        {},
        { force: true },
        fakeContext(fakeSyncService(), subscriptionService),
      );

      expect(subscriptionService.renewSubscriptions).toHaveBeenCalledWith(CALLER_ID, {
        force: true,
      });
    });
  });

  describe('guards', () => {
    it('fails loudly when a service is not registered', async () => {
      const context: any = {
        user: { _id: CALLER_ID },
        hasRole: (): boolean => true,
        getService: (): undefined => undefined,
      };

      await expect(resolver().getSyncState({}, { resource: 'messages' }, context))
        .rejects.toThrow('Azure Sync Service not available');
      await expect(resolver().subscriptions({}, {}, context))
        .rejects.toThrow('Azure Subscription Service not available');
    });

    it('rejects a caller without the USER role before touching the service', async () => {
      const syncService = fakeSyncService();
      const context = fakeContext(syncService, fakeSubscriptionService(), []);

      // `@roles` is a synchronous guard: it throws before the async method body
      // runs, so the assertion is on a sync throw rather than a rejection.
      expect(() => resolver().getSyncState({}, { resource: 'messages' }, context))
        .toThrow(/does not have permissions/);

      expect(syncService.getSyncState).not.toHaveBeenCalled();
    });
  });
});

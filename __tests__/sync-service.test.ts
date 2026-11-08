/**
 * AzureSyncService contract (AZ-12).
 *
 * The Graph provider is faked: this suite is about the delta loop's own
 * contract - page chaining, batch classification, deltaLink persistence and the
 * 410 full-resync path. The `AzureSyncState` model is an in-memory stand-in so a
 * test can assert exactly what would be written.
 */
jest.mock('../models/AzureSyncState', () => {
  const store: any[] = [];

  const matches = (document: any, filter: any) => (
    String(document.userId) === String(filter.userId) && document.resource === filter.resource
  );

  const save = jest.fn().mockResolvedValue(undefined);

  function AzureSyncStateMock(this: any, document: any) {
    Object.assign(this, document);
    // A real document persists itself on save(), so the model-free upsert
    // fallback (no findOneAndUpdate) is exercised rather than mocked away.
    this.save = jest.fn(async () => {
      if (!store.includes(this)) store.push(this);
      await save();
    });
  }

  (AzureSyncStateMock as any).findOne = jest.fn((filter: any) => {
    const found = store.find((document) => matches(document, filter));
    return Promise.resolve(found || null);
  });

  (AzureSyncStateMock as any).findOneAndUpdate = jest.fn((filter: any, update: any) => {
    const existing = store.find((document) => matches(document, filter));

    if (existing) {
      Object.assign(existing, update.$set);
      return Promise.resolve(existing);
    }

    const created = { ...filter, ...update.$set };
    store.push(created);
    return Promise.resolve(created);
  });

  (AzureSyncStateMock as any).find = jest.fn((filter: any) => {
    const rows = store.filter((document) => String(document.userId) === String(filter.userId));
    return Promise.resolve(rows);
  });

  return {
    __esModule: true,
    AzureSyncState: AzureSyncStateMock,
    default: AzureSyncStateMock,
    __state: { store, save },
  };
});

// eslint-disable-next-line import/first
import { AzureSyncService, DELTA_PATHS, IMMUTABLE_ID_PREFER_HEADER } from '../services/AzureSyncService';
// eslint-disable-next-line import/first
import { GraphErrorCode, apiError } from '../utils/graph-error';

const sdk: any = jest.requireMock('../models/AzureSyncState');
const state: { store: any[]; save: jest.Mock } = sdk.__state;

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const FINAL_DELTA_LINK = 'https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=final';

function page(value: any[], extra: Record<string, unknown> = {}) {
  return { value, ...extra };
}

function createFakes() {
  const provider: any = { request: jest.fn() };
  const audit: any = { logOperation: jest.fn().mockResolvedValue(undefined) };
  const context: any = { getService: jest.fn(() => undefined) };

  const service = new AzureSyncService({} as any, context);
  service.setGraphClientProvider(provider);
  service.setAuditService(audit);

  return { service, provider, audit, context };
}

/**
 * Seed a persisted cursor row.
 *
 * The literal is annotated `Record<string, any>` on purpose: the repository runs
 * with `noImplicitAny: true` and `strictNullChecks` off, so each `null` property
 * of an inferred object literal is reported as TS7018 (implicit `any`). The
 * annotation keeps this ticket's suites type-clean under the server's own
 * compiler options, which is what the per-file typecheck ratchet reads.
 */
function seedState(overrides: Record<string, unknown> = {}) {
  const document: Record<string, any> = {
    userId: USER_ID,
    resource: 'messages',
    deltaLink: null,
    lastSyncedAt: null,
    cursor: null,
    status: 'idle',
    lastError: null,
    fullResyncCount: 0,
    lastFullResyncAt: null,
    lastSyncWasFullResync: false,
    ...overrides,
  };

  state.store.push(document);
  return document;
}

function storedState(resource: string = 'messages') {
  return state.store.find(
    (document) => String(document.userId) === USER_ID && document.resource === resource,
  );
}

function deltaTokenExpired() {
  return apiError(GraphErrorCode.GRAPH_REQUEST_FAILED, 'Delta token expired', {
    status: 410,
    graphCode: 'resyncRequired',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  state.store.length = 0;
  state.save.mockResolvedValue(undefined);
});

describe('AzureSyncService — delta chain', () => {
  it('follows @odata.nextLink across three pages, emits the union and persists the final deltaLink', async () => {
    const { service, provider } = createFakes();

    provider.request
      .mockResolvedValueOnce(page([{ id: 'm1' }], {
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=2',
      }))
      .mockResolvedValueOnce(page([{ id: 'm2' }, { id: 'm0', '@removed': { reason: 'deleted' } }], {
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=3',
      }))
      .mockResolvedValueOnce(page([{ id: 'm3' }, { id: 'm4' }], {
        '@odata.deltaLink': FINAL_DELTA_LINK,
      }));

    const result = await service.syncMessages(USER_ID);

    expect(provider.request).toHaveBeenCalledTimes(3);
    expect(result.pages).toBe(3);
    expect(result.batches).toHaveLength(3);

    // The union of changes across every page, with the deletion separated.
    expect(result.added.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(result.deleted.map((item) => item.id)).toEqual(['m0']);
    expect(result.updated).toEqual([]);

    expect(result.deltaLink).toBe(FINAL_DELTA_LINK);
    expect(result.fullResync).toBe(false);
    expect(result.status).toBe('synced');
    expect(result.cursor).toBe('m4');

    // Immutable ids on every request; the nextLink is requested verbatim.
    expect(provider.request.mock.calls[0][2].headers.Prefer).toBe(IMMUTABLE_ID_PREFER_HEADER);
    expect(provider.request.mock.calls[1][2].url).toBe(
      'https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=2',
    );
    expect(provider.request.mock.calls[2][2].url).toBe(
      'https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=3',
    );

    // The final deltaLink is what makes the next read cheap.
    const persisted = storedState();
    expect(persisted.deltaLink).toBe(FINAL_DELTA_LINK);
    expect(persisted.status).toBe('synced');
    expect(persisted.lastSyncedAt).toBeInstanceOf(Date);
    expect(persisted.cursor).toBe('m4');
    expect(persisted.lastSyncWasFullResync).toBe(false);
  });

  it('hands each page to onBatch before requesting the next one', async () => {
    const { service, provider } = createFakes();
    const seen: any[] = [];

    provider.request
      .mockResolvedValueOnce(page([{ id: 'a' }], { '@odata.nextLink': 'https://graph.test/2' }))
      .mockResolvedValueOnce(page([{ id: 'b' }], { '@odata.deltaLink': FINAL_DELTA_LINK }));

    await service.syncMessages(USER_ID, {
      onBatch: async (batch) => {
        seen.push({ page: batch.page, ids: batch.added.map((entry: any) => entry.id) });
      },
    });

    expect(seen).toEqual([
      { page: 1, ids: ['a'] },
      { page: 2, ids: ['b'] },
    ]);
  });

  it('starts at the persisted deltaLink and labels non-removed items as updates', async () => {
    const { service, provider } = createFakes();
    const storedLink = 'https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=stored';
    seedState({ deltaLink: storedLink, status: 'synced' });

    provider.request.mockResolvedValueOnce(page([{ id: 'm9' }], { '@odata.deltaLink': FINAL_DELTA_LINK }));

    const result = await service.syncMessages(USER_ID);

    expect(provider.request.mock.calls[0][1]).toBe(storedLink);
    expect(result.added).toEqual([]);
    expect(result.updated.map((item) => item.id)).toEqual(['m9']);
  });

  it('labels a first-ever sync (no deltaLink) as additions and reports page counts', async () => {
    const { service, provider } = createFakes();
    seedState({ deltaLink: null });

    provider.request.mockResolvedValueOnce(page([{ id: 'm1' }, { id: 'm2' }], {
      '@odata.deltaLink': FINAL_DELTA_LINK,
    }));

    const result = await service.syncMessages(USER_ID);

    expect(provider.request.mock.calls[0][1]).toBe(DELTA_PATHS.messages);
    expect(result.added.map((item) => item.id)).toEqual(['m1', 'm2']);
  });

  it('honours an explicit changeType hint when the payload carries one', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValueOnce(page([
      { id: 'n1', changeType: 'created' },
      { id: 'n2', changeType: 'updated' },
      { id: 'n3', changeType: 'deleted' },
    ], { '@odata.deltaLink': FINAL_DELTA_LINK }));

    const result = await service.syncMessages(USER_ID);

    expect(result.added.map((item) => item.id)).toEqual(['n1']);
    expect(result.updated.map((item) => item.id)).toEqual(['n2']);
    expect(result.deleted.map((item) => item.id)).toEqual(['n3']);
  });
});

describe('AzureSyncService — 410 Gone means one full resync', () => {
  it('re-runs once from the base path, records the resync and does not propagate the error', async () => {
    const { service, provider, audit } = createFakes();
    const staleLink = 'https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=expired';
    seedState({ deltaLink: staleLink, status: 'synced', fullResyncCount: 0 });

    provider.request
      .mockRejectedValueOnce(deltaTokenExpired())
      .mockResolvedValueOnce(page([{ id: 'r1' }, { id: 'r2' }], {
        '@odata.deltaLink': FINAL_DELTA_LINK,
      }));

    // The 410 must not surface to the caller.
    const result = await service.syncMessages(USER_ID);

    expect(provider.request).toHaveBeenCalledTimes(2);
    expect(provider.request.mock.calls[0][1]).toBe(staleLink);
    // The rebuild starts at the collection's delta path, not the dead token.
    expect(provider.request.mock.calls[1][1]).toBe(DELTA_PATHS.messages);

    expect(result.fullResync).toBe(true);
    expect(result.status).toBe('resync');
    expect(result.pages).toBe(1);
    expect(result.added.map((item) => item.id)).toEqual(['r1', 'r2']);
    expect(result.deltaLink).toBe(FINAL_DELTA_LINK);

    // The resync is recorded on the cursor row, not just returned.
    const persisted = storedState();
    expect(persisted.fullResyncCount).toBe(1);
    expect(persisted.lastFullResyncAt).toBeInstanceOf(Date);
    expect(persisted.lastSyncWasFullResync).toBe(true);
    expect(persisted.deltaLink).toBe(FINAL_DELTA_LINK);
    expect(persisted.status).toBe('resync');

    // …and audited.
    const fullResyncAudit = audit.logOperation.mock.calls
      .map((call: any[]) => call[0])
      .find((entry: any) => entry.operation === 'sync.messages.fullResync');
    expect(fullResyncAudit).toBeDefined();
    expect(fullResyncAudit.metadata.reason).toBe('delta-token-expired');
  });

  it('performs exactly one rebuild: a second 410 is propagated', async () => {
    const { service, provider } = createFakes();
    seedState({ deltaLink: 'https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=expired' });

    provider.request
      .mockRejectedValueOnce(deltaTokenExpired())
      .mockRejectedValueOnce(deltaTokenExpired());

    await expect(service.syncMessages(USER_ID)).rejects.toMatchObject({ status: 410 });

    expect(provider.request).toHaveBeenCalledTimes(2);
    // The first resync was recorded even though the rebuild failed - and the
    // rebuild failure itself is recorded as an error, not silently dropped.
    expect(storedState().fullResyncCount).toBe(1);
    expect(storedState().status).toBe('error');
    expect(storedState().lastError).toContain('Delta token expired');
  });
});

describe('AzureSyncService — resource paths and failure modes', () => {
  it('uses the events and drive delta paths', async () => {
    for (const [method, path, resource] of [
      ['syncEvents', DELTA_PATHS.events, 'events'],
      ['syncDrive', DELTA_PATHS.drive, 'drive'],
    ] as const) {
      jest.clearAllMocks();
      state.store.length = 0;

      const { service, provider } = createFakes();
      provider.request.mockResolvedValueOnce(page([], { '@odata.deltaLink': `${path}?$deltatoken=x` }));

      await (service as any)[method](USER_ID);

      expect(provider.request.mock.calls[0][1]).toBe(path);
      expect(storedState(resource).deltaLink).toBe(`${path}?$deltatoken=x`);
    }
  });

  it('fails loudly when the Graph provider is not available', async () => {
    const context: any = { getService: jest.fn(() => undefined) };
    const service = new AzureSyncService({} as any, context);

    await expect(service.syncMessages(USER_ID)).rejects.toMatchObject({
      code: GraphErrorCode.NOT_CONNECTED,
    });
  });

  it('refuses an unsupported resource', async () => {
    const { service } = createFakes();

    await expect((service as any).sync(USER_ID, 'contacts')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });
  });

  it('throws rather than truncating when the page bound is hit, and records the failure', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValueOnce(page([{ id: 'a' }], {
      '@odata.nextLink': 'https://graph.test/2',
    }));

    await expect(service.syncMessages(USER_ID, { maxPages: 1 })).rejects.toMatchObject({
      code: GraphErrorCode.PAGINATION_LIMIT_EXCEEDED,
    });

    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(storedState().status).toBe('error');
    expect(storedState().lastError).toContain('exceeded');
  });

  it('reads back the persisted sync state', async () => {
    const { service } = createFakes();
    seedState({ deltaLink: FINAL_DELTA_LINK, status: 'synced', lastSyncedAt: new Date() });

    const row = await service.getSyncState(USER_ID, 'messages');

    expect(row.deltaLink).toBe(FINAL_DELTA_LINK);
    expect(await service.getSyncState(USER_ID, 'events')).toBeNull();
  });

  it('lists every cursor row for a user and guards the empty id', async () => {
    const { service } = createFakes();
    seedState({ resource: 'messages' });
    seedState({ resource: 'events' });
    state.store.push({ userId: 'someone-else', resource: 'messages' });

    const rows = await service.listSyncStates(USER_ID);

    expect(rows.map((row: any) => row.resource).sort()).toEqual(['events', 'messages']);
    await expect(service.listSyncStates('')).rejects.toMatchObject({ code: GraphErrorCode.NOT_CONNECTED });
  });

  it('returns empty collections rather than throwing when the model is absent', async () => {
    const { service } = createFakes();
    const model: any = sdk.AzureSyncState;
    const find = model.find;
    const findOne = model.findOne;
    const findOneAndUpdate = model.findOneAndUpdate;

    try {
      delete model.find;
      delete model.findOne;
      delete model.findOneAndUpdate;

      await expect(service.listSyncStates(USER_ID)).resolves.toEqual([]);
      await expect(service.getSyncState(USER_ID, 'messages')).resolves.toBeNull();

      // The model-free upsert path still persists through the document.
      const provider: any = { request: jest.fn() };
      provider.request.mockResolvedValueOnce(page([{ id: 'x' }], { '@odata.deltaLink': FINAL_DELTA_LINK }));
      service.setGraphClientProvider(provider);

      const result = await service.syncMessages(USER_ID);
      expect(result.deltaLink).toBe(FINAL_DELTA_LINK);
      expect(state.store.some((row) => row.deltaLink === FINAL_DELTA_LINK)).toBe(true);
    } finally {
      model.find = find;
      model.findOne = findOne;
      model.findOneAndUpdate = findOneAndUpdate;
    }
  });

  it('reads the provider and audit service from the container when no setter ran', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce(page([], { '@odata.deltaLink': FINAL_DELTA_LINK }));
    const audit = { logOperation: jest.fn().mockResolvedValue(undefined) };

    const context: any = {
      getService: jest.fn((id: string) => {
        if (id === 'azure.AzureGraphClientProvider@1.0.0') return { request };
        if (id === 'azure.AzureAuditService@1.0.0') return audit;
        return undefined;
      }),
    };

    const service = new AzureSyncService({} as any, context);
    const result = await service.syncMessages(USER_ID);

    expect(result.deltaLink).toBe(FINAL_DELTA_LINK);
    expect(audit.logOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'sync.messages.delta', outcome: 'success' }),
    );
  });

  it('survives a container that throws and a failing audit write', async () => {
    const throwing: any = {
      getService: () => { throw new Error('not ready'); },
    };
    const service = new AzureSyncService({} as any, throwing);

    // No provider resolvable => a typed failure, not a crash.
    await expect(service.syncMessages(USER_ID)).rejects.toMatchObject({
      code: GraphErrorCode.NOT_CONNECTED,
    });

    // With a provider but an audit that rejects, the sync still completes.
    const provider: any = { request: jest.fn() };
    provider.request.mockResolvedValue(page([], { '@odata.deltaLink': FINAL_DELTA_LINK }));
    service.setGraphClientProvider(provider);
    service.setAuditService({ logOperation: jest.fn().mockRejectedValue(new Error('audit down')) });

    await expect(service.syncMessages(USER_ID)).resolves.toMatchObject({
      deltaLink: FINAL_DELTA_LINK,
    });
  });

  it('enqueues a sync onto the per-resource queue, and runs it inline without a provider', async () => {
    const enqueue = jest.fn().mockResolvedValue('envelope-1');
    const queueService: any = { enqueue, createQueue: jest.fn().mockResolvedValue(true) };
    const provider: any = { request: jest.fn() };

    const withQueue: any = {
      getService: jest.fn((id: string) => {
        if (id === 'reactory.QueueProvider@1.0.0') return { getDefaultProvider: () => queueService };
        if (id === 'azure.AzureGraphClientProvider@1.0.0') return provider;
        return undefined;
      }),
    };

    const service = new AzureSyncService({} as any, withQueue);

    await expect(service.enqueueSync(USER_ID, 'events')).resolves.toEqual({ queued: true });

    // The producer the per-resource queues were missing: the right queue name and
    // the userId in the payload.
    const [envelope, options] = enqueue.mock.calls[0];
    expect(options).toEqual({ queueId: 'azure-calendar-sync', createIfNotExists: true });
    expect(envelope.body).toMatchObject({ queueId: 'azure-calendar-sync', userId: USER_ID });
    // Queued, so no Graph call.
    expect(provider.request).not.toHaveBeenCalled();

    // No provider: the pass still runs, inline.
    const inlineProvider: any = { request: jest.fn() };
    inlineProvider.request.mockResolvedValue(page([], { '@odata.deltaLink': FINAL_DELTA_LINK }));

    const inlineContext: any = {
      getService: jest.fn((id: string) => (
        id === 'azure.AzureGraphClientProvider@1.0.0' ? inlineProvider : undefined
      )),
    };
    const inline = new AzureSyncService({} as any, inlineContext);

    await expect(inline.enqueueSync(USER_ID, 'drive')).resolves.toEqual({
      queued: false,
      reason: 'queue-provider-unavailable',
    });
    expect(inlineProvider.request).toHaveBeenCalledTimes(1);

    // Same guards as every other entry point.
    await expect(service.enqueueSync('', 'messages')).rejects.toMatchObject({
      code: GraphErrorCode.NOT_CONNECTED,
    });
    await expect(service.enqueueSync(USER_ID, 'contacts' as any)).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });
  });

  it('dispatches by resource and rejects one it does not know', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue(page([], { '@odata.deltaLink': FINAL_DELTA_LINK }));

    for (const resource of ['messages', 'events', 'drive'] as const) {
      const result = await service.sync(USER_ID, resource);
      expect(result.resource).toBe(resource);
    }

    await expect((service as any).sync(USER_ID, 'contacts')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });
  });
});

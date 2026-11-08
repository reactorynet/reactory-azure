/**
 * AzureSubscriptionService contract (AZ-12).
 *
 * The Graph client is faked at the `getClient()` boundary, so the assertions are
 * about what this service sends and stores:
 *
 *   - a fresh, encrypted `clientState` per subscription;
 *   - the **granted** expirationDateTime, never the requested one;
 *   - renewal at 80% of the granted lifetime (a different grant => a different
 *     renewal time);
 *   - clientState verification in constant time, with every failure a
 *     `{ valid: false, reason }` rather than a throw.
 */
jest.mock('../models/AzureSubscription', () => {
  const store: any[] = [];

  /**
   * Minimal MongoDB filter matcher: equality, `$lte`, `$type: 'string'` and
   * `$or`. Only what the service's queries use - `renewSubscriptions` pushes the
   * due-schedule predicate into `find()`, and a mock that ignored it would not
   * prove the pushdown works.
   */
  const matchesCondition = (document: any, key: string, expected: any): boolean => {
    const actual = document?.[key];

    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if (expected.$lte !== undefined) {
        if (actual === null || actual === undefined) return false;
        const bound = new Date(expected.$lte).getTime();
        const value = new Date(actual).getTime();
        if (Number.isNaN(bound) || Number.isNaN(value)) return false;
        return value <= bound;
      }
      if (expected.$type === 'string') return typeof actual === 'string';
    }

    // `{ field: null }` matches null, undefined and a missing field (MongoDB).
    if (expected === null) return actual === null || actual === undefined;

    return String(actual) === String(expected);
  };

  const matches = (document: any, filter: any): boolean => Object.keys(filter).every((key) => {
    if (key === '$or') {
      const clauses = Array.isArray(filter.$or) ? filter.$or : [];
      return clauses.some((clause: any) => matches(document, clause));
    }
    return matchesCondition(document, key, filter[key]);
  });

  function AzureSubscriptionMock(this: any, document: any) {
    Object.assign(this, document);
    // A real Mongoose document saves itself; keep that so the model-free
    // `upsertRecord` fallback can be exercised end to end.
    this.save = jest.fn(async () => {
      if (!store.includes(this)) store.push(this);
    });
  }

  (AzureSubscriptionMock as any).findOne = jest.fn((filter: any) => {
    const found = store.find((document) => matches(document, filter));
    return Promise.resolve(found || null);
  });

  (AzureSubscriptionMock as any).findOneAndUpdate = jest.fn(
    (filter: any, update: any, options: any = {}) => {
      const existing = store.find((document) => matches(document, filter));

      if (existing) {
        Object.assign(existing, update.$set);
        return Promise.resolve(existing);
      }

      if (options?.upsert === false) return Promise.resolve(null);

      const created = { ...filter, ...update.$set };
      store.push(created);
      return Promise.resolve(created);
    },
  );

  (AzureSubscriptionMock as any).find = jest.fn((filter: any) => {
    const rows = store.filter((document) => matches(document, filter));
    return Promise.resolve(rows);
  });

  return {
    __esModule: true,
    AzureSubscription: AzureSubscriptionMock,
    default: AzureSubscriptionMock,
    __state: { store },
  };
});

// eslint-disable-next-line import/first
import {
  AzureSubscriptionService,
  DEFAULT_REQUESTED_SUBSCRIPTION_LIFETIME_MS,
  RENEWAL_FRACTION,
} from '../services/AzureSubscriptionService';
// eslint-disable-next-line import/first
import { decryptToken } from '../utils/token-encryption';

const sdk: any = jest.requireMock('../models/AzureSubscription');
const state: { store: any[] } = sdk.__state;

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const OTHER_USER_ID = '6a9f9d2f3c4b5a6f7e8d9c0b';
const ENCRYPTION_KEY = 'az12-test-encryption-key';
const NOTIFICATION_URL = 'https://app.test/azure/webhooks/graph';
const NOW = new Date('2026-11-08T00:00:00.000Z');

const originalEnv = process.env;

function iso(date: Date): string {
  return date.toISOString();
}

function createFakes() {
  const post = jest.fn();
  const patch = jest.fn();
  const del = jest.fn();
  const api = jest.fn(() => ({ post, patch, delete: del }));

  const provider: any = { getClient: jest.fn(() => ({ api })) };
  const audit: any = { logOperation: jest.fn().mockResolvedValue(undefined) };
  const context: any = { getService: jest.fn(() => undefined) };

  const service = new AzureSubscriptionService({} as any, context);
  service.setGraphClientProvider(provider);
  service.setAuditService(audit);

  return { service, provider, audit, api, post, patch, del };
}

/** Create a stored subscription through the service, with a controlled grant. */
async function createRecord(
  fakes: ReturnType<typeof createFakes>,
  options: {
    subscriptionId?: string;
    grantedLifetimeMs?: number;
    clientState?: string;
    userId?: string;
    now?: Date;
    resource?: string;
  } = {},
) {
  const subscriptionId = options.subscriptionId || 'sub-1';
  const grantedLifetimeMs = options.grantedLifetimeMs ?? 6 * 60 * 60 * 1000;
  const now = options.now ?? NOW;

  fakes.post.mockResolvedValueOnce({
    id: subscriptionId,
    resource: '/me/messages',
    changeType: 'created,updated',
    notificationUrl: NOTIFICATION_URL,
    expirationDateTime: iso(new Date(now.getTime() + grantedLifetimeMs)),
  });

  return fakes.service.create(options.userId || USER_ID, {
    resource: options.resource || 'messages',
    clientState: options.clientState || `secret-${subscriptionId}`,
    now,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  state.store.length = 0;
  process.env = {
    ...originalEnv,
    AZURE_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    AZURE_WEBHOOK_NOTIFICATION_URL: NOTIFICATION_URL,
  };
});

afterAll(() => {
  process.env = originalEnv;
});

describe('AzureSubscriptionService — create', () => {
  it('posts /subscriptions, encrypts clientState and stores the granted expiry', async () => {
    const fakes = createFakes();
    const grantedLifetimeMs = 6 * 60 * 60 * 1000;
    const record = await createRecord(fakes, { grantedLifetimeMs });

    expect(fakes.api).toHaveBeenCalledWith('/subscriptions');
    expect(fakes.post).toHaveBeenCalledTimes(1);

    const body = fakes.post.mock.calls[0][0];
    expect(body.resource).toBe('/me/messages');
    expect(body.notificationUrl).toBe(NOTIFICATION_URL);
    expect(body.changeType).toBe('created,updated');
    // The plaintext secret goes to Graph (it echoes it back)…
    expect(body.clientState).toBe('secret-sub-1');
    // …and is requested at now + the default ask; Graph may grant less.
    expect(body.expirationDateTime).toBe(iso(new Date(NOW.getTime() + DEFAULT_REQUESTED_SUBSCRIPTION_LIFETIME_MS)));

    // Only the ciphertext is persisted.
    expect(record.clientState).not.toBe('secret-sub-1');
    expect(record.clientState).toContain(':');
    expect(record.clientStateSalt).toBeTruthy();
    expect(decryptToken(record.clientState, ENCRYPTION_KEY, record.clientStateSalt)).toBe('secret-sub-1');

    // The grant, not the ask.
    expect(record.expirationDateTime).toEqual(new Date(NOW.getTime() + grantedLifetimeMs));
    expect(record.nextRenewAt).toEqual(
      new Date(NOW.getTime() + Math.floor(grantedLifetimeMs * RENEWAL_FRACTION)),
    );
    expect(record.active).toBe(true);
    expect(record.resource).toBe('messages');

    // The stored secret verifies.
    await expect(fakes.service.verifyClientState('sub-1', 'secret-sub-1')).resolves.toMatchObject({
      valid: true,
    });
    await expect(fakes.service.verifyClientState('sub-1', 'not-the-secret')).resolves.toMatchObject({
      valid: false,
      reason: 'client-state-mismatch',
    });
  });

  it('generates a random clientState per subscription when none is supplied', async () => {
    const fakes = createFakes();

    fakes.post
      .mockResolvedValueOnce({
        id: 'sub-a',
        resource: '/me/messages',
        notificationUrl: NOTIFICATION_URL,
        expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
      })
      .mockResolvedValueOnce({
        id: 'sub-b',
        resource: '/me/messages',
        notificationUrl: NOTIFICATION_URL,
        expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
      });

    await fakes.service.create(USER_ID, { resource: 'messages', now: NOW });
    await fakes.service.create(USER_ID, { resource: 'messages', now: NOW });

    const secretA = fakes.post.mock.calls[0][0].clientState;
    const secretB = fakes.post.mock.calls[1][0].clientState;

    expect(secretA).not.toBe(secretB);
    expect(secretA.length).toBeGreaterThanOrEqual(32);

    await expect(fakes.service.verifyClientState('sub-a', secretA)).resolves.toMatchObject({ valid: true });
    await expect(fakes.service.verifyClientState('sub-b', secretB)).resolves.toMatchObject({ valid: true });
    // A secret from another subscription does not verify.
    await expect(fakes.service.verifyClientState('sub-a', secretB)).resolves.toMatchObject({ valid: false });
  });

  it('refuses to create without an encryption key', async () => {
    delete process.env.AZURE_TOKEN_ENCRYPTION_KEY;
    const fakes = createFakes();

    await expect(
      fakes.service.create(USER_ID, { resource: 'messages', clientState: 'x', now: NOW }),
    ).rejects.toMatchObject({ code: 'AzureConfigurationMissing' });

    expect(fakes.post).not.toHaveBeenCalled();
  });

  it('refuses a create response with no granted expirationDateTime', async () => {
    const fakes = createFakes();
    fakes.post.mockResolvedValueOnce({ id: 'sub-1', resource: '/me/messages' });

    await expect(
      fakes.service.create(USER_ID, { resource: 'messages', clientState: 'x', now: NOW }),
    ).rejects.toThrow(/no expirationDateTime/);
  });

  it('maps a logical resource or a Graph path and rejects anything else', async () => {
    const fakes = createFakes();

    fakes.post.mockResolvedValueOnce({
      id: 'sub-drive',
      resource: '/me/drive/root',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });

    const record = await fakes.service.create(USER_ID, {
      resource: '/me/drive/root',
      clientState: 'drive-secret',
      now: NOW,
    });

    expect(record.resource).toBe('drive');
    expect(fakes.post.mock.calls[0][0].resource).toBe('/me/drive/root');

    await expect(
      fakes.service.create(USER_ID, { resource: 'contacts', now: NOW }),
    ).rejects.toMatchObject({ code: 'GraphRequestFailed' });
  });
});

describe('AzureSubscriptionService — renew at 80% of the granted lifetime', () => {
  it('derives the renewal time from the lifetime Graph granted, not a hardcoded TTL', async () => {
    const grants = [60 * 60 * 1000, 24 * 60 * 60 * 1000];

    const renewalTimes: Date[] = [];

    for (const [index, grantedLifetimeMs] of grants.entries()) {
      state.store.length = 0;
      const fakes = createFakes();
      const subscriptionId = `sub-${index + 1}`;

      await createRecord(fakes, { subscriptionId, grantedLifetimeMs: 6 * 60 * 60 * 1000 });

      fakes.patch.mockResolvedValueOnce({
        id: subscriptionId,
        resource: '/me/messages',
        expirationDateTime: iso(new Date(NOW.getTime() + grantedLifetimeMs)),
      });

      const result = await fakes.service.renew(USER_ID, subscriptionId, {
        now: NOW,
        requestedLifetimeMs: 24 * 60 * 60 * 1000,
      });

      // The PATCH asks for the requested window…
      expect(fakes.api).toHaveBeenLastCalledWith(`/subscriptions/${subscriptionId}`);
      expect(fakes.patch.mock.calls[0][0].expirationDateTime).toBe(
        iso(new Date(NOW.getTime() + 24 * 60 * 60 * 1000)),
      );

      // …but the result obeys the grant.
      expect(result.grantedLifetimeMs).toBe(grantedLifetimeMs);
      expect(result.expirationDateTime).toEqual(new Date(NOW.getTime() + grantedLifetimeMs));
      expect(result.renewalTime).toEqual(
        new Date(NOW.getTime() + Math.floor(grantedLifetimeMs * 0.8)),
      );

      renewalTimes.push(result.renewalTime);

      // The schedule is persisted too, so a scheduler needs no TTL table.
      const stored = state.store.find((entry) => entry.subscriptionId === subscriptionId);
      expect(stored.nextRenewAt).toEqual(result.renewalTime);
      expect(stored.expirationDateTime).toEqual(result.expirationDateTime);
    }

    // A 1-hour grant and a 24-hour grant cannot produce the same renewal time.
    expect(renewalTimes[0]).toEqual(new Date(NOW.getTime() + 48 * 60 * 1000));
    expect(renewalTimes[1]).toEqual(new Date(NOW.getTime() + 19.2 * 60 * 60 * 1000));
    expect(renewalTimes[0].getTime()).not.toBe(renewalTimes[1].getTime());
  });

  it('throws when Graph returns no granted expirationDateTime', async () => {
    const fakes = createFakes();
    await createRecord(fakes);

    fakes.patch.mockResolvedValueOnce({ id: 'sub-1' });

    await expect(fakes.service.renew(USER_ID, 'sub-1', { now: NOW })).rejects.toThrow(
      /no expirationDateTime/,
    );
  });

  it('renews both subscriptions of one user once they are due', async () => {
    const fakes = createFakes();

    // 6h grant -> nextRenewAt = NOW + 4.8h.
    await createRecord(fakes, { subscriptionId: 'sub-1', clientState: 'a' });
    await createRecord(fakes, { subscriptionId: 'sub-2', clientState: 'b' });

    const later = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);
    fakes.patch.mockImplementation(() => Promise.resolve({
      expirationDateTime: iso(new Date(later.getTime() + 6 * 60 * 60 * 1000)),
    }));

    const renewals = await fakes.service.renewSubscriptions(USER_ID, { now: later });

    expect(renewals).toHaveLength(2);
    expect(renewals.map((entry) => entry.subscriptionId)).toEqual(['sub-1', 'sub-2']);
    // 6h granted from the sweep's reference time => 4.8h until the next renewal.
    expect(renewals[0].grantedLifetimeMs).toBe(6 * 60 * 60 * 1000);
    expect(renewals[0].renewalTime).toEqual(
      new Date(later.getTime() + 4.8 * 60 * 60 * 1000),
    );
  });
});

describe('AzureSubscriptionService — renewal is driven by nextRenewAt (QA-02)', () => {
  it('renews only subscriptions whose schedule has passed, not every active row', async () => {
    const fakes = createFakes();
    // 6h grant -> nextRenewAt = NOW + 4.8h.
    await createRecord(fakes, { subscriptionId: 'sub-1', grantedLifetimeMs: 6 * 60 * 60 * 1000 });

    // One hour in: nothing is due, so Graph is not called at all.
    const early = await fakes.service.renewSubscriptions(USER_ID, {
      now: new Date(NOW.getTime() + 60 * 60 * 1000),
    });

    expect(early).toEqual([]);
    expect(fakes.patch).not.toHaveBeenCalled();

    // Five hours in (past 80% of the grant) the row is due.
    const dueAt = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);
    fakes.patch.mockResolvedValueOnce({
      id: 'sub-1',
      expirationDateTime: iso(new Date(dueAt.getTime() + 6 * 60 * 60 * 1000)),
    });

    const due = await fakes.service.renewSubscriptions(USER_ID, { now: dueAt });

    expect(due).toHaveLength(1);
    expect(due[0].subscriptionId).toBe('sub-1');
    expect(fakes.patch).toHaveBeenCalledTimes(1);
  });

  it('scopes the sweep to one user unless no user is given', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { userId: USER_ID, subscriptionId: 'mine' });
    await createRecord(fakes, { userId: OTHER_USER_ID, subscriptionId: 'theirs' });

    const dueAt = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);
    fakes.patch.mockResolvedValue({
      expirationDateTime: iso(new Date(dueAt.getTime() + 6 * 60 * 60 * 1000)),
    });

    const mine = await fakes.service.renewSubscriptions(USER_ID, { now: dueAt });
    expect(mine.map((entry) => entry.subscriptionId)).toEqual(['mine']);
    expect(mine[0].userId).toBe(USER_ID);

    // The first sweep moved its own schedule forward; rewind it so the
    // unscoped sweep has two due rows to find.
    state.store.forEach((entry) => {
      entry.nextRenewAt = new Date(NOW.getTime() + 4.8 * 60 * 60 * 1000);
    });

    const all = await fakes.service.renewSubscriptions(undefined, { now: dueAt });
    expect(all.map((entry) => entry.subscriptionId).sort()).toEqual(['mine', 'theirs']);
  });

  it('force renews a subscription that is not yet due (manual / GraphQL path)', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { subscriptionId: 'sub-1', grantedLifetimeMs: 24 * 60 * 60 * 1000 });

    const early = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(await fakes.service.renewSubscriptions(USER_ID, { now: early })).toEqual([]);

    fakes.patch.mockResolvedValueOnce({
      expirationDateTime: iso(new Date(early.getTime() + 24 * 60 * 60 * 1000)),
    });

    const forced = await fakes.service.renewSubscriptions(USER_ID, { force: true, now: early });

    expect(forced).toHaveLength(1);
    expect(forced[0].subscriptionId).toBe('sub-1');
  });

  it('derives the missing schedule from renewedAt -> expirationDateTime at 80%', async () => {
    const fakes = createFakes();

    // A row written before nextRenewAt existed: no schedule, but a real grant.
    state.store.push({
      userId: USER_ID,
      subscriptionId: 'legacy',
      resource: 'messages',
      graphResource: '/me/messages',
      changeType: ['created'],
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: new Date(NOW.getTime() + 10 * 60 * 60 * 1000),
      clientState: 'x',
      clientStateSalt: 'y',
      renewedAt: NOW,
      nextRenewAt: null,
      active: true,
    });

    // 80% of a 10h grant is 8h.
    expect(await fakes.service.renewSubscriptions(USER_ID, {
      now: new Date(NOW.getTime() + 7 * 60 * 60 * 1000),
    })).toEqual([]);

    const dueAt = new Date(NOW.getTime() + 9 * 60 * 60 * 1000);
    fakes.patch.mockResolvedValueOnce({
      expirationDateTime: iso(new Date(dueAt.getTime() + 10 * 60 * 60 * 1000)),
    });

    const due = await fakes.service.renewSubscriptions(USER_ID, { now: dueAt });
    expect(due.map((entry) => entry.subscriptionId)).toEqual(['legacy']);
  });

  it('renews a row with no schedule and no grant rather than letting it lapse', async () => {
    const fakes = createFakes();
    state.store.push({
      userId: USER_ID,
      subscriptionId: 'bare',
      resource: 'events',
      active: true,
    });

    fakes.patch.mockResolvedValueOnce({
      expirationDateTime: iso(new Date(NOW.getTime() + 60 * 60 * 1000)),
    });

    const due = await fakes.service.renewSubscriptions(USER_ID, { now: NOW });

    expect(due.map((entry) => entry.subscriptionId)).toEqual(['bare']);
  });

  it('keeps sweeping when one renewal fails and audits the failure', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { subscriptionId: 'sub-1', clientState: 'a' });
    await createRecord(fakes, { subscriptionId: 'sub-2', clientState: 'b' });

    const dueAt = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
    fakes.patch
      .mockRejectedValueOnce({ status: 500, message: 'graph exploded' })
      .mockResolvedValueOnce({
        expirationDateTime: iso(new Date(dueAt.getTime() + 6 * 60 * 60 * 1000)),
      });

    const renewals = await fakes.service.renewSubscriptions(USER_ID, { now: dueAt });

    // One expired mailbox must not stop the other subscription renewing.
    expect(renewals.map((entry) => entry.subscriptionId)).toEqual(['sub-2']);

    const failureAudit = fakes.audit.logOperation.mock.calls
      .map((call: any[]) => call[0])
      .find((entry: any) => entry.outcome === 'failure' && entry.operation === 'subscription.renew');

    expect(failureAudit).toBeDefined();
    expect(failureAudit.metadata.subscriptionId).toBe('sub-1');
    expect(failureAudit.metadata.message).toContain('graph exploded');
  });

  it('pushes the due predicate into the query so a scheduler does not load every active row', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { subscriptionId: 'sub-1' });

    const dueAt = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);
    const find = sdk.AzureSubscription.find as jest.Mock;
    find.mockClear();

    // Persistent, not Once: this test sweeps twice.
    fakes.patch.mockResolvedValue({
      expirationDateTime: iso(new Date(dueAt.getTime() + 6 * 60 * 60 * 1000)),
    });

    await fakes.service.renewSubscriptions(undefined, { now: dueAt });

    // The schedule is in the filter, not only in memory: due dates, rows with no
    // schedule, and rows whose stored schedule is not a date at all.
    const filter = find.mock.calls[0][0];
    expect(filter).toMatchObject({ active: true });
    expect(filter.$or).toEqual([
      { nextRenewAt: { $lte: dueAt } },
      { nextRenewAt: null },
      { nextRenewAt: { $type: 'string' } },
    ]);
    // No userId scope on the scheduler path.
    expect(filter.userId).toBeUndefined();

    // A row whose schedule is still in the future is never loaded: the query
    // excludes it, so it cannot even appear in the in-memory candidate set.
    state.store.push({
      userId: USER_ID,
      subscriptionId: 'not-due-yet',
      resource: 'messages',
      active: true,
      nextRenewAt: new Date(dueAt.getTime() + 60 * 60 * 1000),
      renewedAt: dueAt,
      expirationDateTime: new Date(dueAt.getTime() + 6 * 60 * 60 * 1000),
    });

    // The first sweep renewed sub-1 and moved its own schedule forward; rewind it
    // so both rows are distinct candidates under the next filter.
    state.store[0].nextRenewAt = new Date(NOW.getTime() + 4.8 * 60 * 60 * 1000);

    find.mockClear();
    const second = await fakes.service.renewSubscriptions(undefined, { now: dueAt });

    expect(second.map((entry) => entry.subscriptionId)).toEqual(['sub-1']);
    // Proof the DB did the filtering: the future row was not part of the result
    // set at all, and its schedule is untouched.
    expect(state.store.find((entry) => entry.subscriptionId === 'not-due-yet').nextRenewAt)
      .toEqual(new Date(dueAt.getTime() + 60 * 60 * 1000));
  });

  it('omits the due predicate when the sweep is forced', async () => {
    const fakes = createFakes();
    await createRecord(fakes);

    const find = sdk.AzureSubscription.find as jest.Mock;
    find.mockClear();

    fakes.patch.mockResolvedValueOnce({
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });

    await fakes.service.renewSubscriptions(USER_ID, { force: true, now: NOW });

    const filter = find.mock.calls[0][0];
    expect(filter).toEqual({ active: true, userId: USER_ID });
  });

  it('rejects an invalid `now` instead of renewing on a garbage clock', async () => {
    const fakes = createFakes();
    await createRecord(fakes);

    await expect(
      fakes.service.renewSubscriptions(USER_ID, { now: 'not-a-date' }),
    ).rejects.toThrow(/not a valid date/);

    expect(fakes.patch).not.toHaveBeenCalled();
  });

  it('returns [] when the model has no find (collections not registered)', async () => {
    const fakes = createFakes();
    const model: any = sdk.AzureSubscription;
    const original = model.find;

    try {
      delete model.find;
      await expect(fakes.service.renewSubscriptions(USER_ID)).resolves.toEqual([]);
    } finally {
      model.find = original;
    }
  });
});

describe('AzureSubscriptionService — resubscribe and delete', () => {
  it('replaces an expired subscription with a new id and a new clientState', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { subscriptionId: 'sub-old', clientState: 'old-secret' });

    fakes.post.mockResolvedValueOnce({
      id: 'sub-new',
      resource: '/me/messages',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 12 * 60 * 60 * 1000)),
    });

    const record = await fakes.service.resubscribe(USER_ID, 'sub-old', {
      now: NOW,
      clientState: 'new-secret',
    });

    expect(fakes.api).toHaveBeenCalledWith('/subscriptions');
    // calls[0] is the original create; the replacement is the last POST.
    const replacementBody = fakes.post.mock.calls[fakes.post.mock.calls.length - 1][0];
    expect(replacementBody.clientState).toBe('new-secret');
    expect(replacementBody.resource).toBe('/me/messages');
    expect(record.subscriptionId).toBe('sub-new');
    expect(record.clientState).not.toBe('new-secret');
    expect(record.active).toBe(true);

    await expect(fakes.service.verifyClientState('sub-new', 'new-secret')).resolves.toMatchObject({
      valid: true,
    });
    // The old Graph id is gone from the store.
    await expect(fakes.service.verifyClientState('sub-old', 'old-secret')).resolves.toMatchObject({
      valid: false,
      reason: 'unknown-subscription',
    });
  });

  it('deletes at Graph and marks the row inactive', async () => {
    const fakes = createFakes();
    await createRecord(fakes);

    fakes.del.mockResolvedValueOnce(undefined);

    await expect(fakes.service.delete(USER_ID, 'sub-1')).resolves.toBe(true);

    expect(fakes.api).toHaveBeenCalledWith('/subscriptions/sub-1');
    const stored = state.store.find((entry) => entry.subscriptionId === 'sub-1');
    expect(stored.active).toBe(false);
    expect(stored.nextRenewAt).toBeNull();
  });

  it('treats a 404 delete as already gone', async () => {
    const fakes = createFakes();
    await createRecord(fakes);

    fakes.del.mockRejectedValueOnce({ status: 404, message: 'Resource not found' });

    await expect(fakes.service.delete(USER_ID, 'sub-1')).resolves.toBe(true);
    expect(state.store.find((entry) => entry.subscriptionId === 'sub-1').active).toBe(false);
  });
});

describe('AzureSubscriptionService — clientState verification edge cases', () => {
  it('rejects missing input, unknown and inactive subscriptions without throwing', async () => {
    const fakes = createFakes();
    await createRecord(fakes);
    state.store[0].active = false;

    await expect(fakes.service.verifyClientState('', 'x')).resolves.toMatchObject({
      valid: false,
      reason: 'missing-subscription-id',
    });
    await expect(fakes.service.verifyClientState('sub-1', '')).resolves.toMatchObject({
      valid: false,
      reason: 'missing-client-state',
    });
    await expect(fakes.service.verifyClientState('unknown', 'x')).resolves.toMatchObject({
      valid: false,
      reason: 'unknown-subscription',
    });
    await expect(fakes.service.verifyClientState('sub-1', 'secret-sub-1')).resolves.toMatchObject({
      valid: false,
      reason: 'inactive-subscription',
    });
  });

  it('rejects an unreadable ciphertext instead of throwing', async () => {
    const fakes = createFakes();
    await createRecord(fakes);
    state.store[0].clientState = 'not-a-ciphertext';

    await expect(fakes.service.verifyClientState('sub-1', 'secret-sub-1')).resolves.toMatchObject({
      valid: false,
      reason: 'client-state-unreadable',
    });
  });

  it('never leaks one user\'s subscriptions to another', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { userId: USER_ID, subscriptionId: 'sub-1' });

    await expect(fakes.service.listSubscriptions(OTHER_USER_ID)).resolves.toEqual([]);
    await expect(fakes.service.getSubscription(OTHER_USER_ID, 'sub-1')).resolves.toBeNull();
    await expect(fakes.service.renew(OTHER_USER_ID, 'sub-1')).rejects.toThrow(/No stored subscription/);
  });
});

/**
 * The remaining failure and guard branches (QA-06).
 *
 * These are the paths a caller reaches when Graph, the container or the
 * configuration is wrong - the ones that must produce a typed `ApiError` (or a
 * documented `null`/`[]`) rather than a placeholder or an unhandled throw on the
 * file that also holds the security-sensitive clientState arithmetic.
 */
describe('AzureSubscriptionService — guards and failure branches (QA-06)', () => {
  it('rejects a create without a userId or a resource', async () => {
    const fakes = createFakes();

    await expect(fakes.service.create('', { resource: 'messages' })).rejects.toMatchObject({
      code: 'NotConnected',
    });
    await expect(
      fakes.service.create(USER_ID, { resource: '', now: NOW }),
    ).rejects.toThrow(/resource is required/);
    await expect(
      fakes.service.create(USER_ID, { resource: 'contacts', now: NOW }),
    ).rejects.toThrow(/Unsupported subscription resource/);
  });

  it('normalises change types and rejects an unsupported one', async () => {
    const fakes = createFakes();

    fakes.post.mockResolvedValueOnce({
      id: 'sub-1',
      resource: '/me/messages',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });

    // Casing is normalised and duplicates collapse, so Graph gets a clean list.
    const record = await fakes.service.create(USER_ID, {
      resource: 'messages',
      changeType: ['Created', 'created', 'UPDATED'],
      clientState: 'secret',
      now: NOW,
    });

    expect(fakes.post.mock.calls[0][0].changeType).toBe('created,updated');
    expect(record.changeType).toEqual(['created', 'updated']);

    await expect(
      fakes.service.create(USER_ID, {
        resource: 'messages',
        changeType: ['moved'],
        now: NOW,
      }),
    ).rejects.toThrow(/Unsupported changeType/);
  });

  it('requires a notification URL and a valid requested expiry', async () => {
    const fakes = createFakes();
    delete process.env.AZURE_WEBHOOK_NOTIFICATION_URL;
    delete process.env.REACTORY_APPLICATION_URL;

    await expect(
      fakes.service.create(USER_ID, { resource: 'messages', clientState: 'x', now: NOW }),
    ).rejects.toMatchObject({ code: 'AzureConfigurationMissing' });

    process.env.AZURE_WEBHOOK_NOTIFICATION_URL = NOTIFICATION_URL;

    await expect(
      fakes.service.create(USER_ID, {
        resource: 'messages',
        clientState: 'x',
        expirationDateTime: 'not-a-date',
        now: NOW,
      }),
    ).rejects.toThrow(/not a valid date/);
  });

  it('rejects a create response with no subscription id', async () => {
    const fakes = createFakes();
    fakes.post.mockResolvedValueOnce({
      resource: '/me/messages',
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });

    await expect(
      fakes.service.create(USER_ID, { resource: 'messages', clientState: 'x', now: NOW }),
    ).rejects.toThrow(/no subscription id/);
  });

  it('fails loudly when the provider cannot build a client for a write', async () => {
    const fakes = createFakes();
    // A provider without getClient cannot POST/PATCH/DELETE.
    fakes.service.setGraphClientProvider({} as any);

    await expect(
      fakes.service.create(USER_ID, { resource: 'messages', clientState: 'x', now: NOW }),
    ).rejects.toMatchObject({ code: 'NotConnected' });

    // …and with no provider at all.
    fakes.service.setGraphClientProvider(undefined as any);
    await expect(
      fakes.service.create(USER_ID, { resource: 'messages', clientState: 'x', now: NOW }),
    ).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('rejects a renew with an invalid `now`', async () => {
    const fakes = createFakes();
    await createRecord(fakes);

    await expect(
      fakes.service.renew(USER_ID, 'sub-1', { now: 'nope' }),
    ).rejects.toThrow(/not a valid date/);
  });

  it('refuses to resubscribe a subscription that is not stored', async () => {
    const fakes = createFakes();

    await expect(fakes.service.resubscribe(USER_ID, 'vanished')).rejects.toThrow(
      /No stored subscription/,
    );
    expect(fakes.post).not.toHaveBeenCalled();
  });

  it('removes the replacement when the stored row vanished mid-resubscribe', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { subscriptionId: 'sub-old' });

    fakes.post.mockResolvedValueOnce({
      id: 'sub-new',
      resource: '/me/messages',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });
    fakes.del.mockResolvedValueOnce(undefined);

    // Simulate a concurrent delete between requireRecord and the update: the
    // model reports "no document matched" (upsert:false → null).
    const update = sdk.AzureSubscription.findOneAndUpdate as jest.Mock;
    const original = update.getMockImplementation();
    update.mockResolvedValueOnce(null);

    try {
      await expect(
        fakes.service.resubscribe(USER_ID, 'sub-old', { now: NOW, clientState: 'fresh' }),
      ).rejects.toThrow(/disappeared while it was being replaced/);

      // The orphan is deleted at Graph rather than left calling a URL whose
      // clientState ciphertext was never stored.
      expect(fakes.del).toHaveBeenCalledTimes(1);
      expect(fakes.api).toHaveBeenLastCalledWith('/subscriptions/sub-new');

      const failure = fakes.audit.logOperation.mock.calls
        .map((call: any[]) => call[0])
        .find((entry: any) => entry.outcome === 'failure');

      expect(failure.metadata.reason).toBe('stored-row-vanished');
      expect(failure.metadata.orphanDeleted).toBe(true);
    } finally {
      update.mockImplementation(original);
    }
  });

  it('still fails loudly when the orphan itself cannot be removed', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { subscriptionId: 'sub-old' });

    fakes.post.mockResolvedValueOnce({
      id: 'sub-new',
      resource: '/me/messages',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });
    fakes.del.mockRejectedValueOnce({ status: 500, message: 'graph down' });

    const update = sdk.AzureSubscription.findOneAndUpdate as jest.Mock;
    const original = update.getMockImplementation();
    update.mockResolvedValueOnce(null);

    try {
      await expect(
        fakes.service.resubscribe(USER_ID, 'sub-old', { now: NOW }),
      ).rejects.toThrow(/disappeared while it was being replaced/);

      const failure = fakes.audit.logOperation.mock.calls
        .map((call: any[]) => call[0])
        .find((entry: any) => entry.outcome === 'failure');

      // The cleanup failure is recorded, not allowed to mask the real error.
      expect(failure.metadata.orphanDeleted).toBe(false);
    } finally {
      update.mockImplementation(original);
    }
  });

  it('rejects a resubscribe response with no subscription id', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { subscriptionId: 'sub-old' });

    fakes.post.mockResolvedValueOnce({
      resource: '/me/messages',
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });

    await expect(
      fakes.service.resubscribe(USER_ID, 'sub-old', { now: NOW }),
    ).rejects.toThrow(/no subscription id for the replacement/);
  });

  it('propagates a non-404 delete failure and audits it', async () => {
    const fakes = createFakes();
    await createRecord(fakes);

    fakes.del.mockRejectedValueOnce({ status: 403, code: 'ErrorAccessDenied', message: 'denied' });

    await expect(fakes.service.delete(USER_ID, 'sub-1')).rejects.toMatchObject({
      status: 403,
    });

    const failureAudit = fakes.audit.logOperation.mock.calls
      .map((call: any[]) => call[0])
      .find((entry: any) => entry.operation === 'subscription.delete');

    expect(failureAudit).toBeDefined();
    expect(failureAudit.outcome).toBe('failure');
    expect(failureAudit.metadata.subscriptionId).toBe('sub-1');

    // The row stays active: Graph still holds the subscription.
    expect(state.store.find((entry) => entry.subscriptionId === 'sub-1').active).toBe(true);
  });

  it('returns null/[] rather than throwing when the collection is unavailable', async () => {
    const fakes = createFakes();
    const model: any = sdk.AzureSubscription;
    const originalFind = model.find;
    const originalFindOne = model.findOne;

    try {
      delete model.find;
      delete model.findOne;

      await expect(fakes.service.listSubscriptions(USER_ID)).resolves.toEqual([]);
      await expect(fakes.service.findByGraphId('sub-1')).resolves.toBeNull();
      await expect(fakes.service.getSubscription(USER_ID, 'sub-1')).resolves.toBeNull();
      await expect(fakes.service.verifyClientState('sub-1', 'secret')).resolves.toMatchObject({
        valid: false,
        reason: 'unknown-subscription',
      });
    } finally {
      model.find = originalFind;
      model.findOne = originalFindOne;
    }
  });

  it('guards empty identifiers on the read paths', async () => {
    const fakes = createFakes();

    await expect(fakes.service.listSubscriptions('')).rejects.toMatchObject({
      code: 'NotConnected',
    });
    await expect(fakes.service.findByGraphId('')).resolves.toBeNull();
    await expect(fakes.service.getSubscription('', '')).resolves.toBeNull();
    await expect(fakes.service.verifyClientState('sub-1', '')).resolves.toMatchObject({
      valid: false,
      reason: 'missing-client-state',
    });
  });

  it('honours a custom requested lifetime on create', async () => {
    const fakes = createFakes();

    fakes.post.mockResolvedValueOnce({
      id: 'sub-short',
      resource: '/me/messages',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });

    await fakes.service.create(USER_ID, {
      resource: 'messages',
      clientState: 'secret',
      requestedLifetimeMs: 3_600_000,
      now: NOW,
    });

    // The request asks for an hour; Graph still decides what it grants.
    expect(fakes.post.mock.calls[0][0].expirationDateTime).toBe(
      iso(new Date(NOW.getTime() + 3_600_000)),
    );
  });

  it('falls back to the grant when nextRenewAt is unreadable', async () => {
    const fakes = createFakes();
    state.store.push({
      userId: USER_ID,
      subscriptionId: 'garbled',
      resource: 'drive',
      graphResource: '/me/drive/root',
      notificationUrl: NOTIFICATION_URL,
      changeType: ['updated'],
      expirationDateTime: new Date(NOW.getTime() + 10 * 60 * 60 * 1000),
      renewedAt: NOW,
      nextRenewAt: 'not-a-date',
      active: true,
    });

    expect(await fakes.service.renewSubscriptions(USER_ID, {
      now: new Date(NOW.getTime() + 60 * 60 * 1000),
    })).toEqual([]);

    const dueAt = new Date(NOW.getTime() + 9 * 60 * 60 * 1000);
    fakes.patch.mockResolvedValueOnce({
      expirationDateTime: iso(new Date(dueAt.getTime() + 10 * 60 * 60 * 1000)),
    });

    const due = await fakes.service.renewSubscriptions(USER_ID, { now: dueAt });
    expect(due.map((entry) => entry.subscriptionId)).toEqual(['garbled']);
  });

  it('resubscribes a row that has no stored Graph path', async () => {
    const fakes = createFakes();
    state.store.push({
      userId: USER_ID,
      subscriptionId: 'sub-old',
      resource: 'events',
      notificationUrl: NOTIFICATION_URL,
      changeType: ['created'],
      expirationDateTime: new Date(NOW.getTime() - 1000),
      clientState: 'x',
      clientStateSalt: 'y',
      renewedAt: NOW,
      active: true,
    });

    fakes.post.mockResolvedValueOnce({
      id: 'sub-new',
      resource: '/me/events',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });

    const record = await fakes.service.resubscribe(USER_ID, 'sub-old', {
      now: NOW,
      clientState: 'fresh',
    });

    // The path is derived from the logical resource when the row has none.
    expect(fakes.post.mock.calls[0][0].resource).toBe('/me/events');
    expect(record.subscriptionId).toBe('sub-new');
  });

  it('finds a stored subscription by its Graph id alone (webhook path)', async () => {
    const fakes = createFakes();
    await createRecord(fakes, { subscriptionId: 'sub-1' });

    await expect(fakes.service.findByGraphId('sub-1')).resolves.toMatchObject({
      subscriptionId: 'sub-1',
      userId: USER_ID,
    });
  });

  it('requires both ids before looking a subscription up', async () => {
    const fakes = createFakes();

    await expect(fakes.service.renew('', 'sub-1')).rejects.toThrow(
      /userId and subscriptionId are required/,
    );
    await expect(fakes.service.delete(USER_ID, '')).rejects.toThrow(
      /userId and subscriptionId are required/,
    );
    await expect(fakes.service.resubscribe(USER_ID, '')).rejects.toThrow(
      /userId and subscriptionId are required/,
    );
  });

  it('rejects an unparseable granted expirationDateTime', async () => {
    const fakes = createFakes();
    await createRecord(fakes);

    fakes.patch.mockResolvedValueOnce({ id: 'sub-1', expirationDateTime: 'not-a-date' });

    await expect(fakes.service.renew(USER_ID, 'sub-1', { now: NOW })).rejects.toThrow(
      /invalid expirationDateTime/,
    );
  });

  it('resolves the provider and the audit service from the container', async () => {
    const post = jest.fn().mockResolvedValue({
      id: 'sub-ctx',
      resource: '/me/messages',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });
    const client = { api: jest.fn(() => ({ post })) };
    const audit = { logOperation: jest.fn().mockResolvedValue(undefined) };

    const context: any = {
      getService: jest.fn((id: string) => {
        if (id === 'azure.AzureGraphClientProvider@1.0.0') return { getClient: () => client };
        if (id === 'azure.AzureAuditService@1.0.0') return audit;
        return undefined;
      }),
    };

    // No setters bound: both getters have to use the container.
    const service = new AzureSubscriptionService({} as any, context);
    const record = await service.create(USER_ID, {
      resource: 'messages',
      clientState: 'ctx-secret',
      now: NOW,
    });

    expect(record.subscriptionId).toBe('sub-ctx');
    expect(audit.logOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'subscription.create', outcome: 'success' }),
    );
    await expect(service.verifyClientState('sub-ctx', 'ctx-secret')).resolves.toMatchObject({
      valid: true,
    });
  });

  it('treats a container that throws as "no provider" instead of crashing', async () => {
    const throwing: any = {
      getService: () => { throw new Error('container not ready'); },
    };

    // Without a provider the write is a typed failure…
    const bare = new AzureSubscriptionService({} as any, throwing);
    await expect(
      bare.create(USER_ID, { resource: 'messages', clientState: 'x', now: NOW }),
    ).rejects.toMatchObject({ code: 'NotConnected' });

    // …and with one, the audit lookup degrades instead of failing the write.
    const post = jest.fn().mockResolvedValue({
      id: 'sub-no-audit',
      resource: '/me/messages',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });
    const service = new AzureSubscriptionService({} as any, throwing);
    service.setGraphClientProvider({ getClient: () => ({ api: () => ({ post }) }) } as any);

    const record = await service.create(USER_ID, {
      resource: 'messages',
      clientState: 'secret',
      now: NOW,
    });

    expect(record.subscriptionId).toBe('sub-no-audit');
  });

  it('swallows a failing audit write so it cannot fail the operation', async () => {
    const fakes = createFakes();
    fakes.audit.logOperation.mockRejectedValue(new Error('audit store down'));

    fakes.post.mockResolvedValueOnce({
      id: 'sub-1',
      resource: '/me/messages',
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
    });

    const record = await fakes.service.create(USER_ID, {
      resource: 'messages',
      clientState: 'secret',
      now: NOW,
    });

    expect(record.subscriptionId).toBe('sub-1');
    expect(fakes.audit.logOperation).toHaveBeenCalled();
  });

  it('persists without findOneAndUpdate (a model flavour that lacks it)', async () => {
    const fakes = createFakes();
    const model: any = sdk.AzureSubscription;
    const original = model.findOneAndUpdate;

    try {
      delete model.findOneAndUpdate;

      fakes.post.mockResolvedValueOnce({
        id: 'sub-fallback',
        resource: '/me/messages',
        notificationUrl: NOTIFICATION_URL,
        expirationDateTime: iso(new Date(NOW.getTime() + 3_600_000)),
      });

      const record = await fakes.service.create(USER_ID, {
        resource: 'messages',
        clientState: 'secret',
        now: NOW,
      });

      expect(record.subscriptionId).toBe('sub-fallback');
      expect(state.store.some((entry) => entry.subscriptionId === 'sub-fallback')).toBe(true);

      // The update branch: an existing row is assigned in place.
      fakes.patch.mockResolvedValueOnce({
        expirationDateTime: iso(new Date(NOW.getTime() + 7_200_000)),
      });
      const renewal = await fakes.service.renew(USER_ID, 'sub-fallback', { now: NOW });
      expect(renewal.subscriptionId).toBe('sub-fallback');
    } finally {
      model.findOneAndUpdate = original;
    }
  });
});

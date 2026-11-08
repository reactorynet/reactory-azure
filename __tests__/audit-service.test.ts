/**
 * AzureAuditService contract: requirement 7 of AZ-01.
 *
 * "`logOperation` redacts the keys above and never throws." Both halves are tested
 * here, against a mocked model and a mocked core audit service - the pure `redact()`
 * helper is covered in utils.test.ts, but a passing helper proves nothing about
 * what `logOperation` actually persists or what happens when the write fails.
 */
jest.mock('../models/AzureAuditLog', () => {
  const persisted: any[] = [];

  const save = jest.fn(function save(this: any) {
    persisted.push({ ...this });
    return Promise.resolve(undefined);
  });

  function AzureAuditLogMock(this: any, document: any) {
    Object.assign(this, document);
    this.save = save;
  }
  (AzureAuditLogMock as any).find = jest.fn();

  return {
    __esModule: true,
    AzureAuditLog: AzureAuditLogMock,
    default: AzureAuditLogMock,
    __state: { persisted, save },
  };
});

// eslint-disable-next-line import/first
import { AzureAuditService, REDACTED_KEYS, redact } from '../services/AzureAuditService';

const sdk: any = jest.requireMock('../models/AzureAuditLog');
const state: { persisted: any[]; save: jest.Mock } = sdk.__state;

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';

function createService(options: { coreAudit?: any; contextGetService?: any } = {}) {
  const context: any = {
    getService: options.contextGetService || jest.fn(() => options.coreAudit),
    error: jest.fn(),
  };

  const service = new AzureAuditService({} as any, context);
  if (options.coreAudit) service.setAuditService(options.coreAudit);

  return { service, context };
}

beforeEach(() => {
  jest.clearAllMocks();
  state.persisted.length = 0;
  state.save.mockImplementation(function save(this: any) {
    state.persisted.push({ ...this });
    return Promise.resolve(undefined);
  });
});

describe('AzureAuditService.logOperation — redaction', () => {
  it('persists every credential key redacted', async () => {
    const { service } = createService();

    await service.logOperation({
      userId: USER_ID,
      operation: 'mail.listMessages',
      resource: '/me/messages',
      outcome: 'success',
      durationMs: 12,
      metadata: {
        authorization: 'Bearer secret-a',
        access_token: 'secret-b',
        refresh_token: 'secret-c',
        token: 'secret-d',
        bearer: 'secret-e',
        query: { filter: 'isRead eq false' },
      },
    });

    expect(state.save).toHaveBeenCalledTimes(1);
    const document = state.persisted[0];

    for (const key of REDACTED_KEYS) {
      expect(document.metadata[key]).toBe('[REDACTED]');
    }

    // A non-credential key survives, so the redaction is targeted, not blanket.
    expect(document.metadata.query).toEqual({ filter: 'isRead eq false' });

    const serialised = JSON.stringify(document);
    for (const secret of ['secret-a', 'secret-b', 'secret-c', 'secret-d', 'secret-e']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('records the operation, resource, outcome and a numeric duration', async () => {
    const { service } = createService();

    await service.logOperation({
      userId: USER_ID,
      operation: 'drive.getDefaultDrive',
      resource: '/me/drive',
      outcome: 'failure',
      graphCode: 'itemNotFound',
      correlationId: 'corr-1',
      durationMs: Number.NaN,
      metadata: { attempt: 1 },
    });

    const document = state.persisted[0];
    expect(document.operation).toBe('drive.getDefaultDrive');
    expect(document.resource).toBe('/me/drive');
    expect(document.outcome).toBe('failure');
    expect(document.graphCode).toBe('itemNotFound');
    expect(document.correlationId).toBe('corr-1');
    expect(document.durationMs).toBe(0);
    expect(document.timestamp).toBeInstanceOf(Date);
  });
});

describe('AzureAuditService.logOperation — never throws', () => {
  it('resolves when the model save rejects', async () => {
    const { service } = createService();
    state.save.mockRejectedValueOnce(new Error('mongo is down'));

    await expect(service.logOperation({
      userId: USER_ID,
      operation: 'mail.listMessages',
      resource: '/me/messages',
      outcome: 'success',
    })).resolves.toBeUndefined();
  });

  it('resolves when the core audit write rejects', async () => {
    const coreAudit = { logAuditEvent: jest.fn().mockRejectedValue(new Error('audit unavailable')) };
    const { service } = createService({ coreAudit });

    await expect(service.logOperation({
      userId: USER_ID,
      operation: 'calendar.listEvents',
      resource: '/me/events',
      outcome: 'success',
    })).resolves.toBeUndefined();

    expect(coreAudit.logAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('resolves when there is no core audit service at all', async () => {
    const { service } = createService();

    await expect(service.logOperation({
      userId: USER_ID,
      operation: 'tasks.listTaskLists',
      resource: '/me/todo/lists',
      outcome: 'success',
    })).resolves.toBeUndefined();
  });

  it('resolves when resolving the core audit service throws', async () => {
    const contextGetService = jest.fn(() => { throw new Error('container not ready'); });
    const { service } = createService({ contextGetService });

    await expect(service.logOperation({
      userId: USER_ID,
      operation: 'contacts.listContacts',
      resource: '/me/contacts',
      outcome: 'success',
      metadata: { token: 'must-not-leak' },
    })).resolves.toBeUndefined();

    expect(JSON.stringify(state.persisted[0])).not.toContain('must-not-leak');
  });

  it('tolerates a circular metadata payload', async () => {
    const { service } = createService();
    const metadata: any = { operation: 'circular' };
    metadata.self = metadata;

    await expect(service.logOperation({
      userId: USER_ID,
      operation: 'sync.delta',
      resource: '/me/messages/delta',
      outcome: 'success',
      metadata,
    })).resolves.toBeUndefined();

    expect(state.persisted[0].metadata.self).toBe('[CIRCULAR]');
  });
});

describe('AzureAuditService.logAuthEvent', () => {
  it('records an auth operation against the token resource', async () => {
    const { service } = createService();

    await service.logAuthEvent(USER_ID, 'connect', { scopes: 3 });

    const document = state.persisted[0];
    expect(document.operation).toBe('auth.connect');
    expect(document.resource).toBe('azure_token');
    expect(document.outcome).toBe('success');
  });

  it('never throws when the write fails', async () => {
    const { service } = createService();
    state.save.mockRejectedValueOnce(new Error('write failed'));

    await expect(service.logAuthEvent(USER_ID, 'revoke')).resolves.toBeUndefined();
  });
});

describe('AzureAuditService.getAuditTrail', () => {
  function chainResolving(rows: any[]) {
    const chain: any = {};
    chain.sort = jest.fn(() => chain);
    chain.limit = jest.fn(() => chain);
    chain.lean = jest.fn(() => Promise.resolve(rows));
    sdk.AzureAuditLog.find.mockReturnValue(chain);
    return chain;
  }

  it('returns the newest entries for a user and clamps the limit', async () => {
    const chain = chainResolving([{ operation: 'a' }, { operation: 'b' }]);
    const { service } = createService();

    const rows = await service.getAuditTrail(USER_ID, 5000);

    expect(rows).toHaveLength(2);
    expect(sdk.AzureAuditLog.find).toHaveBeenCalledWith({ userId: USER_ID });
    expect(chain.sort).toHaveBeenCalledWith({ timestamp: -1 });
    expect(chain.limit).toHaveBeenCalledWith(1000);
  });

  it('clamps a non-positive limit to 1 and propagates a query failure', async () => {
    const chain = chainResolving([]);
    const { service } = createService();

    await service.getAuditTrail(USER_ID, 0);
    expect(chain.limit).toHaveBeenCalledWith(1);

    chain.lean.mockRejectedValueOnce(new Error('query failed'));
    await expect(service.getAuditTrail(USER_ID)).rejects.toThrow('query failed');
  });
});

describe('redact()', () => {
  it('walks arrays and leaves scalars alone', () => {
    expect(redact([{ token: 'x' }, 'plain', 7])).toEqual([{ token: '[REDACTED]' }, 'plain', 7]);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('summarises buffers instead of persisting them', () => {
    expect(redact(Buffer.from('0123456789'))).toBe('[BUFFER:10]');
  });

  it('truncates deeply nested payloads rather than recursing without bound', () => {
    let deep: any = { token: 'x' };
    for (let index = 0; index < 12; index += 1) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain('[TRUNCATED]');
  });

  it('keeps dates', () => {
    const now = new Date('2026-11-08T00:00:00Z');
    expect(redact({ at: now })).toEqual({ at: now });
  });
});

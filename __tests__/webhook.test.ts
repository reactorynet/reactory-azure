/**
 * Graph webhook endpoint, queue registration and processors (AZ-12).
 *
 * The route is mounted behind a stand-in for `req.context`, exactly like
 * `routes-auth.test.ts`, so the service lookups follow the production path.
 *
 * Behaviours that are load-bearing here:
 *   1. the validation handshake echoes the URL-decoded token, decoded ONCE, as
 *      `text/plain; charset=utf-8`;
 *   2. a mismatched clientState is answered 202 **and** audited;
 *   3. verified notifications are enqueued, and a missing queue provider is a
 *      logged no-op (still 202);
 *   4. processors register only when `reactory.QueueProvider@1.0.0` exists, and a
 *      service's `onStartup` is what does it in a running deployment;
 *   5. the envelope the route enqueues is the envelope `dispatchAzureQueueMessage`
 *      drains, and every processor drives the right service method.
 */
import express from 'express';
import request from 'supertest';

// eslint-disable-next-line import/first
import webhookRoutes from '../routes/webhooks';
// eslint-disable-next-line import/first
import {
  AZURE_QUEUE_ENVELOPE_VERSION,
  AZURE_QUEUE_NAMES,
  clearAzureQueueProcessors,
  dispatchAzureQueueMessage,
  enqueueAzureJob,
  getRegisteredAzureQueues,
  registerAzureQueueProcessors,
} from '../queues';
// eslint-disable-next-line import/first
import { AzureSyncService } from '../services/AzureSyncService';
// eslint-disable-next-line import/first
import {
  auditRejectedNotification,
  decodeValidationToken,
  ensureGraphWebhookBody,
  readValidationToken,
  sendValidationToken,
  verifyGraphWebhookNotifications,
  verifyNotification,
  webhookVerification,
} from '../middleware/webhook-verification';
// eslint-disable-next-line import/first
import { describeQueueProvider, resolveQueueService } from '../queues/provider';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';

interface IFakeContext {
  context: any;
  subscriptionService: any;
  auditService: any;
  queueService: any;
  queueProvider: any;
}

function createFakes(options: { withQueue?: boolean; withSubscription?: boolean } = {}): IFakeContext {
  const subscriptionService: any = {
    verifyClientState: jest.fn(),
    findByGraphId: jest.fn(),
  };

  const auditService: any = { logOperation: jest.fn().mockResolvedValue(undefined) };

  const queueService: any = {
    createQueue: jest.fn().mockResolvedValue(true),
    enqueue: jest.fn().mockResolvedValue('envelope-1'),
  };

  const queueProvider: any = {
    getDefaultProvider: jest.fn(() => queueService),
    getProvider: jest.fn(() => queueService),
  };

  const services: Record<string, any> = {
    'azure.AzureAuditService@1.0.0': auditService,
    'azure.AzureSubscriptionService@1.0.0': options.withSubscription === false ? undefined : subscriptionService,
    'reactory.QueueProvider@1.0.0': options.withQueue === false ? undefined : queueProvider,
  };

  return {
    context: { getService: jest.fn((id: string) => services[id]) },
    subscriptionService,
    auditService,
    queueService,
    queueProvider,
  };
}

function buildApp(context: any) {
  const app = express();

  app.use((req, _res, next) => {
    (req as any).context = context;
    next();
  });

  app.use('/azure/webhooks', webhookRoutes);

  return app;
}

function notification(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId: 'sub-1',
    clientState: 'the-secret',
    changeType: 'created',
    resource: '/me/messages',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearAzureQueueProcessors();
});

describe('POST /azure/webhooks/graph — validation handshake', () => {
  it('returns the exact URL-decoded token as text/plain; charset=utf-8', async () => {
    // No subscription service at all: the handshake must not depend on it.
    const { context } = createFakes({ withSubscription: false });
    const token = 'Validation: Testing client application';

    const response = await request(buildApp(context))
      .post('/azure/webhooks/graph')
      .query({ validationToken: token });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.text).toBe(token);
  });

  it('decodes reserved characters and does not JSON-quote the token', async () => {
    const { context } = createFakes();
    const token = 'a b&c/d=e?f%g+ h';

    const response = await request(buildApp(context))
      .post('/azure/webhooks/graph')
      .query({ validationToken: token });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.text).toBe(token);
    expect(response.text.startsWith('"')).toBe(false);
  });

  it('handles a raw percent-encoded query string', async () => {
    const { context } = createFakes();

    const response = await request(buildApp(context))
      .post('/azure/webhooks/graph?validationToken=Validation%3A%20Token%20%26%20more');

    expect(response.status).toBe(200);
    expect(response.text).toBe('Validation: Token & more');
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('decodes exactly once: a token containing a literal %20 survives', async () => {
    const { context } = createFakes();
    // Graph puts `abc%2520def` on the wire for a token whose real value is
    // `abc%20def`. Express decodes the query once; a second decode would answer
    // `abc def` and the handshake would fail.
    const response = await request(buildApp(context))
      .post('/azure/webhooks/graph?validationToken=abc%2520def');

    expect(response.status).toBe(200);
    expect(response.text).toBe('abc%20def');
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('uses the guarded decoder only for a raw, unparsed string', () => {
    // The helper is for a raw query string, not for an already-decoded value.
    expect(decodeValidationToken('Validation%3A%20Token')).toBe('Validation: Token');
    // A malformed escape is returned verbatim rather than throwing.
    expect(decodeValidationToken('100%zz')).toBe('100%zz');
    expect(decodeValidationToken(undefined)).toBe('');
  });
});

describe('POST /azure/webhooks/graph — clientState verification', () => {
  it('rejects a wrong clientState with 202 and an audit entry, and never enqueues it', async () => {
    const fakes = createFakes();
    fakes.subscriptionService.verifyClientState.mockResolvedValue({
      valid: false,
      reason: 'client-state-mismatch',
      subscription: { userId: USER_ID, subscriptionId: 'sub-1' },
    });

    const response = await request(buildApp(fakes.context))
      .post('/azure/webhooks/graph')
      .send({ value: [notification({ clientState: 'forged' })] });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: 0, rejected: 1 });

    expect(fakes.subscriptionService.verifyClientState).toHaveBeenCalledWith('sub-1', 'forged');

    // Audited as a failure, against the subscription's owner.
    expect(fakes.auditService.logOperation).toHaveBeenCalledTimes(1);
    const auditEntry = fakes.auditService.logOperation.mock.calls[0][0];
    expect(auditEntry.operation).toBe('webhook.clientStateRejected');
    expect(auditEntry.outcome).toBe('failure');
    expect(auditEntry.userId).toBe(USER_ID);
    expect(auditEntry.metadata.subscriptionId).toBe('sub-1');
    expect(auditEntry.metadata.reason).toBe('client-state-mismatch');

    expect(fakes.queueService.enqueue).not.toHaveBeenCalled();
  });

  it('accepts verified notifications and enqueues them on azure-webhook-process', async () => {
    const fakes = createFakes();
    fakes.subscriptionService.verifyClientState.mockResolvedValue({ valid: true });

    const response = await request(buildApp(fakes.context))
      .post('/azure/webhooks/graph')
      .send({ value: [notification()] });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: 1, rejected: 0 });

    expect(fakes.queueService.createQueue).toHaveBeenCalledWith(AZURE_QUEUE_NAMES.webhookProcess);
    expect(fakes.queueService.enqueue).toHaveBeenCalledTimes(1);

    const [envelope, enqueueOptions] = fakes.queueService.enqueue.mock.calls[0];
    expect(enqueueOptions).toEqual({
      queueId: AZURE_QUEUE_NAMES.webhookProcess,
      createIfNotExists: true,
    });
    expect(envelope.body.notifications).toHaveLength(1);
    expect(envelope.body.notifications[0].subscriptionId).toBe('sub-1');
    expect(envelope.header.id).toBeTruthy();
  });

  it('processes a mixed batch: one accepted, one rejected', async () => {
    const fakes = createFakes();
    fakes.subscriptionService.verifyClientState.mockImplementation((subscriptionId: string) => (
      subscriptionId === 'sub-1'
        ? Promise.resolve({ valid: true })
        : Promise.resolve({ valid: false, reason: 'client-state-mismatch' })
    ));

    const response = await request(buildApp(fakes.context))
      .post('/azure/webhooks/graph')
      .send({
        value: [
          notification({ subscriptionId: 'sub-1' }),
          notification({ subscriptionId: 'sub-2', clientState: 'wrong' }),
        ],
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: 1, rejected: 1 });
    expect(fakes.auditService.logOperation).toHaveBeenCalledTimes(1);
    expect(fakes.queueService.enqueue.mock.calls[0][0].body.notifications).toHaveLength(1);
  });

  it('still answers 202 when the queue provider is absent (degraded no-op)', async () => {
    const fakes = createFakes({ withQueue: false });
    fakes.subscriptionService.verifyClientState.mockResolvedValue({ valid: true });

    const response = await request(buildApp(fakes.context))
      .post('/azure/webhooks/graph')
      .send({ value: [notification()] });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: 1, rejected: 0 });
  });

  it('answers 503 when the subscription service cannot verify anything', async () => {
    const fakes = createFakes({ withSubscription: false });

    const response = await request(buildApp(fakes.context))
      .post('/azure/webhooks/graph')
      .send({ value: [notification()] });

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('Azure Subscription Service not available');
  });

  it('handles an empty notification batch', async () => {
    const fakes = createFakes();

    const response = await request(buildApp(fakes.context))
      .post('/azure/webhooks/graph')
      .send({ value: [] });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: 0, rejected: 0 });
    expect(fakes.subscriptionService.verifyClientState).not.toHaveBeenCalled();
  });
});

describe('Azure queues — provider-gated registration', () => {
  it('degrades to a logged no-op when reactory.QueueProvider@1.0.0 is absent', async () => {
    const context = { getService: jest.fn(() => undefined) };

    const result = await registerAzureQueueProcessors(context);

    expect(result.available).toBe(false);
    expect(result.registered).toEqual([]);
    expect(result.skipped).toEqual(Object.values(AZURE_QUEUE_NAMES));
    expect(getRegisteredAzureQueues()).toEqual([]);
  });

  it('never throws at module load without a provider', () => {
    // Importing the barrel is the module-load path; the assertions above run
    // after a real import, and this documents the contract explicitly.
    expect(() => require('../queues')).not.toThrow();
  });

  it('creates and registers all five queues when the provider is available', async () => {
    const queueService: any = { createQueue: jest.fn().mockResolvedValue(true) };
    const context = {
      getService: jest.fn((id: string) => (
        id === 'reactory.QueueProvider@1.0.0'
          ? { getDefaultProvider: () => queueService }
          : undefined
      )),
    };

    const result = await registerAzureQueueProcessors(context);

    expect(result.available).toBe(true);
    expect(result.registered).toEqual(Object.values(AZURE_QUEUE_NAMES));
    expect(queueService.createQueue).toHaveBeenCalledTimes(5);
    expect(getRegisteredAzureQueues()).toEqual(Object.values(AZURE_QUEUE_NAMES));

    clearAzureQueueProcessors();
  });

  it('dispatches a job through the queue processor', async () => {
    const syncService: any = { syncMessages: jest.fn().mockResolvedValue({}) };
    const context = {
      getService: jest.fn((id: string) => (
        id === 'azure.AzureSyncService@1.0.0' ? syncService : undefined
      )),
    };

    const handled = await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.mailSync, {
      userId: USER_ID,
    });

    expect(handled).toBe(true);
    expect(syncService.syncMessages).toHaveBeenCalledWith(USER_ID);
  });

  it('enqueueAzureJob is a no-op without a provider', async () => {
    const context = { getService: jest.fn(() => undefined) };

    await expect(
      enqueueAzureJob(context, AZURE_QUEUE_NAMES.mailSync, { userId: USER_ID }),
    ).resolves.toEqual({ queued: false, reason: 'queue-provider-unavailable' });
  });

  it('enqueues through a provider that only exposes addJob', async () => {
    const addJob = jest.fn().mockResolvedValue(undefined);
    const context = {
      getService: jest.fn((id: string) => (
        id === 'reactory.QueueProvider@1.0.0'
          ? { getDefaultProvider: () => ({ addJob }) }
          : undefined
      )),
    };

    await expect(
      enqueueAzureJob(context, AZURE_QUEUE_NAMES.driveSync, { userId: USER_ID }),
    ).resolves.toEqual({ queued: true });

    expect(addJob).toHaveBeenCalledWith(
      AZURE_QUEUE_NAMES.driveSync,
      expect.objectContaining({ data: { userId: USER_ID } }),
    );
  });

  it('reports an unsupported provider and a rejected enqueue instead of throwing', async () => {
    const unsupported = {
      getService: jest.fn((id: string) => (
        id === 'reactory.QueueProvider@1.0.0'
          ? { getDefaultProvider: () => ({ createQueue: jest.fn() }) }
          : undefined
      )),
    };

    await expect(
      enqueueAzureJob(unsupported, AZURE_QUEUE_NAMES.mailSync, { userId: USER_ID }),
    ).resolves.toEqual({ queued: false, reason: 'enqueue-unsupported' });

    const rejecting = {
      getService: jest.fn((id: string) => (
        id === 'reactory.QueueProvider@1.0.0'
          ? {
            getDefaultProvider: () => ({
              createQueue: jest.fn(),
              enqueue: jest.fn().mockRejectedValue(new Error('backend down')),
            }),
          }
          : undefined
      )),
    };

    await expect(
      enqueueAzureJob(rejecting, AZURE_QUEUE_NAMES.mailSync, { userId: USER_ID }),
    ).resolves.toEqual({ queued: false, reason: 'enqueue-failed' });
  });

  it('registers even when the backend says the queue already exists', async () => {
    const queueService = {
      // The in-memory provider throws for an existing queue.
      createQueue: jest.fn().mockRejectedValue(new Error('Queue already exists')),
    };
    const context = {
      getService: jest.fn((id: string) => (
        id === 'reactory.QueueProvider@1.0.0'
          ? { getDefaultProvider: () => queueService }
          : undefined
      )),
    };

    const result = await registerAzureQueueProcessors(context);

    expect(result.available).toBe(true);
    expect(result.registered).toEqual(Object.values(AZURE_QUEUE_NAMES));

    clearAzureQueueProcessors();
  });
});

/**
 * The defensive branches of the webhook helpers (QQ-N01).
 *
 * These are the paths a request reaches when the container is half-built or the
 * subscription service misbehaves: every one must degrade to a reason string or
 * a logged warn, never to a thrown error that would turn a rejected notification
 * into a 500 Graph retries forever.
 */
describe('webhook-verification helpers — degraded paths', () => {
  const NOTIFICATION = {
    subscriptionId: 'sub-1',
    clientState: 'secret',
    changeType: 'created',
    resource: '/me/messages',
    tenantId: 'tenant-1',
  };

  it('reads a token from a raw url when the caller has no parsed query', () => {
    expect(readValidationToken({ url: '/azure/webhooks/graph?validationToken=raw%2Btoken' } as any))
      .toBe('raw+token');
    expect(readValidationToken({ originalUrl: '/azure/webhooks/graph?validationToken=a%26b' } as any))
      .toBe('a&b');
    // No token at all.
    expect(readValidationToken({ url: '/azure/webhooks/graph' } as any)).toBeUndefined();
    // A parsed query wins over the raw url (single decode, never twice).
    expect(readValidationToken({
      query: { validationToken: 'abc%20def' },
      url: '/azure/webhooks/graph?validationToken=abc%2520def',
    } as any)).toBe('abc%20def');
  });

  it('only parses a JSON body for a POST to the webhook path', () => {
    const next = jest.fn();
    const res: any = {};

    // Wrong method.
    ensureGraphWebhookBody({ method: 'GET', url: '/azure/webhooks/graph' } as any, res, next);
    // Right method, wrong path.
    ensureGraphWebhookBody({ method: 'POST', url: '/azure/auth/url' } as any, res, next);
    // A host-level parser already ran.
    ensureGraphWebhookBody(
      { method: 'POST', url: '/azure/webhooks/graph', body: { value: [] } } as any,
      res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(3);
    // The array the module contributes is exactly this one guard.
    expect(webhookVerification).toEqual([ensureGraphWebhookBody]);
  });

  it('reports a verification outcome for every failure mode instead of throwing', async () => {
    // No subscription service at all.
    await expect(
      verifyNotification({ getService: (): undefined => undefined }, NOTIFICATION),
    ).resolves.toMatchObject({ valid: false, reason: 'subscription-service-unavailable' });

    // A service without verifyClientState.
    await expect(
      verifyNotification({ getService: () => ({}) }, NOTIFICATION),
    ).resolves.toMatchObject({ valid: false, reason: 'subscription-service-unavailable' });

    // A service that resolves nothing.
    await expect(
      verifyNotification(
        { getService: () => ({ verifyClientState: async (): Promise<undefined> => undefined }) },
        NOTIFICATION,
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'verification-returned-nothing' });

    // A service that throws (a broken ciphertext read, a container error).
    await expect(
      verifyNotification(
        { getService: () => ({ verifyClientState: async () => { throw new Error('boom'); } }) },
        NOTIFICATION,
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'verification-failed: boom' });

    // A rejection with no reason falls back to the documented default.
    await expect(
      verifyNotification(
        { getService: () => ({ verifyClientState: async () => ({ valid: false }) }) },
        NOTIFICATION,
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'client-state-mismatch' });
  });

  it('takes the first value of a repeated query parameter', () => {
    expect(readValidationToken({ query: { validationToken: ['first', 'second'] } } as any))
      .toBe('first');
  });

  it('writes an empty body rather than "undefined" for a token-less handshake', () => {
    const setHeader = jest.fn();
    const send = jest.fn().mockReturnValue('sent');
    const res: any = { setHeader, status: jest.fn(() => ({ send })) };

    sendValidationToken(res, undefined);
    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
    expect(send).toHaveBeenCalledWith('');

    // A repeated parameter is answered with its first value.
    sendValidationToken(res, ['a', 'b']);
    expect(send).toHaveBeenLastCalledWith('a');
  });

  it('splits a batch and audits every rejection through the batch helper', async () => {
    const audit = { logOperation: jest.fn().mockResolvedValue(undefined) };
    const service = {
      verifyClientState: async (id: string) => (id === 'good'
        ? { valid: true }
        : { valid: false, reason: 'client-state-mismatch' }),
    };
    const context = {
      getService: (id: string) => {
        if (id === 'azure.AzureSubscriptionService@1.0.0') return service;
        if (id === 'azure.AzureAuditService@1.0.0') return audit;
        return undefined;
      },
    };

    const batch = await verifyGraphWebhookNotifications(context, [
      { subscriptionId: 'good', clientState: 's' },
      { subscriptionId: 'bad', clientState: 's' },
    ]);

    expect(batch.accepted.map((entry) => entry.subscriptionId)).toEqual(['good']);
    expect(batch.rejected.map((entry) => entry.subscriptionId)).toEqual(['bad']);
    expect(batch.reasons).toEqual(['client-state-mismatch']);
    expect(audit.logOperation).toHaveBeenCalledTimes(1);
  });

  it('audits a rejection even when there is no audit service or the audit write throws', async () => {
    const verification = { valid: false, reason: 'client-state-mismatch' };

    // No audit service: a warning, not a throw.
    await expect(
      auditRejectedNotification({ getService: (): undefined => undefined }, NOTIFICATION, verification),
    ).resolves.toBeUndefined();

    // A container that throws while resolving the audit service.
    await expect(
      auditRejectedNotification(
        { getService: () => { throw new Error('not ready'); } },
        NOTIFICATION,
        verification,
      ),
    ).resolves.toBeUndefined();

    // An audit write that rejects: still a warning, never a failed rejection.
    const audit = { logOperation: jest.fn().mockRejectedValue(new Error('audit down')) };
    await expect(
      auditRejectedNotification({ getService: () => audit }, NOTIFICATION, verification),
    ).resolves.toBeUndefined();

    expect(audit.logOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'webhook.clientStateRejected', outcome: 'failure' }),
    );
  });

  it('attributes an orphan rejection to the documented placeholder user', async () => {
    const audit = { logOperation: jest.fn().mockResolvedValue(undefined) };

    await auditRejectedNotification(
      { getService: () => audit },
      { subscriptionId: '' },
      { valid: false },
    );

    expect(audit.logOperation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '000000000000000000000000', resource: '' }),
    );
    expect(audit.logOperation.mock.calls[0][0].metadata.reason).toBe('client-state-mismatch');
  });
});

/**
 * The `reactory.QueueProvider@1.0.0` accessors (QQ-N01).
 *
 * Every branch here exists so a half-configured deployment degrades instead of
 * crashing: the provider may be absent, expose only one of the two accessors,
 * report a different backend key, or throw.
 */
describe('queue provider accessors — every degraded shape', () => {
  it('reports the configured backend key when the provider exposes one', () => {
    expect(describeQueueProvider({
      getService: () => ({ defaultProviderKey: 'bullmq' }),
    })).toBe('bullmq');

    expect(describeQueueProvider({
      getService: () => ({ defaultProvider: 'aws-sqs' }),
    })).toBe('aws-sqs');

    // A single available provider is unambiguous.
    expect(describeQueueProvider({
      getService: () => ({ getAvailableProviders: () => ['in-memory'] }),
    })).toBe('in-memory');

    // Several providers, no default: not reportable.
    expect(describeQueueProvider({
      getService: () => ({ getAvailableProviders: () => ['in-memory', 'bullmq'] }),
    })).toBeUndefined();

    // No provider at all.
    expect(describeQueueProvider({ getService: (): undefined => undefined })).toBeUndefined();

    // A provider whose introspection throws is not a crash.
    expect(describeQueueProvider({
      getService: () => ({
        getAvailableProviders: () => { throw new Error('unavailable'); },
      }),
    })).toBeUndefined();
  });

  it('resolves the backend through whichever accessor the provider has', () => {
    const byKey = { id: 'by-key' };
    const byDefault = { id: 'by-default' };
    const fallback = { id: 'fallback' };

    // An explicit providerKey wins.
    expect(resolveQueueService(
      { getService: () => ({ getProvider: () => byKey, getDefaultProvider: () => byDefault }) },
      'bullmq',
    )).toBe(byKey);

    expect(resolveQueueService({
      getService: () => ({ getDefaultProvider: () => byDefault }),
    })).toBe(byDefault);

    // Only getProvider(): the no-argument form is used.
    expect(resolveQueueService({
      getService: () => ({ getProvider: () => fallback }),
    })).toBe(fallback);

    // No provider.
    expect(resolveQueueService({ getService: (): undefined => undefined })).toBeUndefined();

    // An accessor that throws resolves to undefined rather than propagating.
    expect(resolveQueueService({
      getService: () => ({
        getDefaultProvider: () => { throw new Error('backend down'); },
      }),
    })).toBeUndefined();

    // A provider with neither accessor.
    expect(resolveQueueService({ getService: () => ({}) })).toBeUndefined();
  });
});

describe('Azure queues — registration happens at start-up (QA-01)', () => {
  /** A container stand-in whose QueueProvider serves `queueService`. */
  function providerContext(queueService: any): any {
    return {
      getService: jest.fn((id: string) => (
        id === 'reactory.QueueProvider@1.0.0'
          ? {
            getDefaultProvider: () => queueService,
            getProvider: () => queueService,
            getAvailableProviders: () => ['in-memory'],
          }
          : undefined
      )),
      log: jest.fn(),
    };
  }

  it('AzureSyncService.onStartup registers and creates all five queues', async () => {
    const queueService: any = { createQueue: jest.fn().mockResolvedValue(true) };
    const context = providerContext(queueService);
    const service = new AzureSyncService({} as any, context);

    await service.onStartup(context);

    // This is the hook ServiceManager.startServices awaits, so without it the
    // queues would exist only in tests.
    expect(getRegisteredAzureQueues()).toEqual(Object.values(AZURE_QUEUE_NAMES));
    expect(queueService.createQueue).toHaveBeenCalledTimes(5);
    expect(service.getQueueRegistration()).toMatchObject({
      available: true,
      providerKey: 'in-memory',
      registered: Object.values(AZURE_QUEUE_NAMES),
    });
  });

  it('onStartup falls back to its own context and stays a no-op without a provider', async () => {
    const context: any = { getService: jest.fn(() => undefined), log: jest.fn() };
    const service = new AzureSyncService({} as any, context);

    await expect(service.onStartup()).resolves.toBeUndefined();

    const registration = service.getQueueRegistration();
    expect(registration?.available).toBe(false);
    expect(registration?.registered).toEqual([]);
    expect(registration?.skipped).toEqual(Object.values(AZURE_QUEUE_NAMES));
    expect(getRegisteredAzureQueues()).toEqual([]);
  });

  it('onStartup absorbs a container that throws from getService', async () => {
    // A container that is not ready yet must not abort ServiceManager.startServices.
    const context: any = {
      getService: () => { throw new Error('container not ready'); },
      log: jest.fn(),
    };
    const service = new AzureSyncService({} as any, context);

    await expect(service.onStartup(context)).resolves.toBeUndefined();

    expect(service.getQueueRegistration()?.available).toBe(false);
    expect(service.getQueueRegistration()?.reason).toContain('QueueProvider@1.0.0 is not available');
  });
});

describe('Azure queues — processors (QA-04)', () => {
  const SYNC = 'azure.AzureSyncService@1.0.0';
  const SUBSCRIPTIONS = 'azure.AzureSubscriptionService@1.0.0';

  function processorContext(services: Record<string, any>): any {
    return { getService: jest.fn((id: string) => services[id]), log: jest.fn() };
  }

  it('webhook-process resolves the owner via findByGraphId and dedupes {userId,resource}', async () => {
    const sync = { sync: jest.fn().mockResolvedValue({}) };
    const subscriptions = {
      findByGraphId: jest.fn(async (id: string) => ({
        userId: USER_ID,
        resource: id === 'sub-2' ? 'events' : 'messages',
      })),
    };
    const context = processorContext({ [SYNC]: sync, [SUBSCRIPTIONS]: subscriptions });

    const handled = await dispatchAzureQueueMessage(
      context,
      AZURE_QUEUE_NAMES.webhookProcess,
      {
        notifications: [
          { subscriptionId: 'sub-1', resource: '/me/messages' },
          // Two more notifications for the same pair: one delta pass, not three.
          { subscriptionId: 'sub-1', resource: '/me/messages' },
          { subscriptionId: 'sub-2', resource: '/me/events' },
        ],
      },
    );

    expect(handled).toBe(true);
    expect(subscriptions.findByGraphId).toHaveBeenCalledTimes(3);
    expect(sync.sync).toHaveBeenCalledTimes(2);
    expect(sync.sync).toHaveBeenCalledWith(USER_ID, 'messages');
    expect(sync.sync).toHaveBeenCalledWith(USER_ID, 'events');
  });

  it('webhook-process fans out through enqueueSync when the service offers it', async () => {
    const enqueueSync = jest.fn().mockResolvedValue({ queued: true });
    const sync = { enqueueSync, sync: jest.fn().mockResolvedValue({}) };
    const subscriptions = {
      findByGraphId: jest.fn(async () => ({ userId: USER_ID, resource: 'messages' })),
    };
    const context = processorContext({ [SYNC]: sync, [SUBSCRIPTIONS]: subscriptions });

    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.webhookProcess, {
      notifications: [{ subscriptionId: 'sub-1', resource: '/me/messages' }],
    });

    // The webhook worker hands off to azure-mail-sync instead of running the loop.
    expect(enqueueSync).toHaveBeenCalledWith(USER_ID, 'messages');
    expect(sync.sync).not.toHaveBeenCalled();
  });

  it('webhook-process uses the job userId when the subscription cannot be resolved', async () => {
    const sync = { sync: jest.fn().mockResolvedValue({}) };
    const context = processorContext({ [SYNC]: sync });

    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.webhookProcess, {
      userId: USER_ID,
      notifications: [{ subscriptionId: 'gone', resource: '/me/drive/root' }],
    });

    expect(sync.sync).toHaveBeenCalledWith(USER_ID, 'drive');
  });

  it('webhook-process skips a notification it cannot attribute to a user or resource', async () => {
    const sync = { sync: jest.fn().mockResolvedValue({}) };
    const subscriptions = { findByGraphId: jest.fn(async () => null) };
    const context = processorContext({ [SYNC]: sync, [SUBSCRIPTIONS]: subscriptions });

    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.webhookProcess, {
      notifications: [{ subscriptionId: 'unknown', resource: '/me/messages' }],
    });

    // No owner => no delta pass, and no throw: one bad entry must not block a batch.
    expect(sync.sync).not.toHaveBeenCalled();
  });

  it('webhook-process survives a findByGraphId failure and an empty batch', async () => {
    const sync = { sync: jest.fn().mockResolvedValue({}) };
    const subscriptions = {
      findByGraphId: jest.fn(async () => { throw new Error('mongo down'); }),
    };
    const context = processorContext({ [SYNC]: sync, [SUBSCRIPTIONS]: subscriptions });

    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.webhookProcess, {
      notifications: [{ subscriptionId: 'sub-1', resource: '/me/messages' }],
    });
    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.webhookProcess, { notifications: [] });

    expect(sync.sync).not.toHaveBeenCalled();
  });

  it('webhook-process is a logged no-op when the sync service is missing', async () => {
    const context = processorContext({});

    await expect(
      dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.webhookProcess, {
        notifications: [{ subscriptionId: 'sub-1', resource: '/me/messages' }],
      }),
    ).resolves.toBe(true);
  });

  it('calendar-sync and drive-sync call syncEvents / syncDrive', async () => {
    const sync = {
      syncEvents: jest.fn().mockResolvedValue({}),
      syncDrive: jest.fn().mockResolvedValue({}),
    };
    const context = processorContext({ [SYNC]: sync });

    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.calendarSync, { userId: USER_ID });
    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.driveSync, { userId: USER_ID });

    expect(sync.syncEvents).toHaveBeenCalledWith(USER_ID);
    expect(sync.syncDrive).toHaveBeenCalledWith(USER_ID);
  });

  it('mail-sync ignores a job with no userId', async () => {
    const sync = { syncMessages: jest.fn().mockResolvedValue({}) };
    const context = processorContext({ [SYNC]: sync });

    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.mailSync, {});

    expect(sync.syncMessages).not.toHaveBeenCalled();
  });

  it('calendar-sync and drive-sync ignore a job with no userId', async () => {
    const sync = {
      syncEvents: jest.fn().mockResolvedValue({}),
      syncDrive: jest.fn().mockResolvedValue({}),
    };
    const context = processorContext({ [SYNC]: sync });

    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.calendarSync, {});
    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.driveSync, {});

    expect(sync.syncEvents).not.toHaveBeenCalled();
    expect(sync.syncDrive).not.toHaveBeenCalled();
  });

  it('subscription-renew renews the whole active set, then one user, then forced', async () => {
    const subscriptions = { renewSubscriptions: jest.fn().mockResolvedValue([]) };
    const context = processorContext({ [SUBSCRIPTIONS]: subscriptions });

    // The scheduler tick: no userId, no force - the service selects due rows.
    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.subscriptionRenew, {});
    expect(subscriptions.renewSubscriptions).toHaveBeenLastCalledWith(undefined, { force: false });

    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.subscriptionRenew, {
      userId: USER_ID,
    });
    expect(subscriptions.renewSubscriptions).toHaveBeenLastCalledWith(USER_ID, { force: false });

    // A deliberate operator re-run bypasses the 80% schedule.
    await dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.subscriptionRenew, { force: true });
    expect(subscriptions.renewSubscriptions).toHaveBeenLastCalledWith(undefined, { force: true });
  });

  it('subscription-renew is a logged no-op without the subscription service', async () => {
    const context = processorContext({});

    await expect(
      dispatchAzureQueueMessage(context, AZURE_QUEUE_NAMES.subscriptionRenew, {}),
    ).resolves.toBe(true);
  });

  it('an unknown queue name is reported, not thrown', async () => {
    const context = processorContext({});

    await expect(dispatchAzureQueueMessage(context, 'azure-does-not-exist', {})).resolves.toBe(
      false,
    );
  });
});

describe('Azure queues — enqueue -> dispatch round trip', () => {
  it('drains the exact envelope the webhook route enqueued', async () => {
    const queued: any[] = [];
    const queueService: any = {
      createQueue: jest.fn().mockResolvedValue(true),
      enqueue: jest.fn(async (envelope: any) => {
        queued.push(envelope);
        return 'envelope-1';
      }),
    };
    const queueProvider: any = { getDefaultProvider: () => queueService };

    const sync = { sync: jest.fn().mockResolvedValue({}) };
    const subscriptionService = {
      verifyClientState: jest.fn(async () => ({ valid: true })),
      findByGraphId: jest.fn(async () => ({ userId: USER_ID, resource: 'messages' })),
    };
    const auditService = { logOperation: jest.fn().mockResolvedValue(undefined) };

    const services: Record<string, any> = {
      'reactory.QueueProvider@1.0.0': queueProvider,
      'azure.AzureSyncService@1.0.0': sync,
      'azure.AzureSubscriptionService@1.0.0': subscriptionService,
      'azure.AzureAuditService@1.0.0': auditService,
    };
    const context: any = { getService: jest.fn((id: string) => services[id]), log: jest.fn() };

    // 1. Graph posts a verified notification; the route enqueues work.
    const response = await request(buildApp(context))
      .post('/azure/webhooks/graph')
      .send({ value: [notification()] });

    expect(response.status).toBe(202);
    expect(queued).toHaveLength(1);

    const envelope = queued[0];

    // 2. Pin the producer contract a consumer must drain.
    expect(envelope.header.provider).toBe('reactory-azure');
    expect(envelope.header.version).toBe(AZURE_QUEUE_ENVELOPE_VERSION);
    expect(typeof envelope.header.id).toBe('string');
    expect(typeof envelope.header.receivedTimestamp).toBe('number');
    expect(envelope.body.queueId).toBe(AZURE_QUEUE_NAMES.webhookProcess);
    expect(envelope.body.notifications).toHaveLength(1);
    expect(envelope.body.notifications[0].subscriptionId).toBe('sub-1');

    // 3. The worker drains that same message and the delta pass runs.
    const handled = await dispatchAzureQueueMessage(
      context,
      AZURE_QUEUE_NAMES.webhookProcess,
      envelope,
    );

    expect(handled).toBe(true);
    expect(sync.sync).toHaveBeenCalledWith(USER_ID, 'messages');
    // The transport-only queueId is not leaked into the job.
    expect(subscriptionService.findByGraphId).toHaveBeenCalledWith('sub-1');
  });
});

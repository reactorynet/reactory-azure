import crypto from 'crypto';
import logger from '@reactory/server-core/logging';
import type { IAzureQueueJob } from './types';

/**
 * `reactory.QueueProvider@1.0.0` access, made optional on purpose.
 *
 * `resolveQueueProvider` and `resolveQueueService` never throw: a module that is
 * loaded before (or without) the queue module must not fail at import time or on
 * its first request. Every degradation is a single `logger.warn`, and the caller
 * gets `undefined` / `{ queued: false }`.
 */

/**
 * Version of the `{ header, body }` envelope this module writes and drains.
 *
 * Bump it only if the shape a consumer must read changes; `toAzureQueueJob`
 * unwraps both a raw job and an envelope, so an older producer keeps working.
 */
export const AZURE_QUEUE_ENVELOPE_VERSION = 1;

/** The envelope `enqueueAzureJob` hands to the backend. */
export interface IAzureQueueEnvelope {
  header: {
    /** Unique envelope id (deterministic per enqueue). */
    id: string;
    /** Producer timestamp, epoch ms. */
    receivedTimestamp: number;
    /** Always `reactory-azure` for this module. */
    provider: string;
    /** {@link AZURE_QUEUE_ENVELOPE_VERSION}. */
    version: number;
  };
  /** `queueId` names the destination; every other key is the job payload. */
  body: { queueId: string } & Record<string, unknown>;
}

/** The provider service, or `undefined` when the queue module is not present. */
export function resolveQueueProvider(context: any): any | undefined {
  try {
    return context?.getService?.('reactory.QueueProvider@1.0.0') || undefined;
  } catch {
    return undefined;
  }
}

/** The provider's default backend, or `undefined`. */
export function resolveQueueService(context: any, providerKey?: string): any | undefined {
  const provider = resolveQueueProvider(context);
  if (!provider) return undefined;

  try {
    if (providerKey && typeof provider.getProvider === 'function') {
      return provider.getProvider(providerKey) || undefined;
    }
    if (typeof provider.getDefaultProvider === 'function') {
      return provider.getDefaultProvider() || undefined;
    }
    if (typeof provider.getProvider === 'function') {
      return provider.getProvider() || undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/** Ask the backend key without throwing (used in registration reporting). */
export function describeQueueProvider(context: any): string | undefined {
  const provider = resolveQueueProvider(context);
  if (!provider) return undefined;

  for (const key of ['defaultProviderKey', 'defaultProvider']) {
    if (typeof provider[key] === 'string' && provider[key]) return provider[key];
  }

  if (typeof provider.getAvailableProviders === 'function') {
    try {
      const providers = provider.getAvailableProviders();
      if (Array.isArray(providers) && providers.length === 1) return String(providers[0]);
    } catch {
      /* not fatal */
    }
  }

  return undefined;
}

/**
 * Build the envelope for one job.
 *
 * THIS IS THE PRODUCER/CONSUMER CONTRACT: `enqueueAzureJob` sends exactly this
 * shape, and `dispatchAzureQueueMessage` accepts either it or a bare job. A
 * consumer that drains a queue must pass the drained message straight to
 * `dispatchAzureQueueMessage` - unwrapping it by hand is what
 * {@link toAzureQueueJob} is for.
 */
export function buildAzureQueueEnvelope(
  queueName: string,
  job: Record<string, unknown> = {},
): IAzureQueueEnvelope {
  return {
    header: {
      id: crypto.randomBytes(16).toString('hex'),
      receivedTimestamp: Date.now(),
      provider: 'reactory-azure',
      version: AZURE_QUEUE_ENVELOPE_VERSION,
    },
    body: { queueId: queueName, ...(job || {}) },
  };
}

/**
 * Accept either an envelope (what the queue carries) or a bare job.
 *
 * `queueId` is transport metadata, not part of the job, so it is dropped.
 */
export function toAzureQueueJob(envelopeOrJob: any): IAzureQueueJob {
  const value = envelopeOrJob;

  if (value && typeof value === 'object' && value.body && typeof value.body === 'object') {
    const { queueId, ...job } = value.body as Record<string, unknown> & { queueId?: string };
    return job as IAzureQueueJob;
  }

  return (value && typeof value === 'object' ? value : {}) as IAzureQueueJob;
}

/** Create the queue when the backend needs it; never fatal. */
export async function ensureQueue(service: any, queueName: string): Promise<void> {
  if (!service || typeof service.createQueue !== 'function') return;

  try {
    await service.createQueue(queueName);
  } catch (error: any) {
    // In-memory throws when the queue already exists; BullMQ has no create step.
    logger.debug(`Azure queues: ensureQueue(${queueName}) skipped: ${error?.message}`);
  }
}

/**
 * Enqueue one job.
 *
 * Returns `{ queued: false, reason }` instead of throwing when the provider is
 * unavailable or the backend rejects the enqueue. A webhook must still answer
 * Graph with 202 in that case, and a scheduler tick must not crash the process.
 */
export async function enqueueAzureJob(
  context: any,
  queueName: string,
  job: Record<string, unknown>,
  options: { providerKey?: string } = {},
): Promise<{ queued: boolean; reason?: string }> {
  const service = resolveQueueService(context, options?.providerKey);

  if (!service) {
    logger.warn(
      `Azure queues: reactory.QueueProvider@1.0.0 is unavailable; dropping "${queueName}" job (degraded no-op)`,
    );
    return { queued: false, reason: 'queue-provider-unavailable' };
  }

  const envelope = buildAzureQueueEnvelope(queueName, job);

  try {
    await ensureQueue(service, queueName);

    if (typeof service.enqueue === 'function') {
      await service.enqueue(envelope, { queueId: queueName, createIfNotExists: true });
      return { queued: true };
    }

    // Older provider flavour used by some modules; kept so a mixed deployment
    // still accepts the job.
    if (typeof service.addJob === 'function') {
      await service.addJob(queueName, { type: queueName, data: job });
      return { queued: true };
    }
  } catch (error: any) {
    logger.warn(`Azure queues: enqueue to "${queueName}" failed: ${error?.message}`);
    return { queued: false, reason: 'enqueue-failed' };
  }

  logger.warn(`Azure queues: provider has no enqueue method; dropping "${queueName}" job`);
  return { queued: false, reason: 'enqueue-unsupported' };
}

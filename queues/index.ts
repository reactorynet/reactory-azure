import logger from '@reactory/server-core/logging';
import {
  AZURE_QUEUE_ENVELOPE_VERSION,
  describeQueueProvider,
  enqueueAzureJob,
  ensureQueue,
  resolveQueueProvider,
  resolveQueueService,
  toAzureQueueJob,
} from './provider';
import type { IAzureQueueEnvelope } from './provider';
import { processMailSync } from './mail-sync';
import { processCalendarSync } from './calendar-sync';
import { processDriveSync } from './drive-sync';
import { processWebhookNotifications } from './webhook-process';
import { processSubscriptionRenew } from './subscription-renew';
import { AZURE_QUEUE_NAMES } from './types';
import type {
  AzureQueueProcessor,
  IAzureQueueDefinition,
  IAzureQueueJob,
  IAzureQueueRegistration,
} from './types';

/**
 * The five queues this module owns.
 *
 * Exporting an array keeps the module barrel (`queues: Queues` in index.ts)
 * shape-compatible with every other Reactory module, while the processor
 * registry below is what actually runs a job.
 */
export const AZURE_QUEUE_DEFINITIONS: IAzureQueueDefinition[] = [
  {
    name: AZURE_QUEUE_NAMES.mailSync,
    description: 'Delta-sync one user mailbox from the Microsoft Graph messages delta',
    processor: processMailSync,
  },
  {
    name: AZURE_QUEUE_NAMES.calendarSync,
    description: 'Delta-sync one user calendar from the Microsoft Graph events delta',
    processor: processCalendarSync,
  },
  {
    name: AZURE_QUEUE_NAMES.driveSync,
    description: 'Delta-sync one user default drive from the Microsoft Graph drive delta',
    processor: processDriveSync,
  },
  {
    name: AZURE_QUEUE_NAMES.webhookProcess,
    description: 'Turn verified Graph change notifications into delta passes',
    processor: processWebhookNotifications,
  },
  {
    name: AZURE_QUEUE_NAMES.subscriptionRenew,
    description: 'Renew Graph subscriptions at 80% of the granted lifetime',
    processor: processSubscriptionRenew,
  },
];

/** Processors available in this process, keyed by queue name. */
const processorRegistry = new Map<string, AzureQueueProcessor>();

/** The processor registered for a queue, or the module's definition. */
export function getAzureQueueProcessor(queueName: string): AzureQueueProcessor | undefined {
  if (processorRegistry.has(queueName)) return processorRegistry.get(queueName);
  return AZURE_QUEUE_DEFINITIONS.find((definition) => definition.name === queueName)?.processor;
}

/** Snapshot of the registered queue names (tests / health checks). */
export function getRegisteredAzureQueues(): string[] {
  return Array.from(processorRegistry.keys());
}

/** Drop every registration (tests). */
export function clearAzureQueueProcessors(): void {
  processorRegistry.clear();
}

/**
 * Register the module's processors with `reactory.QueueProvider@1.0.0`.
 *
 * Registration happens only when the provider (and one of its backends) is
 * present. Absence is a logged no-op returning `{ available: false }`: the
 * module loads and serves reads without a queue backend, which is the contract
 * this ticket requires. This function never throws.
 */
export async function registerAzureQueueProcessors(
  context: any,
  options: { providerKey?: string } = {},
): Promise<IAzureQueueRegistration> {
  const provider = resolveQueueProvider(context);

  if (!provider) {
    const reason = 'reactory.QueueProvider@1.0.0 is not available';
    logger.warn(
      `Azure queues: ${reason}; ${AZURE_QUEUE_DEFINITIONS.length} processors not registered (degraded no-op)`,
    );
    return {
      available: false,
      registered: [],
      skipped: AZURE_QUEUE_DEFINITIONS.map((definition) => definition.name),
      reason,
    };
  }

  const service = resolveQueueService(context, options?.providerKey);

  if (!service) {
    const reason = 'the queue provider has no available backend';
    logger.warn(
      `Azure queues: ${reason}; ${AZURE_QUEUE_DEFINITIONS.length} processors not registered (degraded no-op)`,
    );
    return {
      available: false,
      registered: [],
      skipped: AZURE_QUEUE_DEFINITIONS.map((definition) => definition.name),
      reason,
    };
  }

  const registered: string[] = [];

  for (const definition of AZURE_QUEUE_DEFINITIONS) {
    processorRegistry.set(definition.name, definition.processor);
    await ensureQueue(service, definition.name);
    registered.push(definition.name);
  }

  const providerKey = options?.providerKey || describeQueueProvider(context);
  logger.info(`Azure queues: registered ${registered.length} processors (${providerKey || 'provider'})`);

  return {
    available: true,
    providerKey,
    registered,
    skipped: [],
  };
}

/**
 * Run one drained message through its processor.
 *
 * THE CONSUMER CONTRACT: a worker that drains one of these queues passes the
 * message it received straight to this function. The message may be the
 * `{ header, body }` envelope `enqueueAzureJob` produced
 * ({@link IAzureQueueEnvelope}, `AZURE_QUEUE_ENVELOPE_VERSION`) or a bare job -
 * `toAzureQueueJob` unwraps either, dropping the transport-only `queueId`.
 *
 * Unknown queues are logged and return `false`; a processor's own degradation
 * (e.g. a missing service) is logged inside the processor and still counts as
 * handled.
 */
export async function dispatchAzureQueueMessage(
  context: any,
  queueName: string,
  envelopeOrJob: IAzureQueueEnvelope | IAzureQueueJob,
): Promise<boolean> {
  const processor = getAzureQueueProcessor(queueName);

  if (!processor) {
    logger.warn(`Azure queues: no processor for "${queueName}"; message skipped`);
    return false;
  }

  await processor(context, toAzureQueueJob(envelopeOrJob));
  return true;
}

export { enqueueAzureJob, toAzureQueueJob, AZURE_QUEUE_ENVELOPE_VERSION };
export { AZURE_QUEUE_NAMES };
export type { IAzureQueueDefinition, IAzureQueueJob, IAzureQueueRegistration };
export type { IAzureQueueEnvelope } from './provider';

/**
 * The barrel the module wiring reads (`queues: Queues`).
 *
 * Names and descriptions only - a definition's `processor` is deliberately not
 * part of the public module surface; execution goes through
 * `dispatchAzureQueueMessage`.
 */
const queues: Array<{ name: string; description: string }> = AZURE_QUEUE_DEFINITIONS.map(
  (definition) => ({ name: definition.name, description: definition.description }),
);

export default queues;

/**
 * Shared queue contract for the Azure module (AZ-12).
 *
 * Every queue is addressed by name through `reactory.QueueProvider@1.0.0`. The
 * provider is optional: a deployment that runs without it must still load this
 * module and serve Graph reads, so nothing here resolves a service at import
 * time (that would crash the module on load) and nothing throws when the
 * provider is absent - the caller gets a logged no-op instead.
 */

/** The five queues this module owns. */
export const AZURE_QUEUE_NAMES = {
  mailSync: 'azure-mail-sync',
  calendarSync: 'azure-calendar-sync',
  driveSync: 'azure-drive-sync',
  webhookProcess: 'azure-webhook-process',
  subscriptionRenew: 'azure-subscription-renew',
} as const;

export type AzureQueueName = typeof AZURE_QUEUE_NAMES[keyof typeof AZURE_QUEUE_NAMES];

/** Shape of the work item a processor receives. */
export interface IAzureQueueJob {
  /** Whose Microsoft account the job operates on. */
  userId?: string;
  /** Webhook notifications (`azure-webhook-process`). */
  notifications?: any[];
  /** Free-form extra fields supplied by the producer. */
  [key: string]: unknown;
}

/** A processor runs one job; it must not throw for a degraded dependency. */
export type AzureQueueProcessor = (
  context: any,
  job: IAzureQueueJob,
) => Promise<void>;

/** One queue's definition (also the shape the module barrel publishes). */
export interface IAzureQueueDefinition {
  name: AzureQueueName;
  description: string;
  processor: AzureQueueProcessor;
}

/** Outcome of {@link registerAzureQueueProcessors}. */
export interface IAzureQueueRegistration {
  /** False when the provider (or its default backend) is unavailable. */
  available: boolean;
  /** Provider backend key when known (`in-memory`, `bullmq`, `aws-sqs`). */
  providerKey?: string;
  /** Queue names whose processors were registered. */
  registered: string[];
  /** Queue names skipped because the provider was unavailable. */
  skipped: string[];
  reason?: string;
}

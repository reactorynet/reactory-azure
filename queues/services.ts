import logger from '@reactory/server-core/logging';

/**
 * Lazy service lookup for queue processors.
 *
 * Processors run outside a request, so there is no `req.context` - they receive
 * whatever context the queue worker was started with. A missing service is a
 * degraded no-op (warn + return), never a throw: a queue must not be poisoned by
 * a module that has not finished loading.
 */

/** Resolve a service, returning `undefined` instead of throwing. */
export function tryGetService(context: any, id: string): any | undefined {
  try {
    return context?.getService?.(id) || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the sync service or log why the job is being dropped. */
export function resolveSyncService(context: any, queueName: string): any | undefined {
  const service = tryGetService(context, 'azure.AzureSyncService@1.0.0');

  if (!service) {
    logger.warn(
      `Azure queues: azure.AzureSyncService@1.0.0 is unavailable; "${queueName}" job skipped (degraded no-op)`,
    );
    return undefined;
  }

  return service;
}

/** Coerce a job field to a non-empty string, or `''`. */
export function jobString(job: any, key: string): string {
  const value = job?.[key];
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Map a Graph notification resource (`/me/messages`, `/users/{id}/events`, ...)
 * or a logical key onto the sync service's logical resource.
 */
export function resourceFromNotificationValue(resource: string): 'messages' | 'events' | 'drive' | undefined {
  const value = String(resource ?? '').toLowerCase();

  if (!value) return undefined;
  if (value === 'messages' || value === 'events' || value === 'drive') return value as any;
  if (/(^|\/)messages(\/|$)/.test(value)) return 'messages';
  if (/(^|\/)events(\/|$)/.test(value)) return 'events';
  if (/(^|\/)drive(\/|$)/.test(value)) return 'drive';

  return undefined;
}

import logger from '@reactory/server-core/logging';
import { resourceFromNotificationValue, resolveSyncService, tryGetService } from './services';
import type { IAzureQueueJob } from './types';

/**
 * `azure-webhook-process`: turn Graph change notifications into delta passes.
 *
 * A notification names a subscription, not a user, so the subscription row is
 * used to find the owner. Several notifications for the same
 * `{ userId, resource }` collapse into a single sync: ten new messages are ten
 * notifications but one delta query.
 *
 * The webhook route has already verified each `clientState`; this processor is
 * deliberately tolerant - an unresolvable notification is logged and skipped so
 * one bad entry cannot block the rest of the batch.
 */
export async function processWebhookNotifications(
  context: any,
  job: IAzureQueueJob,
): Promise<void> {
  const notifications = Array.isArray(job?.notifications) ? job.notifications : [];
  if (notifications.length === 0) return;

  const syncService = resolveSyncService(context, 'azure-webhook-process');
  if (!syncService || typeof syncService.sync !== 'function') return;

  const subscriptionService = tryGetService(context, 'azure.AzureSubscriptionService@1.0.0');
  const work = new Map<string, { userId: string; resource: 'messages' | 'events' | 'drive' }>();

  for (const notification of notifications) {
    const subscriptionId = String(notification?.subscriptionId ?? '');

    let record: any = null;
    if (subscriptionId && subscriptionService && typeof subscriptionService.findByGraphId === 'function') {
      try {
        record = await subscriptionService.findByGraphId(subscriptionId);
      } catch (error: any) {
        logger.warn(
          `Azure queues: could not resolve subscription ${subscriptionId}: ${error?.message}`,
        );
      }
    }

    const userId = String(job?.userId ?? record?.userId ?? '');
    const resource = resourceFromNotificationValue(
      String(notification?.resource ?? record?.resource ?? ''),
    );

    if (!userId || !resource) {
      logger.warn(
        `Azure queues: azure-webhook-process skipped a notification (subscription=${subscriptionId || 'unknown'}, `
        + `user=${userId || 'unknown'}, resource=${resource || 'unknown'})`,
      );
      continue;
    }

    work.set(`${userId}:${resource}`, { userId, resource });
  }

  for (const { userId, resource } of work.values()) {
    // Fan out to the per-resource queue when the service offers it, so the
    // webhook worker hands off instead of holding the delta loop. Without a queue
    // provider `enqueueSync` runs the pass inline, which is the same behaviour as
    // calling `sync` directly - hence the fallback for a service that predates it.
    if (typeof syncService.enqueueSync === 'function') {
      await syncService.enqueueSync(userId, resource);
    } else {
      await syncService.sync(userId, resource);
    }
  }
}

export default processWebhookNotifications;

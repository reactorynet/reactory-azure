import logger from '@reactory/server-core/logging';
import { jobString, tryGetService } from './services';
import type { IAzureQueueJob } from './types';

/**
 * `azure-subscription-renew`: renew subscriptions before Graph expires them.
 *
 * With `job.userId` set the sweep is scoped to that user; without it every active
 * subscription is considered (the scheduler path). The service selects the rows
 * that are DUE (`nextRenewAt <= now`), so a tick that runs more often than the
 * granted lifetime does not re-extend everything: 80% of the granted lifetime is
 * the trigger. `job.force === true` is an operator re-run that bypasses the
 * schedule; it is never the scheduler's default.
 */
export async function processSubscriptionRenew(
  context: any,
  job: IAzureQueueJob,
): Promise<void> {
  const subscriptionService = tryGetService(context, 'azure.AzureSubscriptionService@1.0.0');

  if (!subscriptionService || typeof subscriptionService.renewSubscriptions !== 'function') {
    logger.warn(
      'Azure queues: azure.AzureSubscriptionService@1.0.0 is unavailable; '
      + '"azure-subscription-renew" job skipped (degraded no-op)',
    );
    return;
  }

  const userId = jobString(job, 'userId');
  await subscriptionService.renewSubscriptions(userId || undefined, {
    force: job?.force === true,
  });
}

export default processSubscriptionRenew;

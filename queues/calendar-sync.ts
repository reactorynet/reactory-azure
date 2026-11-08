import { jobString, resolveSyncService } from './services';
import type { IAzureQueueJob } from './types';

/** `azure-calendar-sync`: run one calendar delta pass for `job.userId`. */
export async function processCalendarSync(context: any, job: IAzureQueueJob): Promise<void> {
  const userId = jobString(job, 'userId');
  if (!userId) return;

  const syncService = resolveSyncService(context, 'azure-calendar-sync');
  if (!syncService || typeof syncService.syncEvents !== 'function') return;

  await syncService.syncEvents(userId);
}

export default processCalendarSync;

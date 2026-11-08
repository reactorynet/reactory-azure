import { jobString, resolveSyncService } from './services';
import type { IAzureQueueJob } from './types';

/** `azure-mail-sync`: run one mailbox delta pass for `job.userId`. */
export async function processMailSync(context: any, job: IAzureQueueJob): Promise<void> {
  const userId = jobString(job, 'userId');
  if (!userId) return;

  const syncService = resolveSyncService(context, 'azure-mail-sync');
  if (!syncService || typeof syncService.syncMessages !== 'function') return;

  await syncService.syncMessages(userId);
}

export default processMailSync;

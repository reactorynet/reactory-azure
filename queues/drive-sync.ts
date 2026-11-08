import { jobString, resolveSyncService } from './services';
import type { IAzureQueueJob } from './types';

/** `azure-drive-sync`: run one drive delta pass for `job.userId`. */
export async function processDriveSync(context: any, job: IAzureQueueJob): Promise<void> {
  const userId = jobString(job, 'userId');
  if (!userId) return;

  const syncService = resolveSyncService(context, 'azure-drive-sync');
  if (!syncService || typeof syncService.syncDrive !== 'function') return;

  await syncService.syncDrive(userId);
}

export default processDriveSync;

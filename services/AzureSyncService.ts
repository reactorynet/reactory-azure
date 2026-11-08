import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import { AzureSyncState } from '../models/AzureSyncState';
import type { AzureSyncResource, IAzureSyncState } from '../models/AzureSyncState';
import {
  GraphErrorCode,
  apiError,
  extractGraphCode,
  extractStatusCode,
} from '../utils/graph-error';
import { AZURE_QUEUE_NAMES, enqueueAzureJob, registerAzureQueueProcessors } from '../queues';
import type { IAzureQueueRegistration } from '../queues';

/**
 * Microsoft Graph delta synchronisation (AZ-12).
 *
 * Three collections - messages, events and the default drive - are read through
 * their `/delta` endpoints. The loop:
 *
 *   1. starts at the persisted `@odata.deltaLink` when there is one, otherwise at
 *      the collection's `/delta` path (an initial sync);
 *   2. follows `@odata.nextLink` until a page carries `@odata.deltaLink`;
 *   3. emits an `{ added, updated, deleted }` batch per page (and hands it to an
 *      optional `onBatch` consumer) so a caller can persist as it goes;
 *   4. persists the final deltaLink, which is what makes the next read cheap.
 *
 * ## 410 Gone
 *
 * A delta token is not permanent: Graph answers `410 Gone` with
 * `code: resyncRequired` (or `SyncStateNotFound`) when the token has expired or
 * the mailbox/drive was rebuilt. That is an expected state transition, not an
 * error: the service records the resync on the state row, clears the token, and
 * re-runs the loop **once** from the base path. The 410 is never propagated (a
 * second failure during the rebuild *is* propagated, because retrying forever
 * would hide a real problem).
 *
 * ## add vs. update
 *
 * Microsoft Graph's delta payload does not distinguish "created" from "updated":
 * both arrive as a plain item, and only deletions are marked (`@removed`). This
 * service therefore classifies:
 *
 *   - `@removed` present, or an explicit `changeType: 'deleted'` → **deleted**;
 *   - an explicit `changeType` (`created` / `updated`) when a caller or a
 *     notification supplies one → that bucket;
 *   - every other item → **added** on an initial or full-resync pass (nothing is
 *     known locally yet) and **updated** on an incremental pass.
 *
 * The union of the three buckets is the complete change set either way; only the
 * label of a brand-new item on an incremental pass can be conservative.
 *
 * Every request carries `Prefer: IdType="ImmutableId"` so message ids survive a
 * mailbox move and a persisted deltaLink stays usable.
 */

/** `GET .../delta` entry point per logical resource. */
export const DELTA_PATHS: Record<AzureSyncResource, string> = {
  messages: '/me/messages/delta',
  events: '/me/events/delta',
  drive: '/me/drive/root/delta',
};

/** Immutable ids: a moved message keeps its id, so a deltaLink stays valid. */
export const IMMUTABLE_ID_PREFER_HEADER = 'IdType="ImmutableId"';

/** Hard page bound for one delta pass; exceeding it throws rather than truncating. */
export const SYNC_MAX_PAGES = 50;

/** Resources this service understands, in a stable order. */
export const AZURE_SYNC_RESOURCES: AzureSyncResource[] = ['messages', 'events', 'drive'];

/** One page's worth of classified changes. */
export interface IAzureSyncBatch<T = any> {
  /** 1-based page number within this pass. */
  page: number;
  added: T[];
  updated: T[];
  deleted: T[];
  /** `@odata.deltaLink` when this was the final page. */
  deltaLink?: string;
}

/** The result of one delta pass. */
export interface IAzureSyncResult<T = any> {
  userId: string;
  resource: AzureSyncResource;
  /** Number of Graph pages read. */
  pages: number;
  /** One entry per page, in order. */
  batches: IAzureSyncBatch<T>[];
  /** Union of every page's `added` bucket. */
  added: T[];
  /** Union of every page's `updated` bucket. */
  updated: T[];
  /** Union of every page's `deleted` bucket. */
  deleted: T[];
  /** Persisted `@odata.deltaLink` for the next read. */
  deltaLink?: string;
  /** True when a 410 forced this pass to be a full resync. */
  fullResync: boolean;
  /** `synced` for a normal pass, `resync` when the pass rebuilt state. */
  status: 'synced' | 'resync';
  /** Id of the last item processed, stored as `cursor`. */
  cursor?: string;
}

/** Optional knobs for {@link AzureSyncService.syncResource}. */
export interface IAzureSyncOptions {
  /** Page bound; defaults to {@link SYNC_MAX_PAGES}. */
  maxPages?: number;
  /** Extra headers merged under the immutable-id `Prefer` header. */
  headers?: Record<string, string>;
  /** Called once per page, before the next page is requested. */
  onBatch?: (batch: IAzureSyncBatch) => void | Promise<void>;
}

/**
 * The queue that owns each resource's delta pass.
 *
 * One source of truth: the queue names live in `queues/types`, so a rename cannot
 * silently orphan a producer.
 */
export const SYNC_QUEUE_BY_RESOURCE: Record<AzureSyncResource, string> = {
  messages: AZURE_QUEUE_NAMES.mailSync,
  events: AZURE_QUEUE_NAMES.calendarSync,
  drive: AZURE_QUEUE_NAMES.driveSync,
};

/** The slice of the Graph provider this service depends on. */
interface ISyncGraphProvider {
  request<T>(userId: string, path: string, options?: any): Promise<T>;
}

/** Graph's delta payload has no typed `@removed` in the SDK; it is a presence check. */
interface IGraphDeltaPage<T = any> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/**
 * True when Graph rejected the delta token.
 *
 * Status 410 is the documented signal; the codes are checked as well because a
 * caller may have already translated the error and dropped the status.
 */
export function isDeltaTokenExpired(error: any): boolean {
  if (!error) return false;

  if (extractStatusCode(error) === 410) return true;

  const code = extractGraphCode(error) || error?.code || error?.meta?.code;
  return [
    'resyncRequired',
    'SyncStateNotFound',
    'InvalidDeltaToken',
    'DeltaTokenExpired',
  ].includes(String(code));
}

/** Classify one page of a delta payload into added / updated / deleted. */
export function classifyDeltaItems<T = any>(
  items: T[],
  mode: { initial: boolean; fullResync: boolean },
): { added: T[]; updated: T[]; deleted: T[] } {
  const added: T[] = [];
  const updated: T[] = [];
  const deleted: T[] = [];

  for (const item of Array.isArray(items) ? items : []) {
    const hinted = typeof (item as any)?.changeType === 'string'
      ? String((item as any).changeType).toLowerCase()
      : '';

    if ((item as any)?.['@removed'] !== undefined && (item as any)?.['@removed'] !== null) {
      deleted.push(item);
    } else if (hinted === 'deleted') {
      deleted.push(item);
    } else if (hinted === 'created' || hinted === 'added') {
      added.push(item);
    } else if (hinted === 'updated') {
      updated.push(item);
    } else if (mode.initial || mode.fullResync) {
      added.push(item);
    } else {
      updated.push(item);
    }
  }

  return { added, updated, deleted };
}

@service({
  id: 'azure.AzureSyncService@1.0.0',
  name: 'AzureSyncService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph delta synchronisation with persisted deltaLink and 410 full resync',
  serviceType: 'integration',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'azure.AzureAuditService@1.0.0', alias: 'auditService' },
  ],
})
class AzureSyncService implements Reactory.Service.IReactoryService {
  name: string = 'AzureSyncService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphClientProvider: ISyncGraphProvider;
  private _auditService: any;
  /** What the last `onStartup` managed to register (observability / health). */
  private _queueRegistration?: IAzureQueueRegistration;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `graphClientProvider` alias. */
  setGraphClientProvider(serviceInstance: any): void {
    this._graphClientProvider = serviceInstance;
  }

  /** Bound by the Reactory service container from the `auditService` alias. */
  setAuditService(serviceInstance: any): void {
    this._auditService = serviceInstance;
  }

  private get graphClientProvider(): ISyncGraphProvider {
    if (this._graphClientProvider) return this._graphClientProvider;

    try {
      return this.context?.getService?.('azure.AzureGraphClientProvider@1.0.0') as any;
    } catch {
      return undefined;
    }
  }

  private get auditService(): any {
    if (this._auditService) return this._auditService;

    try {
      return this.context?.getService?.('azure.AzureAuditService@1.0.0');
    } catch {
      return undefined;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Lifecycle                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Register the module's queues and processors when the service starts.
   *
   * `ServiceManager.startServices` awaits this hook for every service, and a
   * throw here aborts the whole start-up pass - so it cannot throw. Absence of
   * `reactory.QueueProvider@1.0.0` (or of one of its backends) is the normal
   * degraded case: `registerAzureQueueProcessors` returns `available: false`, the
   * reason is logged, and the module keeps serving Graph reads with no queues.
   *
   * Without this hook the queues are defined but never created and the processors
   * never registered, so the webhook path's enqueue would be inert in a running
   * deployment while every unit test still passed.
   */
  async onStartup(context?: Reactory.Server.IReactoryContext): Promise<void> {
    const startupContext = (context || this.context) as any;

    try {
      const registration = await registerAzureQueueProcessors(startupContext);
      this._queueRegistration = registration;

      if (!registration.available) {
        logger.warn(
          `AzureSyncService: queues are degraded (${registration.reason || 'provider unavailable'}); `
          + 'delta sync stays available on demand, webhook work is not queued',
        );
      }
    } catch (error: any) {
      // Registration is best-effort: an unavailable queue module must never stop
      // the service (or the server) from starting.
      this._queueRegistration = {
        available: false,
        registered: [],
        skipped: [],
        reason: `registration failed: ${error?.message || 'unknown error'}`,
      };
      logger.warn(`AzureSyncService: queue registration failed: ${error?.message}`);
    }
  }

  /** What the last `onStartup` registered (`available: false` when degraded). */
  getQueueRegistration(): IAzureQueueRegistration | undefined {
    return this._queueRegistration;
  }

  /* ------------------------------------------------------------------------ */
  /* Public contract                                                          */
  /* ------------------------------------------------------------------------ */

  /** Delta-sync the user's mailbox. */
  async syncMessages(userId: string, options: IAzureSyncOptions = {}): Promise<IAzureSyncResult> {
    return this.syncResource(userId, 'messages', options);
  }

  /** Delta-sync the user's calendar. */
  async syncEvents(userId: string, options: IAzureSyncOptions = {}): Promise<IAzureSyncResult> {
    return this.syncResource(userId, 'events', options);
  }

  /** Delta-sync the user's default drive. */
  async syncDrive(userId: string, options: IAzureSyncOptions = {}): Promise<IAzureSyncResult> {
    return this.syncResource(userId, 'drive', options);
  }

  /** Dispatch by logical resource; the single implementation all three share. */
  async sync(
    userId: string,
    resource: AzureSyncResource,
    options: IAzureSyncOptions = {},
  ): Promise<IAzureSyncResult> {
    return this.syncResource(userId, resource, options);
  }

  /**
   * Ask for a delta pass through the queue for that resource.
   *
   * This is the producer the per-resource queues were missing: without it
   * `azure-mail-sync`, `azure-calendar-sync` and `azure-drive-sync` were
   * registered and processed but never fed. When no queue provider is available
   * the job is run inline instead of being dropped, so a caller always gets its
   * sync - the queue is an execution detail, not a requirement.
   *
   * `azure-webhook-process` uses this, which is what makes a notification fan out
   * to the per-resource queue (one delta pass per `{userId, resource}`) rather
   * than pinning the work to the webhook worker.
   */
  async enqueueSync(
    userId: string,
    resource: AzureSyncResource,
  ): Promise<{ queued: boolean; reason?: string }> {
    this.assertInput(userId, resource);

    const queueName = SYNC_QUEUE_BY_RESOURCE[resource];
    const result = await enqueueAzureJob(this.context, queueName, { userId });

    if (result.queued) return result;

    logger.debug(
      `AzureSyncService: ${queueName} unavailable (${result.reason}); syncing ${resource} inline`,
    );
    await this.syncResource(userId, resource);

    return result;
  }

  /** Read the persisted cursor without running a sync. */
  async getSyncState(userId: string, resource: AzureSyncResource): Promise<IAzureSyncState | null> {
    this.assertInput(userId, resource);
    return this.loadState(userId, resource);
  }

  /** Every cursor row for a user (observability / GraphQL). */
  async listSyncStates(userId: string): Promise<IAzureSyncState[]> {
    if (!userId) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required to read sync state', {
        operation: 'sync.listSyncStates',
      });
    }

    const model: any = AzureSyncState;
    if (typeof model.find !== 'function') return [];

    const rows = await model.find({ userId });
    return Array.isArray(rows) ? rows : [];
  }

  /* ------------------------------------------------------------------------ */
  /* Delta loop                                                               */
  /* ------------------------------------------------------------------------ */

  async syncResource(
    userId: string,
    resource: AzureSyncResource,
    options: IAzureSyncOptions = {},
  ): Promise<IAzureSyncResult> {
    this.assertInput(userId, resource);

    const startedAt = Date.now();
    const state = await this.loadState(userId, resource);
    const storedDeltaLink = state?.deltaLink || undefined;
    const initial = !storedDeltaLink;

    let outcome: {
      batches: IAzureSyncBatch[];
      added: any[];
      updated: any[];
      deleted: any[];
      pages: number;
      deltaLink?: string;
      cursor?: string;
    };
    let fullResync = false;

    try {
      outcome = await this.runDelta(
        userId,
        resource,
        storedDeltaLink || DELTA_PATHS[resource],
        options,
        { initial, fullResync: false },
      );
    } catch (error: any) {
      if (!isDeltaTokenExpired(error)) {
        await this.recordFailure(userId, resource, error);
        throw error;
      }

      // An expired delta token is a state transition, not a failure. Record it,
      // clear the cursor, and rebuild exactly once.
      fullResync = true;
      await this.recordResync(userId, resource, error);

      try {
        outcome = await this.runDelta(userId, resource, DELTA_PATHS[resource], options, {
          initial: true,
          fullResync: true,
        });
      } catch (rebuildError: any) {
        // The rebuild failed: record it, then surface the real error. The resync
        // itself is already recorded, so an operator can see it was attempted.
        await this.recordFailure(userId, resource, rebuildError);
        throw rebuildError;
      }
    }

    const completedAt = new Date();
    const status: 'synced' | 'resync' = fullResync ? 'resync' : 'synced';

    await this.persistState(userId, resource, {
      deltaLink: outcome.deltaLink ?? null,
      lastSyncedAt: completedAt,
      cursor: outcome.cursor ?? null,
      status,
      lastError: null,
      lastSyncWasFullResync: fullResync,
      ...(fullResync ? { lastFullResyncAt: completedAt } : {}),
    });

    await this.audit({
      userId,
      operation: `sync.${resource}.delta`,
      resource: DELTA_PATHS[resource],
      outcome: 'success',
      durationMs: Date.now() - startedAt,
      metadata: {
        pages: outcome.pages,
        added: outcome.added.length,
        updated: outcome.updated.length,
        deleted: outcome.deleted.length,
        fullResync,
      },
    });

    return {
      userId,
      resource,
      pages: outcome.pages,
      batches: outcome.batches,
      added: outcome.added,
      updated: outcome.updated,
      deleted: outcome.deleted,
      deltaLink: outcome.deltaLink,
      fullResync,
      status,
      cursor: outcome.cursor,
    };
  }

  /** Walk `startUrl` to exhaustion, following `@odata.nextLink`. */
  private async runDelta(
    userId: string,
    resource: AzureSyncResource,
    startUrl: string,
    options: IAzureSyncOptions,
    mode: { initial: boolean; fullResync: boolean },
  ): Promise<{
    batches: IAzureSyncBatch[];
    added: any[];
    updated: any[];
    deleted: any[];
    pages: number;
    deltaLink?: string;
    cursor?: string;
  }> {
    const provider = this.requireProvider();
    const maxPages = options.maxPages && options.maxPages > 0 ? options.maxPages : SYNC_MAX_PAGES;

    const batches: IAzureSyncBatch[] = [];
    const added: any[] = [];
    const updated: any[] = [];
    const deleted: any[] = [];

    let url: string | undefined = startUrl;
    let pages = 0;
    let deltaLink: string | undefined;
    let cursor: string | undefined;

    while (url) {
      if (pages >= maxPages) {
        throw apiError(
          GraphErrorCode.PAGINATION_LIMIT_EXCEEDED,
          `Microsoft Graph delta for ${resource} exceeded ${maxPages} page(s); refusing to return a partial sync`,
          { maxPages, pages, resource, operation: `sync.${resource}.delta` },
        );
      }

      const isFirstPage = pages === 0;
      const page = await provider.request<IGraphDeltaPage>(
        userId,
        url,
        {
          operation: `sync.${resource}.delta`,
          headers: {
            ...(options.headers || {}),
            // Immutable ids keep a persisted deltaLink usable across a mailbox move.
            Prefer: IMMUTABLE_ID_PREFER_HEADER,
          },
          // An absolute nextLink already carries its query string; passing it as
          // `url` stops the provider from appending one again.
          ...(isFirstPage ? {} : { url }),
        },
      );

      pages += 1;

      const items = Array.isArray(page?.value) ? page.value : [];
      const classified = classifyDeltaItems(items, mode);

      batches.push({
        page: pages,
        added: classified.added,
        updated: classified.updated,
        deleted: classified.deleted,
        deltaLink: page?.['@odata.deltaLink'],
      });

      added.push(...classified.added);
      updated.push(...classified.updated);
      deleted.push(...classified.deleted);

      if (items.length > 0) {
        const last = items[items.length - 1] as any;
        if (last && last.id !== undefined && last.id !== null) cursor = String(last.id);
      }

      if (page?.['@odata.deltaLink']) deltaLink = page['@odata.deltaLink'];

      url = page?.['@odata.nextLink'];

      if (typeof options.onBatch === 'function') {
        await options.onBatch(batches[batches.length - 1]);
      }
    }

    return { batches, added, updated, deleted, pages, deltaLink, cursor };
  }

  /* ------------------------------------------------------------------------ */
  /* State                                                                    */
  /* ------------------------------------------------------------------------ */

  private async loadState(
    userId: string,
    resource: AzureSyncResource,
  ): Promise<IAzureSyncState | null> {
    const model: any = AzureSyncState;
    if (typeof model.findOne !== 'function') return null;

    return model.findOne({ userId, resource });
  }

  private async persistState(
    userId: string,
    resource: AzureSyncResource,
    values: Record<string, unknown>,
  ): Promise<any> {
    const filter = { userId, resource };
    const model: any = AzureSyncState;

    if (typeof model.findOneAndUpdate === 'function') {
      return model.findOneAndUpdate(
        filter,
        { $set: values },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }

    const existing: any = await this.loadState(userId, resource);

    if (existing) {
      Object.assign(existing, values);
      if (typeof existing.save === 'function') await existing.save();
      return existing;
    }

    const created: any = new model({ ...filter, ...values });
    if (typeof created.save === 'function') await created.save();
    return created;
  }

  /** Record that a 410 forced a full rebuild - persisted before the rebuild runs. */
  private async recordResync(
    userId: string,
    resource: AzureSyncResource,
    error: any,
  ): Promise<void> {
    const state: any = await this.loadState(userId, resource);
    const fullResyncCount = Number(state?.fullResyncCount ?? 0) + 1;
    const at = new Date();

    await this.persistState(userId, resource, {
      deltaLink: null,
      status: 'resync',
      fullResyncCount,
      lastFullResyncAt: at,
      lastSyncWasFullResync: true,
      lastError: null,
    });

    logger.warn(
      `AzureSyncService: delta token for ${resource} expired (${extractGraphCode(error) || 'resyncRequired'}); `
      + `performing full resync #${fullResyncCount}`,
    );

    await this.audit({
      userId,
      operation: `sync.${resource}.fullResync`,
      resource: DELTA_PATHS[resource],
      outcome: 'success',
      graphCode: extractGraphCode(error) || 'resyncRequired',
      metadata: {
        reason: 'delta-token-expired',
        status: extractStatusCode(error) ?? 410,
        fullResyncCount,
      },
    });
  }

  /** Persist a failed pass without masking the Graph error. */
  private async recordFailure(
    userId: string,
    resource: AzureSyncResource,
    error: any,
  ): Promise<void> {
    try {
      await this.persistState(userId, resource, {
        status: 'error',
        lastError: String(error?.message || extractGraphCode(error) || 'sync failed').slice(0, 500),
      });
    } catch (persistError: any) {
      logger.warn(`AzureSyncService: could not record the ${resource} sync failure: ${persistError?.message}`);
    }

    await this.audit({
      userId,
      operation: `sync.${resource}.delta`,
      resource: DELTA_PATHS[resource],
      outcome: 'failure',
      graphCode: extractGraphCode(error),
      metadata: { message: error?.message },
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  private assertInput(userId: string, resource: AzureSyncResource): void {
    if (!userId) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required to sync', {
        operation: 'sync',
      });
    }

    if (!AZURE_SYNC_RESOURCES.includes(resource)) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Unsupported sync resource "${resource}"; expected one of ${AZURE_SYNC_RESOURCES.join(', ')}`,
        { operation: 'sync', resource },
      );
    }
  }

  private requireProvider(): ISyncGraphProvider {
    const provider = this.graphClientProvider;

    if (!provider || typeof provider.request !== 'function') {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Microsoft Graph client provider is not available',
        { operation: 'sync' },
      );
    }

    return provider;
  }

  /** Audit writes never fail the sync they describe. */
  private async audit(entry: {
    userId: string;
    operation: string;
    resource?: string;
    outcome: 'success' | 'failure';
    durationMs?: number;
    graphCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const auditService = this.auditService;
      if (auditService && typeof auditService.logOperation === 'function') {
        await auditService.logOperation(entry);
      }
    } catch (error: any) {
      logger.warn(`AzureSyncService: audit write failed for ${entry.operation}: ${error?.message}`);
    }
  }
}

export const AzureSyncServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureSyncService> = {
  service: (props: any, context: any) => new AzureSyncService(props, context),
  id: 'azure.AzureSyncService@1.0.0',
  name: 'AzureSyncService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph delta synchronisation with persisted deltaLink and 410 full resync',
  serviceType: 'integration',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'azure.AzureAuditService@1.0.0', alias: 'auditService' },
  ],
};

export { AzureSyncService };
export default AzureSyncService;

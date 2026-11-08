import Reactory from '@reactorynet/reactory-core';
import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation } from '@reactory/server-core/models/graphql/decorators/resolver';

/**
 * GraphQL surface for delta sync and change-notification subscriptions (AZ-12).
 *
 * Four fields, each a thin adapter:
 *
 *   - `azureSyncState(resource)`     -> AzureSyncService.getSyncState
 *   - `azureSync(resource)`          -> AzureSyncService.sync
 *   - `azureSubscriptions`           -> AzureSubscriptionService.listSubscriptions
 *   - `azureRenewSubscriptions`      -> AzureSubscriptionService.renewSubscriptions
 *
 * No `userId` argument is exposed: these services act with the caller's vaulted
 * Microsoft token, so accepting one would be an IDOR. Queue processors pass an
 * explicit user id to the services, bypassing GraphQL.
 *
 * The resolver deliberately maps ObjectIds to strings and batches to counts -
 * GraphQL's `String` serializer rejects a raw `ObjectId`.
 */

/** The authenticated caller's id (`_id` is the vault key; `id` is its virtual). */
function callerId(context: Reactory.Server.IReactoryContext): string {
  return String(context?.user?._id ?? (context?.user as any)?.id ?? '');
}

function syncService(context: Reactory.Server.IReactoryContext): any {
  const service = context.getService('azure.AzureSyncService@1.0.0');
  if (!service) throw new Error('Azure Sync Service not available');
  return service;
}

function subscriptionService(context: Reactory.Server.IReactoryContext): any {
  const service = context.getService('azure.AzureSubscriptionService@1.0.0');
  if (!service) throw new Error('Azure Subscription Service not available');
  return service;
}

function mapSyncState(state: any): any | null {
  if (!state) return null;

  return {
    userId: String(state.userId ?? ''),
    resource: String(state.resource ?? ''),
    deltaLink: state.deltaLink ?? null,
    lastSyncedAt: state.lastSyncedAt ?? null,
    cursor: state.cursor ?? null,
    status: String(state.status ?? 'idle'),
    lastError: state.lastError ?? null,
    fullResyncCount: Number(state.fullResyncCount ?? 0),
    lastFullResyncAt: state.lastFullResyncAt ?? null,
    lastSyncWasFullResync: state.lastSyncWasFullResync === true,
  };
}

function mapSyncResult(result: any): any {
  const batches = Array.isArray(result?.batches) ? result.batches : [];

  return {
    userId: String(result?.userId ?? ''),
    resource: String(result?.resource ?? ''),
    pages: Number(result?.pages ?? 0),
    added: Array.isArray(result?.added) ? result.added.length : 0,
    updated: Array.isArray(result?.updated) ? result.updated.length : 0,
    deleted: Array.isArray(result?.deleted) ? result.deleted.length : 0,
    deltaLink: result?.deltaLink ?? null,
    fullResync: result?.fullResync === true,
    status: String(result?.status ?? 'synced'),
    cursor: result?.cursor ?? null,
    batches: batches.map((batch: any) => ({
      page: Number(batch?.page ?? 0),
      added: Array.isArray(batch?.added) ? batch.added.length : 0,
      updated: Array.isArray(batch?.updated) ? batch.updated.length : 0,
      deleted: Array.isArray(batch?.deleted) ? batch.deleted.length : 0,
      deltaLink: batch?.deltaLink ?? null,
    })),
  };
}

function mapSubscription(subscription: any): any {
  return {
    userId: String(subscription?.userId ?? ''),
    subscriptionId: String(subscription?.subscriptionId ?? ''),
    resource: String(subscription?.resource ?? ''),
    graphResource: subscription?.graphResource ?? null,
    changeType: Array.isArray(subscription?.changeType) ? subscription.changeType : [],
    notificationUrl: String(subscription?.notificationUrl ?? ''),
    expirationDateTime: subscription?.expirationDateTime ?? null,
    renewedAt: subscription?.renewedAt ?? null,
    nextRenewAt: subscription?.nextRenewAt ?? null,
    active: subscription?.active !== false,
  };
}

function mapRenewal(renewal: any): any {
  return {
    userId: String(renewal?.userId ?? ''),
    subscriptionId: String(renewal?.subscriptionId ?? ''),
    expirationDateTime: renewal?.expirationDateTime ?? null,
    grantedLifetimeMs: Number(renewal?.grantedLifetimeMs ?? 0),
    renewalTime: renewal?.renewalTime ?? null,
    nextRenewAt: renewal?.nextRenewAt ?? renewal?.renewalTime ?? null,
  };
}

@resolver
class SyncResolver {
  resolver: any;

  /** Persisted delta cursor, or null when the resource has never been synced. */
  @roles(['USER'], 'args.context')
  @query('azureSyncState')
  async getSyncState(
    _obj: any,
    params: { resource: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    const state = await syncService(context).getSyncState(callerId(context), params?.resource);
    return mapSyncState(state);
  }

  /** Run one delta pass for the caller and report per-page change counts. */
  @roles(['USER'], 'args.context')
  @mutation('azureSync')
  async sync(
    _obj: any,
    params: { resource: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    const result = await syncService(context).sync(callerId(context), params?.resource);
    return mapSyncResult(result);
  }

  /** Every subscription stored for the caller. */
  @roles(['USER'], 'args.context')
  @query('azureSubscriptions')
  async subscriptions(
    _obj: any,
    _params: Record<string, unknown>,
    context: Reactory.Server.IReactoryContext,
  ) {
    const rows = await subscriptionService(context).listSubscriptions(callerId(context));
    return (Array.isArray(rows) ? rows : []).map(mapSubscription);
  }

  /**
   * Renew the caller's due subscriptions; `force: true` renews all of them.
   *
   * The scheduler path (`azure-subscription-renew`) omits `force` so 80% of the
   * granted lifetime decides; this argument exists for a deliberate manual
   * renewal, which is why it is forwarded rather than assumed.
   */
  @roles(['USER'], 'args.context')
  @mutation('azureRenewSubscriptions')
  async renewSubscriptions(
    _obj: any,
    params: { force?: boolean },
    context: Reactory.Server.IReactoryContext,
  ) {
    const renewals = await subscriptionService(context).renewSubscriptions(
      callerId(context),
      { force: params?.force === true },
    );
    return (Array.isArray(renewals) ? renewals : []).map(mapRenewal);
  }
}

export default SyncResolver;

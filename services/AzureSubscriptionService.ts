import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import crypto from 'crypto';
import { AzureSubscription } from '../models/AzureSubscription';
import type {
  AzureSubscriptionResource,
  IAzureSubscriptionDocument,
} from '../models/AzureSubscription';
import { decryptToken, encryptToken, generateEncryptionSalt } from '../utils/token-encryption';
import {
  GraphErrorCode,
  apiError,
  extractGraphCode,
  extractStatusCode,
  toGraphApiError,
} from '../utils/graph-error';

/**
 * Microsoft Graph change-notification subscriptions (AZ-12).
 *
 * A subscription is how Graph is told to call us instead of us polling. The two
 * things this service refuses to guess:
 *
 *   1. **Lifetime.** Graph grants a resource-specific maximum (minutes for some
 *      resources, up to 30 days for others) and clamps a requested expiry to it.
 *      `create`/`renew` therefore read `expirationDateTime` from Graph's
 *      *response* and derive the next renewal from it: `nextRenewAt` is **80% of
 *      the granted lifetime**, measured from the request time. There is no
 *      hardcoded TTL anywhere, so a 6-hour grant and a 24-hour grant produce
 *      different renewal times.
 *
 *   2. **clientState.** Graph echoes this opaque value on every notification;
 *      it is the only authentication a notification carries. It is generated per
 *      subscription, stored AES-256-GCM-encrypted with its own salt, and compared
 *      in constant time by `verifyClientState`. A database leak does not let an
 *      attacker forge a notification.
 *
 * Graph's create/renew/delete calls borrow `provider.getClient(userId)` - the
 * single Graph client factory - because the provider exposes only GET helpers.
 */

/** Fraction of the granted lifetime after which renewal runs. */
export const RENEWAL_FRACTION = 0.8;

/**
 * Default lifetime to *ask* for. Graph clamps this to the resource maximum, so
 * this is deliberately generous: the granted value is what we obey.
 */
export const DEFAULT_REQUESTED_SUBSCRIPTION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Graph resource path for each logical resource. */
export const SUBSCRIPTION_RESOURCE_PATHS: Record<AzureSubscriptionResource, string> = {
  messages: '/me/messages',
  events: '/me/events',
  drive: '/me/drive/root',
};

/** Change types Graph accepts on a subscription. */
export const SUBSCRIPTION_CHANGE_TYPES = ['created', 'updated', 'deleted'] as const;

export const AZURE_SUBSCRIPTION_RESOURCES: AzureSubscriptionResource[] = [
  'messages',
  'events',
  'drive',
];

/** Input accepted by {@link AzureSubscriptionService.create}. */
export interface IAzureCreateSubscriptionInput {
  /** Logical resource (`messages` | `events` | `drive`) or its Graph path. */
  resource: string;
  /** Defaults to `['created', 'updated']`. */
  changeType?: string[];
  /** Defaults to `AZURE_WEBHOOK_NOTIFICATION_URL` or `<app>/azure/webhooks/graph`. */
  notificationUrl?: string;
  /** Requested expiry; Graph may grant less. Defaults to now + 24h. */
  expirationDateTime?: string | Date;
  /** Override the random secret. Production callers should omit this. */
  clientState?: string;
  /** Lifetime to request when `expirationDateTime` is omitted (ms). */
  requestedLifetimeMs?: number;
  /** Fixed "now" for deterministic tests. */
  now?: Date | string;
}

/** Options accepted by {@link AzureSubscriptionService.renew}. */
export interface IAzureRenewSubscriptionOptions {
  /** Fixed "now" for deterministic tests. */
  now?: Date | string;
  /** Lifetime to request; Graph grants whatever it allows. */
  requestedLifetimeMs?: number;
}

/** Options accepted by {@link AzureSubscriptionService.renewSubscriptions}. */
export interface IAzureRenewSubscriptionsOptions {
  /**
   * Renew every active subscription regardless of its schedule. Manual/GraphQL
   * renewal uses this; the scheduler must not.
   */
  force?: boolean;
  /** Fixed "now" for deterministic tests and for a scheduler passing its tick. */
  now?: Date | string;
  /** Lifetime to request per subscription (Graph still decides what it grants). */
  requestedLifetimeMs?: number;
}

/**
 * Is this subscription due for renewal at `now`?
 *
 * The schedule is `nextRenewAt`, which is written as 80% of the lifetime Graph
 * granted - so this is what makes the 80% rule drive behaviour rather than just
 * being stored. Three cases:
 *
 *   - `force` renews regardless (manual / GraphQL);
 *   - a stored `nextRenewAt` is authoritative: due at or after it;
 *   - a row with no schedule (written before this existed, or inserted by hand)
 *     derives one from the grant it does hold - `renewedAt` ->
 *     `expirationDateTime` - and applies the same 80% rule. A row with neither
 *     is renewed rather than left to lapse silently.
 */
export function isSubscriptionDue(
  record: any,
  now: Date,
  force: boolean = false,
): boolean {
  if (force) return true;
  if (record?.active === false) return false;

  const nowMs = now.getTime();
  const scheduled = record?.nextRenewAt ? new Date(record.nextRenewAt) : undefined;

  if (scheduled && !Number.isNaN(scheduled.getTime())) {
    return scheduled.getTime() <= nowMs;
  }

  const renewedAt = record?.renewedAt ? new Date(record.renewedAt) : undefined;
  const expiresAt = record?.expirationDateTime ? new Date(record.expirationDateTime) : undefined;

  if (
    renewedAt && expiresAt
    && !Number.isNaN(renewedAt.getTime())
    && !Number.isNaN(expiresAt.getTime())
  ) {
    const grantedLifetimeMs = Math.max(0, expiresAt.getTime() - renewedAt.getTime());
    return nowMs >= renewedAt.getTime() + Math.floor(grantedLifetimeMs * RENEWAL_FRACTION);
  }

  return true;
}

/** The result of a renewal, including the lifetime Graph actually granted. */
export interface IAzureSubscriptionRenewal {
  userId: string;
  subscriptionId: string;
  /** Expiry Graph granted (never the one requested). */
  expirationDateTime: Date;
  /** Granted lifetime in ms, measured from the request time. */
  grantedLifetimeMs: number;
  /** 80% of the granted lifetime. */
  renewalTime: Date;
  /** Alias of `renewalTime`, named to match the stored subscription field. */
  nextRenewAt: Date;
}

/** The result of verifying a notification's clientState. */
export interface IAzureClientStateVerification {
  valid: boolean;
  subscription?: IAzureSubscriptionDocument | any;
  reason?: string;
}

/** The slice of the Graph provider used for writes. */
interface ISubscriptionGraphProvider {
  getClient(userId: string): any;
  request?<T>(userId: string, path: string, options?: any): Promise<T>;
}

/** Generate the per-subscription shared secret. */
export function generateClientState(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Notification URL Graph should call. */
export function defaultNotificationUrl(): string {
  if (process.env.AZURE_WEBHOOK_NOTIFICATION_URL) {
    return String(process.env.AZURE_WEBHOOK_NOTIFICATION_URL);
  }

  const base = (process.env.REACTORY_APPLICATION_URL || '').replace(/\/+$/, '');
  return base ? `${base}/azure/webhooks/graph` : '';
}

/** Map a logical resource or a Graph path onto both forms. */
export function normaliseSubscriptionResource(resource: string): {
  resource: AzureSubscriptionResource;
  graphResource: string;
} {
  const raw = String(resource ?? '').trim();

  if (!raw) {
    throw apiError(GraphErrorCode.GRAPH_REQUEST_FAILED, 'A subscription resource is required', {
      operation: 'subscription.create',
    });
  }

  const lower = raw.toLowerCase();
  if (AZURE_SUBSCRIPTION_RESOURCES.includes(lower as AzureSubscriptionResource)) {
    const key = lower as AzureSubscriptionResource;
    return { resource: key, graphResource: SUBSCRIPTION_RESOURCE_PATHS[key] };
  }

  if (raw.startsWith('/')) {
    if (/(^|\/)messages(\/|$)/i.test(raw)) return { resource: 'messages', graphResource: raw };
    if (/(^|\/)events(\/|$)/i.test(raw)) return { resource: 'events', graphResource: raw };
    if (/(^|\/)drive(\/|$)/i.test(raw)) return { resource: 'drive', graphResource: raw };
  }

  throw apiError(
    GraphErrorCode.GRAPH_REQUEST_FAILED,
    `Unsupported subscription resource "${resource}"; expected one of ${AZURE_SUBSCRIPTION_RESOURCES.join(', ')} or a Graph path`,
    { operation: 'subscription.create', resource },
  );
}

/** Normalise and validate the change types Graph will accept. */
export function normaliseChangeTypes(changeType?: string[]): string[] {
  const values = Array.isArray(changeType) && changeType.length
    ? changeType
    : ['created', 'updated'];

  const normalised: string[] = [];

  for (const entry of values) {
    const value = String(entry ?? '').trim().toLowerCase();
    if (!(SUBSCRIPTION_CHANGE_TYPES as readonly string[]).includes(value)) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Unsupported changeType "${entry}"; expected ${SUBSCRIPTION_CHANGE_TYPES.join(', ')}`,
        { operation: 'subscription.create' },
      );
    }
    if (!normalised.includes(value)) normalised.push(value);
  }

  return normalised;
}

@service({
  id: 'azure.AzureSubscriptionService@1.0.0',
  name: 'AzureSubscriptionService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph change-notification subscriptions with encrypted clientState and granted-lifetime renewal',
  serviceType: 'integration',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'azure.AzureAuditService@1.0.0', alias: 'auditService' },
  ],
})
class AzureSubscriptionService implements Reactory.Service.IReactoryService {
  name: string = 'AzureSubscriptionService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphClientProvider: ISubscriptionGraphProvider;
  private _auditService: any;

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

  private get graphClientProvider(): ISubscriptionGraphProvider {
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
  /* Reads                                                                    */
  /* ------------------------------------------------------------------------ */

  /** Every subscription stored for a user (active and inactive). */
  async listSubscriptions(userId: string): Promise<any[]> {
    if (!userId) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required to list subscriptions', {
        operation: 'subscription.list',
      });
    }

    const model: any = AzureSubscription;
    if (typeof model.find !== 'function') return [];

    const rows = await model.find({ userId });
    return Array.isArray(rows) ? rows : [];
  }

  /** One stored subscription, by Graph subscription id. */
  async getSubscription(userId: string, subscriptionId: string): Promise<any | null> {
    const model: any = AzureSubscription;
    if (!userId || !subscriptionId || typeof model.findOne !== 'function') return null;

    return model.findOne({ userId, subscriptionId: String(subscriptionId) });
  }

  /**
   * One stored subscription, by Graph id alone.
   *
   * A notification identifies a subscription but no user; this is how the
   * webhook/queue paths find the owner. It performs no verification - callers
   * that act on a notification must still check `verifyClientState`.
   */
  async findByGraphId(subscriptionId: string): Promise<any | null> {
    const model: any = AzureSubscription;
    const id = String(subscriptionId ?? '');

    if (!id || typeof model.findOne !== 'function') return null;

    return model.findOne({ subscriptionId: id });
  }

  /* ------------------------------------------------------------------------ */
  /* Create                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Create a Graph subscription.
   *
   * The `clientState` sent to Graph is fresh per subscription (32 random bytes),
   * and only its ciphertext is persisted. The expiry stored is the one Graph
   * **granted**, and `nextRenewAt` is 80% of that lifetime.
   */
  async create(
    userId: string,
    input: IAzureCreateSubscriptionInput,
  ): Promise<IAzureSubscriptionDocument> {
    if (!userId) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required to create a subscription', {
        operation: 'subscription.create',
      });
    }

    const { resource, graphResource } = normaliseSubscriptionResource(input?.resource);
    const changeType = normaliseChangeTypes(input?.changeType);
    const notificationUrl = String(input?.notificationUrl || defaultNotificationUrl() || '');

    if (!notificationUrl) {
      throw apiError(
        GraphErrorCode.MISSING_CONFIGURATION,
        'No notification URL is configured; set AZURE_WEBHOOK_NOTIFICATION_URL or REACTORY_APPLICATION_URL',
        { operation: 'subscription.create' },
      );
    }

    const plaintextClientState = String(input?.clientState || generateClientState());
    const clientStateSalt = generateEncryptionSalt();
    const clientState = encryptToken(
      plaintextClientState,
      this.requireEncryptionKey(),
      clientStateSalt,
    );

    const now = input?.now ? new Date(input.now) : new Date();
    const requestedLifetimeMs = this.requestedLifetime(input?.requestedLifetimeMs);
    const requestedExpiration = input?.expirationDateTime
      ? new Date(input.expirationDateTime)
      : new Date(now.getTime() + requestedLifetimeMs);

    if (Number.isNaN(requestedExpiration.getTime())) {
      throw apiError(GraphErrorCode.GRAPH_REQUEST_FAILED, 'expirationDateTime is not a valid date', {
        operation: 'subscription.create',
      });
    }

    const response = await this.send(userId, 'subscription.create', (client) =>
      client.api('/subscriptions').post({
        changeType: changeType.join(','),
        notificationUrl,
        resource: graphResource,
        expirationDateTime: requestedExpiration.toISOString(),
        // Graph echoes this verbatim on every notification; only the ciphertext
        // is ever written to our database.
        clientState: plaintextClientState,
      }));

    const subscriptionId = String(response?.id || '');
    if (!subscriptionId) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned no subscription id',
        { operation: 'subscription.create' },
      );
    }

    const grantedExpiration = this.readGrantedExpiration(response, 'subscription.create');
    const grantedLifetimeMs = Math.max(0, grantedExpiration.getTime() - now.getTime());

    const record = await this.upsertRecord(
      { userId, subscriptionId },
      {
        userId,
        subscriptionId,
        resource,
        graphResource: String(response?.resource || graphResource),
        changeType,
        notificationUrl: String(response?.notificationUrl || notificationUrl),
        expirationDateTime: grantedExpiration,
        clientState,
        clientStateSalt,
        renewedAt: now,
        nextRenewAt: this.renewalTime(now, grantedLifetimeMs),
        active: true,
      },
    );

    await this.audit({
      userId,
      operation: 'subscription.create',
      resource: graphResource,
      outcome: 'success',
      metadata: {
        subscriptionId,
        resource,
        changeType,
        grantedLifetimeMs,
        nextRenewAt: this.renewalTime(now, grantedLifetimeMs).toISOString(),
      },
    });

    return record;
  }

  /**
   * Create a replacement subscription for one whose Graph id has expired.
   *
   * Graph cannot extend an expired subscription, so this re-creates it with the
   * same resource / change types / notification URL and a **new** clientState,
   * then repoints the stored row at the new Graph id. `requestedLifetimeMs` and
   * `clientState` are test/ops overrides only.
   */
  async resubscribe(
    userId: string,
    subscriptionId: string,
    options: IAzureRenewSubscriptionOptions & { clientState?: string } = {},
  ): Promise<IAzureSubscriptionDocument> {
    const record = await this.requireRecord(userId, subscriptionId);
    const oldSubscriptionId = String(record.subscriptionId);

    const plaintextClientState = String(options?.clientState || generateClientState());
    const clientStateSalt = generateEncryptionSalt();
    const clientState = encryptToken(
      plaintextClientState,
      this.requireEncryptionKey(),
      clientStateSalt,
    );

    const now = options?.now ? new Date(options.now) : new Date();
    const requestedLifetimeMs = this.requestedLifetime(options?.requestedLifetimeMs);
    const requestedExpiration = new Date(now.getTime() + requestedLifetimeMs);

    const response = await this.send(userId, 'subscription.resubscribe', (client) =>
      client.api('/subscriptions').post({
        changeType: (record.changeType || ['created', 'updated']).join(','),
        notificationUrl: record.notificationUrl,
        resource: record.graphResource
          || SUBSCRIPTION_RESOURCE_PATHS[record.resource as AzureSubscriptionResource],
        expirationDateTime: requestedExpiration.toISOString(),
        clientState: plaintextClientState,
      }));

    const newSubscriptionId = String(response?.id || '');
    if (!newSubscriptionId) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned no subscription id for the replacement subscription',
        { operation: 'subscription.resubscribe' },
      );
    }

    const grantedExpiration = this.readGrantedExpiration(response, 'subscription.resubscribe');
    const grantedLifetimeMs = Math.max(0, grantedExpiration.getTime() - now.getTime());

    const updated = await this.upsertRecord(
      { userId, subscriptionId: oldSubscriptionId },
      {
        userId,
        subscriptionId: newSubscriptionId,
        graphResource: String(response?.resource || record.graphResource),
        notificationUrl: String(response?.notificationUrl || record.notificationUrl),
        expirationDateTime: grantedExpiration,
        clientState,
        clientStateSalt,
        renewedAt: now,
        nextRenewAt: this.renewalTime(now, grantedLifetimeMs),
        active: true,
      },
      { upsert: false },
    );

    if (!updated) {
      // The row vanished between requireRecord() and the update (a concurrent
      // delete). The replacement now exists at Graph with a clientState whose
      // ciphertext was never persisted: no notification for it could ever be
      // verified, and it would keep calling us. Never leave that behind.
      const removed = await this.deleteOrphanedReplacement(userId, newSubscriptionId);

      await this.audit({
        userId,
        operation: 'subscription.resubscribe',
        resource: String(record.graphResource || record.resource),
        outcome: 'failure',
        metadata: {
          subscriptionId: newSubscriptionId,
          previousSubscriptionId: oldSubscriptionId,
          reason: 'stored-row-vanished',
          orphanDeleted: removed,
        },
      });

      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `The subscription ${oldSubscriptionId} disappeared while it was being replaced; `
        + 'the replacement was removed again so no unverifiable subscription is left at Graph',
        { operation: 'subscription.resubscribe', subscriptionId: newSubscriptionId },
      );
    }

    await this.audit({
      userId,
      operation: 'subscription.resubscribe',
      resource: String(record.graphResource || record.resource),
      outcome: 'success',
      metadata: {
        previousSubscriptionId: oldSubscriptionId,
        subscriptionId: newSubscriptionId,
        grantedLifetimeMs,
      },
    });

    return updated;
  }

  /* ------------------------------------------------------------------------ */
  /* Renew                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Renew one subscription and return the schedule Graph's grant implies.
   *
   * The requested expiry is deliberately not trusted: Graph clamps it to the
   * resource maximum and answers with the granted value, from which the granted
   * lifetime - and therefore the next renewal at 80% of it - is derived.
   */
  async renew(
    userId: string,
    subscriptionId: string,
    options: IAzureRenewSubscriptionOptions = {},
  ): Promise<IAzureSubscriptionRenewal> {
    const record = await this.requireRecord(userId, subscriptionId);

    const now = options?.now ? new Date(options.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      throw apiError(GraphErrorCode.GRAPH_REQUEST_FAILED, 'renew: "now" is not a valid date', {
        operation: 'subscription.renew',
      });
    }

    const requestedLifetimeMs = this.requestedLifetime(options?.requestedLifetimeMs);
    const requestedExpiration = new Date(now.getTime() + requestedLifetimeMs);

    const response = await this.send(userId, 'subscription.renew', (client) =>
      client.api(`/subscriptions/${encodeURIComponent(String(record.subscriptionId))}`).patch({
        expirationDateTime: requestedExpiration.toISOString(),
      }));

    // The only lifetime that matters is the one Graph granted.
    const grantedExpiration = this.readGrantedExpiration(response, 'subscription.renew');
    const grantedLifetimeMs = Math.max(0, grantedExpiration.getTime() - now.getTime());
    const renewalTime = this.renewalTime(now, grantedLifetimeMs);

    await this.upsertRecord(
      { userId, subscriptionId: String(record.subscriptionId) },
      {
        expirationDateTime: grantedExpiration,
        renewedAt: now,
        nextRenewAt: renewalTime,
        active: true,
        ...(response?.resource ? { graphResource: String(response.resource) } : {}),
      },
      { upsert: false },
    );

    await this.audit({
      userId,
      operation: 'subscription.renew',
      resource: String(record.graphResource || record.resource),
      outcome: 'success',
      metadata: {
        subscriptionId: String(record.subscriptionId),
        requestedLifetimeMs,
        grantedLifetimeMs,
        renewalTime: renewalTime.toISOString(),
      },
    });

    return {
      userId,
      subscriptionId: String(record.subscriptionId),
      expirationDateTime: grantedExpiration,
      grantedLifetimeMs,
      renewalTime,
      nextRenewAt: renewalTime,
    };
  }

  /**
   * Renew the subscriptions that are DUE - for one user, or for all users when
   * `userId` is omitted (the scheduler path).
   *
   * "Due" is {@link isSubscriptionDue}: `nextRenewAt <= now`, i.e. 80% of the
   * lifetime Graph granted has elapsed. Renewing only due rows is what stops a
   * scheduler tick from re-extending every subscription on every run (which would
   * hammer Graph and push each `nextRenewAt` forward forever). Pass
   * `{ force: true }` for a manual/GraphQL renewal.
   *
   * A single failed renewal is logged and audited but does not abort the sweep:
   * one expired mailbox must not stop every other subscription from renewing.
   */
  async renewSubscriptions(
    userId?: string,
    options: IAzureRenewSubscriptionsOptions = {},
  ): Promise<IAzureSubscriptionRenewal[]> {
    const model: any = AzureSubscription;
    if (typeof model.find !== 'function') return [];

    const now = options?.now ? new Date(options.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'renewSubscriptions: "now" is not a valid date',
        { operation: 'subscription.renewSubscriptions' },
      );
    }

    const force = options?.force === true;

    const filter: Record<string, unknown> = { active: true };
    if (userId) filter.userId = userId;

    if (!force) {
      // Push the schedule into the query: the scheduler path runs for every user,
      // so loading every active row and filtering in memory is needlessly
      // expensive. Three clauses, because a row can be due for three reasons:
      //
      //   - the stored schedule has passed;
      //   - it has no schedule at all (`{ nextRenewAt: null }` also matches a
      //     missing field, which is how legacy rows are written), so the schedule
      //     is derived below from the grant the row does hold;
      //   - the stored value is not a date (hand-edited or a legacy string), which
      //     no date comparison can match - the in-memory rule decides.
      filter.$or = [
        { nextRenewAt: { $lte: now } },
        { nextRenewAt: null },
        { nextRenewAt: { $type: 'string' } },
      ];
    }

    const records = await model.find(filter);
    const due = (Array.isArray(records) ? records : []).filter(
      (record: any) => isSubscriptionDue(record, now, force),
    );

    const results: IAzureSubscriptionRenewal[] = [];

    for (const record of due) {
      const owner = String(record?.userId ?? userId ?? '');
      try {
        results.push(await this.renew(owner, String(record.subscriptionId), {
          // Only pin the clock when the caller did; otherwise `renew` reads the
          // real clock, which is what the granted-lifetime maths expects.
          now: options?.now,
          requestedLifetimeMs: options?.requestedLifetimeMs,
        }));
      } catch (error: any) {
        logger.warn(
          `AzureSubscriptionService: renewal failed for ${record?.subscriptionId}: ${error?.message}`,
        );
        await this.audit({
          userId: owner,
          operation: 'subscription.renew',
          resource: String(record?.graphResource || record?.resource || ''),
          outcome: 'failure',
          graphCode: extractGraphCode(error),
          metadata: { subscriptionId: record?.subscriptionId, message: error?.message },
        });
      }
    }

    return results;
  }

  /**
   * Best-effort removal of a replacement subscription whose row could not be
   * stored. Never throws: the caller is already failing the operation, and a
   * second failure must not mask the first.
   */
  private async deleteOrphanedReplacement(
    userId: string,
    subscriptionId: string,
  ): Promise<boolean> {
    try {
      await this.send(userId, 'subscription.resubscribe.cleanup', (client) =>
        client.api(`/subscriptions/${encodeURIComponent(String(subscriptionId))}`).delete());
      return true;
    } catch (error: any) {
      logger.warn(
        `AzureSubscriptionService: could not remove the orphaned replacement ${subscriptionId}: ${error?.message}`,
      );
      return false;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Delete                                                                   */
  /* ------------------------------------------------------------------------ */

  /** Delete a subscription at Graph and mark the stored row inactive. */
  async delete(userId: string, subscriptionId: string): Promise<boolean> {
    const record = await this.requireRecord(userId, subscriptionId);

    try {
      await this.send(userId, 'subscription.delete', (client) =>
        client.api(`/subscriptions/${encodeURIComponent(String(record.subscriptionId))}`).delete());
    } catch (error: any) {
      // 404 means Graph already dropped it - deleting is idempotent.
      if (extractStatusCode(error) !== 404) {
        await this.audit({
          userId,
          operation: 'subscription.delete',
          resource: String(record.graphResource || record.resource),
          outcome: 'failure',
          graphCode: extractGraphCode(error),
          metadata: { subscriptionId: String(record.subscriptionId), message: error?.message },
        });
        throw error;
      }
    }

    await this.upsertRecord(
      { userId, subscriptionId: String(record.subscriptionId) },
      { active: false, nextRenewAt: null },
      { upsert: false },
    );

    await this.audit({
      userId,
      operation: 'subscription.delete',
      resource: String(record.graphResource || record.resource),
      outcome: 'success',
      metadata: { subscriptionId: String(record.subscriptionId) },
    });

    return true;
  }

  /* ------------------------------------------------------------------------ */
  /* Notification verification                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Verify a notification's plaintext `clientState` against the stored secret.
   *
   * Returns `{ valid: false, reason }` for every failure - missing input, an
   * unknown or inactive subscription, an unreadable ciphertext, or a mismatch -
   * rather than throwing, because the caller's job is to reject and audit the
   * notification, not to fail the whole batch. Comparison is constant-time.
   */
  async verifyClientState(
    subscriptionId: string,
    clientState: string,
  ): Promise<IAzureClientStateVerification> {
    const id = String(subscriptionId ?? '');
    if (!id) return { valid: false, reason: 'missing-subscription-id' };

    if (typeof clientState !== 'string' || clientState.length === 0) {
      return { valid: false, reason: 'missing-client-state' };
    }

    const model: any = AzureSubscription;
    const record = typeof model.findOne === 'function'
      ? await model.findOne({ subscriptionId: id })
      : null;

    if (!record) return { valid: false, reason: 'unknown-subscription' };
    if (record.active === false) {
      return { valid: false, subscription: record, reason: 'inactive-subscription' };
    }

    let secret: string;
    try {
      secret = decryptToken(record.clientState, this.requireEncryptionKey(), record.clientStateSalt);
    } catch {
      return { valid: false, subscription: record, reason: 'client-state-unreadable' };
    }

    const expected = Buffer.from(secret, 'utf8');
    const received = Buffer.from(clientState, 'utf8');

    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return { valid: false, subscription: record, reason: 'client-state-mismatch' };
    }

    return { valid: true, subscription: record };
  }

  /* ------------------------------------------------------------------------ */
  /* Transport                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * POST/PATCH/DELETE through the provider's client.
   *
   * The provider exposes GET helpers only, so writes borrow `getClient(userId)` -
   * still the single Graph client factory, with `debugLogging` disabled - and
   * translate failures with the same `toGraphApiError` contract as every read.
   */
  private async send(
    userId: string,
    operation: string,
    run: (client: any) => Promise<any>,
  ): Promise<any> {
    const provider = this.graphClientProvider;

    if (!provider || typeof provider.getClient !== 'function') {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Microsoft Graph client provider cannot build a client for a subscription write',
        { operation },
      );
    }

    const client = provider.getClient(userId);

    try {
      return await run(client);
    } catch (error: any) {
      const tokenSource = typeof client?.__azureTokenSource === 'function'
        ? client.__azureTokenSource()
        : undefined;

      throw toGraphApiError(error, { operation, tokenSource });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  /** `AZURE_TOKEN_ENCRYPTION_KEY`; required for every clientState operation. */
  private requireEncryptionKey(): string {
    const key = process.env.AZURE_TOKEN_ENCRYPTION_KEY;

    if (!key) {
      throw apiError(
        GraphErrorCode.MISSING_CONFIGURATION,
        'AZURE_TOKEN_ENCRYPTION_KEY is not set; refusing to store a notification secret without encryption',
        { operation: 'subscription.clientState' },
      );
    }

    return key;
  }

  private requestedLifetime(value?: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : DEFAULT_REQUESTED_SUBSCRIPTION_LIFETIME_MS;
  }

  /** 80% of the granted lifetime, measured from the request time. */
  private renewalTime(now: Date, grantedLifetimeMs: number): Date {
    return new Date(now.getTime() + Math.floor(Math.max(0, grantedLifetimeMs) * RENEWAL_FRACTION));
  }

  /** Read the expiry Graph actually granted; a missing value is a hard failure. */
  private readGrantedExpiration(response: any, operation: string): Date {
    const raw = response?.expirationDateTime;

    if (!raw) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned no expirationDateTime; cannot derive the granted lifetime',
        { operation },
      );
    }

    const granted = new Date(raw);
    if (Number.isNaN(granted.getTime())) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Microsoft Graph returned an invalid expirationDateTime: ${String(raw)}`,
        { operation },
      );
    }

    return granted;
  }

  private async requireRecord(userId: string, subscriptionId: string): Promise<any> {
    if (!userId || !subscriptionId) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'A userId and subscriptionId are required',
        { operation: 'subscription.lookup' },
      );
    }

    const model: any = AzureSubscription;
    const record = typeof model.findOne === 'function'
      ? await model.findOne({ userId, subscriptionId: String(subscriptionId) })
      : null;

    if (!record) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `No stored subscription ${subscriptionId} for user ${userId}`,
        { operation: 'subscription.lookup', subscriptionId: String(subscriptionId) },
      );
    }

    return record;
  }

  /** Upsert / update one stored subscription, with a model-free fallback. */
  private async upsertRecord(
    filter: Record<string, unknown>,
    values: Record<string, unknown>,
    options: { upsert?: boolean } = { upsert: true },
  ): Promise<any> {
    const model: any = AzureSubscription;

    if (typeof model.findOneAndUpdate === 'function') {
      return model.findOneAndUpdate(
        filter,
        { $set: values },
        {
          upsert: options?.upsert !== false,
          new: true,
          setDefaultsOnInsert: true,
        },
      );
    }

    const existing: any = typeof model.findOne === 'function' ? await model.findOne(filter) : null;

    if (existing) {
      Object.assign(existing, values);
      if (typeof existing.save === 'function') await existing.save();
      return existing;
    }

    const created: any = new model({ ...filter, ...values });
    if (typeof created.save === 'function') await created.save();
    return created;
  }

  /** Audit writes never fail the operation they describe. */
  private async audit(entry: {
    userId: string;
    operation: string;
    resource?: string;
    outcome: 'success' | 'failure';
    graphCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const auditService = this.auditService;
      if (auditService && typeof auditService.logOperation === 'function') {
        await auditService.logOperation(entry);
      }
    } catch (error: any) {
      logger.warn(`AzureSubscriptionService: audit write failed for ${entry.operation}: ${error?.message}`);
    }
  }
}

export const AzureSubscriptionServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureSubscriptionService> = {
  service: (props: any, context: any) => new AzureSubscriptionService(props, context),
  id: 'azure.AzureSubscriptionService@1.0.0',
  name: 'AzureSubscriptionService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph change-notification subscriptions with encrypted clientState and granted-lifetime renewal',
  serviceType: 'integration',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'azure.AzureAuditService@1.0.0', alias: 'auditService' },
  ],
};

export { AzureSubscriptionService };
export default AzureSubscriptionService;

import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import logger from '@reactory/server-core/logging';

/**
 * Microsoft Graph webhook request-level verification (AZ-12).
 *
 * Graph does **not** sign change notifications the way Google Pub/Sub does.
 * Two things authenticate a request instead:
 *
 *   1. **The subscription handshake.** On creation Graph POSTs to the
 *      notification URL with `?validationToken=<opaque>` and requires a `200`
 *      whose body is that token, URL-decoded, as `text/plain; charset=utf-8`.
 *      Echoing anything else (JSON, the wrong encoding, a trailing newline)
 *      fails the subscription.
 *
 *   2. **`clientState`.** Every notification echoes the opaque secret supplied
 *      when the subscription was created. It is verified per notification
 *      against the encrypted secret on `AzureSubscription`, in constant time. A
 *      mismatch is rejected **and audited**; it is never handed to a processor.
 *
 * AZ-01 left this file exporting an empty array because there was nothing to
 * verify yet. `webhookVerification` is now the module-scoped JSON body guard for
 * the webhook path; the verification itself is exported as functions so the
 * route can keep the 202 + audit contract explicit.
 */

/** The path the module router mounts this handler on (under `/azure`). */
export const GRAPH_WEBHOOK_PATH = '/azure/webhooks/graph';

/** Placeholder actor for an audit entry whose owner cannot be resolved. */
export const UNKNOWN_USER_ID = '000000000000000000000000';

/** A notification as Graph posts it. */
export interface IGraphWebhookNotification {
  subscriptionId?: string;
  subscriptionExpirationDateTime?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  tenantId?: string;
  [key: string]: unknown;
}

/** Outcome of verifying one batch of notifications. */
export interface IVerifiedWebhookBatch {
  accepted: IGraphWebhookNotification[];
  rejected: IGraphWebhookNotification[];
  reasons: string[];
}

/** One notification's verification outcome. */
export interface INotificationVerification {
  valid: boolean;
  subscription?: any;
  reason?: string;
}

/**
 * URL-decode a RAW (still percent-encoded) token.
 *
 * ONLY for a raw query string - see {@link readValidationToken}. Express decodes
 * `req.query` exactly once, so decoding that value again is a bug: a token whose
 * decoded form legitimately contains an escape (`abc%20def`) would be corrupted
 * to `abc def`, and Graph only echoes what it sent, so the handshake would fail.
 * A malformed escape sequence falls back to the raw value instead of throwing.
 */
export function decodeValidationToken(raw: unknown): string {
  const value = String(raw ?? '');
  if (!value) return '';

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The validation token for a request, DECODED EXACTLY ONCE.
 *
 * `req.query` is already percent-decoded by Express, so its value is returned
 * verbatim. The guarded {@link decodeValidationToken} is only reached when a
 * caller has no parsed query (a raw `?validationToken=...` string), which keeps
 * the helper testable without double-decoding the real request path.
 *
 * @returns the token, or `undefined` when the request carries none
 */
export function readValidationToken(req: Request): string | undefined {
  const queryValue = (req?.query as any)?.validationToken;

  if (queryValue !== undefined && queryValue !== null) {
    return String(Array.isArray(queryValue) ? queryValue[0] : queryValue);
  }

  // No parsed query (e.g. a caller passing a raw URL): decode the raw string.
  const url = String((req as any)?.originalUrl || (req as any)?.url || '');
  const match = /[?&]validationToken=([^&]*)/.exec(url);
  if (!match) return undefined;

  return decodeValidationToken(match[1]);
}

/**
 * Answer the Graph subscription handshake.
 *
 * Exactly `200`, exactly `text/plain; charset=utf-8`, exactly the token it is
 * given (already decoded) and nothing else.
 */
export function sendValidationToken(res: Response, token: unknown): Response {
  const value = String(Array.isArray(token) ? token[0] ?? '' : token ?? '');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(200).send(value);
}

/** True when this request targets the Graph webhook endpoint. */
export function isGraphWebhookRequest(req: Request): boolean {
  const url = String((req as any)?.originalUrl || (req as any)?.url || '');
  return url.split('?')[0].replace(/\/+$/, '').endsWith('/webhooks/graph');
}

const jsonParser = express.json({ limit: '1mb' });

/**
 * Parse the JSON body for the webhook path only.
 *
 * Scoped deliberately: the module middleware array is global, and a JSON parser
 * applied to every Azure route would be a behaviour change outside this ticket's
 * scope. Requests that already have a body (a host-level parser ran) are left
 * alone.
 */
export const ensureGraphWebhookBody: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.method !== 'POST' || !isGraphWebhookRequest(req) || (req as any).body !== undefined) {
    return next();
  }

  return jsonParser(req, res, next);
};

/** Module-scoped middleware contributed by this file. */
export const webhookVerification: any[] = [ensureGraphWebhookBody];

/** Resolve a service without throwing. */
function tryGetService(context: any, id: string): any | undefined {
  try {
    return context?.getService?.(id) || undefined;
  } catch {
    return undefined;
  }
}

/** True when the subscription service (and therefore clientState verification) is present. */
export function isSubscriptionServiceAvailable(context: any): boolean {
  const service = tryGetService(context, 'azure.AzureSubscriptionService@1.0.0');
  return !!service && typeof service.verifyClientState === 'function';
}

/**
 * Verify one notification's `clientState`.
 *
 * A missing service, an unknown subscription, a decryption failure and a
 * mismatch all return `{ valid: false, reason }` - the caller must reject and
 * audit, not throw.
 */
export async function verifyNotification(
  context: any,
  notification: IGraphWebhookNotification,
): Promise<INotificationVerification> {
  const service = tryGetService(context, 'azure.AzureSubscriptionService@1.0.0');

  if (!service || typeof service.verifyClientState !== 'function') {
    return { valid: false, reason: 'subscription-service-unavailable' };
  }

  try {
    const result = await service.verifyClientState(
      String(notification?.subscriptionId ?? ''),
      String(notification?.clientState ?? ''),
    );

    if (!result) return { valid: false, reason: 'verification-returned-nothing' };

    return {
      valid: result.valid === true,
      subscription: result.subscription,
      reason: result.valid === true ? undefined : (result.reason || 'client-state-mismatch'),
    };
  } catch (error: any) {
    return { valid: false, reason: `verification-failed: ${error?.message || 'unknown error'}` };
  }
}

/**
 * Record a rejected notification.
 *
 * Never throws: an audit outage must not turn a rejected notification into a
 * 500 that makes Graph retry it forever.
 */
export async function auditRejectedNotification(
  context: any,
  notification: IGraphWebhookNotification,
  verification: INotificationVerification,
): Promise<void> {
  const auditService = tryGetService(context, 'azure.AzureAuditService@1.0.0');
  const subscriptionId = String(notification?.subscriptionId ?? '');
  const userId = String(verification?.subscription?.userId ?? UNKNOWN_USER_ID);

  if (!auditService || typeof auditService.logOperation !== 'function') {
    logger.warn(
      `Azure webhook: rejected notification for subscription ${subscriptionId || 'unknown'} `
      + `(${verification?.reason || 'client-state-mismatch'}); no audit service available`,
    );
    return;
  }

  try {
    await auditService.logOperation({
      userId,
      operation: 'webhook.clientStateRejected',
      resource: String(notification?.resource ?? ''),
      outcome: 'failure',
      graphCode: 'InvalidClientState',
      metadata: {
        subscriptionId,
        reason: verification?.reason || 'client-state-mismatch',
        changeType: notification?.changeType,
        tenantId: notification?.tenantId,
      },
    });
  } catch (error: any) {
    logger.warn(`Azure webhook: could not audit the rejected notification: ${error?.message}`);
  }
}

/**
 * Split a Graph notification batch into accepted and rejected.
 *
 * Every rejection is audited. Accepted notifications are the only ones a caller
 * may enqueue.
 */
export async function verifyGraphWebhookNotifications(
  context: any,
  notifications: IGraphWebhookNotification[],
): Promise<IVerifiedWebhookBatch> {
  const accepted: IGraphWebhookNotification[] = [];
  const rejected: IGraphWebhookNotification[] = [];
  const reasons: string[] = [];

  for (const notification of Array.isArray(notifications) ? notifications : []) {
    const verification = await verifyNotification(context, notification);

    if (verification.valid) {
      accepted.push(notification);
      continue;
    }

    rejected.push(notification);
    reasons.push(verification.reason || 'client-state-mismatch');
    await auditRejectedNotification(context, notification, verification);
  }

  return { accepted, rejected, reasons };
}

export default webhookVerification;

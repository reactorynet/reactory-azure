import express, { Request, Response } from 'express';
import logger from '@reactory/server-core/logging';
import { enqueueAzureJob } from '../queues';
import { AZURE_QUEUE_NAMES } from '../queues/types';
import {
  ensureGraphWebhookBody,
  isSubscriptionServiceAvailable,
  readValidationToken,
  sendValidationToken,
  verifyGraphWebhookNotifications,
} from '../middleware/webhook-verification';

/**
 * Microsoft Graph change-notification endpoint: `POST /azure/webhooks/graph`.
 *
 * Two modes, one route:
 *
 *   - **Handshake.** `?validationToken=...` (Graph's subscription validation)
 *     is answered `200 text/plain; charset=utf-8` with the URL-decoded token and
 *     nothing else. This branch runs before any parsing or service lookup, so a
 *     handshake can never fail because Mongo or Redis is down.
 *
 *   - **Notification.** Each notification's `clientState` is verified against
 *     the encrypted secret on its subscription. A mismatch is rejected and
 *     audited; verified notifications are enqueued on
 *     `azure-webhook-process`. The response is `202 Accepted` in both cases so
 *     Graph does not retry a notification we have deliberately refused.
 *
 * If the subscription service is not registered we cannot verify anything, so
 * the route answers `503`: accepting unverified notifications would be worse
 * than asking Graph to retry.
 */
const router = express.Router();

router.post('/graph', ensureGraphWebhookBody, async (req: Request, res: Response) => {
  // ── 1. Validation handshake ──────────────────────────────────────────────
  // `validationToken` is a query parameter, never a body field. Express has
  // already percent-decoded `req.query`, and `readValidationToken` returns that
  // value verbatim - decoding it a second time would corrupt a token whose
  // decoded form contains a literal escape (abc%20def -> abc def).
  const validationToken = readValidationToken(req);

  if (validationToken !== undefined) {
    return sendValidationToken(res, validationToken);
  }

  const context = (req as any)?.context;

  // ── 2. Cannot verify without the subscription service ────────────────────
  if (!isSubscriptionServiceAvailable(context)) {
    logger.warn('Azure webhook: AzureSubscriptionService is not available; returning 503');
    return res.status(503).json({ error: 'Azure Subscription Service not available' });
  }

  const notifications = Array.isArray((req.body as any)?.value) ? (req.body as any).value : [];

  if (notifications.length === 0) {
    return res.status(202).json({ accepted: 0, rejected: 0 });
  }

  // ── 3. Verify every clientState, audit every rejection ───────────────────
  const verification = await verifyGraphWebhookNotifications(context, notifications);

  // ── 4. Enqueue only what passed verification ─────────────────────────────
  if (verification.accepted.length > 0) {
    const enqueued = await enqueueAzureJob(
      context,
      AZURE_QUEUE_NAMES.webhookProcess,
      { notifications: verification.accepted },
    );

    // Absence of a queue provider is a logged no-op, never a crash and never a
    // non-202: Graph has delivered the notification either way.
    if (!enqueued.queued) {
      logger.warn(
        `Azure webhook: ${verification.accepted.length} verified notification(s) not queued `
        + `(${enqueued.reason || 'queue unavailable'}); degraded no-op`,
      );
    }
  }

  return res.status(202).json({
    accepted: verification.accepted.length,
    rejected: verification.rejected.length,
  });
});

export default router;

/**
 * Graph webhook verification middleware - STUB created by AZ-01.
 *
 * TODO(AZ-12): Graph does NOT sign notifications the way Google Pub/Sub does.
 * Verification is per-notification `clientState` comparison against the encrypted
 * secret on AzureSubscription, plus the one-off `validationToken` handshake. Those
 * are request-level concerns of the webhook route, so this middleware array is
 * intentionally empty rather than a placeholder that would reject live calls.
 *
 * AZ-12 extends this file; middleware/index.ts (owned by AZ-01) already spreads
 * whatever it exports.
 */
export const webhookVerification: any[] = [];

export default webhookVerification;

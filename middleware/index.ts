import { webhookVerification } from './webhook-verification';

export { webhookVerification };

/**
 * Module-wide Express middleware.
 *
 * AZ-01 contributes none: the Graph webhook guard is request-scoped and lives in
 * routes/webhooks.ts (AZ-12). The array exists so `index.ts` can declare
 * `middleware` without a later ticket touching the root wiring.
 */
const middleware: any[] = [...webhookVerification];

export default middleware;

import express from 'express';

/**
 * Microsoft Graph change-notification endpoint - EMPTY by design.
 *
 * TODO(AZ-12): implement `POST /azure/webhooks/graph`. The validation handshake
 * (echo the `validationToken` as `text/plain; charset=utf-8`), the per-notification
 * `clientState` verification and the enqueue are all AZ-12's scope; AZ-01 only
 * reserves the mount point so routes/index.ts never has to be edited.
 */
const router = express.Router();

export default router;

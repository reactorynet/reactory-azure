import express from 'express';

/**
 * Binary proxy endpoint - EMPTY by design.
 *
 * TODO(AZ-08): implement `GET /azure/files/:itemId` and
 * `GET /azure/files/:itemId/thumbnail`, streaming the Graph content with a
 * Content-Disposition header and never exposing the pre-authenticated URL.
 * AZ-01 only reserves the mount point so routes/index.ts never has to be edited.
 */
const router = express.Router();

export default router;

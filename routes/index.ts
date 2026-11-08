import express from 'express';
import authRoutes from './auth';
import webhookRoutes from './webhooks';
import proxyRoutes from './proxy';

const router = express.Router();

/**
 * The module is mounted by the server at the `/azure` route key (see index.ts),
 * so every inner path here is relative to that prefix:
 *
 *   /azure/auth/url          /azure/auth/callback
 *   /azure/auth/status       /azure/auth/disconnect
 *   /azure/webhooks/graph    (AZ-12)
 *   /azure/files/:itemId     (AZ-08)
 */
router.use('/auth', authRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/', proxyRoutes);

export default router;

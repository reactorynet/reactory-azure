import express, { Request, Response } from 'express';
import logger from '@reactory/server-core/logging';

const router = express.Router();

/**
 * Microsoft identity HTTP endpoints, mounted under `/azure/auth`.
 *
 * These mirror reactory-google's auth routes so the client surface is familiar.
 * Every handler resolves `azure.AzureAuthService@1.0.0` from the request context;
 * no token is ever returned to the browser.
 */

function getContext(req: Request): any {
  return (req as any).context;
}

/**
 * GET /azure/auth/url?services=mail,calendar
 * Issue a PKCE authorization URL for the current user.
 */
router.get('/url', async (req: Request, res: Response) => {
  try {
    const context = getContext(req);
    if (!context?.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const authService = context.getService('azure.AzureAuthService@1.0.0');
    if (!authService) {
      return res.status(503).json({ error: 'Azure Auth Service not available' });
    }

    const services = req.query.services
      ? String(req.query.services).split(',').map((entry) => entry.trim()).filter(Boolean)
      : [];

    const url = await authService.getAuthorizationUrl(String(context.user._id), services);
    return res.json({ url });
  } catch (error: any) {
    logger.error(`Error generating the Azure auth URL: ${error?.message}`);
    return res.status(500).json({ error: error?.message || 'Could not start the Microsoft authorization flow' });
  }
});

/**
 * GET /azure/auth/callback?code=...&state=...
 * Exchange the authorization code and store the vaulted token.
 */
router.get('/callback', async (req: Request, res: Response) => {
  const appUrl = (process.env.REACTORY_APPLICATION_URL || '').replace(/\/+$/, '');
  const successRedirect =
    process.env.AZURE_AUTH_SUCCESS_REDIRECT || `${appUrl}/?azure=connected`;
  const failureRedirect =
    process.env.AZURE_AUTH_FAILURE_REDIRECT || `${appUrl}/?azure=error`;

  try {
    const context = getContext(req);
    const authService = context?.getService('azure.AzureAuthService@1.0.0');
    if (!authService) {
      return res.redirect(failureRedirect);
    }

    const { code, state } = req.query;
    if (!code || !state) {
      return res.redirect(`${failureRedirect}&reason=missing_params`);
    }

    await authService.handleAuthCallback(String(code), String(state));
    return res.redirect(successRedirect);
  } catch (error: any) {
    logger.error(`Error handling the Azure auth callback: ${error?.message}`);
    return res.redirect(`${failureRedirect}&reason=${encodeURIComponent(error?.code || error?.message || 'error')}`);
  }
});

/** POST /azure/auth/disconnect - mark the vaulted token revoked. */
router.post('/disconnect', async (req: Request, res: Response) => {
  try {
    const context = getContext(req);
    if (!context?.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const authService = context.getService('azure.AzureAuthService@1.0.0');
    if (!authService) {
      return res.status(503).json({ error: 'Azure Auth Service not available' });
    }

    await authService.revokeAccess(String(context.user._id));
    return res.json({ success: true, message: 'Microsoft account disconnected' });
  } catch (error: any) {
    logger.error(`Error disconnecting the Azure account: ${error?.message}`);
    return res.status(500).json({ error: error?.message });
  }
});

/** GET /azure/auth/status - connection status for the current user. */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const context = getContext(req);
    if (!context?.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const authService = context.getService('azure.AzureAuthService@1.0.0');
    if (!authService) {
      return res.status(503).json({ error: 'Azure Auth Service not available' });
    }

    const status = await authService.getConnectionStatus(String(context.user._id));
    return res.json(status);
  } catch (error: any) {
    logger.error(`Error reading the Azure connection status: ${error?.message}`);
    return res.status(500).json({ error: error?.message });
  }
});

export default router;

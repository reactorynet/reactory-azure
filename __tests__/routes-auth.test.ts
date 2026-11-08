/**
 * routes/auth.ts — the module's implemented HTTP surface.
 *
 * These handlers are the only browser-facing entry points AZ-01 delivers, so they
 * get the same treatment as the services: happy path plus every documented
 * failure branch. `req.context` is injected by the server's request middleware, so
 * the tests mount the router behind a tiny stand-in for it.
 */
import express from 'express';
import request from 'supertest';

// eslint-disable-next-line import/first
import authRoutes from '../routes/auth';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const SUCCESS_REDIRECT = 'https://app.test/?azure=connected';
const FAILURE_REDIRECT = 'https://app.test/?azure=error';

const originalEnv = process.env;

function buildApp(options: { user?: any; service?: any } = {}) {
  const app = express();

  app.use((req, _res, next) => {
    const getService = jest.fn(() => options.service);
    (req as any).context = options.user === null
      ? undefined
      : { user: options.user === undefined ? { _id: USER_ID } : options.user, getService };
    next();
  });
  app.use('/azure/auth', authRoutes);

  return app;
}

beforeEach(() => {
  process.env = {
    ...originalEnv,
    AZURE_AUTH_SUCCESS_REDIRECT: SUCCESS_REDIRECT,
    AZURE_AUTH_FAILURE_REDIRECT: FAILURE_REDIRECT,
  };
});

afterAll(() => {
  process.env = originalEnv;
});

describe('GET /azure/auth/url', () => {
  it('returns the PKCE URL and passes the parsed service list', async () => {
    const service = { getAuthorizationUrl: jest.fn().mockResolvedValue('https://login.test/authorize') };

    const response = await request(buildApp({ service }))
      .get('/azure/auth/url?services=mail,%20calendar')

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: 'https://login.test/authorize' });
    expect(service.getAuthorizationUrl).toHaveBeenCalledWith(USER_ID, ['mail', 'calendar']);
  });

  it('defaults to an empty service list', async () => {
    const service = { getAuthorizationUrl: jest.fn().mockResolvedValue('https://login.test/authorize') };

    await request(buildApp({ service })).get('/azure/auth/url').expect(200);

    expect(service.getAuthorizationUrl).toHaveBeenCalledWith(USER_ID, []);
  });

  it('401s without a user context', async () => {
    const response = await request(buildApp({ user: null })).get('/azure/auth/url');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Authentication required');
  });

  it('503s when the auth service is not registered', async () => {
    const response = await request(buildApp({ service: undefined })).get('/azure/auth/url');

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('Azure Auth Service not available');
  });

  it('500s with the service message when authorization fails', async () => {
    const service = {
      getAuthorizationUrl: jest.fn().mockRejectedValue(new Error('AzureConfigurationMissing: no client id')),
    };

    const response = await request(buildApp({ service })).get('/azure/auth/url');

    expect(response.status).toBe(500);
    expect(response.body.error).toContain('no client id');
  });
});

describe('GET /azure/auth/callback', () => {
  it('exchanges the code and redirects to the success URL', async () => {
    const service = { handleAuthCallback: jest.fn().mockResolvedValue({ status: 'CONNECTED' }) };

    const response = await request(buildApp({ service }))
      .get('/azure/auth/callback?code=abc&state=def');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(SUCCESS_REDIRECT);
    expect(service.handleAuthCallback).toHaveBeenCalledWith('abc', 'def');
  });

  it('redirects with reason=missing_params when the query is incomplete', async () => {
    const service = { handleAuthCallback: jest.fn() };

    const response = await request(buildApp({ service })).get('/azure/auth/callback?code=abc');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${FAILURE_REDIRECT}&reason=missing_params`);
    expect(service.handleAuthCallback).not.toHaveBeenCalled();
  });

  it('redirects to the failure URL when the auth service is missing', async () => {
    const response = await request(buildApp({ service: undefined }))
      .get('/azure/auth/callback?code=abc&state=def');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILURE_REDIRECT);
  });

  it('carries the error code into the redirect when the exchange fails', async () => {
    const service = {
      handleAuthCallback: jest.fn().mockRejectedValue({ code: 'InvalidOAuthState', message: 'expired' }),
    };

    const response = await request(buildApp({ service }))
      .get('/azure/auth/callback?code=abc&state=stale');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${FAILURE_REDIRECT}&reason=InvalidOAuthState`);
  });
});

describe('POST /azure/auth/disconnect', () => {
  it('revokes the account', async () => {
    const service = { revokeAccess: jest.fn().mockResolvedValue(undefined) };

    const response = await request(buildApp({ service })).post('/azure/auth/disconnect');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(service.revokeAccess).toHaveBeenCalledWith(USER_ID);
  });

  it('401s without a user context', async () => {
    await request(buildApp({ user: null })).post('/azure/auth/disconnect').expect(401);
  });

  it('503s when the auth service is not registered', async () => {
    await request(buildApp({ service: undefined })).post('/azure/auth/disconnect').expect(503);
  });

  it('500s when revocation fails', async () => {
    const service = { revokeAccess: jest.fn().mockRejectedValue(new Error('mongo down')) };

    const response = await request(buildApp({ service })).post('/azure/auth/disconnect');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('mongo down');
  });
});

describe('GET /azure/auth/status', () => {
  it('returns the connection status for the caller', async () => {
    const status = { userId: USER_ID, status: 'CONNECTED', grantedScopes: ['User.Read'] };
    const service = { getConnectionStatus: jest.fn().mockResolvedValue(status) };

    const response = await request(buildApp({ service })).get('/azure/auth/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(status);
  });

  it('401s without a user context', async () => {
    await request(buildApp({ user: null })).get('/azure/auth/status').expect(401);
  });

  it('503s when the auth service is not registered', async () => {
    await request(buildApp({ service: undefined })).get('/azure/auth/status').expect(503);
  });

  it('500s when the status read fails', async () => {
    const service = { getConnectionStatus: jest.fn().mockRejectedValue(new Error('token store down')) };

    const response = await request(buildApp({ service })).get('/azure/auth/status');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('token store down');
  });
});

describe('routes/auth.ts — defaults without redirect configuration', () => {
  it('falls back to the application URL for both redirects', async () => {
    delete process.env.AZURE_AUTH_SUCCESS_REDIRECT;
    delete process.env.AZURE_AUTH_FAILURE_REDIRECT;
    process.env.REACTORY_APPLICATION_URL = 'https://app.test';

    const service = { handleAuthCallback: jest.fn().mockResolvedValue({}) };
    const success = await request(buildApp({ service })).get('/azure/auth/callback?code=a&state=b');

    // Trailing slashes are stripped from REACTORY_APPLICATION_URL before use.
    expect(success.headers.location).toBe('https://app.test/?azure=connected');

    const failing = await request(buildApp({ service: undefined }))
      .get('/azure/auth/callback?code=a&state=b');
    expect(failing.headers.location).toBe('https://app.test/?azure=error');

    delete process.env.REACTORY_APPLICATION_URL;
  });

  it('handles a request that has no context at all', async () => {
    const response = await request(buildApp({ user: null })).get('/azure/auth/callback?code=a&state=b');

    // No context means no auth service: the callback degrades to the failure redirect.
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('azure=error');
  });

  it('ignores an empty services query parameter', async () => {
    const service = { getAuthorizationUrl: jest.fn().mockResolvedValue('https://login.test/authorize') };

    await request(buildApp({ service })).get('/azure/auth/url?services=').expect(200);

    expect(service.getAuthorizationUrl).toHaveBeenCalledWith(USER_ID, []);
  });
});

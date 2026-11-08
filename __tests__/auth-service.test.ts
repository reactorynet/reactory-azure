import ApiError from '@reactory/server-core/exceptions';

/**
 * No tenant, no network: the MSAL application, the Mongo model and Redis are all
 * fakes. What is asserted is the module's own contract - the PKCE URL, the state
 * handshake, the encryption boundary and the legacy token bridge.
 */
jest.mock('../models/AzureToken', () => {
  const AzureToken = {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };

  return { __esModule: true, AzureToken, default: AzureToken };
});

// eslint-disable-next-line import/first
import { AzureToken } from '../models/AzureToken';
// eslint-disable-next-line import/first
import { AzureAuthService } from '../services/AzureAuthService';
// eslint-disable-next-line import/first
import {
  AzureConnectionStatus,
  LEGACY_SCOPE_UNVERIFIED,
} from '../types/azure.types';
// eslint-disable-next-line import/first
import { decryptToken, encryptToken } from '../utils/token-encryption';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const MASTER_KEY = 'unit-test-encryption-key';
const SALT = 'per-user-salt';

const model = AzureToken as unknown as {
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
};

function fakeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

function fakeUserService(accessToken?: string) {
  return {
    findUserById: jest.fn().mockResolvedValue(
      accessToken
        ? { getAuthentication: (provider: string) => (provider === 'microsoft' ? { props: { accessToken } } : null) }
        : { getAuthentication: () => null },
    ),
  };
}

function createService(options: { accessToken?: string } = {}) {
  const context: any = { getService: jest.fn(() => undefined), error: jest.fn() };
  const service = new AzureAuthService({} as any, context);
  const redis = fakeRedis();
  const userService = fakeUserService(options.accessToken);

  service.setRedisService(redis);
  service.setUserService(userService);

  return { service, redis, userService, context };
}

function vaultRecord(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    accessTokenEncrypted: encryptToken('vault-access-token', MASTER_KEY, SALT),
    refreshTokenEncrypted: encryptToken('vault-refresh-token', MASTER_KEY, SALT),
    accessTokenExpiry: new Date(Date.now() + 3_600_000),
    grantedScopes: ['User.Read', 'Mail.ReadWrite'],
    azureUserId: 'oid-1',
    tenantId: 'tid-1',
    upn: 'user@contoso.com',
    encryptionSalt: SALT,
    connectedAt: new Date('2026-01-01T00:00:00Z'),
    lastRefreshedAt: new Date('2026-01-02T00:00:00Z'),
    revokedAt: undefined,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const originalEnv = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    AZURE_CLIENT_ID: 'client-id',
    AZURE_CLIENT_SECRET: 'client-secret',
    AZURE_TENANT_ID: 'tenant-id',
    AZURE_REDIRECT_URI: 'https://example.test/azure/auth/callback',
    AZURE_TOKEN_ENCRYPTION_KEY: MASTER_KEY,
  };
});

afterAll(() => {
  process.env = originalEnv;
});

describe('AzureAuthService — authorization URL', () => {
  it('uses PKCE S256, the code flow and offline_access, and stores the state', async () => {
    const { service, redis } = createService();

    const url = await service.getAuthorizationUrl(USER_ID, ['mail']);
    const parsed = new URL(url);

    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toContain('offline_access');
    expect(parsed.searchParams.get('scope')).toContain('Mail.ReadWrite');
    expect(parsed.searchParams.get('client_id')).toBe('client-id');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(url).toContain('offline_access');

    const state = parsed.searchParams.get('state');
    expect(state).toBeTruthy();

    // The state is in Redis for 600 s, with the verifier needed to redeem it.
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, payload, ttl] = redis.set.mock.calls[0];

    expect(key).toBe(`azure:oauth:state:${state}`);
    expect(ttl).toBe(600);
    expect(JSON.parse(payload)).toMatchObject({ userId: USER_ID });
    expect(JSON.parse(payload).codeVerifier).toBeTruthy();
  });

  it('accepts literal Microsoft permission names as well as capability keys', async () => {
    const { service } = createService();

    const parsed = new URL(await service.getAuthorizationUrl(USER_ID, ['Mail.Read']));
    expect(parsed.searchParams.get('scope')).toContain('Mail.Read');
  });

  it('fails loudly when the app registration is not configured', async () => {
    delete process.env.AZURE_CLIENT_ID;
    const { service } = createService();

    await expect(service.getAuthorizationUrl(USER_ID)).rejects.toMatchObject({
      code: 'AzureConfigurationMissing',
    });
  });
});

describe('AzureAuthService — callback', () => {
  it('rejects an unknown state', async () => {
    const { service } = createService();

    await expect(service.handleAuthCallback('code', 'unknown-state')).rejects.toMatchObject({
      code: 'InvalidOAuthState',
    });
  });

  it('exchanges the code, encrypts both tokens and never stores plaintext', async () => {
    const { service, redis } = createService();
    const state = 'state-abc';
    const verifier = 'verifier-xyz';

    redis.get.mockResolvedValue(JSON.stringify({
      userId: USER_ID,
      scopes: ['User.Read', 'offline_access'],
      codeVerifier: verifier,
      nonce: 'nonce',
      createdAt: new Date().toISOString(),
    }));

    service.setMsalClient({
      acquireTokenByCode: jest.fn().mockResolvedValue({
        accessToken: 'plain-access',
        refreshToken: 'plain-refresh',
        expiresOn: new Date(Date.now() + 3_600_000),
        scopes: ['User.Read', 'offline_access'],
        idTokenClaims: { oid: 'oid-1', tid: 'tid-1', preferred_username: 'user@contoso.com' },
      }),
    });

    model.findOne.mockResolvedValue(null);
    model.findOneAndUpdate.mockResolvedValue(vaultRecord());
    model.findOne.mockResolvedValue(vaultRecord());

    await service.handleAuthCallback('code-1', state);

    const msal = (service as any)._msalClient;
    expect(msal.acquireTokenByCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'code-1', codeVerifier: verifier }),
    );

    const [, update] = model.findOneAndUpdate.mock.calls[0];
    expect(update.accessTokenEncrypted).not.toContain('plain-access');
    expect(update.refreshTokenEncrypted).not.toContain('plain-refresh');
    expect(decryptToken(update.accessTokenEncrypted, MASTER_KEY, update.encryptionSalt)).toBe('plain-access');
    expect(update.azureUserId).toBe('oid-1');
    expect(update.tenantId).toBe('tid-1');
    expect(update.upn).toBe('user@contoso.com');

    // The state is single-use.
    expect(redis.del).toHaveBeenCalledWith(`azure:oauth:state:${state}`);
  });
});

describe('AzureAuthService — token resolution', () => {
  it('returns a vaulted token and caches it to expiry minus 60 s', async () => {
    const { service, redis } = createService();
    model.findOne.mockResolvedValue(vaultRecord());

    const result = await service.getToken(USER_ID);

    expect(result).toEqual({ token: 'vault-access-token', source: 'vault' });

    const setCall = redis.set.mock.calls.find(([key]) => key === `azure:${USER_ID}:token`);
    expect(setCall).toBeDefined();
    expect(setCall[2]).toBeGreaterThan(3000);
    expect(setCall[2]).toBeLessThanOrEqual(3540);
  });

  it('serves a cached vault token without decrypting or refreshing', async () => {
    const { service, redis } = createService();
    const record = vaultRecord();
    model.findOne.mockResolvedValue(record);
    redis.get.mockResolvedValue(JSON.stringify({
      token: 'cached-token',
      expiresAt: new Date(Date.now() + 600_000),
    }));

    const msal = { acquireTokenByRefreshToken: jest.fn() };
    service.setMsalClient(msal);

    await expect(service.getToken(USER_ID)).resolves.toEqual({
      token: 'cached-token',
      source: 'vault',
    });

    // Revocation is decided from the row, so exactly one read happens - the cache
    // only saves the deliberately expensive scrypt decrypt and any refresh.
    expect(model.findOne).toHaveBeenCalledTimes(1);
    expect(msal.acquireTokenByRefreshToken).not.toHaveBeenCalled();
    expect(record.save).not.toHaveBeenCalled();
  });

  it('falls back to the legacy User-document token and NEVER caches it', async () => {
    const { service, redis } = createService({ accessToken: 'legacy-access-token' });
    model.findOne.mockResolvedValue(null);

    const result = await service.getToken(USER_ID);

    expect(result).toEqual({ token: 'legacy-access-token', source: 'legacy' });
    expect(redis.set).not.toHaveBeenCalled();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('raises NotConnected when neither a vault nor a legacy token exists', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(null);

    await expect(service.getToken(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('reports legacy:unverified scopes rather than an empty grant', async () => {
    const { service } = createService({ accessToken: 'legacy-access-token' });
    model.findOne.mockResolvedValue(null);

    await expect(service.getGrantedScopes(USER_ID)).resolves.toEqual([LEGACY_SCOPE_UNVERIFIED]);
  });

  it('reports the vault scopes when a record exists', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord());

    await expect(service.getGrantedScopes(USER_ID)).resolves.toEqual(['User.Read', 'Mail.ReadWrite']);
  });

  it('refreshes an expired vault token before returning it', async () => {
    const { service } = createService();
    const record = vaultRecord({ accessTokenExpiry: new Date(Date.now() + 1_000) });
    model.findOne.mockResolvedValue(record);

    service.setMsalClient({
      acquireTokenByRefreshToken: jest.fn().mockResolvedValue({
        accessToken: 'refreshed-access',
        refreshToken: 'refreshed-refresh',
        expiresOn: new Date(Date.now() + 3_600_000),
      }),
    });

    const result = await service.getToken(USER_ID);

    expect(result).toEqual({ token: 'refreshed-access', source: 'vault' });
    expect(record.save).toHaveBeenCalled();
    expect(decryptToken(record.accessTokenEncrypted, MASTER_KEY, SALT)).toBe('refreshed-access');
  });
});

describe('AzureAuthService — connection status', () => {
  it('reports LEGACY for a user served by the bridge', async () => {
    const { service } = createService({ accessToken: 'legacy-access-token' });
    model.findOne.mockResolvedValue(null);

    const status = await service.getConnectionStatus(USER_ID);

    expect(status.status).toBe(AzureConnectionStatus.LEGACY);
    expect(status.tokenSource).toBe('legacy');
    expect(status.grantedScopes).toEqual([LEGACY_SCOPE_UNVERIFIED]);
  });

  it('reports CONNECTED for a live vault token', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord());

    const status = await service.getConnectionStatus(USER_ID);

    expect(status.status).toBe(AzureConnectionStatus.CONNECTED);
    expect(status.tokenSource).toBe('vault');
    expect(status.upn).toBe('user@contoso.com');
  });

  it('reports REVOKED after a disconnect', async () => {
    const { service, redis } = createService();
    const record = vaultRecord();
    model.findOne.mockResolvedValue(record);

    await service.revokeAccess(USER_ID);

    expect(record.revokedAt).toBeInstanceOf(Date);
    expect(record.save).toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith(`azure:${USER_ID}:token`);
    expect((await service.getConnectionStatus(USER_ID)).status).toBe(AzureConnectionStatus.REVOKED);
  });

  it('reports DISCONNECTED for a user with no credential at all', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(null);

    const status = await service.getConnectionStatus(USER_ID);

    expect(status.status).toBe(AzureConnectionStatus.DISCONNECTED);
    expect(status.grantedScopes).toEqual([]);
  });
});

describe('AzureAuthService — profile', () => {
  it('maps /me onto firstName/lastName/email without fetching a photo', async () => {
    const { service } = createService();
    const request = jest.fn().mockResolvedValue({
      givenName: 'Ada',
      surname: 'Lovelace',
      mail: 'ada@contoso.com',
      userPrincipalName: 'ada@contoso.onmicrosoft.com',
    });
    const requestRaw = jest.fn();
    service.setGraphProvider({ request, requestRaw });

    const details = await service.getUserDetails(USER_ID);

    expect(details).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@contoso.com',
      avatar: null,
    });
    expect(request).toHaveBeenCalledWith(USER_ID, '/me', expect.objectContaining({ select: expect.any(String) }));
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it('fetches the photo only when asked, as a data URI', async () => {
    const { service } = createService();
    service.setGraphProvider({
      request: jest.fn().mockResolvedValue({ givenName: 'Ada', surname: 'Lovelace', mail: 'ada@contoso.com' }),
      requestRaw: jest.fn().mockResolvedValue({
        buffer: Buffer.from('image-bytes'),
        contentType: 'image/png',
        status: 200,
        headers: {},
      }),
    });

    const details = await service.getUserDetails(USER_ID, { profileImage: true, imageSize: '48x48' });

    expect(details.avatar).toBe(`data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`);
  });

  it('returns a null avatar when the photo cannot be read', async () => {
    const { service } = createService();
    service.setGraphProvider({
      request: jest.fn().mockResolvedValue({ givenName: 'Ada', surname: 'Lovelace', mail: 'ada@contoso.com' }),
      requestRaw: jest.fn().mockRejectedValue(new ApiError('ImageNotFound', { code: 'ImageNotFound' })),
    });

    await expect(service.getUserDetails(USER_ID, { profileImage: true })).resolves.toMatchObject({ avatar: null });
  });
});

/**
 * F1 regression: a revoked vault row is TERMINAL for token resolution.
 *
 * The defect this covers: the user connected through the new flow (so an
 * AzureToken row exists), disconnected, and *also* still carries a Microsoft
 * authentication on the User document. Previously getToken() fell through to that
 * legacy token, so `azureDisconnect` reported REVOKED while every Graph call kept
 * authenticating. Requirement 4b(a) scopes the bridge to "when no AzureToken row
 * exists", and revokeAccess' contract is that the local revocation stops the tokens
 * being served.
 */
describe('AzureAuthService — revoked row is terminal (F1 regression)', () => {
  function revokedRow(overrides: Record<string, unknown> = {}) {
    return vaultRecord({ revokedAt: new Date('2026-11-01T10:00:00Z'), ...overrides });
  }

  it('refuses to serve the legacy User-document token when the row is revoked', async () => {
    // Both credentials are present: a revoked vault row AND a live legacy token.
    const { service, redis } = createService({ accessToken: 'legacy-token-still-live' });
    model.findOne.mockResolvedValue(revokedRow());

    await expect(service.getToken(USER_ID)).rejects.toMatchObject({
      code: 'NotConnected',
      revoked: true,
      status: AzureConnectionStatus.REVOKED,
    });

    // No cached vault token is left behind for a later request to pick up.
    expect(redis.del).toHaveBeenCalledWith(`azure:${USER_ID}:token`);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('reports no granted scopes for the revoked state, not legacy:unverified', async () => {
    const { service } = createService({ accessToken: 'legacy-token-still-live' });
    model.findOne.mockResolvedValue(revokedRow());

    const scopes = await service.getGrantedScopes(USER_ID);

    expect(scopes).toEqual([]);
    expect(scopes).not.toContain(LEGACY_SCOPE_UNVERIFIED);
  });

  it('reports hasValidToken false and status REVOKED, so all four agree', async () => {
    const { service } = createService({ accessToken: 'legacy-token-still-live' });
    model.findOne.mockResolvedValue(revokedRow());

    await expect(service.hasValidToken(USER_ID)).resolves.toBe(false);
    await expect(service.getConnectionStatus(USER_ID)).resolves.toMatchObject({
      status: AzureConnectionStatus.REVOKED,
      tokenSource: 'vault',
    });
    await expect(service.getToken(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('still honours the legacy bridge when NO row exists at all', async () => {
    // The positive control: this is the state the bridge exists for.
    const { service } = createService({ accessToken: 'legacy-token-live' });
    model.findOne.mockResolvedValue(null);

    await expect(service.getToken(USER_ID)).resolves.toEqual({
      token: 'legacy-token-live',
      source: 'legacy',
    });
    await expect(service.getGrantedScopes(USER_ID)).resolves.toEqual([LEGACY_SCOPE_UNVERIFIED]);
    await expect(service.getConnectionStatus(USER_ID)).resolves.toMatchObject({
      status: AzureConnectionStatus.LEGACY,
    });
  });

  it('raises NotConnected after a real disconnect, even with a legacy token present', async () => {
    const { service } = createService({ accessToken: 'legacy-token-still-live' });
    const record = vaultRecord();
    model.findOne.mockResolvedValue(record);

    await service.revokeAccess(USER_ID);

    expect(record.revokedAt).toBeInstanceOf(Date);
    await expect(service.getToken(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
  });
});

describe('AzureAuthService — hasValidToken', () => {
  it('is true for a live vault row and false for a revoked one', async () => {
    const { service } = createService();

    model.findOne.mockResolvedValue(vaultRecord());
    await expect(service.hasValidToken(USER_ID)).resolves.toBe(true);

    model.findOne.mockResolvedValue(vaultRecord({ revokedAt: new Date() }));
    await expect(service.hasValidToken(USER_ID)).resolves.toBe(false);
  });

  it('is true for a legacy token and false when neither exists', async () => {
    const legacy = createService({ accessToken: 'legacy-token' });
    model.findOne.mockResolvedValue(null);
    await expect(legacy.service.hasValidToken(USER_ID)).resolves.toBe(true);

    const none = createService();
    model.findOne.mockResolvedValue(null);
    await expect(none.service.hasValidToken(USER_ID)).resolves.toBe(false);
  });

  it('is false when the lookup throws', async () => {
    const { service } = createService();
    model.findOne.mockRejectedValue(new Error('mongo down'));

    await expect(service.hasValidToken(USER_ID)).resolves.toBe(false);
  });
});

describe('AzureAuthService — getAuthorizedClient', () => {
  it('returns a client from the Graph provider for a connected user', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord());

    const client = { kind: 'graph-client' };
    const provider = { getClient: jest.fn(() => client) };
    service.setGraphProvider(provider);

    await expect(service.getAuthorizedClient(USER_ID)).resolves.toBe(client);
    expect(provider.getClient).toHaveBeenCalledWith(USER_ID);
  });

  it('throws GraphProviderUnavailable when no provider is registered', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord());

    await expect(service.getAuthorizedClient(USER_ID)).rejects.toMatchObject({
      code: 'GraphProviderUnavailable',
    });
  });

  it('fails fast with NotConnected rather than returning a client that will 401', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(null);

    const provider = { getClient: jest.fn() };
    service.setGraphProvider(provider);

    await expect(service.getAuthorizedClient(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
    expect(provider.getClient).not.toHaveBeenCalled();
  });
});

describe('AzureAuthService — refresh failures', () => {
  it('rejects NotConnected when there is no vaulted row to refresh', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(null);

    await expect(service.refreshAccessToken(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('raises TokenRefreshFailed when Microsoft rejects the refresh', async () => {
    const { service } = createService();
    const record = vaultRecord();
    model.findOne.mockResolvedValue(record);

    service.setMsalClient({
      acquireTokenByRefreshToken: jest.fn().mockRejectedValue({
        errorCode: 'temporarily_unavailable',
        errorMessage: 'try later',
      }),
    });

    await expect(service.refreshAccessToken(USER_ID)).rejects.toMatchObject({
      code: 'TokenRefreshFailed',
    });
    // A transient failure must not revoke the user's connection.
    expect(record.revokedAt).toBeUndefined();
  });

  it('marks the row revoked on invalid_grant', async () => {
    const { service } = createService();
    const record = vaultRecord();
    model.findOne.mockResolvedValue(record);

    service.setMsalClient({
      acquireTokenByRefreshToken: jest.fn().mockRejectedValue({
        errorCode: 'invalid_grant',
        errorMessage: 'AADSTS700082: refresh token expired',
      }),
    });

    await expect(service.refreshAccessToken(USER_ID)).rejects.toMatchObject({
      code: 'TokenRefreshFailed',
    });
    expect(record.revokedAt).toBeInstanceOf(Date);
    expect(record.save).toHaveBeenCalled();
  });

  it('rejects TokenRefreshFailed when the refresh returns no access token', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord());

    service.setMsalClient({
      acquireTokenByRefreshToken: jest.fn().mockResolvedValue({ accessToken: null }),
    });

    await expect(service.refreshAccessToken(USER_ID)).rejects.toMatchObject({
      code: 'TokenRefreshFailed',
    });
  });

  it('refreshes a row whose expiry is unreadable', async () => {
    const { service } = createService();
    const record = vaultRecord({ accessTokenExpiry: new Date('not-a-date') });
    model.findOne.mockResolvedValue(record);

    service.setMsalClient({
      acquireTokenByRefreshToken: jest.fn().mockResolvedValue({
        accessToken: 'renewed',
        expiresOn: new Date(Date.now() + 3_600_000),
      }),
    });

    await expect(service.getToken(USER_ID)).resolves.toEqual({ token: 'renewed', source: 'vault' });
  });
});

describe('AzureAuthService — remaining edges', () => {
  it('getToken rejects without a userId', async () => {
    const { service } = createService();
    await expect(service.getToken('')).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('treats a malformed cache entry as a miss', async () => {
    const { service, redis } = createService();
    redis.get.mockResolvedValue('not-json');
    model.findOne.mockResolvedValue(vaultRecord());

    await expect(service.getToken(USER_ID)).resolves.toMatchObject({ source: 'vault' });
  });

  it('reports TOKEN_EXPIRED for a vault row within the refresh buffer', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord({ accessTokenExpiry: new Date(Date.now() + 5_000) }));

    await expect(service.getConnectionStatus(USER_ID)).resolves.toMatchObject({
      status: AzureConnectionStatus.TOKEN_EXPIRED,
    });
  });

  it('falls back to NotConnected when the user service cannot look users up', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(null);
    service.setUserService({});

    await expect(service.getToken(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('requestAdditionalScopes merges the current grant with the new services', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord());

    const url = new URL(await service.requestAdditionalScopes(USER_ID, ['calendar']));

    expect(url.searchParams.get('scope')).toContain('Mail.ReadWrite');
    expect(url.searchParams.get('scope')).toContain('Calendars.ReadWrite');
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('getProfileImage returns null for an empty buffer', async () => {
    const { service } = createService();
    service.setGraphProvider({
      requestRaw: jest.fn().mockResolvedValue({ buffer: Buffer.alloc(0), contentType: 'image/jpeg' }),
    });

    await expect(service.getProfileImage(USER_ID)).resolves.toBeNull();
  });

  it('getProfileImage defaults to image/jpeg when no content type is returned', async () => {
    const { service } = createService();
    service.setGraphProvider({
      requestRaw: jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), contentType: undefined }),
    });

    await expect(service.getProfileImage(USER_ID)).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('x').toString('base64')}`,
    );
  });

  it('getGrantedScopes returns [] when a row exists with no scopes recorded', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord({ grantedScopes: undefined }));

    await expect(service.getGrantedScopes(USER_ID)).resolves.toEqual([]);
  });

  it('getConnectionStatus tolerates a row with no upn', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord({ upn: '', tenantId: '' }));

    await expect(service.getConnectionStatus(USER_ID)).resolves.toMatchObject({
      upn: undefined,
      tenantId: undefined,
    });
  });
});

describe('AzureAuthService — callback failure modes', () => {
  it('rejects a callback missing the code or the state', async () => {
    const { service } = createService();

    await expect(service.handleAuthCallback('', 'state')).rejects.toMatchObject({ code: 'InvalidOAuthState' });
    await expect(service.handleAuthCallback('code', '')).rejects.toMatchObject({ code: 'InvalidOAuthState' });
  });

  it('rejects an unreadable state payload', async () => {
    const { service, redis } = createService();
    redis.get.mockResolvedValue('not-json');

    await expect(service.handleAuthCallback('code', 'state')).rejects.toMatchObject({
      code: 'InvalidOAuthState',
    });
  });

  it('rejects TokenExchangeFailed when Microsoft refuses the code, and audits the failure', async () => {
    const { service, redis } = createService();
    redis.get.mockResolvedValue(JSON.stringify({
      userId: USER_ID,
      scopes: ['User.Read'],
      codeVerifier: 'verifier',
      nonce: 'n',
      createdAt: new Date().toISOString(),
    }));

    service.setMsalClient({
      acquireTokenByCode: jest.fn().mockRejectedValue({ errorCode: 'invalid_grant', errorMessage: 'bad code' }),
    });

    const audit = { logOperation: jest.fn().mockResolvedValue(undefined) };
    const contextAudit = jest.spyOn(service as any, 'auditService', 'get').mockReturnValue(audit);

    await expect(service.handleAuthCallback('code', 'state')).rejects.toMatchObject({
      code: 'TokenExchangeFailed',
    });
    expect(audit.logOperation).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));

    contextAudit.mockRestore();
  });

  it('rejects TokenExchangeFailed when no access token comes back', async () => {
    const { service, redis } = createService();
    redis.get.mockResolvedValue(JSON.stringify({
      userId: USER_ID, scopes: ['User.Read'], codeVerifier: 'v', nonce: 'n', createdAt: new Date().toISOString(),
    }));

    service.setMsalClient({ acquireTokenByCode: jest.fn().mockResolvedValue({ accessToken: null }) });

    await expect(service.handleAuthCallback('code', 'state')).rejects.toMatchObject({
      code: 'TokenExchangeFailed',
    });
  });

  it('rejects NoRefreshToken when the first consent yields no refresh token', async () => {
    const { service, redis } = createService();
    redis.get.mockResolvedValue(JSON.stringify({
      userId: USER_ID, scopes: ['User.Read'], codeVerifier: 'v', nonce: 'n', createdAt: new Date().toISOString(),
    }));

    service.setMsalClient({
      acquireTokenByCode: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: null }),
    });
    model.findOne.mockResolvedValue(null);

    await expect(service.handleAuthCallback('code', 'state')).rejects.toMatchObject({
      code: 'NoRefreshToken',
    });
  });

  it('reuses the stored refresh token when a re-consent does not re-issue one', async () => {
    const { service, redis } = createService();
    redis.get.mockResolvedValue(JSON.stringify({
      userId: USER_ID, scopes: ['User.Read'], codeVerifier: 'v', nonce: 'n', createdAt: new Date().toISOString(),
    }));

    service.setMsalClient({
      acquireTokenByCode: jest.fn().mockResolvedValue({
        accessToken: 'new-access',
        // no refreshToken: Microsoft only re-issues one on the first consent
        expiresOn: new Date(Date.now() + 3_600_000),
        scopes: ['User.Read', 'offline_access'],
        idTokenClaims: { oid: 'oid-1', tid: 'tid-1', preferred_username: 'user@contoso.com' },
      }),
    });

    const existing = vaultRecord();
    model.findOne.mockResolvedValue(existing);
    model.findOneAndUpdate.mockResolvedValue(existing);

    await service.handleAuthCallback('code', 'state');

    const [, update] = model.findOneAndUpdate.mock.calls[0];
    expect(decryptToken(update.refreshTokenEncrypted, MASTER_KEY, update.encryptionSalt)).toBe('vault-refresh-token');
    // The salt is stable across re-connects, so previously vaulted data stays readable.
    expect(update.encryptionSalt).toBe(SALT);
  });

  it('falls back to a one-hour lifetime when Microsoft returns no expiry', async () => {
    const { service, redis } = createService();
    redis.get.mockResolvedValue(JSON.stringify({
      userId: USER_ID, scopes: ['User.Read'], codeVerifier: 'v', nonce: 'n', createdAt: new Date().toISOString(),
    }));

    service.setMsalClient({
      acquireTokenByCode: jest.fn().mockResolvedValue({
        accessToken: 'a', refreshToken: 'r', scopes: ['User.Read'],
      }),
    });
    model.findOne.mockResolvedValue(null);
    model.findOneAndUpdate.mockResolvedValue(vaultRecord());

    await service.handleAuthCallback('code', 'state');

    const [, update] = model.findOneAndUpdate.mock.calls[0];
    const ttlMs = new Date(update.accessTokenExpiry).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(3_500_000);
    expect(ttlMs).toBeLessThanOrEqual(3_600_000);
  });
});

describe('AzureAuthService — lazily built MSAL client', () => {
  it('constructs the confidential client from configuration exactly once', () => {
    const { service } = createService();

    const first = (service as any).msalClient;
    const second = (service as any).msalClient;

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });
});

describe('AzureAuthService — configuration guards and revocation edges', () => {
  it('refuses to handle a vaulted token when the encryption key is missing', async () => {
    delete process.env.AZURE_TOKEN_ENCRYPTION_KEY;
    const { service } = createService();
    model.findOne.mockResolvedValue(vaultRecord());

    await expect(service.getToken(USER_ID)).rejects.toMatchObject({
      code: 'AzureConfigurationMissing',
    });
  });

  it('revokeAccess resolves when there is no vault row', async () => {
    const { service, redis } = createService();
    model.findOne.mockResolvedValue(null);

    await expect(service.revokeAccess(USER_ID)).resolves.toBeUndefined();
    expect(redis.del).toHaveBeenCalledWith(`azure:${USER_ID}:token`);
  });

  it('revokeAccess does not re-save an already revoked row', async () => {
    const { service } = createService();
    const record = vaultRecord({ revokedAt: new Date('2026-11-01T00:00:00Z') });
    model.findOne.mockResolvedValue(record);

    await service.revokeAccess(USER_ID);

    expect(record.save).not.toHaveBeenCalled();
  });

  it('treats a failing user lookup as "no legacy token"', async () => {
    const { service } = createService();
    model.findOne.mockResolvedValue(null);
    service.setUserService({ findUserById: jest.fn().mockRejectedValue(new Error('user db down')) });

    await expect(service.getToken(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('requests only the default scopes when no service is named', async () => {
    const { service } = createService();

    const url = new URL(await service.getAuthorizationUrl(USER_ID, []));
    const scope = url.searchParams.get('scope');

    expect(scope).toContain('offline_access');
    expect(scope).toContain('User.Read');
    expect(scope).not.toContain('Mail.');
  });
});

describe('AzureAuthService — dependency fallbacks through the context', () => {
  it('rejects getAuthorizationUrl without a userId', async () => {
    const { service } = createService();
    await expect(service.getAuthorizationUrl('')).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('names every missing configuration variable at once', async () => {
    delete process.env.AZURE_CLIENT_SECRET;
    delete process.env.AZURE_REDIRECT_URI;
    const { service } = createService();

    await expect(service.getAuthorizationUrl(USER_ID)).rejects.toMatchObject({
      code: 'AzureConfigurationMissing',
    });
    await expect(service.getAuthorizationUrl(USER_ID)).rejects.toThrow(/AZURE_CLIENT_SECRET/);
    await expect(service.getAuthorizationUrl(USER_ID)).rejects.toThrow(/AZURE_REDIRECT_URI/);
  });

  it('resolves Redis and the user service from the context when no setter was called', async () => {
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn() };
    const userService = {
      findUserById: jest.fn().mockResolvedValue({
        getAuthentication: () => ({ props: { accessToken: 'context-legacy-token' } }),
      }),
    };

    const context: any = {
      getService: jest.fn((id: string) => {
        if (id === 'core.RedisService@1.0.0') return redis;
        if (id === 'core.UserService@1.0.0') return userService;
        return undefined;
      }),
      error: jest.fn(),
    };

    const service = new AzureAuthService({} as any, context);
    model.findOne.mockResolvedValue(null);

    // The PKCE URL is stored through the context-provided Redis, ...
    await service.getAuthorizationUrl(USER_ID);
    expect(redis.set).toHaveBeenCalledTimes(1);

    // ... and the legacy token is read through the context-provided UserService.
    await expect(service.getToken(USER_ID)).resolves.toEqual({
      token: 'context-legacy-token',
      source: 'legacy',
    });
  });

  it('getUserDetails rejects GraphProviderUnavailable without a provider', async () => {
    const { service } = createService();

    await expect(service.getUserDetails(USER_ID)).rejects.toMatchObject({
      code: 'GraphProviderUnavailable',
    });
  });

  it('handleAuthCallback tolerates an audit lookup that throws', async () => {
    const context: any = {
      getService: jest.fn((id: string) => {
        if (id === 'azure.AzureAuditService@1.0.0') throw new Error('container not ready');
        return undefined;
      }),
      error: jest.fn(),
    };
    const service = new AzureAuthService({} as any, context);
    const redis = {
      get: jest.fn().mockResolvedValue(JSON.stringify({
        userId: USER_ID, scopes: ['User.Read'], codeVerifier: 'v', nonce: 'n', createdAt: new Date().toISOString(),
      })),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
    };
    service.setRedisService(redis);
    service.setMsalClient({ acquireTokenByCode: jest.fn().mockRejectedValue({ errorCode: 'invalid_grant' }) });

    await expect(service.handleAuthCallback('code', 'state')).rejects.toMatchObject({
      code: 'TokenExchangeFailed',
    });
  });
});

import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import crypto from 'crypto';
import { ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node';
import { AzureToken } from '../models/AzureToken';
import {
  AzureConnectionStatus,
  LEGACY_SCOPE_UNVERIFIED,
  type AzureTokenSource,
  type IAzureConfig,
  type IAzureConnection,
  type IAzureTokenRecord,
  type IAzureTokenResult,
  type IAzureUserDetails,
  type IAzureUserDetailsOptions,
} from '../types/azure.types';
import { decryptToken, encryptToken, generateEncryptionSalt } from '../utils/token-encryption';
import { getDefaultScopes, getScopesForServices } from '../utils/scopes';
import {
  AZURE_OAUTH_STATE_TTL_SECONDS,
  oauthStateCacheKey,
  tokenCacheKey,
  tokenCacheTtlSeconds,
} from '../utils/cache-keys';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/** Microsoft's v2.0 endpoint base. A single tenant id or `organizations`. */
const LOGIN_BASE_URL = 'https://login.microsoftonline.com';

/** Refresh a vaulted token this many ms before it actually expires. */
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/** Fallback lifetime when Microsoft returns no `expiresOn`. */
const DEFAULT_TOKEN_LIFETIME_MS = 3_600_000;

/** What is stored under `azure:oauth:state:{state}` for 600 s. */
interface IOAuthStatePayload {
  userId: string;
  scopes: string[];
  codeVerifier: string;
  nonce: string;
  createdAt: string;
}

/**
 * Azure / Microsoft identity authentication and token management.
 *
 * The vault (`azure_tokens`) is the only refreshable credential store. Users who
 * signed in before this module existed are served by the **legacy bridge**: their
 * access token lives on the User document's `microsoft` authentication, which
 * `ProfileResolver.isTokenValid` refreshes - not this service. The bridge is
 * deliberately asymmetric:
 *
 *   - it never writes to AzureToken;
 *   - it never caches (a legacy token has no `scope` and no `expires`, so any TTL
 *     would be a guess and a revoked token would keep being served);
 *   - it never refreshes - a 401 raises `LegacyTokenExpired` instead;
 *   - `getGrantedScopes` returns `['legacy:unverified']`, which a scope gate must
 *     read as "attempt the call", never as "insufficient scope".
 *
 * Tokens are encrypted with AES-256-GCM under `AZURE_TOKEN_ENCRYPTION_KEY` and a
 * stable per-user salt. The token value is never logged.
 */
@service({
  id: 'azure.AzureAuthService@1.0.0',
  name: 'AzureAuthService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft identity authentication, PKCE authorisation and token vault',
  serviceType: 'authentication',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'core.UserService@1.0.0', alias: 'userService' },
    { id: 'core.RedisService@1.0.0', alias: 'redisService' },
  ],
})
class AzureAuthService implements Reactory.Service.IReactoryService {
  name: string = 'AzureAuthService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _redisService: any;
  private _userService: any;
  private _msalClient: any;
  private _cryptoProvider: CryptoProvider;
  private _graphProvider: any;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
    this._cryptoProvider = new CryptoProvider();
  }

  /** Bound by the Reactory service container from the `redisService` dependency alias. */
  setRedisService(serviceInstance: any): void {
    this._redisService = serviceInstance;
  }

  /** Bound by the Reactory service container from the `userService` dependency alias. */
  setUserService(serviceInstance: any): void {
    this._userService = serviceInstance;
  }

  /** Test seam: inject a fake MSAL application so no token endpoint is called. */
  setMsalClient(client: any): void {
    this._msalClient = client;
  }

  /** Test seam: inject a fake Graph provider. */
  setGraphProvider(provider: any): void {
    this._graphProvider = provider;
  }

  private get redisService(): any {
    if (this._redisService) return this._redisService;
    return this.context.getService('core.RedisService@1.0.0');
  }

  private get userService(): any {
    if (this._userService) return this._userService;
    return this.context.getService('core.UserService@1.0.0');
  }

  private get auditService(): any {
    try {
      return this.context.getService('azure.AzureAuditService@1.0.0');
    } catch {
      return undefined;
    }
  }

  /** The Graph provider is resolved lazily: the provider depends on this service. */
  private get graphProvider(): any {
    if (this._graphProvider) return this._graphProvider;
    return this.context.getService('azure.AzureGraphClientProvider@1.0.0');
  }

  /** Runtime configuration, validated on first use. */
  get config(): IAzureConfig {
    const tenantId = process.env.AZURE_TENANT_ID || 'organizations';

    return {
      clientId: process.env.AZURE_CLIENT_ID || '',
      clientSecret: process.env.AZURE_CLIENT_SECRET || '',
      tenantId,
      redirectUri: process.env.AZURE_REDIRECT_URI || '',
      tokenEncryptionKey: process.env.AZURE_TOKEN_ENCRYPTION_KEY || '',
      apiRateLimit: Number(process.env.AZURE_API_RATE_LIMIT || 0) || 0,
      authority: `${LOGIN_BASE_URL}/${tenantId}`,
      graphBaseUrl: 'https://graph.microsoft.com',
    };
  }

  /** Throws a typed error instead of building a half-configured client. */
  private requireConfig(): IAzureConfig {
    const config = this.config;
    const missing: string[] = [];

    if (!config.clientId) missing.push('AZURE_CLIENT_ID');
    if (!config.clientSecret) missing.push('AZURE_CLIENT_SECRET');
    if (!config.redirectUri) missing.push('AZURE_REDIRECT_URI');

    if (missing.length) {
      throw apiError(
        GraphErrorCode.MISSING_CONFIGURATION,
        `Microsoft identity is not configured: ${missing.join(', ')}`,
        { missing },
      );
    }

    return config;
  }

  /** `AZURE_TOKEN_ENCRYPTION_KEY`, required for every vault operation. */
  private get encryptionKey(): string {
    const key = process.env.AZURE_TOKEN_ENCRYPTION_KEY;
    if (!key) {
      throw apiError(
        GraphErrorCode.MISSING_CONFIGURATION,
        'AZURE_TOKEN_ENCRYPTION_KEY is not set; refusing to handle Microsoft tokens without encryption',
      );
    }
    return key;
  }

  private get cryptoProvider(): CryptoProvider {
    return this._cryptoProvider;
  }

  private get msalClient(): any {
    if (!this._msalClient) {
      const config = this.requireConfig();
      this._msalClient = new ConfidentialClientApplication({
        auth: {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          authority: config.authority,
        },
      });
    }
    return this._msalClient;
  }

  /**
   * Resolve the requested scope set.
   *
   * `services` accepts capability keys (`mail`, `calendar`, ...) and literal
   * Microsoft permission names (`Mail.Read`). Literal names are used verbatim;
   * capabilities are expanded through the registry. The defaults (which include
   * `offline_access`) are always present so a connection can outlive one token.
   */
  private resolveScopes(services: string[] = []): string[] {
    if (!services || services.length === 0) return getDefaultScopes();

    const literal = services.filter((entry) => typeof entry === 'string' && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z]/.test(entry));
    const capabilities = services.filter((entry) => !literal.includes(entry));

    const scopes = new Set<string>(getDefaultScopes());
    literal.forEach((scope) => scopes.add(scope));
    if (capabilities.length) getScopesForServices(capabilities).forEach((scope) => scopes.add(scope));

    return Array.from(scopes);
  }

  /**
   * Build the v2.0 authorization URL for a user.
   *
   * PKCE (`S256`) is mandatory: the verifier stays in Redis under the `state`
   * key for 600 s and is required to exchange the code.
   */
  async getAuthorizationUrl(userId: string, services: string[] = []): Promise<string> {
    if (!userId) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required to start the Microsoft authorization flow');
    }

    const config = this.requireConfig();
    const scopes = this.resolveScopes(services);

    const { verifier, challenge } = await this.cryptoProvider.generatePkceCodes();
    const state = crypto.randomBytes(24).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');

    const payload: IOAuthStatePayload = {
      userId: String(userId),
      scopes,
      codeVerifier: verifier,
      nonce,
      createdAt: new Date().toISOString(),
    };

    await this.redisService.set(
      oauthStateCacheKey(state),
      JSON.stringify(payload),
      AZURE_OAUTH_STATE_TTL_SECONDS,
    );

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      response_mode: 'query',
      scope: scopes.join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'consent',
    });

    return `${config.authority}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /**
   * Exchange the authorization code for tokens, encrypt them and store the vault
   * record. The state is single-use: it is deleted after a successful exchange.
   */
  async handleAuthCallback(code: string, state: string): Promise<IAzureConnection> {
    if (!code || !state) {
      throw apiError(GraphErrorCode.INVALID_OAUTH_STATE, 'The Microsoft callback is missing code or state');
    }

    const rawState = await this.redisService.get(oauthStateCacheKey(state));
    if (!rawState) {
      throw apiError(GraphErrorCode.INVALID_OAUTH_STATE, 'Invalid or expired Microsoft authorization state');
    }

    let payload: IOAuthStatePayload;
    try {
      payload = JSON.parse(rawState);
    } catch {
      throw apiError(GraphErrorCode.INVALID_OAUTH_STATE, 'The Microsoft authorization state payload is not readable');
    }

    const config = this.requireConfig();
    const key = this.encryptionKey;

    let result: any;
    try {
      result = await this.msalClient.acquireTokenByCode({
        code,
        scopes: payload.scopes,
        redirectUri: config.redirectUri,
        codeVerifier: payload.codeVerifier,
      });
    } catch (error: any) {
      await this.auditService?.logOperation?.({
        userId: payload.userId,
        operation: 'auth.callback',
        resource: 'azure_token',
        outcome: 'failure',
        durationMs: 0,
        graphCode: error?.errorCode || 'TokenExchangeFailed',
      });
      throw apiError(
        'TokenExchangeFailed',
        `Microsoft rejected the authorization code: ${error?.errorMessage || error?.message || 'unknown error'}`,
        { errorCode: error?.errorCode },
      );
    }

    if (!result?.accessToken) {
      throw apiError('TokenExchangeFailed', 'Microsoft returned no access token for the authorization code');
    }

    const existing: any = await AzureToken.findOne({ userId: payload.userId });
    const salt = existing?.encryptionSalt || generateEncryptionSalt();

    // A re-consent does not always re-issue a refresh token; keep the vaulted one.
    let refreshToken: string | undefined = result.refreshToken;
    if (!refreshToken && existing?.refreshTokenEncrypted) {
      refreshToken = decryptToken(existing.refreshTokenEncrypted, key, existing.encryptionSalt);
    }
    if (!refreshToken) {
      throw apiError(
        'NoRefreshToken',
        'Microsoft returned no refresh token; request offline_access and consent again',
      );
    }

    const claims: any = result.idTokenClaims || {};
    const expiresAt: Date = result.expiresOn instanceof Date
      ? result.expiresOn
      : new Date(Date.now() + DEFAULT_TOKEN_LIFETIME_MS);

    const grantedScopes: string[] = Array.isArray(result.scopes) && result.scopes.length
      ? result.scopes
      : payload.scopes;

    await AzureToken.findOneAndUpdate(
      { userId: payload.userId },
      {
        userId: payload.userId,
        accessTokenEncrypted: encryptToken(result.accessToken, key, salt),
        refreshTokenEncrypted: encryptToken(refreshToken, key, salt),
        accessTokenExpiry: expiresAt,
        grantedScopes,
        azureUserId: claims.oid || result.uniqueId || '',
        tenantId: claims.tid || result.tenantId || '',
        upn: claims.preferred_username || claims.upn || claims.email || result.account?.username || '',
        encryptionSalt: salt,
        connectedAt: existing?.connectedAt || new Date(),
        lastRefreshedAt: new Date(),
        revokedAt: null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await this.redisService.del(oauthStateCacheKey(state)).catch(() => {});
    await this.cacheVaultToken(payload.userId, result.accessToken, expiresAt);

    await this.auditService?.logOperation?.({
      userId: payload.userId,
      operation: 'auth.connect',
      resource: 'azure_token',
      outcome: 'success',
      durationMs: 0,
      metadata: { scopes: grantedScopes.length },
    });

    return this.getConnectionStatus(payload.userId);
  }

  /**
   * Refresh a vaulted access token.
   *
   * Only vaulted tokens can be refreshed: a legacy token is refreshed by the
   * sign-in flow that owns it (`ProfileResolver.isTokenValid`), never here.
   */
  async refreshAccessToken(userId: string): Promise<IAzureTokenRecord> {
    const record: any = await AzureToken.findOne({ userId });
    if (!record) {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        `No vaulted Microsoft token exists for user ${userId}; a legacy token cannot be refreshed here`,
      );
    }

    const key = this.encryptionKey;
    const refreshToken = decryptToken(record.refreshTokenEncrypted, key, record.encryptionSalt);

    let result: any;
    try {
      result = await this.msalClient.acquireTokenByRefreshToken({
        refreshToken,
        scopes: record.grantedScopes?.length ? record.grantedScopes : getDefaultScopes(),
      });
    } catch (error: any) {
      // A rejected refresh token usually means consent was withdrawn: mark it so
      // callers see REVOKED rather than a token that keeps failing.
      if (String(error?.errorCode || '').toLowerCase().includes('invalid_grant')) {
        record.revokedAt = new Date();
        await record.save().catch(() => {});
      }

      await this.auditService?.logOperation?.({
        userId: String(userId),
        operation: 'auth.refresh',
        resource: 'azure_token',
        outcome: 'failure',
        durationMs: 0,
        graphCode: error?.errorCode || 'RefreshFailed',
      });

      throw apiError(
        'TokenRefreshFailed',
        `Microsoft rejected the refresh token: ${error?.errorMessage || error?.message || 'unknown error'}`,
        { errorCode: error?.errorCode },
      );
    }

    if (!result?.accessToken) {
      throw apiError('TokenRefreshFailed', 'Microsoft returned no access token on refresh');
    }

    const expiresAt: Date = result.expiresOn instanceof Date
      ? result.expiresOn
      : new Date(Date.now() + DEFAULT_TOKEN_LIFETIME_MS);

    record.accessTokenEncrypted = encryptToken(result.accessToken, key, record.encryptionSalt);
    record.accessTokenExpiry = expiresAt;
    record.lastRefreshedAt = new Date();
    if (result.refreshToken) {
      record.refreshTokenEncrypted = encryptToken(result.refreshToken, key, record.encryptionSalt);
    }
    await record.save();

    await this.cacheVaultToken(String(userId), result.accessToken, expiresAt);

    await this.auditService?.logOperation?.({
      userId: String(userId),
      operation: 'auth.refresh',
      resource: 'azure_token',
      outcome: 'success',
      durationMs: 0,
    });

    return record;
  }

  /**
   * Resolve the access token to use for a user, with its provenance.
   *
   * Three states, and the difference between the last two is a security boundary:
   *
   *   1. **vault** - an `AzureToken` row exists and is not revoked. Decrypt it
   *      (refreshing first when it is within 60 s of expiry) and cache it to
   *      `expiry - 60 s`.
   *   2. **no row at all** - the user predates this module. Serve the legacy
   *      User-document token, uncached and unrefreshed.
   *   3. **row exists and is revoked** - the user disconnected. This is TERMINAL:
   *      no token is returned and the legacy bridge is **not** consulted, even when
   *      the User document still carries a live Microsoft token. Otherwise
   *      `azureDisconnect` would report REVOKED while every Graph call kept
   *      authenticating (the state that produced this rule).
   *
   * The revocation check is deliberately a database read rather than a cache read:
   * the cache is authoritative for *cost* (it skips the deliberately slow scrypt
   * decrypt), never for *permission*. `revokeAccess` also drops the cache entry.
   */
  async getToken(userId: string): Promise<IAzureTokenResult> {
    if (!userId) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required to resolve a Microsoft token');
    }

    const record: any = await AzureToken.findOne({ userId });

    // Revoked is terminal: see the JSDoc above. Never fall through to legacy.
    if (record && record.revokedAt) {
      await this.redisService.del(tokenCacheKey(String(userId))).catch(() => {});

      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        `Microsoft Graph access was revoked for user ${userId}; reconnect the account`,
        { userId, revoked: true, status: AzureConnectionStatus.REVOKED },
      );
    }

    if (record) {
      const cached = await this.readCachedToken(userId);
      if (cached) return { token: cached, source: 'vault' };

      let current = record;
      const expiryMs = new Date(current.accessTokenExpiry).getTime();

      if (!Number.isFinite(expiryMs) || expiryMs <= Date.now() + TOKEN_REFRESH_BUFFER_MS) {
        current = await this.refreshAccessToken(userId);
      }

      const token = decryptToken(current.accessTokenEncrypted, this.encryptionKey, current.encryptionSalt);
      await this.cacheVaultToken(String(userId), token, current.accessTokenExpiry);

      return { token, source: 'vault' };
    }

    // No row at all (not "no usable row") is the only state that enables the bridge.
    const legacyToken = await this.getLegacyToken(userId);
    if (legacyToken) {
      // Never cached: see the class JSDoc. The value is not logged either.
      return { token: legacyToken, source: 'legacy' };
    }

    throw apiError(
      GraphErrorCode.NOT_CONNECTED,
      `Microsoft Graph is not connected for user ${userId}`,
      { userId },
    );
  }

  /**
   * True when the user has a usable credential.
   *
   * A revoked row is false - revocation is terminal here too, so this can never
   * disagree with {@link getToken}.
   */
  async hasValidToken(userId: string): Promise<boolean> {
    try {
      const record: any = await AzureToken.findOne({ userId });
      if (record) return !record.revokedAt;

      return Boolean(await this.getLegacyToken(userId));
    } catch (error) {
      return false;
    }
  }

  /**
   * Granted scopes for a user.
   *
   * Mirrors {@link getToken}'s three states exactly, so a scope gate can never
   * describe a capability the token resolver would refuse:
   *
   *   - vault row and not revoked -> the stored `grantedScopes`;
   *   - no row at all -> `['legacy:unverified']`, which a gate must read as
   *     "attempt the call and surface the real Graph error" (see
   *     `isScopeVerificationDeferred` in utils/scopes.ts);
   *   - row revoked -> `[]`, the same answer as "no credential", because there is
   *     no usable credential. Never `['legacy:unverified']`.
   */
  async getGrantedScopes(userId: string): Promise<string[]> {
    const record: any = await AzureToken.findOne({ userId });

    if (record) {
      if (record.revokedAt) return [];

      return Array.isArray(record.grantedScopes) ? [...record.grantedScopes] : [];
    }

    const legacyToken = await this.getLegacyToken(userId);
    if (legacyToken) return [LEGACY_SCOPE_UNVERIFIED];

    return [];
  }

  /** Connection state for the `azureConnectionStatus` query. */
  async getConnectionStatus(userId: string): Promise<IAzureConnection> {
    const record: any = await AzureToken.findOne({ userId });

    if (record) {
      const base = {
        userId: String(userId),
        email: record.upn || undefined,
        upn: record.upn || undefined,
        tenantId: record.tenantId || undefined,
        grantedScopes: Array.isArray(record.grantedScopes) ? [...record.grantedScopes] : [],
        tokenSource: 'vault' as AzureTokenSource,
        connectedAt: record.connectedAt,
        lastRefreshedAt: record.lastRefreshedAt,
        expiresAt: record.accessTokenExpiry,
      };

      if (record.revokedAt) {
        return { ...base, status: AzureConnectionStatus.REVOKED };
      }

      const expired = new Date(record.accessTokenExpiry).getTime() <= Date.now() + TOKEN_REFRESH_BUFFER_MS;
      return {
        ...base,
        status: expired ? AzureConnectionStatus.TOKEN_EXPIRED : AzureConnectionStatus.CONNECTED,
      };
    }

    const legacyToken = await this.getLegacyToken(userId);
    if (legacyToken) {
      return {
        userId: String(userId),
        status: AzureConnectionStatus.LEGACY,
        grantedScopes: [LEGACY_SCOPE_UNVERIFIED],
        tokenSource: 'legacy',
      };
    }

    return {
      userId: String(userId),
      status: AzureConnectionStatus.DISCONNECTED,
      grantedScopes: [],
    };
  }

  /**
   * Disconnect the account.
   *
   * The vault row is marked revoked (never deleted - the audit trail must survive)
   * and the cache entry is dropped. No live revocation call is made: this module
   * never talks to a tenant it has no configuration for, and the local revocation
   * is what stops the tokens being served.
   */
  async revokeAccess(userId: string): Promise<void> {
    const record: any = await AzureToken.findOne({ userId });

    if (record && !record.revokedAt) {
      record.revokedAt = new Date();
      await record.save();
    }

    await this.redisService.del(tokenCacheKey(String(userId))).catch(() => {});

    await this.auditService?.logOperation?.({
      userId: String(userId),
      operation: 'auth.revoke',
      resource: 'azure_token',
      outcome: 'success',
      durationMs: 0,
    });
  }

  /** Issue an authorization URL that adds `services` to the current consent. */
  async requestAdditionalScopes(userId: string, services: string[]): Promise<string> {
    const existing = await this.getGrantedScopes(userId);
    const requested = this.resolveScopes(services);
    const combined = Array.from(new Set([...existing.join(' ').split(' '), ...requested])).filter(Boolean);

    return this.getAuthorizationUrl(userId, combined);
  }

  /**
   * A Graph client authenticated as this user.
   *
   * Resolved through `AzureGraphClientProvider@1.0.0` - there is exactly one place
   * a Graph `Client` is constructed.
   */
  async getAuthorizedClient(userId: string): Promise<any> {
    const provider = this.graphProvider;
    if (!provider) {
      throw apiError('GraphProviderUnavailable', 'azure.AzureGraphClientProvider@1.0.0 is not registered');
    }

    // Fail fast with NotConnected rather than handing back a client that will 401.
    await this.getToken(userId);

    return provider.getClient(userId);
  }

  /**
   * The signed-in user's Microsoft profile.
   *
   * Same shape the legacy shim returns (`firstName`, `lastName`, `email`,
   * `avatar`) because a core resolver consumes it. The photo is fetched only when
   * asked for.
   */
  async getUserDetails(
    userId: string,
    options: IAzureUserDetailsOptions = {},
  ): Promise<IAzureUserDetails> {
    const provider = this.graphProvider;
    if (!provider) {
      throw apiError('GraphProviderUnavailable', 'azure.AzureGraphClientProvider@1.0.0 is not registered');
    }

    const profile = await provider.request(userId, '/me', {
      select: 'givenName,surname,mail,userPrincipalName',
      operation: 'auth.getUserDetails',
    });

    const details: IAzureUserDetails = {
      firstName: profile?.givenName || '',
      lastName: profile?.surname || '',
      email: profile?.mail || profile?.userPrincipalName || '',
      avatar: null,
    };

    if (options.profileImage === true) {
      details.avatar = await this.getProfileImage(userId, options.imageSize);
    }

    return details;
  }

  /**
   * Fetch `/me/photos/{size}/$value` as a data URI.
   *
   * A missing photo is not an error (many accounts have none), so this returns
   * `null`; every other failure is also swallowed to `null` because an avatar
   * must never fail a profile read. Callers that need the photo must request it
   * explicitly.
   */
  async getProfileImage(userId: string, imageSize: string = '120x120'): Promise<string | null> {
    try {
      const response = await this.graphProvider.requestRaw(
        userId,
        `/me/photos/${imageSize}/$value`,
        { operation: 'auth.getProfileImage' },
      );

      if (!response?.buffer?.length) return null;

      const contentType = response.contentType || 'image/jpeg';
      return `data:${contentType};base64,${response.buffer.toString('base64')}`;
    } catch (error: any) {
      logger.debug(`AzureAuthService: could not fetch the profile image (${error?.code || error?.message})`);
      return null;
    }
  }

  /**
   * Read the legacy token from the user document.
   *
   * Read-only, unaudited (a token read is not an operation) and never cached. A
   * failure here means "no legacy token", not "connection error": the caller then
   * raises NotConnected.
   */
  private async getLegacyToken(userId: string): Promise<string | undefined> {
    try {
      const userService = this.userService;
      if (!userService || typeof userService.findUserById !== 'function') return undefined;

      const user: any = await userService.findUserById(String(userId));
      const authentication = user && typeof user.getAuthentication === 'function'
        ? user.getAuthentication('microsoft')
        : null;

      const token = authentication?.props?.accessToken;
      return typeof token === 'string' && token.length > 0 ? token : undefined;
    } catch (error: any) {
      logger.debug(`AzureAuthService: legacy Microsoft token lookup failed (${error?.message})`);
      return undefined;
    }
  }

  /** Read a vaulted token from Redis; a malformed entry is a miss, not an error. */
  private async readCachedToken(userId: string): Promise<string | undefined> {
    try {
      const cached = await this.redisService.get(tokenCacheKey(String(userId)));
      if (!cached) return undefined;

      const parsed = JSON.parse(cached);
      const expiresAt = parsed?.expiresAt ? new Date(parsed.expiresAt).getTime() : 0;

      if (typeof parsed?.token === 'string' && parsed.token.length && expiresAt > Date.now()) {
        return parsed.token;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Cache a vaulted token until 60 s before it expires. Never called for legacy. */
  private async cacheVaultToken(userId: string, token: string, expiresAt: Date): Promise<void> {
    const ttl = tokenCacheTtlSeconds(expiresAt);
    if (ttl <= 0) return;

    await this.redisService
      .set(tokenCacheKey(String(userId)), JSON.stringify({ token, expiresAt }), ttl)
      .catch(() => {});
  }
}

export const AzureAuthServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureAuthService> = {
  service: (props: any, context: any) => new AzureAuthService(props, context),
  id: 'azure.AzureAuthService@1.0.0',
  name: 'AzureAuthService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft identity authentication, PKCE authorisation and token vault',
  serviceType: 'authentication',
  dependencies: [
    { id: 'core.UserService@1.0.0', alias: 'userService' },
    { id: 'core.RedisService@1.0.0', alias: 'redisService' },
  ],
};

export { AzureAuthService };

/**
 * Core Azure types shared across every service in the module.
 *
 * The module identity is `core.ReactoryAzure@1.0.0`; every contributed
 * component uses the `azure` namespace (`azure.AzureMailService@1.0.0`).
 */

/** Connection state of a user's Azure / Microsoft Graph account. */
export enum AzureConnectionStatus {
  /** No AzureToken record and no legacy Microsoft authentication on the user. */
  DISCONNECTED = 'DISCONNECTED',
  /** An authorization URL has been issued and the code exchange is pending. */
  AUTHORIZING = 'AUTHORIZING',
  /** A vaulted (AzureToken) access token is present and not revoked. */
  CONNECTED = 'CONNECTED',
  /** The vaulted access token has expired; refreshToken is still usable. */
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  /** The user revoked access; a reconnect is required. */
  REVOKED = 'REVOKED',
  /**
   * No AzureToken record exists, but the user document carries a Microsoft
   * authentication from the legacy sign-in flow. The token is used as-is:
   * it is never cached and never refreshed by this module.
   */
  LEGACY = 'LEGACY',
}

/** Where the access token used for a Graph request came from. */
export type AzureTokenSource = 'vault' | 'legacy';

/**
 * Sentinel returned by `getGrantedScopes` for a legacy-sourced token.
 *
 * The user document's `authentications[].props` carries no scope string, so the
 * granted scopes are genuinely unknown. Scope gates MUST read this value as
 * "attempt the call and surface the real Graph error" - never as "insufficient
 * scope" - or every legacy user is locked out of the module.
 */
export const LEGACY_SCOPE_UNVERIFIED = 'legacy:unverified';

/** A resolved access token plus its provenance. */
export interface IAzureTokenResult {
  /** The bearer token. Never log this value. */
  token: string;
  source: AzureTokenSource;
}

/** Runtime configuration read from the `AZURE_*` environment variables. */
export interface IAzureConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
  tokenEncryptionKey: string;
  /** Requests per minute allowed per user; `0` disables the gate. */
  apiRateLimit: number;
  /** `organizations` (multi-tenant) or a single tenant id. */
  authority: string;
  /** Graph base URL for the SDK. */
  graphBaseUrl: string;
}

/** The public shape of a user's Azure connection, surfaced over GraphQL. */
export interface IAzureConnection {
  userId: string;
  status: AzureConnectionStatus;
  email?: string;
  upn?: string;
  tenantId?: string;
  grantedScopes: string[];
  /** `vault` when an AzureToken row exists, `legacy` for the User-document token. */
  tokenSource?: AzureTokenSource;
  connectedAt?: Date;
  lastRefreshedAt?: Date;
  expiresAt?: Date;
}

/** Options for `AzureAuthService.getUserDetails`. */
export interface IAzureUserDetailsOptions {
  /** When true, fetch `/me/photo/$value` and return it as a data URI. */
  profileImage?: boolean;
  /** Graph photo size, e.g. `120x120` (default). */
  imageSize?: string;
}

/** The profile shape the module returns - identical to the legacy shim's shape. */
export interface IAzureUserDetails {
  firstName: string;
  lastName: string;
  email: string;
  avatar: string | null;
}

/** Persisted token record (see models/AzureToken.ts). */
export interface IAzureTokenRecord {
  userId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  accessTokenExpiry: Date;
  grantedScopes: string[];
  azureUserId: string;
  tenantId: string;
  upn: string;
  encryptionSalt: string;
  connectedAt: Date;
  lastRefreshedAt?: Date;
  revokedAt?: Date;
}

/** Outcome values persisted to AzureAuditLog. */
export type AzureAuditOutcome = 'success' | 'failure';

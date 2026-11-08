/**
 * Redis key naming for the module: `azure:{userId}:{domain}:{key}`.
 *
 * Every cached value is namespaced by user first so a single user's cache can be
 * dropped by pattern, and by domain second so one capability never reads another's
 * data.
 */

export const AZURE_CACHE_PREFIX = 'azure';

/** Cache domains. Keep the values stable: they are part of the key contract. */
export const AzureCacheDomain = {
  TOKEN: 'token',
  CONNECTION_STATUS: 'connection',
  SCOPES: 'scopes',
  MAIL_FOLDERS: 'mail:folders',
  MAIL_MESSAGE: 'mail:message',
  CALENDAR_LIST: 'calendar:list',
  DRIVE_ITEM: 'drive:item',
  WORKBOOK_WORKSHEETS: 'workbook:worksheets',
  CONTACTS_LIST: 'contacts:list',
  SYNC_STATE: 'sync:state',
} as const;

/** `azure:{userId}:{domain}` or `azure:{userId}:{domain}:{key}`. */
export function azureCacheKey(userId: string, domain: string, key?: string): string {
  const base = `${AZURE_CACHE_PREFIX}:${userId}:${domain}`;
  return key === undefined || key === null ? base : `${base}:${key}`;
}

/** OAuth state lives for 600 s and is not user-scoped: the state token is the key. */
export const AZURE_OAUTH_STATE_TTL_SECONDS = 600;

/** `azure:oauth:state:{state}` */
export function oauthStateCacheKey(state: string): string {
  return `${AZURE_CACHE_PREFIX}:oauth:state:${state}`;
}

/** Cached vaulted access token (`azure:{userId}:token`). */
export function tokenCacheKey(userId: string): string {
  return azureCacheKey(userId, AzureCacheDomain.TOKEN);
}

/** Cached connection status (`azure:{userId}:connection`). */
export function connectionStatusCacheKey(userId: string): string {
  return azureCacheKey(userId, AzureCacheDomain.CONNECTION_STATUS);
}

/** Seconds a token may stay cached: expiry minus a 60 s safety margin. */
export function tokenCacheTtlSeconds(expiresAt: Date | string | number, now: number = Date.now()): number {
  const expiryMs = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  const ttlMs = expiryMs - now - 60_000;
  return ttlMs > 0 ? Math.floor(ttlMs / 1000) : 0;
}

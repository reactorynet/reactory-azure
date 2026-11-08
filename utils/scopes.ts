/**
 * Microsoft Graph delegated scope registry.
 *
 * Scopes are grouped per capability so a caller can request only what a feature
 * needs. `offline_access` is always requested: without it Graph issues no refresh
 * token and the connection cannot outlive the first access token.
 *
 * The directory values are Microsoft Graph permission names (`Mail.Read`), not
 * Google's URL form - they are what the v2.0 `/authorize` endpoint expects on the
 * space-separated `scope` parameter.
 */

import { LEGACY_SCOPE_UNVERIFIED } from '../types/azure.types';

/** Scopes every connection needs: identity plus a refresh token. */
export const BASE_SCOPES: string[] = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
];

/** Capability -> delegated scopes. Keys match the `services` argument of getAuthorizationUrl. */
export const AZURE_SCOPES: Record<string, string[]> = {
  profile: ['User.Read', 'User.ReadBasic.All'],
  directory: ['User.ReadBasic.All'],
  mail: ['Mail.ReadWrite', 'Mail.Send'],
  mail_read: ['Mail.Read'],
  mail_send: ['Mail.Send'],
  calendar: ['Calendars.ReadWrite'],
  calendar_read: ['Calendars.Read'],
  tasks: ['Tasks.ReadWrite'],
  drive: ['Files.ReadWrite'],
  drive_read: ['Files.Read'],
  documents: ['Files.ReadWrite'],
  workbook: ['Files.ReadWrite'],
  contacts: ['Contacts.ReadWrite', 'People.Read'],
  contacts_read: ['Contacts.Read', 'People.Read'],
  teams: ['Chat.ReadWrite', 'ChannelMessage.Read.All', 'Team.ReadBasic.All', 'Channel.ReadBasic.All'],
  sharepoint: ['Sites.ReadWrite.All'],
  presence: ['Presence.Read'],
};

/** Default scopes: identity only (plus offline_access). */
export function getDefaultScopes(): string[] {
  return [...BASE_SCOPES];
}

/** Union of the default scopes and every scope implied by `services`. */
export function getScopesForServices(services: string[] = []): string[] {
  const scopes = new Set<string>(BASE_SCOPES);

  for (const service of services) {
    const requested = AZURE_SCOPES[service];
    if (requested) {
      for (const scope of requested) scopes.add(scope);
    }
  }

  return Array.from(scopes);
}

/**
 * True when the granted set cannot be verified and the gate must stand aside.
 *
 * `getGrantedScopes` returns `['legacy:unverified']` for a user served by the
 * legacy User-document bridge: that token carries no scope string, so the
 * module genuinely does not know what was granted. Requirement 4b(c) is explicit
 * that this must be read as *attempt the call and surface the real Graph error*,
 * never as *insufficient scope* - otherwise every legacy user is locked out of
 * every capability the moment a gate is added.
 */
export function isScopeVerificationDeferred(granted: string[]): boolean {
  return Array.isArray(granted) && granted.includes(LEGACY_SCOPE_UNVERIFIED);
}

/**
 * True when every scope in `required` is present in `granted`.
 *
 * Returns `true` when the grant is unverifiable (see
 * {@link isScopeVerificationDeferred}): the gate defers to Graph rather than
 * refusing the call locally. A caller that must distinguish the two cases should
 * check `isScopeVerificationDeferred` first.
 */
export function hasRequiredScopes(granted: string[], required: string[]): boolean {
  if (isScopeVerificationDeferred(granted)) return true;
  if (!Array.isArray(required) || required.length === 0) return true;
  const grantedSet = new Set(granted || []);
  return required.every((scope) => grantedSet.has(scope));
}

/**
 * Scopes in `required` that are missing from `granted`.
 *
 * Empty for an unverifiable legacy grant: reporting every scope as "missing" is
 * the lock-out this module is required to avoid.
 */
export function getMissingScopes(granted: string[], required: string[]): string[] {
  if (isScopeVerificationDeferred(granted)) return [];
  const grantedSet = new Set(granted || []);
  return (required || []).filter((scope) => !grantedSet.has(scope));
}

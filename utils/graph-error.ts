import ApiError from '@reactory/server-core/exceptions';
import type { AzureTokenSource } from '../types/azure.types';

/**
 * Microsoft Graph error translation.
 *
 * The one rule this module follows everywhere: a failed Graph call becomes an
 * `ApiError` that carries the Graph `code`. It never returns `[]`, `null` or a
 * truthy placeholder. Callers branch on `error.code`, so the code has to survive
 * the wrapping - which is why `apiError()` assigns it as a first-class property
 * as well as into `meta`.
 */

/** Error codes the module raises itself (in addition to Graph's own codes). */
export const GraphErrorCode = {
  /** 401 from Graph: the access token is expired or revoked. */
  INVALID_AUTHENTICATION_TOKEN: 'InvalidAuthenticationToken',
  /**
   * 401 on a request made with a legacy (User-document) token. Distinct from
   * InvalidAuthenticationToken on purpose: the legacy flow cannot refresh, so the
   * caller must prompt a reconnect instead of treating the grant as revoked.
   */
  LEGACY_TOKEN_EXPIRED: 'LegacyTokenExpired',
  /** No vaulted token and no legacy Microsoft authentication on the user. */
  NOT_CONNECTED: 'NotConnected',
  /** `requestAll` hit its `maxPages` bound - the result would be incomplete. */
  PAGINATION_LIMIT_EXCEEDED: 'PaginationLimitExceeded',
  /** `batch` refuses more than 20 requests. */
  BATCH_SIZE_EXCEEDED: 'BatchSizeExceeded',
  /** The OAuth state parameter is unknown or expired. */
  INVALID_OAUTH_STATE: 'InvalidOAuthState',
  /** Required `AZURE_*` configuration is missing. */
  MISSING_CONFIGURATION: 'AzureConfigurationMissing',
  /** A token could not be encrypted or decrypted. */
  TOKEN_ENCRYPTION_FAILED: 'TokenEncryptionFailed',
  /** A stub service method from a later ticket was called. */
  NOT_IMPLEMENTED: 'NotImplemented',
  /** Anything we could not classify. */
  GRAPH_REQUEST_FAILED: 'GraphRequestFailed',
} as const;

/**
 * Create an `ApiError` whose `code` is readable as `error.code`.
 *
 * `ApiError` itself only exposes `message`/`meta`/`extensions`, so the code is
 * assigned onto the instance (and into `meta` for serialisation).
 */
export function apiError(code: string, message: string, meta: Record<string, unknown> = {}): ApiError {
  const error = new ApiError(message, { code, ...meta }) as ApiError & { code: string };
  (error as any).code = code;

  for (const [key, value] of Object.entries({ code, ...meta })) {
    if (value !== undefined && key !== 'code') {
      (error as any)[key] = value;
    }
  }

  return error;
}

/** Read a header from a plain object, a `Headers` instance or a `Map`. */
export function readHeader(headers: any, name: string): string | undefined {
  if (!headers) return undefined;

  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value !== undefined && value !== null) return String(value);
  }

  const lower = name.toLowerCase();
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) {
        const value = headers[key];
        return value === undefined || value === null ? undefined : String(value);
      }
    }
  }

  return undefined;
}

/** HTTP status of a Graph/fetch error, if it has one. */
export function extractStatusCode(error: any): number | undefined {
  if (!error) return undefined;
  const candidates = [
    error.statusCode,
    error.status,
    error.response?.status,
    error.response?.statusCode,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }

  return undefined;
}

/** The Graph error body, parsed from `body` / `response.data` when it is a string. */
export function extractErrorBody(error: any): any {
  const raw = error?.body ?? error?.response?.data ?? error?.bodyAsText;
  if (!raw) return undefined;

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { message: raw };
    }
  }

  return raw;
}

/** The Graph `code` (`InvalidAuthenticationToken`, `itemNotFound`, ...). */
export function extractGraphCode(error: any): string | undefined {
  if (!error) return undefined;

  const body = extractErrorBody(error);
  const code = error.code ?? body?.error?.code ?? body?.code ?? error.response?.data?.error?.code;

  // `code` on a fetch-level failure is a Node error code (ECONNRESET, ...), not a
  // Graph code. Only string codes that look like Graph's are accepted.
  if (typeof code === 'string' && code.length > 0 && !/^E[A-Z]+$/.test(code)) return code;

  return undefined;
}

/** Retry-After in milliseconds (seconds or an HTTP date), if present. */
export function extractRetryAfterMs(error: any): number | undefined {
  const headers = error?.headers || error?.response?.headers;
  const raw = readHeader(headers, 'retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return undefined;
}

/** True when the status warrants a retry: 429, 503 or any other 5xx. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (typeof status !== 'number') return false;
  return status === 429 || status === 503 || (status >= 500 && status <= 599);
}

/**
 * Translate any thrown Graph/fetch error into an `ApiError`.
 *
 * @param error - the original error
 * @param options.tokenSource - provenance of the token used for the request
 * @param options.operation - the operation name recorded in `meta`
 */
export function toGraphApiError(
  error: any,
  options: { tokenSource?: AzureTokenSource; operation?: string } = {},
): ApiError {
  if (error && typeof error === 'object' && (error as any).__isReactoryApiError === true) {
    return error as ApiError;
  }

  const status = extractStatusCode(error);
  const graphCode = extractGraphCode(error);
  const message = error?.message || 'Microsoft Graph request failed';

  // A 401 on a legacy token means "this token can no longer be used and cannot be
  // refreshed here" - prompt a reconnect rather than reporting a revoked grant.
  if (status === 401 && options.tokenSource === 'legacy') {
    return apiError(
      GraphErrorCode.LEGACY_TOKEN_EXPIRED,
      'The Microsoft token on the user profile has expired. Reconnect the Microsoft account.',
      { status, graphCode, operation: options.operation },
    );
  }

  const code = graphCode
    || (status === 401 ? GraphErrorCode.INVALID_AUTHENTICATION_TOKEN : undefined)
    || GraphErrorCode.GRAPH_REQUEST_FAILED;

  const apiFailure = apiError(code, message, {
    status,
    graphCode,
    operation: options.operation,
    tokenSource: options.tokenSource,
    requestId: error?.requestId,
  });

  (apiFailure as any).__isReactoryApiError = true;
  return apiFailure;
}

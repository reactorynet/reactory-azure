import ApiError from '@reactory/server-core/exceptions';

import {
  TokenEncryptionError,
  decryptToken,
  encryptToken,
  generateEncryptionSalt,
} from '../utils/token-encryption';
import {
  buildHeaders,
  buildQuery,
  encodePathSegment,
  escapeODataString,
  quoteSearchExpression,
  withQuery,
} from '../utils/odata';
import {
  AZURE_OAUTH_STATE_TTL_SECONDS,
  azureCacheKey,
  oauthStateCacheKey,
  tokenCacheKey,
  tokenCacheTtlSeconds,
} from '../utils/cache-keys';
import {
  GraphErrorCode,
  apiError,
  extractRetryAfterMs,
  extractStatusCode,
  isRetryableStatus,
  readHeader,
  toGraphApiError,
} from '../utils/graph-error';
import {
  AZURE_SCOPES,
  getDefaultScopes,
  getMissingScopes,
  getScopesForServices,
  hasRequiredScopes,
  isScopeVerificationDeferred,
} from '../utils/scopes';
import { redact } from '../services/AzureAuditService';

const MASTER_KEY = 'test-master-key-do-not-use-in-production';

describe('token encryption (AES-256-GCM)', () => {
  it('round-trips a token', () => {
    const salt = generateEncryptionSalt();
    const ciphertext = encryptToken('access-token-value', MASTER_KEY, salt);

    expect(ciphertext).not.toContain('access-token-value');
    expect(ciphertext.split(':')).toHaveLength(3);
    expect(decryptToken(ciphertext, MASTER_KEY, salt)).toBe('access-token-value');
  });

  it('uses a fresh IV per call', () => {
    const salt = generateEncryptionSalt();
    expect(encryptToken('same', MASTER_KEY, salt)).not.toBe(encryptToken('same', MASTER_KEY, salt));
  });

  it('throws on a tampered ciphertext', () => {
    const salt = generateEncryptionSalt();
    const [iv, tag, payload] = encryptToken('tamper-me', MASTER_KEY, salt).split(':');
    const flipped = Buffer.from(payload, 'base64');
    flipped[0] = flipped[0] ^ 0xff;
    const tampered = [iv, tag, flipped.toString('base64')].join(':');

    expect(() => decryptToken(tampered, MASTER_KEY, salt)).toThrow(TokenEncryptionError);
  });

  it('throws on a tampered auth tag', () => {
    const salt = generateEncryptionSalt();
    const [iv, , payload] = encryptToken('tamper-me', MASTER_KEY, salt).split(':');
    const tag = Buffer.alloc(16, 7).toString('base64');

    expect(() => decryptToken([iv, tag, payload].join(':'), MASTER_KEY, salt)).toThrow(TokenEncryptionError);
  });

  it('throws when the salt does not match', () => {
    const ciphertext = encryptToken('salt-bound', MASTER_KEY, generateEncryptionSalt());
    expect(() => decryptToken(ciphertext, MASTER_KEY, generateEncryptionSalt())).toThrow(TokenEncryptionError);
  });

  it('rejects an IV or auth tag of the wrong length', () => {
    const salt = generateEncryptionSalt();
    const [, tag, payload] = encryptToken('x', MASTER_KEY, salt).split(':');

    expect(() => decryptToken([Buffer.alloc(4).toString('base64'), tag, payload].join(':'), MASTER_KEY, salt))
      .toThrow(TokenEncryptionError);
  });

  it('rejects an empty master key', () => {
    expect(() => encryptToken('x', '', 'salt')).toThrow(TokenEncryptionError);
  });

  it('rejects a malformed payload and an empty plaintext', () => {
    expect(() => decryptToken('not-a-ciphertext', MASTER_KEY, 'salt')).toThrow(TokenEncryptionError);
    expect(() => encryptToken('', MASTER_KEY, 'salt')).toThrow(TokenEncryptionError);
  });
});

describe('odata helpers', () => {
  it('builds select/top/filter/orderby', () => {
    const query = buildQuery({
      select: ['id', 'subject'],
      filter: "from/emailAddress/address eq 'a@b.com'",
      orderBy: 'receivedDateTime desc',
      top: 5,
    });

    expect(query).toContain('$select=id%2Csubject');
    expect(query).toContain('$top=5');
    expect(query).toContain('$orderby=receivedDateTime%20desc');
    expect(query).toContain('$filter=');
    expect(query.startsWith('?')).toBe(true);
  });

  it('returns an empty string when nothing is requested', () => {
    expect(buildQuery({})).toBe('');
  });

  it('quotes a search expression and asks for eventual consistency', () => {
    const query = buildQuery({ search: 'subject:invoice' });
    expect(query).toContain(encodeURIComponent('"subject:invoice"'));
    expect(buildHeaders({ search: 'subject:invoice' }).ConsistencyLevel).toBe('eventual');
  });

  it('includes $skip only when it is positive', () => {
    expect(buildQuery({ skip: 10 })).toContain('$skip=10');
    expect(buildQuery({ skip: 0 })).toBe('');
  });

  it('drops empty entries from a select list', () => {
    expect(buildQuery({ select: ['id', ''] })).toBe('?$select=id');
  });

  it('lets caller headers override the defaults', () => {
    const headers = buildHeaders({ headers: { Accept: 'application/json;odata.metadata=minimal' } });
    expect(headers.Accept).toBe('application/json;odata.metadata=minimal');
  });

  it('does not double-quote an already-quoted search', () => {
    expect(quoteSearchExpression('"already"')).toBe('"already"');
  });

  it('adds the ImmutableId Prefer header on request', () => {
    expect(buildHeaders({ immutableIds: true }).Prefer).toBe('IdType="ImmutableId"');
    expect(buildHeaders({}).Prefer).toBeUndefined();
  });

  it('doubles single quotes in an OData literal', () => {
    expect(escapeODataString("O'Brien")).toBe("O''Brien");
  });

  it('appends a query string without duplicating the separator', () => {
    expect(withQuery('/me/messages', '')).toBe('/me/messages');
    expect(withQuery('/me/messages', '?$top=1')).toBe('/me/messages?$top=1');
    expect(withQuery('/me/messages?$top=1', '?$skip=2')).toBe('/me/messages?$top=1&$skip=2');
  });

  it('percent-encodes each path segment', () => {
    expect(encodePathSegment('a b#c?.txt')).toBe('a%20b%23c%3F.txt');
    expect(encodePathSegment('/me/drive/root:/a b/file.txt')).toBe('/me/drive/root:/a%20b/file.txt');
  });
});

describe('cache keys', () => {
  it('uses azure:{userId}:{domain}:{key}', () => {
    expect(azureCacheKey('u1', 'mail:folders')).toBe('azure:u1:mail:folders');
    expect(azureCacheKey('u1', 'mail:message', 'm1')).toBe('azure:u1:mail:message:m1');
    expect(tokenCacheKey('u1')).toBe('azure:u1:token');
  });

  it('namespaces OAuth state and keeps a 600 s TTL', () => {
    expect(oauthStateCacheKey('abc')).toBe('azure:oauth:state:abc');
    expect(AZURE_OAUTH_STATE_TTL_SECONDS).toBe(600);
  });

  it('caps the token TTL at expiry minus 60 s', () => {
    const now = 1_700_000_000_000;
    expect(tokenCacheTtlSeconds(new Date(now + 3_600_000), now)).toBe(3540);
    expect(tokenCacheTtlSeconds(new Date(now + 30_000), now)).toBe(0);
  });
});

describe('graph error translation', () => {
  it('produces an ApiError that carries the code', () => {
    const error = apiError('CustomCode', 'boom');
    expect(error).toBeInstanceOf(ApiError);
    expect((error as any).code).toBe('CustomCode');
    expect(error.meta.code).toBe('CustomCode');
  });

  it('preserves the Graph code', () => {
    const translated = toGraphApiError({ statusCode: 404, code: 'itemNotFound', message: 'not found' });
    expect(translated).toBeInstanceOf(ApiError);
    expect((translated as any).code).toBe('itemNotFound');
    expect((translated as any).status).toBe(404);
  });

  it('maps a bare 401 to InvalidAuthenticationToken', () => {
    const translated = toGraphApiError({ statusCode: 401, message: 'Access token has expired' });
    expect((translated as any).code).toBe('InvalidAuthenticationToken');
  });

  it('maps a legacy 401 to LegacyTokenExpired, not InvalidAuthenticationToken', () => {
    const translated = toGraphApiError(
      { statusCode: 401, code: 'InvalidAuthenticationToken', message: 'expired' },
      { tokenSource: 'legacy' },
    );

    expect((translated as any).code).toBe('LegacyTokenExpired');
    expect((translated as any).code).not.toBe(GraphErrorCode.INVALID_AUTHENTICATION_TOKEN);
    expect((translated as any).graphCode).toBe('InvalidAuthenticationToken');
  });

  it('reads a Graph code out of a JSON body', () => {
    const translated = toGraphApiError({
      statusCode: 400,
      body: JSON.stringify({ error: { code: 'ErrorInvalidRequest', message: 'bad' } }),
    });
    expect((translated as any).code).toBe('ErrorInvalidRequest');
  });

  it('classifies retryable statuses', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(undefined)).toBe(false);
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    expect(extractRetryAfterMs({ headers: { 'retry-after': '2' } })).toBe(2000);
    expect(readHeader(new Map([['retry-after', '3']]) as any, 'retry-after')).toBe('3');
    expect(extractStatusCode({ status: 503 })).toBe(503);
  });
});

describe('audit redaction', () => {
  it('redacts every credential key', () => {
    const redacted = redact({
      authorization: 'Bearer abc',
      access_token: 'a',
      accessToken: 'b',
      refresh_token: 'c',
      token: 'd',
      bearer: 'e',
      nested: { Authorization: 'Bearer xyz', keep: 'visible' },
      list: [{ refreshToken: 'f' }],
    }) as any;

    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted.access_token).toBe('[REDACTED]');
    expect(redacted.accessToken).toBe('[REDACTED]');
    expect(redacted.refresh_token).toBe('[REDACTED]');
    expect(redacted.token).toBe('[REDACTED]');
    expect(redacted.bearer).toBe('[REDACTED]');
    expect(redacted.nested.Authorization).toBe('[REDACTED]');
    expect(redacted.nested.keep).toBe('visible');
    expect(redacted.list[0].refreshToken).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toContain('Bearer abc');
  });

  it('survives a circular payload', () => {
    const payload: any = { operation: 'mail.list' };
    payload.self = payload;
    expect(() => redact(payload)).not.toThrow();
  });
});

describe('scope registry', () => {
  it('always requests offline_access', () => {
    expect(getDefaultScopes()).toContain('offline_access');
  });

  it('expands capability keys', () => {
    const scopes = getScopesForServices(['mail', 'calendar']);
    expect(scopes).toContain('Mail.ReadWrite');
    expect(scopes).toContain('Mail.Send');
    expect(scopes).toContain('Calendars.ReadWrite');
    expect(scopes).toContain('offline_access');
  });

  it('reports missing scopes', () => {
    expect(hasRequiredScopes(['User.Read'], ['User.Read'])).toBe(true);
    expect(getMissingScopes(['User.Read'], ['User.Read', 'Mail.Read'])).toEqual(['Mail.Read']);
    expect(Object.keys(AZURE_SCOPES).length).toBeGreaterThan(5);
  });

  /**
   * Requirement 4b(c): a legacy grant is *unverifiable*, not *insufficient*. If the
   * only scope helper in the module answered "false / all missing" for
   * `legacy:unverified`, the first ticket to add a gate would lock out every legacy
   * user. The sentinel is therefore encoded in the helpers, not just in a comment.
   */
  describe('legacy:unverified is deferred, never insufficient', () => {
    const LEGACY_ONLY = ['legacy:unverified'];

    it('identifies the sentinel', () => {
      expect(isScopeVerificationDeferred(LEGACY_ONLY)).toBe(true);
      expect(isScopeVerificationDeferred(['User.Read'])).toBe(false);
      expect(isScopeVerificationDeferred(undefined as any)).toBe(false);
      expect(isScopeVerificationDeferred([])).toBe(false);
    });

    it('hasRequiredScopes defers instead of refusing', () => {
      expect(hasRequiredScopes(LEGACY_ONLY, ['Mail.Read'])).toBe(true);
      expect(hasRequiredScopes(LEGACY_ONLY, ['User.ReadBasic.All', 'Sites.ReadWrite.All'])).toBe(true);
    });

    it('getMissingScopes reports nothing missing', () => {
      expect(getMissingScopes(LEGACY_ONLY, ['Mail.Read', 'Files.ReadWrite'])).toEqual([]);
    });

    it('treats an empty requirement list as satisfied', () => {
      expect(hasRequiredScopes(['User.Read'], [])).toBe(true);
      expect(hasRequiredScopes(undefined as any, undefined as any)).toBe(true);
      expect(getMissingScopes(undefined as any, ['Mail.Read'])).toEqual(['Mail.Read']);
    });

    it('ignores an unknown capability key', () => {
      const scopes = getScopesForServices(['not-a-capability']);
      expect(scopes).toEqual(getDefaultScopes());
      expect(scopes).toContain('offline_access');
    });

    it('still refuses a real grant that lacks the scope', () => {
      expect(hasRequiredScopes(['User.Read'], ['Mail.Read'])).toBe(false);
      expect(getMissingScopes(['User.Read'], ['Mail.Read'])).toEqual(['Mail.Read']);
    });
  });
});

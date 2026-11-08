import type { IGraphRequestOptions } from '../types/graph.types';

/**
 * OData query-string construction.
 *
 * Graph is picky in ways a generic URL builder gets wrong:
 *   - `$search` must be a quoted expression and needs `ConsistencyLevel: eventual`;
 *   - `$search` may not be combined with `$orderby` / `$count`;
 *   - `$filter` literals embed single quotes, which must be doubled, not escaped;
 *   - paths are URL-encoded per segment, so a `#` or `?` in a filename cannot
 *     change the request.
 */

/** Join a string or string[] as a comma-separated list. */
function joinList(value: string | string[] | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const filtered = value.filter((entry) => typeof entry === 'string' && entry.length > 0);
    return filtered.length ? filtered.join(',') : undefined;
  }
  return value.length ? value : undefined;
}

/** Double single quotes so an OData string literal cannot be broken out of. */
export function escapeODataString(value: string): string {
  return String(value).replace(/'/g, "''");
}

/** Quote a `$search` expression, leaving an already-quoted value alone. */
export function quoteSearchExpression(value: string): string {
  const trimmed = String(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) return trimmed;
  return `"${trimmed.replace(/"/g, '\\"')}"`;
}

/**
 * Build the `?...` query string for a request.
 *
 * Returns an empty string when no option contributes a parameter, so the caller
 * can concatenate unconditionally.
 */
export function buildQuery(options: IGraphRequestOptions = {}): string {
  const params: string[] = [];

  const select = joinList(options.select);
  if (select) params.push(`$select=${encodeURIComponent(select)}`);

  if (options.filter) params.push(`$filter=${encodeURIComponent(options.filter)}`);

  if (options.search) {
    params.push(`$search=${encodeURIComponent(quoteSearchExpression(options.search))}`);
  }

  const orderBy = joinList(options.orderBy);
  if (orderBy) params.push(`$orderby=${encodeURIComponent(orderBy)}`);

  if (typeof options.top === 'number' && Number.isFinite(options.top)) {
    params.push(`$top=${Math.max(0, Math.trunc(options.top))}`);
  }

  if (typeof options.skip === 'number' && Number.isFinite(options.skip) && options.skip > 0) {
    params.push(`$skip=${Math.trunc(options.skip)}`);
  }

  const expand = joinList(options.expand);
  if (expand) params.push(`$expand=${encodeURIComponent(expand)}`);

  if (options.count === true) params.push('$count=true');

  return params.length ? `?${params.join('&')}` : '';
}

/**
 * Headers that accompany a request.
 *
 * `$search` needs `ConsistencyLevel: eventual`; `Prefer: IdType="ImmutableId"`
 * makes message ids stable across mailbox moves (the ids change shape, so callers
 * must not parse them).
 */
export function buildHeaders(
  options: IGraphRequestOptions & { immutableIds?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.search) headers.ConsistencyLevel = 'eventual';
  if (options.immutableIds) headers.Prefer = 'IdType="ImmutableId"';

  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (value !== undefined && value !== null) headers[key] = String(value);
    }
  }

  return headers;
}

/**
 * Percent-encode a Graph path, segment by segment.
 *
 * `/` is preserved so a whole relative path can be passed in, and two Graph
 * path metacharacters are restored after encoding because Graph only accepts them
 * literally:
 *   - `:` for drive addressing (`/me/drive/root:/folder/file.docx`) and for
 *     SharePoint site paths (`/sites/hostname:/sites/name`);
 *   - `$` for the property/action segments (`/photo/$value`, `/content`).
 *
 * Everything else - spaces, `#`, `?`, `%`, `&` - stays encoded, so a filename
 * cannot change the shape of the request.
 */
export function encodePathSegment(segment: string): string {
  return String(segment)
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/%3A/gi, ':').replace(/%24/g, '$'))
    .join('/');
}

/** Append a query string to a path or URL that may already carry one. */
export function withQuery(pathOrUrl: string, query: string): string {
  if (!query) return pathOrUrl;
  const separator = pathOrUrl.includes('?') ? '&' : '?';
  return `${pathOrUrl}${separator}${query.replace(/^\?/, '')}`;
}

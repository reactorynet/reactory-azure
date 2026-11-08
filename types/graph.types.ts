/**
 * Transport-level Microsoft Graph types.
 *
 * These describe the *provider* contract (services/graph/AzureGraphClientProvider.ts),
 * not any Graph domain resource. Domain shapes live in the per-domain type files.
 */

/** OData query options accepted by every provider request. */
export interface IGraphRequestOptions {
  /** `$select` - property names or a pre-joined string. */
  select?: string | string[];
  /** `$filter` - raw OData filter expression. */
  filter?: string;
  /** `$search` - quoted search expression. Requires `ConsistencyLevel: eventual`. */
  search?: string;
  /** `$orderby` - property names, optionally with `asc` / `desc`. */
  orderBy?: string | string[];
  /** `$top` - page size. */
  top?: number;
  /** `$skip` - offset. Not supported with `$search`. */
  skip?: number;
  /** `$expand` - navigation properties. */
  expand?: string | string[];
  /** `$count` - request the total count. Not supported with `$search`. */
  count?: boolean;
  /** HTTP headers merged over the defaults. */
  headers?: Record<string, string>;
  /** Graph API version; `v1.0` unless a documented legacy shim path needs otherwise. */
  apiVersion?: string;
  /** Absolute URL to request verbatim (used to follow `@odata.nextLink`). */
  url?: string;
}

/** A single page of a Graph collection response. */
export interface IGraphPage<T> {
  items: T[];
  /** `@odata.nextLink` - present when more pages remain. */
  nextLink?: string;
  /** `@odata.deltaLink` - present on the final page of a delta query. */
  deltaLink?: string;
  /** `@odata.count` - present only when `$count=true` was requested. */
  count?: number;
}

/** One request inside a Graph `$batch` payload. */
export interface IBatchRequest {
  id: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** One response inside a Graph `$batch` payload. */
export interface IBatchResponse {
  id: string;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A raw (non-JSON) response, used for `/photo/$value` and file content. */
export interface IGraphBinaryResponse {
  status: number;
  headers: Record<string, string>;
  buffer: Buffer;
  contentType?: string;
}

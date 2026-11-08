import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import { Client, ResponseType } from '@microsoft/microsoft-graph-client';
import type ApiError from '@reactory/server-core/exceptions';
import type {
  IBatchRequest,
  IBatchResponse,
  IGraphBinaryResponse,
  IGraphPage,
  IGraphRequestOptions,
} from '../../types/graph.types';
import type { AzureTokenSource } from '../../types/azure.types';
import { buildHeaders, buildQuery } from '../../utils/odata';
import {
  GraphErrorCode,
  apiError,
  extractGraphCode,
  extractRetryAfterMs,
  extractStatusCode,
  isRetryableStatus,
  toGraphApiError,
} from '../../utils/graph-error';

/** Graph refuses a `$batch` payload with more than 20 requests. */
export const GRAPH_BATCH_LIMIT = 20;

/** Default page bound for `requestAll` / `delta`. */
export const GRAPH_DEFAULT_MAX_PAGES = 10;

/** Total attempts (first call plus retries) for a retryable failure. */
export const GRAPH_MAX_ATTEMPTS = 3;

/** Backoff base for 5xx retries, doubling per attempt. */
const BACKOFF_BASE_MS = 500;

/** Backoff ceiling, so a long chain of failures cannot stall a request for minutes. */
const BACKOFF_MAX_MS = 8_000;

/** The Graph v1.0 endpoint. No preview API version is used by this module. */
export const GRAPH_BASE_URL = 'https://graph.microsoft.com';

/** The raw shape of a Graph collection response (before it is normalised). */
interface IGraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
  '@odata.count'?: number;
}

/** Options accepted by the provider's own methods. */
export interface IGraphProviderOptions extends IGraphRequestOptions {
  /** Maximum pages `requestAll`/`delta` will fetch before throwing. */
  maxPages?: number;
  /** Operation name used in error metadata and logs. */
  operation?: string;
}

/**
 * Build a Graph client around a caller-supplied access token.
 *
 * @deprecated AZ-19 - ONLY the legacy compatibility shim (services/graph.ts) may
 * use this. Its callers (reactory-core's Microsoft sign-in path) own the token and
 * have no userId to authenticate with, and this function performs no token
 * caching, refresh or auditing. New code must use
 * `AzureGraphClientProvider#getClient(userId)`.
 *
 * It lives here so that every construction of a Graph `Client` - and therefore
 * every place `debugLogging` could be turned on - remains in this one file.
 */
export function createTokenGraphClient(accessToken: string, apiVersion: string = 'v1.0'): Client {
  if (!accessToken) {
    throw apiError(GraphErrorCode.NOT_CONNECTED, 'An access token is required to build a legacy Graph client');
  }

  return Client.init({
    baseUrl: GRAPH_BASE_URL,
    defaultVersion: apiVersion,
    debugLogging: false,
    authProvider: (done: (error: Error | null, accessToken?: string) => void) => {
      done(null, accessToken);
    },
  });
}

/**
 * The single place a Microsoft Graph `Client` is constructed in this module.
 *
 * Responsibilities:
 *   - build the SDK client with `Client.init`, authenticating through
 *     `AzureAuthService.getToken(userId)` (never a caller-supplied token);
 *   - run requests with a deterministic retry policy: 429/503 honour
 *     `Retry-After`, other 5xx use exponential backoff with jitter, other 4xx are
 *     never retried;
 *   - convert every failure into an `ApiError` that preserves the Graph `code`;
 *   - paginate (`requestAll`, `delta`) with a hard bound that throws instead of
 *     silently truncating, and batch with the documented 20-request limit.
 *
 * `debugLogging` is false: the SDK's debug output logs request URLs and headers,
 * which is a credential-leak path.
 */
@service({
  id: 'azure.AzureGraphClientProvider@1.0.0',
  name: 'AzureGraphClientProvider',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph client provider - authentication, retry, pagination and batching',
  serviceType: 'integration',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureAuthService@1.0.0', alias: 'azureAuthService' },
  ],
})
class AzureGraphClientProvider implements Reactory.Service.IReactoryService {
  name: string = 'AzureGraphClientProvider';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _authService: any;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `azureAuthService` dependency alias. */
  setAzureAuthService(serviceInstance: any): void {
    this._authService = serviceInstance;
  }

  private get authService(): any {
    if (this._authService) return this._authService;
    return this.context.getService('azure.AzureAuthService@1.0.0');
  }

  /**
   * Build a Graph `Client` for one user.
   *
   * The auth provider resolves the token per request, so a long-lived client
   * still picks up a refreshed token. It also records the token provenance so a
   * 401 can be reported as `LegacyTokenExpired` rather than a revoked grant.
   */
  getClient(userId: string, apiVersion: string = 'v1.0'): Client {
    if (!userId) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required to build a Graph client');
    }

    const session: { source?: AzureTokenSource } = {};

    const client = Client.init({
      baseUrl: GRAPH_BASE_URL,
      defaultVersion: apiVersion,
      debugLogging: false,
      authProvider: (done: (error: Error | null, accessToken?: string) => void) => {
        Promise.resolve(this.authService.getToken(userId))
          .then((result: { token: string; source: AzureTokenSource }) => {
            session.source = result.source;
            done(null, result.token);
          })
          .catch((error: Error) => {
            done(error);
          });
      },
    });

    (client as any).__azureTokenSource = () => session.source;
    return client;
  }

  /**
   * A Graph client around an explicit token.
   *
   * @deprecated AZ-19 - legacy shim only. See {@link createTokenGraphClient}.
   */
  getClientWithToken(accessToken: string, apiVersion: string = 'v1.0'): Client {
    return createTokenGraphClient(accessToken, apiVersion);
  }

  /**
   * GET a single Graph resource.
   *
   * @throws ApiError carrying the Graph `code` on any failure.
   */
  async request<T>(userId: string, path: string, options: IGraphProviderOptions = {}): Promise<T> {
    const client = this.getClient(userId, options.apiVersion || 'v1.0');
    return this.withRetry<T>(options.operation || 'request', path, userId, () =>
      this.execute<T>(client, path, options));
  }

  /**
   * GET a raw (non-JSON) response - `/photo/$value`, file content.
   *
   * Uses `ResponseType.RAW` so the SDK hands back the underlying `Response`
   * instead of trying to parse a binary payload as JSON.
   */
  async requestRaw(
    userId: string,
    path: string,
    options: IGraphProviderOptions = {},
  ): Promise<IGraphBinaryResponse> {
    const client = this.getClient(userId, options.apiVersion || 'v1.0');

    return this.withRetry<IGraphBinaryResponse>(options.operation || 'requestRaw', path, userId, async () => {
      const request = client.api(path).responseType(ResponseType.RAW);
      const response: any = await request.get();
      const headers = this.normaliseHeaders(response?.headers);
      const buffer = await this.toBuffer(response);

      return {
        status: typeof response?.status === 'number' ? response.status : 200,
        headers,
        buffer,
        contentType: headers['content-type'],
      };
    });
  }

  /**
   * GET every page of a collection, following `@odata.nextLink`.
   *
   * The page bound is a hard limit: hitting it raises
   * `ApiError(PaginationLimitExceeded)` rather than returning a partial list,
   * because a silently truncated mailbox or drive listing is indistinguishable
   * from an empty one.
   */
  async requestAll<T>(
    userId: string,
    path: string,
    options: IGraphProviderOptions = {},
  ): Promise<T[]> {
    const maxPages = options.maxPages && options.maxPages > 0 ? options.maxPages : GRAPH_DEFAULT_MAX_PAGES;
    const items: T[] = [];
    let nextLink = path;
    let pages = 0;
    let firstPage = true;

    while (nextLink) {
      if (pages >= maxPages) {
        throw apiError(
          GraphErrorCode.PAGINATION_LIMIT_EXCEEDED,
          `Microsoft Graph pagination exceeded ${maxPages} page(s) for ${path}; refusing to return a partial result`,
          { maxPages, pages, resource: path },
        );
      }

      const pageOptions: IGraphProviderOptions = firstPage
        ? options
        : { operation: options.operation, apiVersion: options.apiVersion, headers: options.headers };

      const page = await this.request<IGraphCollectionResponse<T>>(
        userId,
        firstPage ? path : nextLink,
        firstPage ? pageOptions : { ...pageOptions, url: nextLink },
      );

      pages += 1;
      firstPage = false;

      if (Array.isArray(page?.value)) items.push(...page.value);
      nextLink = page?.['@odata.nextLink'];
    }

    return items;
  }

  /**
   * Run a delta query to completion.
   *
   * Returns the accumulated items plus the final `@odata.deltaLink`, which the
   * caller persists as its sync cursor. Same page bound and failure contract as
   * {@link requestAll}.
   */
  async delta<T>(
    userId: string,
    path: string,
    options: IGraphProviderOptions = {},
  ): Promise<IGraphPage<T>> {
    const maxPages = options.maxPages && options.maxPages > 0 ? options.maxPages : GRAPH_DEFAULT_MAX_PAGES;
    const items: T[] = [];
    let nextLink = path;
    let deltaLink: string | undefined;
    let pages = 0;
    let firstPage = true;

    while (nextLink) {
      if (pages >= maxPages) {
        throw apiError(
          GraphErrorCode.PAGINATION_LIMIT_EXCEEDED,
          `Microsoft Graph delta exceeded ${maxPages} page(s) for ${path}; refusing to return a partial sync`,
          { maxPages, pages, resource: path },
        );
      }

      const pageOptions: IGraphProviderOptions = firstPage
        ? options
        : { operation: options.operation, apiVersion: options.apiVersion, headers: options.headers };

      const page = await this.request<IGraphCollectionResponse<T>>(
        userId,
        firstPage ? path : nextLink,
        firstPage ? pageOptions : { ...pageOptions, url: nextLink },
      );

      pages += 1;
      firstPage = false;

      if (Array.isArray(page?.value)) items.push(...page.value);
      if (page?.['@odata.deltaLink']) deltaLink = page['@odata.deltaLink'];
      nextLink = page?.['@odata.nextLink'];
    }

    return { items, deltaLink };
  }

  /**
   * POST a Graph `$batch` with at most {@link GRAPH_BATCH_LIMIT} requests.
   *
   * Graph rejects larger payloads, so the limit is enforced here: a caller gets a
   * typed error instead of an opaque 400 from the service.
   */
  async batch(userId: string, requests: IBatchRequest[]): Promise<IBatchResponse[]> {
    if (!Array.isArray(requests) || requests.length === 0) {
      throw apiError(GraphErrorCode.BATCH_SIZE_EXCEEDED, 'A Graph batch requires at least one request', {
        count: Array.isArray(requests) ? requests.length : 0,
      });
    }

    if (requests.length > GRAPH_BATCH_LIMIT) {
      throw apiError(
        GraphErrorCode.BATCH_SIZE_EXCEEDED,
        `A Graph batch accepts at most ${GRAPH_BATCH_LIMIT} requests; received ${requests.length}`,
        { count: requests.length, limit: GRAPH_BATCH_LIMIT },
      );
    }

    const client = this.getClient(userId);

    const response = await this.withRetry<{ responses?: IBatchResponse[] }>('batch', '/$batch', userId, async () => {
      const result: any = await client.api('/$batch').post({ requests });
      return result;
    });

    return Array.isArray(response?.responses) ? response.responses : [];
  }

  /** Apply query + headers and issue the GET. */
  private async execute<T>(client: Client, path: string, options: IGraphProviderOptions): Promise<T> {
    // An absolute `@odata.nextLink` is the request target, not a decoration.
    const target = options.url || path;
    let request: any = client.api(target);

    if (options.apiVersion) request = request.version(options.apiVersion);

    // An absolute `@odata.nextLink` already carries its query string; adding one
    // again would duplicate `$skiptoken` and reset the cursor.
    if (!options.url) {
      const query = buildQuery(options);
      if (query) request = request.query(query.replace(/^\?/, ''));
    }

    request = request.headers(buildHeaders(options));

    const response = await request.get();
    return response as T;
  }

  /** Run `operation`, retrying only the statuses that can succeed on a retry. */
  private async withRetry<T>(
    operation: string,
    resource: string,
    userId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;

    for (;;) {
      attempt += 1;

      try {
        return await run();
      } catch (error) {
        const status = extractStatusCode(error);
        const retryable = isRetryableStatus(status);

        if (!retryable || attempt >= GRAPH_MAX_ATTEMPTS) {
          throw await this.translateError(error, userId, operation, resource);
        }

        const retryAfterMs = extractRetryAfterMs(error);
        const delayMs = retryAfterMs !== undefined ? retryAfterMs : this.backoffDelayMs(attempt);

        logger.debug(
          `AzureGraphClientProvider: ${operation} ${resource} failed with ${status}; `
          + `retry ${attempt}/${GRAPH_MAX_ATTEMPTS - 1} in ${delayMs}ms`,
        );

        await this.sleep(delayMs);
      }
    }
  }

  /** Exponential backoff with jitter (full jitter over the exponential ceiling). */
  private backoffDelayMs(attempt: number): number {
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
    return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  /** Exposed for tests; real timers in production. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Resolve the token provenance so a 401 can be classified.
   *
   * This only runs on a failure path, and a failure to determine the source must
   * never mask the original Graph error.
   */
  private async resolveTokenSource(userId: string): Promise<AzureTokenSource | undefined> {
    try {
      const result = await this.authService.getToken(userId);
      return result?.source;
    } catch {
      return undefined;
    }
  }

  /** Convert a thrown error into an `ApiError`, preserving the Graph code. */
  private async translateError(
    error: any,
    userId: string,
    operation: string,
    resource: string,
  ): Promise<ApiError> {
    const tokenSource = await this.resolveTokenSource(userId);

    if (tokenSource === 'legacy' && extractStatusCode(error) === 401) {
      return toGraphApiError(error, { tokenSource, operation });
    }

    const apiFailure = toGraphApiError(error, { tokenSource, operation });
    (apiFailure as any).resource = resource;
    (apiFailure as any).graphCode = (apiFailure as any).graphCode || extractGraphCode(error);
    return apiFailure;
  }

  /** Lower-case a header bag (plain object, `Headers` or `Map`). */
  private normaliseHeaders(headers: any): Record<string, string> {
    const output: Record<string, string> = {};
    if (!headers) return output;

    if (typeof headers.forEach === 'function') {
      headers.forEach((value: string, key: string) => {
        output[String(key).toLowerCase()] = String(value);
      });
      return output;
    }

    for (const [key, value] of Object.entries(headers)) {
      output[String(key).toLowerCase()] = String(value);
    }
    return output;
  }

  /** Coerce a RAW response body into a Buffer without assuming one runtime shape. */
  private async toBuffer(response: any): Promise<Buffer> {
    const body = response?.body ?? response;

    if (Buffer.isBuffer(body)) return body;
    if (body && typeof body.arrayBuffer === 'function') {
      return Buffer.from(await body.arrayBuffer());
    }
    if (typeof response?.arrayBuffer === 'function') {
      return Buffer.from(await response.arrayBuffer());
    }
    if (body && typeof body.on === 'function') {
      const chunks: Buffer[] = [];
      return new Promise<Buffer>((resolve, reject) => {
        body.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        body.on('end', () => resolve(Buffer.concat(chunks)));
        body.on('error', reject);
      });
    }

    return Buffer.alloc(0);
  }
}

export const AzureGraphClientProviderDefinition: Reactory.Service.IReactoryServiceDefinition<AzureGraphClientProvider> = {
  service: (props: any, context: any) => new AzureGraphClientProvider(props, context),
  id: 'azure.AzureGraphClientProvider@1.0.0',
  name: 'AzureGraphClientProvider',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph client provider - authentication, retry, pagination and batching',
  serviceType: 'integration',
  dependencies: [
    { id: 'azure.AzureAuthService@1.0.0', alias: 'azureAuthService' },
  ],
};

export { AzureGraphClientProvider };
export default AzureGraphClientProvider;

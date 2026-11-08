import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import type ApiError from '@reactory/server-core/exceptions';
import {
  WORKBOOK_ERROR_CODE,
  type IAzureWorkbookService,
  type IWorkbookAddTableRowOptions,
  type IWorkbookAppendRowsOptions,
  type IWorkbookClearRangeOptions,
  type IWorkbookGetRangeOptions,
  type IWorkbookListTablesOptions,
  type IWorkbookListWorksheetsOptions,
  type IWorkbookRange,
  type IWorkbookRangeUpdate,
  type IWorkbookRequestOptions,
  type IWorkbookSession,
  type IWorkbookTable,
  type IWorkbookTableColumn,
  type IWorkbookTableRow,
  type IWorkbookUpdateRangeOptions,
  type IWorkbookWorksheet,
  type WorkbookValues,
} from '../types/workbook.types';
import { azureCacheKey, AzureCacheDomain } from '../utils/cache-keys';
import { encodePathSegment, escapeODataString } from '../utils/odata';
import { GraphErrorCode, apiError, toGraphApiError } from '../utils/graph-error';

/**
 * How long a worksheet listing is cached. The ticket fixes this at two minutes:
 * worksheets change rarely (a rename or a new sheet), and every workbook call is
 * a round trip to Graph.
 */
export const WORKBOOK_WORKSHEETS_CACHE_TTL_SECONDS = 120;

/** Values `clearRange` accepts for Graph's `applyTo`. */
const CLEAR_APPLY_TO = ['All', 'Formats', 'Contents'] as const;

/** The subset of a Graph collection payload this service reads. */
interface IGraphCollection<T> {
  value?: T[];
}

/**
 * The slice of `AzureGraphClientProvider` this service calls.
 *
 * Declaring it (rather than reaching for `any`) documents that every request -
 * including the session-header ones - goes through the module's single Graph
 * client factory, which owns auth, retry and error translation.
 */
interface IWorkbookGraphProvider {
  request<T>(userId: string, path: string, options?: Record<string, unknown>): Promise<T>;
  getClient(userId: string): any;
}

/** Options accepted by the internal request helpers. */
interface IWorkbookCallOptions {
  operation: string;
  sessionId?: string;
}

/**
 * `azure.AzureWorkbookService@1.0.0` - Excel workbooks over Microsoft Graph.
 *
 * Three properties are non-negotiable and are enforced here rather than left to
 * the caller:
 *
 *  1. **Sessions are always closed.** A `/workbook/createSession` that is never
 *     closed pins the workbook: later requests from anyone else either hang or
 *     fail until the session expires. `withSession()` therefore closes in a
 *     `finally`, including when the wrapped operation throws, and every mutation
 *     can opt into that wrapper with `useSession: true`.
 *  2. **Values are passed through untouched.** `values` is `any[][]`: Graph
 *     returns `null` for an empty cell and a string such as `'#DIV/0!'` for an
 *     error cell. This service never maps one to the other, never parses an
 *     error string, and never pads a row.
 *  3. **A payload is never truncated.** A write sends exactly the matrix it was
 *     given, however many rows that is. There is no cap and no paging on a
 *     write; a caller that gets a result back can trust it covers the input.
 *
 * Graph exposes no worksheet-level append endpoint, so `appendRows` composes a
 * used-range read with one range write; `addTableRow` is the single-request
 * append for a table.
 */
@service({
  id: 'azure.AzureWorkbookService@1.0.0',
  name: 'AzureWorkbookService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Excel workbook worksheets, ranges, tables and sessions over Microsoft Graph',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphProvider' },
    { id: 'core.RedisService@1.0.0', alias: 'redisService' },
  ],
})
class AzureWorkbookService implements IAzureWorkbookService, Reactory.Service.IReactoryService {
  name: string = 'AzureWorkbookService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphProvider: any;
  private _redisService: any;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `graphProvider` dependency alias. */
  setGraphProvider(serviceInstance: any): void {
    this._graphProvider = serviceInstance;
  }

  /** Bound by the Reactory service container from the `redisService` dependency alias. */
  setRedisService(serviceInstance: any): void {
    this._redisService = serviceInstance;
  }

  // ---------------------------------------------------------------------------
  // Worksheets
  // ---------------------------------------------------------------------------

  /**
   * `GET /me/drive/items/{itemId}/workbook/worksheets`.
   *
   * Cached for {@link WORKBOOK_WORKSHEETS_CACHE_TTL_SECONDS} per user and item.
   * The cache is best-effort: a Redis outage, a miss or a malformed payload all
   * read as "not cached". A call that carries a `sessionId` (or
   * `forceRefresh: true`) bypasses the cache, because a session exists precisely
   * to observe the workbook's current state.
   */
  async listWorksheets(
    userId: string,
    itemId: string,
    options: IWorkbookListWorksheetsOptions = {},
  ): Promise<IWorkbookWorksheet[]> {
    const uid = this.resolveUserId(userId);
    // A session view must never be written to the shared cache: it reflects one
    // session's state. A forced refresh skips the read but does rewrite, so the
    // next caller gets the fresh list.
    const sessionScoped = options.sessionId !== undefined;
    const bypassRead = sessionScoped || options.forceRefresh === true;
    const cacheKey = worksheetCacheKey(uid, itemId, options.driveId);

    if (!bypassRead) {
      const cached = await this.readWorksheetsCache(cacheKey);
      if (cached) return cached;
    }

    const page = await this.requestJson<IGraphCollection<IWorkbookWorksheet>>(
      uid,
      `${this.workbookPath(itemId, options)}/worksheets`,
      { operation: 'workbook.listWorksheets', sessionId: options.sessionId },
    );

    const items = Array.isArray(page?.value) ? page.value : [];

    if (!sessionScoped) await this.writeWorksheetsCache(cacheKey, items);

    return items;
  }

  // ---------------------------------------------------------------------------
  // Ranges
  // ---------------------------------------------------------------------------

  /**
   * `GET …/worksheets/{worksheet}/usedRange` - or
   * `…/usedRange(valuesOnly=true|false)` when the caller asked for values.
   *
   * Without `valuesOnly` Graph returns the address and the counts only, which is
   * the cheaper shape; `appendRows` relies on that.
   */
  async getUsedRange(
    userId: string,
    itemId: string,
    worksheet: string,
    options: IWorkbookGetRangeOptions = {},
  ): Promise<IWorkbookRange> {
    const uid = this.resolveUserId(userId);
    const suffix = typeof options.valuesOnly === 'boolean'
      ? `/usedRange(valuesOnly=${options.valuesOnly})`
      : '/usedRange';

    return this.requestJson<IWorkbookRange>(
      uid,
      `${this.worksheetPath(itemId, worksheet, options)}${suffix}`,
      { operation: 'workbook.getUsedRange', sessionId: options.sessionId },
    );
  }

  /** `GET …/worksheets/{worksheet}/range(address='A1:D20')`. */
  async getRange(
    userId: string,
    itemId: string,
    worksheet: string,
    address: string,
    options: IWorkbookRequestOptions = {},
  ): Promise<IWorkbookRange> {
    const uid = this.resolveUserId(userId);

    return this.requestJson<IWorkbookRange>(
      uid,
      this.rangePath(itemId, worksheet, address, options),
      { operation: 'workbook.getRange', sessionId: options.sessionId },
    );
  }

  /**
   * `PATCH …/worksheets/{worksheet}/range(address='A1:D20')` with
   * `{ values, formulas?, numberFormat? }`.
   *
   * `values` is sent exactly as supplied - `null` cells and `'#DIV/0!'` strings
   * included - so an error cell stays an error cell and a large matrix is not
   * trimmed. `formulas` and `numberFormat` are only sent when the caller set
   * them; an empty array is still sent, because "clear the formats" is a
   * meaningful instruction.
   */
  async updateRange(
    userId: string,
    itemId: string,
    worksheet: string,
    address: string,
    update: IWorkbookRangeUpdate,
    options: IWorkbookUpdateRangeOptions = {},
  ): Promise<IWorkbookRange> {
    const uid = this.resolveUserId(userId);
    const path = this.rangePath(itemId, worksheet, address, options);
    const body = this.buildRangeBody(update);

    const write = (sessionId?: string) => this.graphWrite<IWorkbookRange>(
      uid,
      path,
      'patch',
      body,
      { operation: 'workbook.updateRange', sessionId },
    );

    if (options.useSession === true) {
      return this.withSession(uid, itemId, (session) => write(session.id), options);
    }

    return write(options.sessionId);
  }

  /**
   * Append rows below the worksheet's used range.
   *
   * Graph has no worksheet-level append, so this is two documented calls:
   * `GET …/usedRange` to learn where the data ends, then one
   * `PATCH …/range(address='…')` carrying **every** supplied row. One request for
   * the write keeps a large append atomic; running both inside a session
   * (`useSession: true`) also keeps another writer from slipping in between.
   *
   * Graph reports a pristine worksheet as `A1` with one row and one column, so a
   * one-cell used range is probed once (`valuesOnly: true`) before deciding that
   * the sheet is empty and the append starts at row 1.
   */
  async appendRows(
    userId: string,
    itemId: string,
    worksheet: string,
    values: WorkbookValues,
    options: IWorkbookAppendRowsOptions = {},
  ): Promise<IWorkbookRange> {
    const uid = this.resolveUserId(userId);
    this.assertValues(values);

    const append = async (sessionId?: string): Promise<IWorkbookRange> => {
      const used = await this.getUsedRange(uid, itemId, worksheet, {
        driveId: options.driveId,
        sessionId,
      });

      const startRow = await this.resolveAppendStartRow(uid, itemId, worksheet, used, {
        driveId: options.driveId,
        sessionId,
      });

      const columns = this.maxRowLength(values);
      const endRow = startRow + values.length - 1;
      const address = `A${startRow}:${columnLetter(columns)}${endRow}`;

      return this.updateRange(
        uid,
        itemId,
        worksheet,
        address,
        { values },
        { driveId: options.driveId, sessionId },
      );
    };

    if (options.useSession === true) {
      return this.withSession(uid, itemId, (session) => append(session.id), options);
    }

    return append(options.sessionId);
  }

  /** `POST …/worksheets/{worksheet}/range(address='A1:D20')/clear`. */
  async clearRange(
    userId: string,
    itemId: string,
    worksheet: string,
    address: string,
    options: IWorkbookClearRangeOptions = {},
  ): Promise<void> {
    const uid = this.resolveUserId(userId);
    const applyTo = options.applyTo === undefined ? 'All' : options.applyTo;

    if (!CLEAR_APPLY_TO.includes(applyTo as (typeof CLEAR_APPLY_TO)[number])) {
      throw apiError(
        WORKBOOK_ERROR_CODE.INVALID_VALUES,
        `clearRange applyTo must be one of ${CLEAR_APPLY_TO.join(', ')}`,
        { operation: 'workbook.clearRange', applyTo },
      );
    }

    const path = `${this.rangePath(itemId, worksheet, address, options)}/clear`;
    const clear = (sessionId?: string) => this.graphWrite<void>(
      uid,
      path,
      'post',
      { applyTo },
      { operation: 'workbook.clearRange', sessionId },
    );

    if (options.useSession === true) {
      await this.withSession(uid, itemId, (session) => clear(session.id), options);
      return;
    }

    await clear(options.sessionId);
  }

  // ---------------------------------------------------------------------------
  // Tables
  // ---------------------------------------------------------------------------

  /**
   * `GET …/workbook/tables` - or `…/worksheets/{worksheet}/tables`.
   *
   * A table listing is small and changes with the sheet's structure, so it is
   * deliberately not cached: a stale table id makes `addTableRow` fail.
   */
  async listTables(
    userId: string,
    itemId: string,
    options: IWorkbookListTablesOptions = {},
  ): Promise<IWorkbookTable[]> {
    const uid = this.resolveUserId(userId);
    const base = options.worksheet
      ? `${this.worksheetPath(itemId, options.worksheet, options)}/tables`
      : `${this.workbookPath(itemId, options)}/tables`;

    const page = await this.requestJson<IGraphCollection<IWorkbookTable>>(uid, base, {
      operation: 'workbook.listTables',
      sessionId: options.sessionId,
    });

    return Array.isArray(page?.value) ? page.value : [];
  }

  /** `GET …/workbook/tables/{table}` - the identifier may be a name or an id. */
  async getTable(
    userId: string,
    itemId: string,
    table: string,
    options: IWorkbookRequestOptions = {},
  ): Promise<IWorkbookTable> {
    const uid = this.resolveUserId(userId);

    return this.requestJson<IWorkbookTable>(uid, this.tablePath(itemId, table, options), {
      operation: 'workbook.getTable',
      sessionId: options.sessionId,
    });
  }

  /** `GET …/workbook/tables/{table}/columns`. */
  async listTableColumns(
    userId: string,
    itemId: string,
    table: string,
    options: IWorkbookRequestOptions = {},
  ): Promise<IWorkbookTableColumn[]> {
    const uid = this.resolveUserId(userId);

    const page = await this.requestJson<IGraphCollection<IWorkbookTableColumn>>(
      uid,
      `${this.tablePath(itemId, table, options)}/columns`,
      { operation: 'workbook.listTableColumns', sessionId: options.sessionId },
    );

    return Array.isArray(page?.value) ? page.value : [];
  }

  /**
   * `POST …/workbook/tables/{table}/rows/add`.
   *
   * `index: null` appends; a number inserts at that row. The `values` matrix is
   * sent whole - no truncation, no padding.
   */
  async addTableRow(
    userId: string,
    itemId: string,
    table: string,
    values: WorkbookValues,
    options: IWorkbookAddTableRowOptions = {},
  ): Promise<IWorkbookTableRow> {
    const uid = this.resolveUserId(userId);
    this.assertValues(values);

    const body = {
      index: typeof options.index === 'number' && Number.isFinite(options.index)
        ? Math.trunc(options.index)
        : null,
      values,
    };

    const path = `${this.tablePath(itemId, table, options)}/rows/add`;
    const add = (sessionId?: string) => this.graphWrite<IWorkbookTableRow>(
      uid,
      path,
      'post',
      body,
      { operation: 'workbook.addTableRow', sessionId },
    );

    if (options.useSession === true) {
      return this.withSession(uid, itemId, (session) => add(session.id), options);
    }

    return add(options.sessionId);
  }

  /** `DELETE …/workbook/tables/{table}/rows/{rowId}`. */
  async deleteTableRow(
    userId: string,
    itemId: string,
    table: string,
    rowId: string,
    options: IWorkbookRequestOptions = {},
  ): Promise<void> {
    const uid = this.resolveUserId(userId);

    if (rowId === undefined || rowId === null || String(rowId).trim() === '') {
      throw apiError(
        WORKBOOK_ERROR_CODE.MISSING_PARAMETER,
        'A table rowId is required to delete a table row',
        { operation: 'workbook.deleteTableRow' },
      );
    }

    await this.graphWrite<void>(
      uid,
      `${this.tablePath(itemId, table, options)}/rows/${encodeURIComponent(String(rowId))}`,
      'delete',
      undefined,
      { operation: 'workbook.deleteTableRow', sessionId: options.sessionId },
    );
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * `POST …/workbook/createSession` with `persistChanges: true`.
   *
   * Persisting is the only mode this service offers: a session that discards its
   * changes on close would let a caller believe a write landed when it did not.
   *
   * The returned id must be sent as the `workbook-session-id` header on every
   * subsequent request **and** released with {@link closeSession}. Call
   * {@link withSession} unless you genuinely need a long-lived session, because a
   * leaked session pins the workbook.
   */
  async createSession(
    userId: string,
    itemId: string,
    options: IWorkbookRequestOptions = {},
  ): Promise<IWorkbookSession> {
    const uid = this.resolveUserId(userId);

    const response = await this.graphWrite<{ id?: string }>(
      uid,
      `${this.workbookPath(itemId, options)}/createSession`,
      'post',
      { persistChanges: true },
      { operation: 'workbook.createSession' },
    );

    const id = response?.id;

    if (!id) {
      throw apiError(
        WORKBOOK_ERROR_CODE.SESSION_NOT_CREATED,
        'Microsoft Graph created a workbook session without returning an id',
        { operation: 'workbook.createSession', itemId },
      );
    }

    return { id: String(id), persistChanges: true };
  }

  /** `POST …/workbook/closeSession` - the header carries the session id. */
  async closeSession(
    userId: string,
    itemId: string,
    sessionId: string,
    options: IWorkbookRequestOptions = {},
  ): Promise<void> {
    const uid = this.resolveUserId(userId);

    if (sessionId === undefined || sessionId === null || String(sessionId).trim() === '') {
      throw apiError(
        WORKBOOK_ERROR_CODE.MISSING_PARAMETER,
        'A sessionId is required to close a workbook session',
        { operation: 'workbook.closeSession' },
      );
    }

    await this.graphWrite<void>(
      uid,
      `${this.workbookPath(itemId, options)}/closeSession`,
      'post',
      undefined,
      { operation: 'workbook.closeSession', sessionId: String(sessionId) },
    );
  }

  /**
   * Run `run` inside a session and close it in a `finally`.
   *
   * The session is closed whether `run` resolves or rejects. If the close itself
   * fails and the operation succeeded, the close failure is raised (a leaked
   * session is a real failure, not a warning); if the operation failed, its error
   * is preserved and the close failure is logged, because masking the original
   * failure would hide the actual defect.
   */
  async withSession<T>(
    userId: string,
    itemId: string,
    run: (session: IWorkbookSession) => Promise<T>,
    options: IWorkbookRequestOptions = {},
  ): Promise<T> {
    const uid = this.resolveUserId(userId);
    const session = await this.createSession(uid, itemId, options);

    let operationError: unknown;

    try {
      return await run(session);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      // A leaked session pins the workbook for every later request, so the close
      // is not optional - it runs even when the operation above threw.
      try {
        await this.closeSession(uid, itemId, session.id, options);
      } catch (closeError: any) {
        if (operationError === undefined) throw closeError;

        logger.error(
          `AzureWorkbookService: failed to close workbook session ${session.id} for item ${itemId} `
          + `(${closeError?.code || closeError?.message})`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Graph plumbing
  // ---------------------------------------------------------------------------

  /** The provider, bound by the container or resolved from the request context. */
  private get provider(): IWorkbookGraphProvider {
    const provider = (this._graphProvider
      || this.context?.getService?.('azure.AzureGraphClientProvider@1.0.0')) as IWorkbookGraphProvider | undefined;

    if (!provider) {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Azure Graph Client Provider is not available',
        { operation: 'workbook.getProvider' },
      );
    }

    return provider;
  }

  /** The Redis service, used only by the worksheet cache. */
  private get redisService(): any {
    return this._redisService || this.context?.getService?.('core.RedisService@1.0.0');
  }

  /** A `userId` is mandatory; fall back to the request context when omitted. */
  private resolveUserId(userId?: string): string {
    const uid = String(userId || (this.context as any)?.user?._id || '');

    if (!uid) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required for a workbook operation', {
        operation: 'workbook.resolveUserId',
      });
    }

    return uid;
  }

  /** `/me/drive` or `/drives/{driveId}`. */
  private driveBase(options?: IWorkbookRequestOptions): string {
    return options?.driveId
      ? `/drives/${encodeURIComponent(String(options.driveId))}`
      : '/me/drive';
  }

  /** `…/items/{itemId}/workbook`. */
  private workbookPath(itemId: string, options?: IWorkbookRequestOptions): string {
    if (itemId === undefined || itemId === null || String(itemId).trim() === '') {
      throw apiError(
        WORKBOOK_ERROR_CODE.MISSING_PARAMETER,
        'A drive itemId is required for a workbook operation',
        { operation: 'workbook.workbookPath' },
      );
    }

    return `${this.driveBase(options)}/items/${encodeURIComponent(String(itemId))}/workbook`;
  }

  /** `…/workbook/worksheets/{worksheet}` - the identifier may be a name or an id. */
  private worksheetPath(
    itemId: string,
    worksheet: string,
    options?: IWorkbookRequestOptions,
  ): string {
    if (worksheet === undefined || worksheet === null || String(worksheet).trim() === '') {
      throw apiError(
        WORKBOOK_ERROR_CODE.MISSING_PARAMETER,
        'A worksheet name or id is required',
        { operation: 'workbook.worksheetPath' },
      );
    }

    return `${this.workbookPath(itemId, options)}/worksheets/${encodeURIComponent(String(worksheet))}`;
  }

  /**
   * `range(address='A1:D20')`.
   *
   * The single quote is OData's string delimiter: it is doubled *before* the
   * address is percent-encoded, so a value cannot terminate the literal. The
   * colon is legal in a Graph path and is kept literal, so the expression reads
   * the way the documentation writes it; spaces, `#`, `?` and `&` stay encoded so
   * an address cannot change the request.
   */
  private rangeExpression(address: string): string {
    if (address === undefined || address === null || String(address).trim() === '') {
      throw apiError(
        WORKBOOK_ERROR_CODE.INVALID_ADDRESS,
        'A range address is required',
        { operation: 'workbook.rangeExpression' },
      );
    }

    const encoded = encodePathSegment(escapeODataString(String(address).trim()));
    return `range(address='${encoded}')`;
  }

  /** `…/worksheets/{worksheet}/range(address='…')`. */
  private rangePath(
    itemId: string,
    worksheet: string,
    address: string,
    options?: IWorkbookRequestOptions,
  ): string {
    return `${this.worksheetPath(itemId, worksheet, options)}/${this.rangeExpression(address)}`;
  }

  /** `…/workbook/tables/{table}` - the identifier may be a name or an id. */
  private tablePath(
    itemId: string,
    table: string,
    options?: IWorkbookRequestOptions,
  ): string {
    if (table === undefined || table === null || String(table).trim() === '') {
      throw apiError(
        WORKBOOK_ERROR_CODE.MISSING_PARAMETER,
        'A table name or id is required',
        { operation: 'workbook.tablePath' },
      );
    }

    return `${this.workbookPath(itemId, options)}/tables/${encodeURIComponent(String(table))}`;
  }

  /** One GET through the provider (retry and error translation included). */
  private async requestJson<T>(
    userId: string,
    path: string,
    options: IWorkbookCallOptions,
  ): Promise<T> {
    try {
      return await this.provider.request<T>(userId, path, {
        operation: options.operation,
        headers: this.sessionHeaders(options.sessionId),
      }) as T;
    } catch (error) {
      throw this.translate(error, options.operation);
    }
  }

  /**
   * One non-GET Graph call through the provider's client.
   *
   * The SDK client is the right seam here: the `workbook-session-id` header has
   * to travel with the request, and the provider's `request()` is GET-only.
   */
  private async graphWrite<T>(
    userId: string,
    path: string,
    method: 'post' | 'patch' | 'delete',
    body: unknown,
    options: IWorkbookCallOptions,
  ): Promise<T> {
    let request: any;

    try {
      request = this.provider.getClient(userId).api(path);

      const headers = this.sessionHeaders(options.sessionId);
      if (headers) request = request.headers(headers);

      const response = body === undefined
        ? await request[method]()
        : await request[method](body);

      return response as T;
    } catch (error) {
      throw this.translate(error, options.operation);
    }
  }

  /** The `workbook-session-id` header, or `undefined` when there is no session. */
  private sessionHeaders(sessionId?: string): Record<string, string> | undefined {
    if (sessionId === undefined || sessionId === null || String(sessionId).trim() === '') {
      return undefined;
    }

    return { 'workbook-session-id': String(sessionId) };
  }

  /** Translate any thrown Graph error into an `ApiError` that keeps the code. */
  private translate(error: any, operation: string): ApiError {
    return toGraphApiError(error, { operation });
  }

  /**
   * Build the PATCH body from a range update.
   *
   * Only the keys the caller supplied are sent, and every value is forwarded by
   * reference: normalising `null`, parsing `'#DIV/0!'` or copying the matrix
   * would be a silent edit of the caller's data.
   */
  private buildRangeBody(update: IWorkbookRangeUpdate): Record<string, unknown> {
    if (!update || typeof update !== 'object') {
      throw apiError(
        WORKBOOK_ERROR_CODE.INVALID_VALUES,
        'A range update with a values matrix is required',
        { operation: 'workbook.updateRange' },
      );
    }

    this.assertValues(update.values);

    const body: Record<string, unknown> = { values: update.values };

    if (update.formulas !== undefined) body.formulas = update.formulas;
    if (update.numberFormat !== undefined) body.numberFormat = update.numberFormat;

    return body;
  }

  /** Reject a payload that is not a non-empty row-major matrix - before any call. */
  private assertValues(values: WorkbookValues): void {
    if (!Array.isArray(values) || values.length === 0) {
      throw apiError(
        WORKBOOK_ERROR_CODE.INVALID_VALUES,
        'values must be a non-empty row-major matrix',
        { operation: 'workbook.assertValues' },
      );
    }

    for (const row of values) {
      if (!Array.isArray(row)) {
        throw apiError(
          WORKBOOK_ERROR_CODE.INVALID_VALUES,
          'values must be a row-major matrix: every row must be an array',
          { operation: 'workbook.assertValues', rows: values.length },
        );
      }
    }
  }

  /** The widest row in the matrix; the append address needs an exact width. */
  private maxRowLength(values: WorkbookValues): number {
    return values.reduce(
      (max, row) => Math.max(max, Array.isArray(row) ? row.length : 0),
      0,
    ) || 1;
  }

  /**
   * The first row an append may write.
   *
   * Normally `usedRange.rowIndex + usedRange.rowCount + 1`. A pristine worksheet
   * is reported by Graph as `A1` with one row and one column, which is
   * indistinguishable from a sheet whose `A1` is genuinely used - so that case is
   * probed once with `valuesOnly: true` before starting at row 1.
   */
  private async resolveAppendStartRow(
    userId: string,
    itemId: string,
    worksheet: string,
    used: IWorkbookRange | undefined,
    options: IWorkbookRequestOptions,
  ): Promise<number> {
    const rowIndex = typeof used?.rowIndex === 'number' ? used.rowIndex : 0;
    const rowCount = typeof used?.rowCount === 'number' ? used.rowCount : 0;

    if (!this.isPristineRange(used)) return rowIndex + rowCount + 1;

    const probe = await this.getUsedRange(userId, itemId, worksheet, {
      driveId: options.driveId,
      sessionId: options.sessionId,
      valuesOnly: true,
    });

    const hasValue = Array.isArray(probe?.values)
      && probe.values.some((row) => Array.isArray(row)
        && row.some((cell) => cell !== null && cell !== ''));

    return hasValue ? rowIndex + rowCount + 1 : rowIndex + 1;
  }

  /** True when `usedRange` may be the one-cell `A1` shape Graph gives an empty sheet. */
  private isPristineRange(used: IWorkbookRange | undefined): boolean {
    if (!used) return false;

    return used.rowIndex === 0
      && used.columnIndex === 0
      && used.rowCount === 1
      && used.columnCount === 1
      && String(used.address || '').toUpperCase().startsWith('A1');
  }

  // ---------------------------------------------------------------------------
  // Worksheet cache (best-effort, never authoritative)
  // ---------------------------------------------------------------------------

  /**
   * Read the worksheet list from Redis. A miss, a malformed payload and a Redis
   * failure all read as "not cached" - a cache outage must not fail a read.
   */
  private async readWorksheetsCache(cacheKey: string): Promise<IWorkbookWorksheet[] | undefined> {
    try {
      const redis = this.redisService;
      if (!redis || typeof redis.get !== 'function') return undefined;

      const raw = await redis.get(cacheKey);
      if (!raw) return undefined;

      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(parsed?.items)) return undefined;

      return parsed.items as IWorkbookWorksheet[];
    } catch {
      return undefined;
    }
  }

  /** Write the worksheet list for two minutes. A failure is swallowed. */
  private async writeWorksheetsCache(cacheKey: string, items: IWorkbookWorksheet[]): Promise<void> {
    try {
      const redis = this.redisService;
      if (!redis || typeof redis.set !== 'function') return;

      await redis.set(
        cacheKey,
        JSON.stringify({ items, cachedAt: new Date().toISOString() }),
        WORKBOOK_WORKSHEETS_CACHE_TTL_SECONDS,
      );
    } catch {
      // Cache writes are best-effort: a Redis outage must not fail a workbook read.
    }
  }
}

/** `azure:{userId}:workbook:worksheets:{itemId}` - plus the drive when one is addressed. */
export function worksheetCacheKey(userId: string, itemId: string, driveId?: string): string {
  const key = driveId ? `${driveId}:${itemId}` : itemId;
  return azureCacheKey(userId, AzureCacheDomain.WORKBOOK_WORKSHEETS, key);
}

/**
 * A zero-based column index as an A1 column label (`1` → `A`, `27` → `AA`).
 *
 * Exported because `appendRows` builds an address from it and the tests assert
 * the boundary cases rather than trusting the loop.
 */
export function columnLetter(column: number): string {
  let index = Math.max(1, Math.trunc(Number(column) || 1));
  let label = '';

  while (index > 0) {
    const remainder = (index - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    index = Math.floor((index - 1) / 26);
  }

  return label;
}

export const AzureWorkbookServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureWorkbookService> = {
  service: (props: any, context: any) => new AzureWorkbookService(props, context),
  id: 'azure.AzureWorkbookService@1.0.0',
  name: 'AzureWorkbookService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Excel workbook worksheets, ranges, tables and sessions over Microsoft Graph',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphProvider' },
    { id: 'core.RedisService@1.0.0', alias: 'redisService' },
  ],
};

export { AzureWorkbookService };

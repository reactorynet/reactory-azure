/**
 * Excel workbook (Microsoft Graph `/workbook`) domain types and the
 * `AzureWorkbookService` contract.
 *
 * Two rules shape this file:
 *
 *  1. **Values are `any[][]` and are never coerced.** Graph returns `null` for an
 *     empty cell and a *string* such as `'#DIV/0!'` or `'#VALUE!'` for an error
 *     cell. A consumer that needs numbers has to deal with both, so the service
 *     passes the matrix through untouched - it does not map `null` to `''`, does
 *     not parse error strings, and does not round numbers. Turning `'#DIV/0!'`
 *     into `null` (or dropping it) would silently change a workbook's meaning.
 *  2. **Values are never truncated.** A range write sends exactly the rows it was
 *     given; there is no row or cell cap, and no paging on a write. A worksheet
 *     read returns the range Graph returned in full. Silently trimming a payload
 *     is the same class of bug as swallowing an error.
 *
 * Addressing: a workbook is a drive item, so every operation starts at
 * `/me/drive/items/{itemId}/workbook` (or `/drives/{driveId}/items/{itemId}/...`).
 * Worksheets and tables are addressed by **id or name** - Graph accepts either -
 * and are percent-encoded by the service, never by the caller.
 */
import type { AzureTokenSource } from './azure.types';

/**
 * One cell value as Graph represents it.
 *
 * `string` covers both text (`'Total'`) and an error literal (`'#DIV/0!'`);
 * `null` is an empty cell. `undefined` is deliberately not in the union: a
 * missing cell is `null` on the wire, and accepting `undefined` would let a
 * caller send a sparse row that Graph rejects.
 */
export type WorkbookCellValue = string | number | boolean | null;

/** A row-major matrix of cell values, exactly as Graph sends and receives it. */
export type WorkbookValues = WorkbookCellValue[][];

/** A formula matrix (`'=SUM(A1:A3)'`) or `null` per cell. */
export type WorkbookFormulas = (string | number | boolean | null)[][];

/** A number-format matrix (`'0.00'`, `'yyyy-mm-dd'`). */
export type WorkbookNumberFormats = (string | number | boolean | null)[][];

/** Values accepted by `clearRange`. Graph's `applyTo` enumeration. */
export type WorkbookClearApplyTo = 'All' | 'Formats' | 'Contents';

/**
 * Error codes the workbook service raises itself.
 *
 * Graph's own codes (`itemNotFound`, `accessDenied`, `InvalidArgument`, ...)
 * arrive unchanged through `toGraphApiError`; these cover the failures that never
 * reach Graph because the request could not be built.
 */
export const WORKBOOK_ERROR_CODE = {
  /** A required identifier (itemId, worksheet, table, address) is missing. */
  MISSING_PARAMETER: 'WorkbookMissingParameter',
  /** `values` is not a non-empty row-major matrix. */
  INVALID_VALUES: 'WorkbookInvalidValues',
  /** A range address is blank or contains a character Graph cannot address. */
  INVALID_ADDRESS: 'WorkbookInvalidAddress',
  /** `/workbook/createSession` answered without a session id. */
  SESSION_NOT_CREATED: 'WorkbookSessionNotCreated',
} as const;

/** Options every workbook call accepts. */
export interface IWorkbookRequestOptions {
  /** Address a SharePoint/other drive instead of the signed-in user's drive. */
  driveId?: string;
  /**
   * A session id from `createSession()`.
   *
   * When supplied it is sent as the `workbook-session-id` header on this call
   * only. Prefer `withSession()` (or `useSession: true`): it closes the session
   * for you, and a session that is never closed pins the workbook.
   */
  sessionId?: string;
}

/** Options for `listWorksheets`. */
export interface IWorkbookListWorksheetsOptions extends IWorkbookRequestOptions {
  /** Bypass (and refresh) the two-minute worksheet cache. */
  forceRefresh?: boolean;
}

/** Options for `getUsedRange`. */
export interface IWorkbookGetRangeOptions extends IWorkbookRequestOptions {
  /**
   * `true` returns `values`, `text`, `valueTypes`, `formulas` and `numberFormat`
   * alongside the address; Graph's default is `false` (address and counts only).
   *
   * The parameter is sent as `usedRange(valuesOnly=…)` only when the caller sets
   * it, so the documented plain `…/usedRange` path stays reachable.
   */
  valuesOnly?: boolean;
}

/** Options for `appendRows`. */
export interface IWorkbookAppendRowsOptions extends IWorkbookRequestOptions {
  /**
   * When true the whole append (used-range read + write) runs inside one workbook
   * session, so no other writer can interleave between the two requests.
   */
  useSession?: boolean;
}

/** Options for `updateRange`. */
export interface IWorkbookUpdateRangeOptions extends IWorkbookRequestOptions {
  /** Run the write inside a session, closed in a `finally`. */
  useSession?: boolean;
}

/** Options for `clearRange`. */
export interface IWorkbookClearRangeOptions extends IWorkbookUpdateRangeOptions {
  /** Graph's `applyTo`: `All` (default), `Formats` or `Contents`. */
  applyTo?: WorkbookClearApplyTo;
}

/** Options for `listTables` - scope the list to one worksheet. */
export interface IWorkbookListTablesOptions extends IWorkbookRequestOptions {
  /** When set, list `…/worksheets/{worksheet}/tables`; otherwise `…/workbook/tables`. */
  worksheet?: string;
}

/** Options for `getTable` / `listTableColumns`. */
export type IWorkbookTableOptions = IWorkbookRequestOptions;

/** Options for `addTableRow`. */
export interface IWorkbookAddTableRowOptions extends IWorkbookRequestOptions {
  /** Zero-based row index to insert at; omitted (or null) appends. */
  index?: number;
  /** Run the insert inside a session, closed in a `finally`. */
  useSession?: boolean;
}

/** A range write: `values` is mandatory, `formulas`/`numberFormat` are optional. */
export interface IWorkbookRangeUpdate {
  values: WorkbookValues;
  formulas?: WorkbookFormulas;
  numberFormat?: WorkbookNumberFormats;
}

/** A worksheet (`/workbook/worksheets/{id}`). */
export interface IWorkbookWorksheet {
  id: string;
  name?: string;
  /** Zero-based position in the workbook. */
  position?: number;
  /** `Visible`, `Hidden` or `VeryHidden`. */
  visibility?: string;
}

/**
 * A range (`/workbook/worksheets/{id|name}/range(address='…')`).
 *
 * `values` is optional because Graph only returns it when it was asked for -
 * `usedRange` without `valuesOnly` returns the address and counts.
 */
export interface IWorkbookRange {
  address: string;
  addressLocal?: string;
  cellCount?: number;
  columnCount?: number;
  columnIndex?: number;
  rowCount?: number;
  rowIndex?: number;
  /** Row-major values; `null` for an empty cell, `'#DIV/0!'` for an error cell. */
  values?: WorkbookValues;
  /** Row-major display text. */
  text?: (string | null)[][];
  /** Row-major value *types* (`'String'`, `'Double'`, `'Error'`, ...). */
  valueTypes?: (string | null)[][];
  formulas?: WorkbookFormulas;
  numberFormat?: WorkbookNumberFormats;
}

/** A table (`/workbook/tables/{id|name}`). */
export interface IWorkbookTable {
  id: string;
  name?: string;
  displayName?: string;
  showHeaders?: boolean;
  showTotals?: boolean;
  style?: string;
  /** The A1 address of the table body, headers excluded. */
  tableRange?: string;
}

/** One table column (`/workbook/tables/{id}/columns/{id}`). */
export interface IWorkbookTableColumn {
  id: string;
  name?: string;
  index?: number;
  values?: WorkbookValues;
}

/** One table row (`/workbook/tables/{id}/rows/{index}`). */
export interface IWorkbookTableRow {
  index?: number;
  values?: WorkbookValues;
}

/** A workbook session (`POST /workbook/createSession`). */
export interface IWorkbookSession {
  id: string;
  /** Always `true` for sessions this service creates: changes are persisted. */
  persistChanges?: boolean;
}

/**
 * The `AzureWorkbookService` contract.
 *
 * Every method takes the owning `userId` first and the drive item id second. A
 * user id is mandatory: the Graph client is authenticated per user.
 */
export interface IAzureWorkbookService {
  /** `GET …/workbook/worksheets`, cached for two minutes per user and item. */
  listWorksheets(
    userId: string,
    itemId: string,
    options?: IWorkbookListWorksheetsOptions,
  ): Promise<IWorkbookWorksheet[]>;

  /** `GET …/worksheets/{worksheet}/usedRange[(valuesOnly=…)]`. */
  getUsedRange(
    userId: string,
    itemId: string,
    worksheet: string,
    options?: IWorkbookGetRangeOptions,
  ): Promise<IWorkbookRange>;

  /** `GET …/worksheets/{worksheet}/range(address='…')`. */
  getRange(
    userId: string,
    itemId: string,
    worksheet: string,
    address: string,
    options?: IWorkbookRequestOptions,
  ): Promise<IWorkbookRange>;

  /** `PATCH …/worksheets/{worksheet}/range(address='…')` with the given matrix. */
  updateRange(
    userId: string,
    itemId: string,
    worksheet: string,
    address: string,
    update: IWorkbookRangeUpdate,
    options?: IWorkbookUpdateRangeOptions,
  ): Promise<IWorkbookRange>;

  /**
   * Append rows below the worksheet's used range.
   *
   * Graph has no worksheet-level append endpoint, so this composes a used-range
   * read with one range write (both in one session when `useSession` is set).
   */
  appendRows(
    userId: string,
    itemId: string,
    worksheet: string,
    values: WorkbookValues,
    options?: IWorkbookAppendRowsOptions,
  ): Promise<IWorkbookRange>;

  /** `POST …/worksheets/{worksheet}/range(address='…')/clear`. */
  clearRange(
    userId: string,
    itemId: string,
    worksheet: string,
    address: string,
    options?: IWorkbookClearRangeOptions,
  ): Promise<void>;

  /** `GET …/workbook/tables` or `…/worksheets/{worksheet}/tables`. */
  listTables(
    userId: string,
    itemId: string,
    options?: IWorkbookListTablesOptions,
  ): Promise<IWorkbookTable[]>;

  /** `GET …/workbook/tables/{table}` (id or name). */
  getTable(
    userId: string,
    itemId: string,
    table: string,
    options?: IWorkbookTableOptions,
  ): Promise<IWorkbookTable>;

  /** `POST …/workbook/tables/{table}/rows/add` - the append/insert primitive. */
  addTableRow(
    userId: string,
    itemId: string,
    table: string,
    values: WorkbookValues,
    options?: IWorkbookAddTableRowOptions,
  ): Promise<IWorkbookTableRow>;

  /** `DELETE …/workbook/tables/{table}/rows/{rowId}`. */
  deleteTableRow(
    userId: string,
    itemId: string,
    table: string,
    rowId: string,
    options?: IWorkbookRequestOptions,
  ): Promise<void>;

  /** `GET …/workbook/tables/{table}/columns`. */
  listTableColumns(
    userId: string,
    itemId: string,
    table: string,
    options?: IWorkbookTableOptions,
  ): Promise<IWorkbookTableColumn[]>;

  /** `POST …/workbook/createSession` with `persistChanges: true`. */
  createSession(
    userId: string,
    itemId: string,
    options?: IWorkbookRequestOptions,
  ): Promise<IWorkbookSession>;

  /** `POST …/workbook/closeSession` with the `workbook-session-id` header. */
  closeSession(
    userId: string,
    itemId: string,
    sessionId: string,
    options?: IWorkbookRequestOptions,
  ): Promise<void>;

  /**
   * Run `run` inside a workbook session and close it in a `finally`.
   *
   * The close happens even when `run` throws, because a leaked
   * `/workbook/createSession` pins the workbook for every later request.
   */
  withSession<T>(
    userId: string,
    itemId: string,
    run: (session: IWorkbookSession) => Promise<T>,
    options?: IWorkbookRequestOptions,
  ): Promise<T>;
}

/** Re-exported so a caller can annotate a token without importing azure.types. */
export type WorkbookTokenSource = AzureTokenSource;

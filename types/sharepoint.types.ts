/**
 * SharePoint domain types (AZ-15).
 *
 * These mirror the **v1.0** Microsoft Graph resources returned by the site, list
 * and list-item endpoints:
 *
 *   GET /sites/{hostname}:/{site-path}   a site resolved from its path
 *   GET /sites/root                      the tenant root site
 *   GET /sites?search={term}             sites matching a term
 *   GET /sites/{site-id}/lists           the lists (and libraries) on a site
 *   GET /sites/{site-id}/drive           the site's document library drive
 *   GET /sites/{site-id}/lists/{id}/items?expand=fields
 *   GET /sites/{site-id}/lists/{id}/columns
 *
 * ## The two details that decide whether this integration works at all
 *
 * 1. **`expand=fields` has no OData dollar prefix.**
 *    List items do not carry their column data inline. A list-item read must ask
 *    for the `fields` navigation property, and Microsoft's published list-item
 *    examples use the plain `expand` query parameter (`?expand=fields`), not
 *    `$expand`. A `$expand` here is reported to be accepted and then return no
 *    `fields` at all - a *silent empty result*, which is worse than an error
 *    because the caller believes the list is empty. See
 *    `LIST_ITEMS_EXPAND_PARAM` and `AzureSharePointService.listItems`.
 *
 * 2. **The keys inside `fields` are INTERNAL column names, not display names.**
 *    The payload for a list item is `{ id, fields }`, and `fields` is keyed by
 *    the site's internal name (`Title`, `Status`, `_x0043_lient`), never by the
 *    name a user sees in the SharePoint UI (`Workflow Status`). SharePoint
 *    ignores an unknown key: the write succeeds and stores nothing. That is why
 *    {@link IAzureSharePointColumn} exists and why `createItem` validates every
 *    key against `getListColumns` before it sends the request.
 */

/**
 * The one query parameter this module adds to a list-item read.
 *
 * Deliberately **not** `$expand=fields`. Kept as a named constant so the
 * request-shape test can assert the exact form and so nobody "fixes" it into the
 * OData-prefixed spelling that silently drops the column data.
 */
export const LIST_ITEMS_EXPAND_PARAM = 'expand=fields';

/**
 * The site-lookup query parameter. `GET /sites?search={term}` is also spelled
 * without a dollar prefix - the sites collection does not accept `$search`.
 */
export const SITES_SEARCH_PARAM = 'search';

/** Default `$select` for a site read / list operation. */
export const DEFAULT_SHAREPOINT_SITE_SELECT = [
  'id',
  'name',
  'displayName',
  'webUrl',
  'root',
  'siteCollection',
  'createdDateTime',
  'lastModifiedDateTime',
].join(',');

/** The list projection AZ-15 specifies: `id,name,displayName,list,webUrl`. */
export const SHAREPOINT_LIST_SELECT = 'id,name,displayName,list,webUrl';

/** The drive projection used by {@link IAzureSharePointDrive}. */
export const SHAREPOINT_DRIVE_SELECT = 'id,name,driveType,webUrl,description';

/** Default `$top` for a list-item page; SharePoint allows far more but a UI never needs it. */
export const DEFAULT_SHAREPOINT_ITEM_TOP = 100;

/** Error codes this service raises itself (Graph's own codes pass through untouched). */
export const SHAREPOINT_ERROR_CODE = {
  /**
   * A `fields` key is not an internal column name on the target list. Raised
   * before the write, because SharePoint would otherwise accept the request and
   * store nothing.
   */
  UNKNOWN_COLUMN: 'SharePointUnknownColumn',
  /** The `fields` payload is missing, empty, or not a plain object. */
  INVALID_FIELDS: 'SharePointInvalidFields',
  /** A required id / hostname / path is missing or empty. */
  MISSING_PARAMETER: 'MissingSharePointParameter',
} as const;

/**
 * The `columnDefinition` facet a column is built from.
 *
 * Graph models a column's *value* type by the presence of exactly one facet
 * (`text`, `number`, `choice`, ...), which is what `columnType` reports.
 */
export type AzureSharePointColumnType =
  | 'text'
  | 'number'
  | 'choice'
  | 'dateTime'
  | 'boolean'
  | 'personOrGroup'
  | 'calculated'
  | 'lookup'
  | 'currency'
  | 'hyperlinkOrPicture'
  | 'thumbnail'
  | 'term'
  | 'contentApprovalStatus'
  | 'geolocation';

/** The facets probed, in a stable order, to derive `columnType`. */
export const SHAREPOINT_COLUMN_FACETS: readonly AzureSharePointColumnType[] = [
  'text',
  'number',
  'choice',
  'dateTime',
  'boolean',
  'personOrGroup',
  'calculated',
  'lookup',
  'currency',
  'hyperlinkOrPicture',
  'thumbnail',
  'term',
  'contentApprovalStatus',
  'geolocation',
];

/** A SharePoint site (`site` resource), normalised. */
export interface IAzureSharePointSite {
  id: string;
  /** Last segment of the site URL, e.g. `marketing`. */
  name?: string;
  displayName?: string;
  webUrl?: string;
  /** Host of the site collection, e.g. `contoso.sharepoint.com`. */
  hostname?: string;
  /** True for the site collection root. */
  isRoot?: boolean;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

/** A SharePoint list or document library (`list` resource), normalised. */
export interface IAzureSharePointList {
  id: string;
  /** URL-safe name, e.g. `Documents`. */
  name?: string;
  displayName?: string;
  webUrl?: string;
  /** List template, e.g. `documentLibrary`, `genericList`. */
  template?: string;
  hidden?: boolean;
  contentTypeId?: string;
}

/** Content type assigned to a list item. */
export interface IAzureSharePointItemContentType {
  id?: string;
  name?: string;
}

/**
 * One list item.
 *
 * `fields` is the column data, keyed by the list's **internal** column names.
 * It is `{}` only when Graph genuinely returned no `fields` object (a write that
 * was not expanded); it is never a substitute for a failed read.
 */
export interface IAzureSharePointListItem {
  id: string;
  fields: Record<string, unknown>;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  contentType?: IAzureSharePointItemContentType;
}

/** One page of list items, with the opaque cursor for the next page. */
export interface IAzureSharePointItemPage {
  items: IAzureSharePointListItem[];
  /** `@odata.nextLink` - absent on the last page. */
  nextLink?: string;
}

/**
 * A column definition, exposed so a caller can map a display name
 * (`Workflow Status`) to the internal name (`Status`) that `fields` requires.
 */
export interface IAzureSharePointColumn {
  id: string;
  /** The internal name - the key `fields` uses. */
  name: string;
  displayName?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  readOnly?: boolean;
  enforceUniqueValues?: boolean;
  columnType?: AzureSharePointColumnType;
}

/**
 * A site's document library drive.
 *
 * The `id` is the key that joins SharePoint documents to AZ-08's drive surface
 * (`AzureDriveService` addresses `/drives/{drive-id}/...`).
 */
export interface IAzureSharePointDrive {
  id: string;
  name?: string;
  driveType?: string;
  webUrl?: string;
  description?: string;
}

/** Paging options for a list-item read. */
export interface IAzureSharePointItemListOptions {
  /** `$top` for one page; defaults to {@link DEFAULT_SHAREPOINT_ITEM_TOP}. */
  top?: number;
  /**
   * Continue from a previous `AzureSharePointItemPage.nextLink`. The URL is used
   * verbatim (it already carries `expand=fields` and the cursor), so every other
   * option is ignored for that page.
   */
  nextLink?: string;
  /** Drain every page (bounded by `maxPages`; the provider throws at the bound). */
  all?: boolean;
  /** Page bound for `all`; defaults to the provider's bound. */
  maxPages?: number;
}

/**
 * The write payload for a list item: `{ fields: { ... } }`.
 *
 * There is deliberately no top-level `id`: Graph owns the item id, and the only
 * thing a caller supplies is the column data. Keys must be internal column names
 * - `createItem` rejects anything else rather than letting SharePoint silently
 * discard it.
 */
export interface IAzureSharePointItemInput {
  fields: Record<string, unknown>;
}

/** The public contract of `azure.AzureSharePointService@1.0.0`. */
export interface IAzureSharePointService {
  getSiteByPath(userId: string, hostname: string, sitePath: string): Promise<IAzureSharePointSite>;
  getRootSite(userId: string): Promise<IAzureSharePointSite>;
  listSites(userId: string, search?: string): Promise<IAzureSharePointSite[]>;
  listLists(userId: string, siteId: string): Promise<IAzureSharePointList[]>;
  listItems(
    userId: string,
    siteId: string,
    listId: string,
    options?: IAzureSharePointItemListOptions,
  ): Promise<IAzureSharePointItemPage>;
  getItem(userId: string, siteId: string, listId: string, itemId: string): Promise<IAzureSharePointListItem>;
  createItem(
    userId: string,
    siteId: string,
    listId: string,
    input: IAzureSharePointItemInput,
  ): Promise<IAzureSharePointListItem>;
  updateItem(
    userId: string,
    siteId: string,
    listId: string,
    itemId: string,
    input: IAzureSharePointItemInput,
  ): Promise<IAzureSharePointListItem>;
  deleteItem(userId: string, siteId: string, listId: string, itemId: string): Promise<void>;
  getListColumns(userId: string, siteId: string, listId: string): Promise<IAzureSharePointColumn[]>;
  getSiteDrive(userId: string, siteId: string): Promise<IAzureSharePointDrive>;
}

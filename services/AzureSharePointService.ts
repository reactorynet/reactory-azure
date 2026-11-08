import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { encodePathSegment, withQuery } from '../utils/odata';
import { GraphErrorCode, apiError, toGraphApiError } from '../utils/graph-error';
import type { IGraphProviderOptions } from './graph/AzureGraphClientProvider';
import type {
  IAzureSharePointColumn,
  IAzureSharePointDrive,
  IAzureSharePointItemInput,
  IAzureSharePointItemListOptions,
  IAzureSharePointItemPage,
  IAzureSharePointList,
  IAzureSharePointListItem,
  IAzureSharePointService,
  IAzureSharePointSite,
} from '../types/sharepoint.types';
import {
  DEFAULT_SHAREPOINT_ITEM_TOP,
  DEFAULT_SHAREPOINT_SITE_SELECT,
  LIST_ITEMS_EXPAND_PARAM,
  SHAREPOINT_COLUMN_FACETS,
  SHAREPOINT_DRIVE_SELECT,
  SHAREPOINT_ERROR_CODE,
  SHAREPOINT_LIST_SELECT,
  SITES_SEARCH_PARAM,
} from '../types/sharepoint.types';

/** The raw Graph collection envelope (only the parts this service reads). */
interface IGraphCollection<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

/** The provider surface this service depends on - typed so generic calls are checked. */
interface ISharePointGraphProvider {
  request<T>(userId: string, path: string, options?: IGraphProviderOptions): Promise<T>;
  requestAll<T>(userId: string, path: string, options?: IGraphProviderOptions): Promise<T[]>;
  getClient(userId: string): any;
}

const SITES_PATH = '/sites';

/** `/sites/{site-id}` - the site id is a composite (`host,guid,guid`) and is encoded as one segment. */
function sitePath(siteId: string): string {
  return `${SITES_PATH}/${encodePathSegment(String(siteId))}`;
}

/** `/sites/{site-id}/lists`. */
function listsPath(siteId: string): string {
  return `${sitePath(siteId)}/lists`;
}

/** `/sites/{site-id}/lists/{list-id}`. */
function listPath(siteId: string, listId: string): string {
  return `${listsPath(siteId)}/${encodePathSegment(String(listId))}`;
}

/** `/sites/{site-id}/lists/{list-id}/items`. */
function itemsPath(siteId: string, listId: string): string {
  return `${listPath(siteId, listId)}/items`;
}

/** `/sites/{site-id}/lists/{list-id}/items/{item-id}`. */
function itemPath(siteId: string, listId: string, itemId: string): string {
  return `${itemsPath(siteId, listId)}/${encodePathSegment(String(itemId))}`;
}

/**
 * Build the path-addressed site lookup: `/sites/{hostname}:/{site-path}`.
 *
 * The `:` and the `/` after it are literal - they are the delimiter that turns a
 * hostname plus a server-relative path into a site id. `encodePathSegment`
 * restores `:` after percent-encoding and preserves `/` as a separator, so a
 * path segment containing a space is encoded (`/sites/Team Site` becomes
 * `/sites/Team%20Site`) while the addressing syntax survives.
 *
 * An empty (or `/`) path addresses the site collection root, which is the
 * documented `/sites/{hostname}:/` form.
 */
function siteByPathPath(hostname: string, sitePathValue: string): string {
  const host = encodePathSegment(String(hostname).trim());
  const path = typeof sitePathValue === 'string'
    ? sitePathValue.replace(/^\/+/, '').replace(/\/+$/, '')
    : '';

  return path.length === 0
    ? `${SITES_PATH}/${host}:/`
    : `${SITES_PATH}/${host}:/${encodePathSegment(path)}`;
}

/** Copy a non-empty string onto a target object. */
function assignString(target: any, key: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) target[key] = value;
}

/** A finite, positive `$top`, or the provided default. */
function pageSize(value: number | undefined, fallback: number = DEFAULT_SHAREPOINT_ITEM_TOP): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

/** Normalise one `site` resource. */
function normaliseSite(raw: any): IAzureSharePointSite {
  const site: IAzureSharePointSite = { id: String(raw?.id ?? '') };

  assignString(site, 'name', raw?.name);
  assignString(site, 'displayName', raw?.displayName);
  assignString(site, 'webUrl', raw?.webUrl);
  assignString(site, 'hostname', raw?.siteCollection?.hostname);
  assignString(site, 'createdDateTime', raw?.createdDateTime);
  assignString(site, 'lastModifiedDateTime', raw?.lastModifiedDateTime);

  if (typeof raw?.root === 'boolean') site.isRoot = raw.root;

  return site;
}

/** Normalise one `list` resource. */
function normaliseList(raw: any): IAzureSharePointList {
  const list: IAzureSharePointList = { id: String(raw?.id ?? '') };

  assignString(list, 'name', raw?.name);
  assignString(list, 'displayName', raw?.displayName);
  assignString(list, 'webUrl', raw?.webUrl);
  assignString(list, 'template', raw?.list?.template);
  assignString(list, 'contentTypeId', raw?.list?.contentTypeId);

  if (typeof raw?.list?.hidden === 'boolean') list.hidden = raw.list.hidden;

  return list;
}

/**
 * Normalise one list item.
 *
 * `fields` is copied only when Graph actually returned an object. The keys are
 * forwarded unchanged: they are the list's internal column names, and renaming
 * them here would break the round-trip between a read and a write.
 */
function normaliseItem(raw: any): IAzureSharePointListItem {
  const item: IAzureSharePointListItem = {
    id: String(raw?.id ?? ''),
    fields: raw?.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields)
      ? { ...raw.fields }
      : {},
  };

  assignString(item, 'webUrl', raw?.webUrl);
  assignString(item, 'createdDateTime', raw?.createdDateTime);
  assignString(item, 'lastModifiedDateTime', raw?.lastModifiedDateTime);

  const contentType = raw?.contentType;
  if (contentType && typeof contentType === 'object') {
    const normalised: { id?: string; name?: string } = {};
    assignString(normalised, 'id', contentType.id);
    assignString(normalised, 'name', contentType.name);
    if (Object.keys(normalised).length > 0) item.contentType = normalised;
  }

  return item;
}

/**
 * Derive the value type of a `columnDefinition`.
 *
 * Graph expresses the type as exactly one facet object (`text`, `choice`, ...);
 * the first one present wins. A column with no recognised facet reports no
 * `columnType` rather than guessing.
 */
function columnType(raw: any): IAzureSharePointColumn['columnType'] {
  if (!raw || typeof raw !== 'object') return undefined;

  for (const facet of SHAREPOINT_COLUMN_FACETS) {
    if (raw[facet] !== undefined && raw[facet] !== null) return facet;
  }

  return undefined;
}

/** Normalise one `columnDefinition`. */
function normaliseColumn(raw: any): IAzureSharePointColumn {
  const column: IAzureSharePointColumn = {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? ''),
  };

  assignString(column, 'displayName', raw?.displayName);
  assignString(column, 'description', raw?.description);

  if (typeof raw?.required === 'boolean') column.required = raw.required;
  if (typeof raw?.hidden === 'boolean') column.hidden = raw.hidden;
  if (typeof raw?.readOnly === 'boolean') column.readOnly = raw.readOnly;
  if (typeof raw?.enforceUniqueValues === 'boolean') {
    column.enforceUniqueValues = raw.enforceUniqueValues;
  }

  const type = columnType(raw);
  if (type) column.columnType = type;

  return column;
}

/** Normalise one `drive` resource (a site's document library). */
function normaliseDrive(raw: any): IAzureSharePointDrive {
  const drive: IAzureSharePointDrive = { id: String(raw?.id ?? '') };

  assignString(drive, 'name', raw?.name);
  assignString(drive, 'driveType', raw?.driveType);
  assignString(drive, 'webUrl', raw?.webUrl);
  assignString(drive, 'description', raw?.description);

  return drive;
}

/**
 * Require a `{ fields: { ... } }` write payload.
 *
 * An empty `fields` object is rejected locally: Graph accepts it, writes nothing
 * and returns 201, which is exactly the silent no-op this service exists to
 * prevent. A non-object (an array, a string, `null`) is rejected for the same
 * reason.
 */
function requireFields(
  input: IAzureSharePointItemInput | undefined,
  operation: string,
): Record<string, unknown> {
  const fields = (input as any)?.fields;

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw apiError(
      SHAREPOINT_ERROR_CODE.INVALID_FIELDS,
      'A SharePoint list item write requires { fields: { ... } }',
      { operation },
    );
  }

  if (Object.keys(fields).length === 0) {
    throw apiError(
      SHAREPOINT_ERROR_CODE.INVALID_FIELDS,
      'A SharePoint list item write requires at least one field (an empty fields object writes nothing)',
      { operation },
    );
  }

  return fields as Record<string, unknown>;
}

/**
 * Refuse a `fields` key that is not an internal column name on the list.
 *
 * This is the guard against the defining SharePoint defect: an unknown key is
 * **not** an error to SharePoint. It returns 201, the item exists, and the value
 * is missing - so a caller who passes a display name (`Workflow Status`) or a
 * guessed internal name believes the write succeeded. Validating against
 * `getListColumns` turns that into a loud, typed failure before the request.
 *
 * Matching is exact (SharePoint internal names are case-sensitive). When a key
 * differs only in case, the error names the correct spelling - that is the
 * single most common near-miss (`title` for `Title`).
 */
function assertKnownColumns(
  fields: Record<string, unknown>,
  columns: IAzureSharePointColumn[],
  meta: { operation: string; siteId?: string; listId?: string },
): void {
  const allowed = columns
    .map((column) => column.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  const allowedSet = new Set(allowed);

  const unknown = Object.keys(fields).filter((key) => !allowedSet.has(key));
  if (unknown.length === 0) return;

  const hints = unknown
    .map((key) => {
      const match = allowed.find((name) => name.toLowerCase() === key.toLowerCase());
      return match ? `${key} -> ${match}` : undefined;
    })
    .filter((hint): hint is string => hint !== undefined);

  throw apiError(
    SHAREPOINT_ERROR_CODE.UNKNOWN_COLUMN,
    `SharePoint field(s) [${unknown.join(', ')}] are not internal column names on this list. `
      + 'The keys of `fields` must be the INTERNAL names returned by getListColumns '
      + '(display names and guessed names are silently discarded by SharePoint).'
      + (hints.length > 0 ? ` Did you mean: ${hints.join(', ')}?` : ''),
    {
      ...meta,
      unknownColumns: unknown,
      allowedColumns: allowed.slice(0, 100),
      ...(hints.length > 0 ? { caseHints: hints } : {}),
    },
  );
}

/**
 * AzureSharePointService - Microsoft Graph SharePoint sites, lists, list items,
 * list columns and the site's document library drive.
 *
 * A thin, typed adapter over `AzureGraphClientProvider`: the provider owns the
 * Graph `Client`, retries, `@odata.nextLink` pagination and error translation, so
 * this service never re-implements transport policy. Every failure propagates as
 * an `ApiError` carrying the Graph `code` (`itemNotFound`, `accessDenied`,
 * `InvalidAuthenticationToken`, ...); no read returns `[]`/`null` on failure.
 *
 * ## `expand=fields` (non-dollar) - the defect this service is written around
 *
 * {@link listItems} and {@link getItem} append **`expand=fields`** to the
 * request. That is the spelling in Microsoft's published list-item examples.
 * The OData-prefixed `$expand=fields` is reported to be accepted by the service
 * and then return items with **no `fields` property at all** - a silent empty
 * result, indistinguishable from an empty list. `LIST_ITEMS_EXPAND_PARAM` holds
 * the non-dollar value, and the request-shape suite asserts it.
 *
 * (No live tenant is available to this repository. The test asserts the
 * documented non-dollar form and records that fact; if a tenant ever becomes
 * available, that is the assertion to re-verify.)
 *
 * ## `fields` keys are internal column names
 *
 * The write payload is `{ fields: { ... } }` and the keys must be the list's
 * **internal** column names, not its display names. SharePoint does not reject an
 * unknown key - it stores nothing. {@link getListColumns} exists so a caller can
 * map `displayName -> name`, and {@link createItem} validates every key against
 * that column list before it sends a request.
 *
 * ## Joining AZ-08
 *
 * {@link getSiteDrive} resolves `/sites/{site-id}/drive` and returns the document
 * library's drive id. That id is what `AzureDriveService` needs to list, download
 * and upload the site's documents - SharePoint documents therefore join the same
 * drive surface as OneDrive.
 */
@service({
  id: 'azure.AzureSharePointService@1.0.0',
  name: 'AzureSharePointService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph SharePoint sites, lists, list items, columns and site drives',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
  ],
})
class AzureSharePointService implements Reactory.Service.IReactoryService, IAzureSharePointService {
  name: string = 'AzureSharePointService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphClientProvider: ISharePointGraphProvider;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `graphClientProvider` alias. */
  setGraphClientProvider(serviceInstance: any): void {
    this._graphClientProvider = serviceInstance;
  }

  private get graphClientProvider(): ISharePointGraphProvider {
    if (this._graphClientProvider) return this._graphClientProvider;
    return this.context.getService('azure.AzureGraphClientProvider@1.0.0') as unknown as ISharePointGraphProvider;
  }

  /**
   * Resolve a site from its hostname and server-relative path.
   *
   * `GET /sites/{hostname}:/{site-path}` - for example
   * `GET /sites/contoso.sharepoint.com:/sites/Marketing`.
   *
   * The path is encoded per segment, so a site whose URL contains a space is
   * requested safely (`/sites/Team Site` -> `/sites/Team%20Site`). An empty path
   * (or `/`) addresses the site collection root via `/sites/{hostname}:/`.
   *
   * @throws ApiError carrying the Graph `code` (e.g. `itemNotFound`)
   */
  async getSiteByPath(
    userId: string,
    hostname: string,
    sitePathValue: string,
  ): Promise<IAzureSharePointSite> {
    this.requireValue(hostname, 'hostname');

    const site = await this.graphClientProvider.request<any>(
      userId,
      siteByPathPath(hostname, sitePathValue),
      {
        select: DEFAULT_SHAREPOINT_SITE_SELECT,
        operation: 'getSiteByPath',
      },
    );

    return this.requireSite(site, 'getSiteByPath');
  }

  /**
   * Read the tenant's root site (`GET /sites/root`).
   *
   * @throws ApiError carrying the Graph `code`
   */
  async getRootSite(userId: string): Promise<IAzureSharePointSite> {
    const site = await this.graphClientProvider.request<any>(
      userId,
      `${SITES_PATH}/root`,
      {
        select: DEFAULT_SHAREPOINT_SITE_SELECT,
        operation: 'getRootSite',
      },
    );

    return this.requireSite(site, 'getRootSite');
  }

  /**
   * List sites, optionally filtered by a search term.
   *
   * `GET /sites` - or `GET /sites?search={term}`.
   *
   * The collection parameter is spelled **`search`**, without the OData dollar
   * prefix (`$search` is not accepted on `/sites`). A search term is
   * percent-encoded and appended to the path; the read is still bounded by the
   * provider's `requestAll` page limit.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listSites(userId: string, search?: string): Promise<IAzureSharePointSite[]> {
    const term = typeof search === 'string' ? search.trim() : '';
    const path = term.length > 0
      ? withQuery(SITES_PATH, `${SITES_SEARCH_PARAM}=${encodeURIComponent(term)}`)
      : SITES_PATH;

    const sites = await this.graphClientProvider.requestAll<any>(userId, path, {
      select: DEFAULT_SHAREPOINT_SITE_SELECT,
      operation: 'listSites',
    });

    return (Array.isArray(sites) ? sites : []).map(normaliseSite);
  }

  /**
   * List the lists (and document libraries) on a site.
   *
   * `GET /sites/{site-id}/lists?$select=id,name,displayName,list,webUrl`.
   * Every page is drained through the provider's bounded `requestAll`; the
   * collection is small enough that a cursor adds no value.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listLists(userId: string, siteId: string): Promise<IAzureSharePointList[]> {
    this.requireValue(siteId, 'siteId');

    const lists = await this.graphClientProvider.requestAll<any>(userId, listsPath(siteId), {
      select: SHAREPOINT_LIST_SELECT,
      operation: 'listLists',
    });

    return (Array.isArray(lists) ? lists : []).map(normaliseList);
  }

  /**
   * List the items in a list.
   *
   * `GET /sites/{site-id}/lists/{list-id}/items?expand=fields`
   *
   * **The expand parameter has no dollar prefix.** `$expand=fields` is reported
   * to be accepted and then return items without their column data, so a caller
   * sees an empty `fields` object rather than an error. The path is built with
   * {@link LIST_ITEMS_EXPAND_PARAM}, which is `expand=fields`.
   *
   * One page is returned unless `options.all` is set; `options.nextLink` resumes
   * from `@odata.nextLink`, whose URL already carries the expand and the cursor.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listItems(
    userId: string,
    siteId: string,
    listId: string,
    options: IAzureSharePointItemListOptions = {},
  ): Promise<IAzureSharePointItemPage> {
    this.requireValue(siteId, 'siteId');
    this.requireValue(listId, 'listId');

    const nextLink = typeof options.nextLink === 'string' && options.nextLink.trim().length > 0
      ? options.nextLink.trim()
      : undefined;

    if (nextLink) {
      const page = await this.graphClientProvider.request<IGraphCollection<any>>(userId, nextLink, {
        url: nextLink,
        operation: 'listItems',
      });

      return this.toItemPage(page);
    }

    const path = withQuery(itemsPath(siteId, listId), LIST_ITEMS_EXPAND_PARAM);

    if (options.all === true) {
      const all = await this.graphClientProvider.requestAll<any>(userId, path, {
        top: pageSize(options.top),
        operation: 'listItems',
        ...(typeof options.maxPages === 'number' ? { maxPages: options.maxPages } : {}),
      });

      return { items: (Array.isArray(all) ? all : []).map(normaliseItem) };
    }

    const page = await this.graphClientProvider.request<IGraphCollection<any>>(userId, path, {
      top: pageSize(options.top),
      operation: 'listItems',
    });

    return this.toItemPage(page);
  }

  /**
   * Read one list item, with its column data.
   *
   * `GET /sites/{site-id}/lists/{list-id}/items/{item-id}?expand=fields` - the
   * same non-dollar expand as {@link listItems}, for the same reason.
   *
   * @throws ApiError carrying the Graph `code` (e.g. `itemNotFound`)
   */
  async getItem(
    userId: string,
    siteId: string,
    listId: string,
    itemId: string,
  ): Promise<IAzureSharePointListItem> {
    this.requireValue(siteId, 'siteId');
    this.requireValue(listId, 'listId');
    this.requireValue(itemId, 'itemId');

    const item = await this.graphClientProvider.request<any>(
      userId,
      withQuery(itemPath(siteId, listId, itemId), LIST_ITEMS_EXPAND_PARAM),
      { operation: 'getItem' },
    );

    return this.requireItem(item, 'getItem');
  }

  /**
   * Create a list item.
   *
   * `POST /sites/{site-id}/lists/{list-id}/items` with `{ fields: { ... } }`.
   *
   * Before the write the column list is read and **every key in `fields` is
   * validated against the list's internal column names**. An unknown key is
   * rejected with `SharePointUnknownColumn` and no request is sent: SharePoint
   * would otherwise return 201 and store nothing, which makes a guessed internal
   * name (or a display name) look like a successful write.
   *
   * @throws ApiError `SharePointUnknownColumn` / `SharePointInvalidFields`, or the
   * Graph error from the write
   */
  async createItem(
    userId: string,
    siteId: string,
    listId: string,
    input: IAzureSharePointItemInput,
  ): Promise<IAzureSharePointListItem> {
    this.requireValue(siteId, 'siteId');
    this.requireValue(listId, 'listId');

    const fields = requireFields(input, 'createItem');

    // The column list is what makes an internal name checkable. A failure here
    // (no permission, site gone) propagates: guessing is never the fallback.
    const columns = await this.getListColumns(userId, siteId, listId);
    assertKnownColumns(fields, columns, { operation: 'createItem', siteId, listId });

    const client = this.graphClientProvider.getClient(userId);

    let created: any;
    try {
      created = await client.api(itemsPath(siteId, listId)).post({ fields });
    } catch (error: any) {
      throw toGraphApiError(error, { operation: 'createItem' });
    }

    return this.requireItem(created, 'createItem');
  }

  /**
   * Update a list item's column data.
   *
   * `PATCH /sites/{site-id}/lists/{list-id}/items/{item-id}` with
   * `{ fields: { ... } }`. Only the supplied columns are sent; SharePoint leaves
   * the rest untouched.
   *
   * The keys must be internal column names - call {@link getListColumns} and use
   * its `name` (not `displayName`). This method does not re-read the column list
   * on every patch; `createItem` is the gate that catches a guessed name, and the
   * same naming rule applies here.
   *
   * @throws ApiError `SharePointInvalidFields`, or the Graph error from the patch
   */
  async updateItem(
    userId: string,
    siteId: string,
    listId: string,
    itemId: string,
    input: IAzureSharePointItemInput,
  ): Promise<IAzureSharePointListItem> {
    this.requireValue(siteId, 'siteId');
    this.requireValue(listId, 'listId');
    this.requireValue(itemId, 'itemId');

    const fields = requireFields(input, 'updateItem');
    const client = this.graphClientProvider.getClient(userId);

    let updated: any;
    try {
      updated = await client.api(itemPath(siteId, listId, itemId)).patch({ fields });
    } catch (error: any) {
      throw toGraphApiError(error, { operation: 'updateItem' });
    }

    return this.requireItem(updated, 'updateItem');
  }

  /**
   * Delete a list item.
   *
   * `DELETE /sites/{site-id}/lists/{list-id}/items/{item-id}`. Resolves to `void`
   * - a successful delete has no body, and the contract does not invent one.
   *
   * @throws ApiError carrying the Graph `code` (e.g. `itemNotFound`)
   */
  async deleteItem(
    userId: string,
    siteId: string,
    listId: string,
    itemId: string,
  ): Promise<void> {
    this.requireValue(siteId, 'siteId');
    this.requireValue(listId, 'listId');
    this.requireValue(itemId, 'itemId');

    const client = this.graphClientProvider.getClient(userId);

    try {
      await client.api(itemPath(siteId, listId, itemId)).delete();
    } catch (error: any) {
      throw toGraphApiError(error, { operation: 'deleteItem' });
    }
  }

  /**
   * List a list's column definitions.
   *
   * `GET /sites/{site-id}/lists/{list-id}/columns`. This is the display-name to
   * internal-name map: a caller reads `displayName` for the label a user sees and
   * `name` for the key `fields` requires. `columnType` reports which
   * `columnDefinition` facet the column is built from.
   *
   * No `$select` is sent on purpose - the facets (`text`, `choice`, ...) are what
   * `columnType` is derived from, and a projection would drop whichever facet the
   * caller's list actually uses.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async getListColumns(
    userId: string,
    siteId: string,
    listId: string,
  ): Promise<IAzureSharePointColumn[]> {
    this.requireValue(siteId, 'siteId');
    this.requireValue(listId, 'listId');

    const columns = await this.graphClientProvider.requestAll<any>(
      userId,
      `${listPath(siteId, listId)}/columns`,
      { operation: 'getListColumns' },
    );

    return (Array.isArray(columns) ? columns : []).map(normaliseColumn);
  }

  /**
   * Read the site's document library drive.
   *
   * `GET /sites/{site-id}/drive`. The returned `id` is the drive id that
   * `AzureDriveService` (AZ-08) addresses as `/drives/{drive-id}/...`, which is
   * how SharePoint documents join the same surface as OneDrive files.
   *
   * @throws ApiError carrying the Graph `code` (a site without a document
   * library answers `itemNotFound`)
   */
  async getSiteDrive(userId: string, siteId: string): Promise<IAzureSharePointDrive> {
    this.requireValue(siteId, 'siteId');

    const drive = await this.graphClientProvider.request<any>(
      userId,
      `${sitePath(siteId)}/drive`,
      {
        select: SHAREPOINT_DRIVE_SELECT,
        operation: 'getSiteDrive',
      },
    );

    if (!drive || typeof drive !== 'object' || typeof drive.id !== 'string' || drive.id === '') {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned no document library drive for this site',
        { operation: 'getSiteDrive', siteId },
      );
    }

    return normaliseDrive(drive);
  }

  /** Map a Graph collection response onto an item page. */
  private toItemPage(page: IGraphCollection<any> | undefined): IAzureSharePointItemPage {
    const result: IAzureSharePointItemPage = {
      items: Array.isArray(page?.value) ? page.value.map(normaliseItem) : [],
    };

    if (typeof page?.['@odata.nextLink'] === 'string') {
      result.nextLink = page['@odata.nextLink'];
    }

    return result;
  }

  /** A site read must identify a site. */
  private requireSite(value: any, operation: string): IAzureSharePointSite {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id === '') {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Microsoft Graph returned no site body for ${operation}`,
        { operation },
      );
    }

    return normaliseSite(value);
  }

  /** A write must return a real item, never a synthetic one. */
  private requireItem(value: any, operation: string): IAzureSharePointListItem {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id === '') {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Microsoft Graph returned no list item body for ${operation}`,
        { operation },
      );
    }

    return normaliseItem(value);
  }

  /** A path segment / parameter must be a non-empty string before it reaches Graph. */
  private requireValue(value: string, label: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw apiError(
        SHAREPOINT_ERROR_CODE.MISSING_PARAMETER,
        `A non-empty ${label} is required`,
        { parameter: label },
      );
    }
  }
}

export const AzureSharePointServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureSharePointService> = {
  service: (props: any, context: any) => new AzureSharePointService(props, context),
  id: 'azure.AzureSharePointService@1.0.0',
  name: 'AzureSharePointService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph SharePoint sites, lists, list items, columns and site drives',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
  ],
};

export { AzureSharePointService };

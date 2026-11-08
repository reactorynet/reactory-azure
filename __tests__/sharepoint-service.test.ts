import ApiError from '@reactory/server-core/exceptions';
import { InsufficientPermissions } from '@reactory/server-core/exceptions';

/**
 * Request-shape and contract suite for AZ-15 (SharePoint).
 *
 * The Graph SDK is mocked, so every assertion is about the request this module
 * *would* send - no live Graph call is made (there is no Azure tenant attached to
 * this repository and the ticket forbids one).
 *
 * Three assertions carry the ticket:
 *
 *   1. **Every path**, including the path-addressed site form
 *      `/sites/{hostname}:/{site-path}` and the `/:` root form.
 *   2. **`listItems` sends `expand=fields` WITHOUT the dollar prefix.**
 *      NO TENANT WAS AVAILABLE TO VERIFY THIS. The assertion records the
 *      *documented* non-dollar form: Microsoft's published list-item examples use
 *      `?expand=fields`, and `$expand=fields` is reported to be accepted and then
 *      return items with no `fields` at all (a silent empty result). If a tenant
 *      ever becomes available, this is the assertion to re-verify.
 *   3. **`createItem` rejects a key absent from `getListColumns` output.**
 *      SharePoint silently ignores an unknown `fields` key, so a display name or
 *      a guessed internal name produces a 201 that wrote nothing. That must be a
 *      loud, local failure.
 */
jest.mock('@microsoft/microsoft-graph-client', () => {
  const chain: any = {};
  chain.api = jest.fn(() => chain);
  chain.version = jest.fn(() => chain);
  chain.query = jest.fn(() => chain);
  chain.headers = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.responseType = jest.fn(() => chain);
  chain.get = jest.fn();
  chain.post = jest.fn();
  chain.patch = jest.fn();
  chain.delete = jest.fn();

  const client: any = {
    api: jest.fn(() => chain),
    __azureTokenSource: () => 'vault',
  };

  return {
    Client: { init: jest.fn(() => client) },
    ResponseType: { RAW: 'raw' },
    __chain: chain,
    __client: client,
  };
});

// eslint-disable-next-line import/first
import { Client } from '@microsoft/microsoft-graph-client';
// eslint-disable-next-line import/first
import { AzureGraphClientProvider } from '../services/graph/AzureGraphClientProvider';
// eslint-disable-next-line import/first
import { AzureSharePointService } from '../services/AzureSharePointService';
// eslint-disable-next-line import/first
import SharePointResolver from '../graphql/resolvers/SharePointResolver';
// eslint-disable-next-line import/first
import { SHAREPOINT_ERROR_CODE } from '../types/sharepoint.types';
// eslint-disable-next-line import/first
import fs from 'fs';
// eslint-disable-next-line import/first
import path from 'path';

const sdk: any = jest.requireMock('@microsoft/microsoft-graph-client');
const chain = sdk.__chain;
const client = sdk.__client;

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const CALLER_ID = '6a1b2c3d4e5f60718293a4b5';
const OTHER_USER_ID = '9f8e7d6c5b4a39281706f5e4';
const HOSTNAME = 'contoso.sharepoint.com';
const SITE_ID = 'contoso.sharepoint.com,8f3a2b1c-4d5e-6f70-8192-a3b4c5d6e7f8,6c2b1a09-8f7e-6d5c-4b3a-291807f6e5d4';
const LIST_ID = 'b1a2c3d4-e5f6-4708-9a1b-2c3d4e5f6071';
const ITEM_ID = '42';

/** Percent-encode one path segment exactly as the module does (no `:`/`$` in these ids). */
const seg = (value: string): string => encodeURIComponent(value);

const SITE_PATH = `/sites/${seg(SITE_ID)}`;
const LISTS_PATH = `${SITE_PATH}/lists`;
const LIST_PATH = `${LISTS_PATH}/${seg(LIST_ID)}`;
const ITEMS_PATH = `${LIST_PATH}/items`;
const ITEM_PATH = `${ITEMS_PATH}/${seg(ITEM_ID)}`;
const COLUMNS_PATH = `${LIST_PATH}/columns`;

/** Build the real provider on the mocked SDK and hand it to the service. */
function createService(): AzureSharePointService {
  const authService = {
    getToken: jest.fn().mockResolvedValue({ token: 'vault-token', source: 'vault' }),
  };

  const provider = new AzureGraphClientProvider({} as any, {
    getService: jest.fn(() => authService),
    error: jest.fn(),
  } as any);
  provider.setAzureAuthService(authService);

  const service = new AzureSharePointService({} as any, {
    getService: jest.fn(() => provider),
    error: jest.fn(),
  } as any);
  service.setGraphClientProvider(provider);

  return service;
}

/** The path of the most recent Graph request. */
function lastPath(): string {
  const calls = client.api.mock.calls;
  return String(calls[calls.length - 1][0]);
}

/** Every path requested during a test. */
function requestedPaths(): string[] {
  return client.api.mock.calls.map((call: any[]) => String(call[0]));
}

/** Every `?...` query string handed to the SDK, decoded for readability. */
function requestedQueries(): string[] {
  return chain.query.mock.calls.map((call: any[]) => decodeURIComponent(String(call[0])));
}

/** A `columnDefinition` fixture with an internal name that differs from its display name. */
const TITLE_COLUMN = {
  id: 'col-1',
  name: 'Title',
  displayName: 'Title',
  required: true,
  text: { maxLength: 255 },
};

const STATUS_COLUMN = {
  id: 'col-2',
  name: 'Status',
  displayName: 'Workflow Status',
  choice: { choices: ['Draft', 'Done'] },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Graph client selection', () => {
  it('builds the client on GA v1.0 with debug logging off', async () => {
    chain.get.mockResolvedValue({ id: 'root', name: 'root' });

    await createService().getRootSite(USER_ID);

    const options = (Client.init as jest.Mock).mock.calls[0][0];
    expect(options.defaultVersion).toBe('v1.0');
    expect(options.debugLogging).toBe(false);
  });
});

describe('site addressing', () => {
  it('getSiteByPath: GET /sites/{hostname}:/{site-path}', async () => {
    chain.get.mockResolvedValue({
      id: SITE_ID,
      name: 'marketing',
      displayName: 'Marketing',
      webUrl: 'https://contoso.sharepoint.com/sites/marketing',
      root: false,
      siteCollection: { hostname: HOSTNAME },
    });

    const site = await createService().getSiteByPath(USER_ID, HOSTNAME, '/sites/marketing');

    expect(lastPath()).toBe(`/sites/${HOSTNAME}:/sites/marketing`);
    expect(site).toMatchObject({
      id: SITE_ID,
      name: 'marketing',
      displayName: 'Marketing',
      hostname: HOSTNAME,
      isRoot: false,
    });
    expect(requestedQueries().some((query) => query.includes('$select=id,name,displayName,webUrl'))).toBe(true);
  });

  it('getSiteByPath: encodes a site path containing a space', async () => {
    chain.get.mockResolvedValue({ id: SITE_ID, name: 'Team Site' });

    await createService().getSiteByPath(USER_ID, HOSTNAME, 'sites/Team Site');

    // The path delimiter `:` and the `/` separators survive; the space does not.
    expect(lastPath()).toBe(`/sites/${HOSTNAME}:/sites/Team%20Site`);
    expect(lastPath()).not.toContain(' ');
  });

  it('getSiteByPath: an empty path addresses the site collection root', async () => {
    chain.get.mockResolvedValue({ id: SITE_ID, root: true });

    await createService().getSiteByPath(USER_ID, HOSTNAME, '/');

    expect(lastPath()).toBe(`/sites/${HOSTNAME}:/`);
  });

  it('getRootSite: GET /sites/root', async () => {
    chain.get.mockResolvedValue({ id: 'contoso.sharepoint.com,root', root: true });

    const site = await createService().getRootSite(USER_ID);

    expect(lastPath()).toBe('/sites/root');
    expect(site.isRoot).toBe(true);
  });

  it('listSites: GET /sites when there is no search term', async () => {
    chain.get.mockResolvedValue({ value: [{ id: 'site-1' }] });

    const sites = await createService().listSites(USER_ID);

    expect(lastPath()).toBe('/sites');
    expect(sites).toHaveLength(1);
  });

  it('listSites: GET /sites?search= - the sites parameter has no dollar prefix', async () => {
    chain.get.mockResolvedValue({ value: [{ id: 'site-1' }, { id: 'site-2' }] });

    const sites = await createService().listSites(USER_ID, 'Team Site');

    // Documented form for the sites collection: `search`, not `$search`.
    expect(lastPath()).toBe('/sites?search=Team%20Site');
    expect(lastPath()).not.toContain('$search');
    expect(requestedQueries().some((query) => query.includes('$search'))).toBe(false);
    expect(sites.map((site) => site.id)).toEqual(['site-1', 'site-2']);
  });
});

describe('lists and columns', () => {
  it('listLists: GET /sites/{siteId}/lists selecting id,name,displayName,list,webUrl', async () => {
    chain.get.mockResolvedValue({
      value: [
        {
          id: LIST_ID,
          name: 'Documents',
          displayName: 'Documents',
          webUrl: 'https://contoso.sharepoint.com/sites/marketing/Documents',
          list: { template: 'documentLibrary', hidden: false, contentTypeId: '0x0101' },
        },
      ],
    });

    const lists = await createService().listLists(USER_ID, SITE_ID);

    expect(lastPath()).toBe(LISTS_PATH);
    expect(
      requestedQueries().some((query) => query.includes('$select=id,name,displayName,list,webUrl')),
    ).toBe(true);
    expect(lists[0]).toMatchObject({
      id: LIST_ID,
      name: 'Documents',
      template: 'documentLibrary',
      hidden: false,
      contentTypeId: '0x0101',
    });
  });

  it('getListColumns: GET /sites/{siteId}/lists/{listId}/columns, mapping display to internal name', async () => {
    chain.get.mockResolvedValue({ value: [TITLE_COLUMN, STATUS_COLUMN] });

    const columns = await createService().getListColumns(USER_ID, SITE_ID, LIST_ID);

    expect(lastPath()).toBe(COLUMNS_PATH);
    expect(columns).toEqual([
      {
        id: 'col-1',
        name: 'Title',
        displayName: 'Title',
        required: true,
        columnType: 'text',
      },
      {
        id: 'col-2',
        name: 'Status',
        displayName: 'Workflow Status',
        columnType: 'choice',
      },
    ]);

    // The point of the method: the display label differs from the key `fields` needs.
    expect(columns[1].displayName).toBe('Workflow Status');
    expect(columns[1].name).toBe('Status');
  });
});

describe('list items - expand=fields (non-dollar)', () => {
  it('listItems: GET /sites/{siteId}/lists/{listId}/items?expand=fields', async () => {
    chain.get.mockResolvedValue({
      value: [{ id: ITEM_ID, fields: { Title: 'Q4 plan', Status: 'Draft' } }],
    });

    const page = await createService().listItems(USER_ID, SITE_ID, LIST_ID);

    // VERIFIED FORM: no tenant exists in this repository. The documented
    // non-dollar `expand=fields` is asserted; `$expand=fields` is reported to
    // return no fields at all (a silent empty result), so it must never be sent.
    expect(lastPath()).toBe(`${ITEMS_PATH}?expand=fields`);
    expect(lastPath()).toContain('?expand=fields');
    expect(lastPath()).not.toContain('$expand');
    expect(requestedQueries().some((query) => query.includes('expand='))).toBe(false);

    expect(page.items[0].fields).toEqual({ Title: 'Q4 plan', Status: 'Draft' });
    expect(requestedQueries().some((query) => query.includes('$top=100'))).toBe(true);
  });

  it('listItems: honours options.top and returns the nextLink cursor', async () => {
    chain.get.mockResolvedValue({
      value: [{ id: ITEM_ID }],
      '@odata.nextLink': `${ITEMS_PATH}?expand=fields&$skiptoken=abc`,
    });

    const page = await createService().listItems(USER_ID, SITE_ID, LIST_ID, { top: 25 });

    expect(lastPath()).toBe(`${ITEMS_PATH}?expand=fields`);
    expect(requestedQueries().some((query) => query.includes('$top=25'))).toBe(true);
    expect(page.nextLink).toBe(`${ITEMS_PATH}?expand=fields&$skiptoken=abc`);
  });

  it('listItems: follows an @odata.nextLink verbatim (it already carries expand)', async () => {
    const cursor = `${ITEMS_PATH}?expand=fields&$skiptoken=abc`;
    chain.get.mockResolvedValue({ value: [{ id: '43' }] });

    await createService().listItems(USER_ID, SITE_ID, LIST_ID, { nextLink: cursor });

    expect(lastPath()).toBe(cursor);
  });

  it('listItems: options.all drains every page', async () => {
    chain.get
      .mockResolvedValueOnce({ value: [{ id: '1' }], '@odata.nextLink': '/next-page' })
      .mockResolvedValueOnce({ value: [{ id: '2' }] });

    const page = await createService().listItems(USER_ID, SITE_ID, LIST_ID, { all: true });

    expect(page.items.map((item) => item.id)).toEqual(['1', '2']);
    expect(requestedPaths()).toEqual([`${ITEMS_PATH}?expand=fields`, '/next-page']);
  });

  it('getItem: GET /sites/{siteId}/lists/{listId}/items/{itemId}?expand=fields', async () => {
    chain.get.mockResolvedValue({
      id: ITEM_ID,
      fields: { Title: 'Q4 plan' },
      webUrl: 'https://contoso.sharepoint.com/sites/marketing/Lists/Status/42_.000',
      contentType: { id: '0x0100', name: 'Item' },
    });

    const item = await createService().getItem(USER_ID, SITE_ID, LIST_ID, ITEM_ID);

    expect(lastPath()).toBe(`${ITEM_PATH}?expand=fields`);
    expect(lastPath()).not.toContain('$expand');
    expect(item).toMatchObject({
      id: ITEM_ID,
      fields: { Title: 'Q4 plan' },
      contentType: { id: '0x0100', name: 'Item' },
    });
  });
});

describe('item writes - { fields: { ... } } with internal column names', () => {
  it('createItem: validates the column list, then POSTs { fields } to the items path', async () => {
    chain.get.mockResolvedValue({ value: [TITLE_COLUMN, STATUS_COLUMN] });
    chain.post.mockResolvedValue({ id: ITEM_ID, fields: { Title: 'Q4 plan', Status: 'Draft' } });

    const item = await createService().createItem(USER_ID, SITE_ID, LIST_ID, {
      fields: { Title: 'Q4 plan', Status: 'Draft' },
    });

    // The column read comes first: it is what makes an internal name checkable.
    expect(requestedPaths()).toEqual([COLUMNS_PATH, ITEMS_PATH]);
    expect(lastPath()).toBe(ITEMS_PATH);
    // The payload is exactly { fields }, keyed by internal names.
    expect(chain.post).toHaveBeenCalledWith({ fields: { Title: 'Q4 plan', Status: 'Draft' } });
    expect(item.fields).toEqual({ Title: 'Q4 plan', Status: 'Draft' });
  });

  it('createItem: rejects a display name that is not an internal column name', async () => {
    chain.get.mockResolvedValue({ value: [TITLE_COLUMN, STATUS_COLUMN] });

    let caught: any;
    try {
      await createService().createItem(USER_ID, SITE_ID, LIST_ID, {
        fields: { 'Workflow Status': 'Done' },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe(SHAREPOINT_ERROR_CODE.UNKNOWN_COLUMN);
    expect(caught.unknownColumns).toEqual(['Workflow Status']);
    expect(caught.allowedColumns).toEqual(['Title', 'Status']);
    // The crucial part: no write was attempted, so SharePoint cannot return 201
    // for a request that would store nothing.
    expect(chain.post).not.toHaveBeenCalled();
  });

  it('createItem: rejects a guessed key and names the correct case', async () => {
    chain.get.mockResolvedValue({ value: [TITLE_COLUMN, STATUS_COLUMN] });

    let caught: any;
    try {
      await createService().createItem(USER_ID, SITE_ID, LIST_ID, { fields: { title: 'x' } });
    } catch (error) {
      caught = error;
    }

    expect(caught.code).toBe(SHAREPOINT_ERROR_CODE.UNKNOWN_COLUMN);
    expect(caught.message).toContain('title -> Title');
    expect(caught.caseHints).toEqual(['title -> Title']);
    expect(chain.post).not.toHaveBeenCalled();
  });

  it('createItem: rejects an empty or malformed fields payload before any request', async () => {
    await expect(
      createService().createItem(USER_ID, SITE_ID, LIST_ID, { fields: {} }),
    ).rejects.toMatchObject({ code: SHAREPOINT_ERROR_CODE.INVALID_FIELDS });

    await expect(
      createService().createItem(USER_ID, SITE_ID, LIST_ID, undefined as any),
    ).rejects.toMatchObject({ code: SHAREPOINT_ERROR_CODE.INVALID_FIELDS });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('updateItem: PATCH /sites/{siteId}/lists/{listId}/items/{itemId} with { fields }', async () => {
    chain.patch.mockResolvedValue({ id: ITEM_ID, fields: { Status: 'Done' } });

    const item = await createService().updateItem(USER_ID, SITE_ID, LIST_ID, ITEM_ID, {
      fields: { Status: 'Done' },
    });

    expect(lastPath()).toBe(ITEM_PATH);
    expect(chain.patch).toHaveBeenCalledWith({ fields: { Status: 'Done' } });
    expect(item.fields).toEqual({ Status: 'Done' });
  });

  it('updateItem: rejects an empty fields object without sending a patch', async () => {
    await expect(
      createService().updateItem(USER_ID, SITE_ID, LIST_ID, ITEM_ID, { fields: {} }),
    ).rejects.toMatchObject({ code: SHAREPOINT_ERROR_CODE.INVALID_FIELDS });

    expect(chain.patch).not.toHaveBeenCalled();
  });

  it('deleteItem: DELETE /sites/{siteId}/lists/{listId}/items/{itemId}', async () => {
    chain.delete.mockResolvedValue(undefined);

    await expect(
      createService().deleteItem(USER_ID, SITE_ID, LIST_ID, ITEM_ID),
    ).resolves.toBeUndefined();

    expect(lastPath()).toBe(ITEM_PATH);
    expect(chain.delete).toHaveBeenCalledTimes(1);
  });
});

describe('site drive (the AZ-08 join)', () => {
  it('getSiteDrive: GET /sites/{siteId}/drive and returns the drive id', async () => {
    chain.get.mockResolvedValue({
      id: 'b!documentLibraryDrive',
      name: 'Documents',
      driveType: 'documentLibrary',
      webUrl: 'https://contoso.sharepoint.com/sites/marketing/Documents',
    });

    const drive = await createService().getSiteDrive(USER_ID, SITE_ID);

    expect(lastPath()).toBe(`${SITE_PATH}/drive`);
    expect(
      requestedQueries().some((query) => query.includes('$select=id,name,driveType,webUrl,description')),
    ).toBe(true);
    expect(drive).toMatchObject({ id: 'b!documentLibraryDrive', driveType: 'documentLibrary' });
  });

  it('getSiteDrive: throws when Graph returns no drive body', async () => {
    chain.get.mockResolvedValue(undefined);

    await expect(createService().getSiteDrive(USER_ID, SITE_ID)).rejects.toMatchObject({
      code: 'GraphRequestFailed',
    });
  });
});

describe('normalisation and failure contract', () => {
  it('drops unknown item members and keeps fields keys untouched', async () => {
    chain.get.mockResolvedValue({
      id: ITEM_ID,
      fields: { Title: 'x', _UIVersionString: '1.0', SomeInternalName: 7 },
      unexpectedMember: 'ignored',
    });

    const item = await createService().getItem(USER_ID, SITE_ID, LIST_ID, ITEM_ID);

    expect(Object.keys(item).sort()).toEqual(['fields', 'id']);
    expect(item.fields).toEqual({ Title: 'x', _UIVersionString: '1.0', SomeInternalName: 7 });
  });

  it('propagates the Graph code as an ApiError (itemNotFound)', async () => {
    chain.get.mockRejectedValue({
      statusCode: 404,
      code: 'itemNotFound',
      message: 'Item not found',
    });

    let caught: any;
    try {
      await createService().getItem(USER_ID, SITE_ID, LIST_ID, ITEM_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('itemNotFound');
    expect(caught.status).toBe(404);
  });

  it('propagates a write failure instead of returning a synthetic item', async () => {
    chain.get.mockResolvedValue({ value: [TITLE_COLUMN] });
    chain.post.mockRejectedValue({
      statusCode: 403,
      code: 'accessDenied',
      message: 'Access denied',
    });

    await expect(
      createService().createItem(USER_ID, SITE_ID, LIST_ID, { fields: { Title: 'x' } }),
    ).rejects.toMatchObject({ code: 'accessDenied' });
  });

  it('requires non-empty ids before any request is sent', async () => {
    const service = createService();

    await expect(service.listLists(USER_ID, '')).rejects.toMatchObject({
      code: SHAREPOINT_ERROR_CODE.MISSING_PARAMETER,
    });
    await expect(service.listItems(USER_ID, SITE_ID, '  ')).rejects.toMatchObject({
      code: SHAREPOINT_ERROR_CODE.MISSING_PARAMETER,
    });
    await expect(service.getSiteByPath(USER_ID, '', 'sites/x')).rejects.toMatchObject({
      code: SHAREPOINT_ERROR_CODE.MISSING_PARAMETER,
    });

    expect(client.api).not.toHaveBeenCalled();
  });
});

describe('GraphQL surface alignment', () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, '..', 'graphql', 'types', 'SharePoint.graphql'),
    'utf8',
  );

  it('declares the four required queries and the item mutations', () => {
    for (const field of [
      'azureSites',
      'azureSharePointLists',
      'azureSharePointItems',
      'azureSharePointColumns',
      'azureSharePointDrive',
      'azureRootSite',
      'azureSiteByPath',
      'azureSharePointItem',
      'azureCreateSharePointItem',
      'azureUpdateSharePointItem',
      'azureDeleteSharePointItem',
    ]) {
      expect(schema).toContain(field);
    }
  });

  it('models `fields` as a JSON map so internal column names pass through', () => {
    expect(schema).toContain('fields: JSON!');
    expect(schema).toContain('input AzureSharePointItemInput');
  });

  it('exposes the resolver methods the schema names', () => {
    const resolver: any = new SharePointResolver();

    for (const method of [
      'listSites',
      'getRootSite',
      'getSiteByPath',
      'listLists',
      'listItems',
      'getItem',
      'listColumns',
      'getSiteDrive',
      'createItem',
      'updateItem',
      'deleteItem',
    ]) {
      expect(typeof resolver[method]).toBe('function');
    }
  });
});

describe('resolver argument mapping and ownership', () => {
  /** A context whose service records calls. */
  function createContext(overrides: Record<string, any> = {}) {
    const service = {
      listSites: jest.fn().mockResolvedValue([]),
      getRootSite: jest.fn().mockResolvedValue({ id: 'root' }),
      getSiteByPath: jest.fn().mockResolvedValue({ id: 'site' }),
      listLists: jest.fn().mockResolvedValue([]),
      listItems: jest.fn().mockResolvedValue({ items: [] }),
      getItem: jest.fn().mockResolvedValue({ id: ITEM_ID, fields: {} }),
      getListColumns: jest.fn().mockResolvedValue([]),
      getSiteDrive: jest.fn().mockResolvedValue({ id: 'drive' }),
      createItem: jest.fn().mockResolvedValue({ id: ITEM_ID, fields: {} }),
      updateItem: jest.fn().mockResolvedValue({ id: ITEM_ID, fields: {} }),
      deleteItem: jest.fn().mockResolvedValue(undefined),
    };

    return {
      service,
      context: {
        user: { _id: CALLER_ID },
        getService: jest.fn(() => service),
        // The @roles decorator requires a USER grant before the body runs.
        hasRole: jest.fn((role: string) => role === 'USER'),
        ...overrides,
      } as any,
    };
  }

  it('defaults every field to the caller id', async () => {
    const { service, context } = createContext();
    const resolver: any = new SharePointResolver();

    await resolver.listSites({}, { search: 'marketing' }, context);
    await resolver.listItems({}, { siteId: SITE_ID, listId: LIST_ID }, context);
    await resolver.listColumns({}, { siteId: SITE_ID, listId: LIST_ID }, context);
    await resolver.getSiteDrive({}, { siteId: SITE_ID }, context);

    expect(service.listSites).toHaveBeenCalledWith(CALLER_ID, 'marketing');
    expect(service.listItems).toHaveBeenCalledWith(CALLER_ID, SITE_ID, LIST_ID, {});
    expect(service.getListColumns).toHaveBeenCalledWith(CALLER_ID, SITE_ID, LIST_ID);
    expect(service.getSiteDrive).toHaveBeenCalledWith(CALLER_ID, SITE_ID);
  });

  it('forwards the item payload unchanged on create and update', async () => {
    const { service, context } = createContext();
    const resolver: any = new SharePointResolver();
    const input = { fields: { Title: 'x', Status: 'Draft' } };

    await resolver.createItem({}, { siteId: SITE_ID, listId: LIST_ID, input }, context);
    await resolver.updateItem({}, { siteId: SITE_ID, listId: LIST_ID, itemId: ITEM_ID, input }, context);

    expect(service.createItem).toHaveBeenCalledWith(CALLER_ID, SITE_ID, LIST_ID, input);
    expect(service.updateItem).toHaveBeenCalledWith(CALLER_ID, SITE_ID, LIST_ID, ITEM_ID, input);
  });

  it('deleteItem resolves to true after the service deletes', async () => {
    const { service, context } = createContext();
    const resolver: any = new SharePointResolver();

    await expect(
      resolver.deleteItem({}, { siteId: SITE_ID, listId: LIST_ID, itemId: ITEM_ID }, context),
    ).resolves.toBe(true);

    expect(service.deleteItem).toHaveBeenCalledWith(CALLER_ID, SITE_ID, LIST_ID, ITEM_ID);
  });

  it('allows an ADMIN to name another user', async () => {
    const { service, context } = createContext({ hasRole: jest.fn(() => true) });
    const resolver: any = new SharePointResolver();

    await resolver.listLists({}, { userId: OTHER_USER_ID, siteId: SITE_ID }, context);

    expect(service.listLists).toHaveBeenCalledWith(OTHER_USER_ID, SITE_ID);
  });

  it('rejects a non-admin naming another user (IDOR guard)', async () => {
    const { service, context } = createContext();
    const resolver: any = new SharePointResolver();

    let caught: any;
    try {
      await resolver.listLists({}, { userId: OTHER_USER_ID, siteId: SITE_ID }, context);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InsufficientPermissions);
    expect(service.listLists).not.toHaveBeenCalled();
  });

  it('fails loudly when the service is not registered', async () => {
    const context = {
      user: { _id: CALLER_ID },
      getService: jest.fn(() => undefined),
      hasRole: jest.fn(() => true),
    } as any;
    const resolver: any = new SharePointResolver();

    await expect(resolver.getRootSite({}, {}, context)).rejects.toThrow(
      'Azure SharePoint Service not available',
    );
  });
});

import ApiError from '@reactory/server-core/exceptions';

/**
 * Request-shape suite for AZ-10 (Excel workbooks).
 *
 * The Graph SDK is mocked, so every assertion is about the *request this module
 * would send* - never a live call. That matters more for Excel than for most
 * domains: `/workbook` paths are deeply nested (`…/worksheets/{name}/range(address='…')`),
 * a workbook is addressed through its drive item, and a write that omits the
 * `workbook-session-id` header silently lands in a different session.
 *
 * Coverage: every documented workbook endpoint the service uses -
 *   worksheets, usedRange (with and without valuesOnly), range read/write,
 *   clear, tables, table columns, table rows, createSession and closeSession.
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
import { AzureWorkbookService, WORKBOOK_WORKSHEETS_CACHE_TTL_SECONDS } from '../services/AzureWorkbookService';

const sdk: any = jest.requireMock('@microsoft/microsoft-graph-client');
const chain = sdk.__chain;
const client = sdk.__client;

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const ITEM_ID = '01ABCDEF23HIJKLMNOPQRSTUVWXYZ';
const WORKSHEET = 'Sheet1';
const TABLE = 'Table1';
const SESSION_ID = 'session-42';

const BASE = `/me/drive/items/${encodeURIComponent(ITEM_ID)}/workbook`;
const WORKSHEETS_PATH = `${BASE}/worksheets`;
const WORKSHEET_PATH = `${WORKSHEETS_PATH}/${encodeURIComponent(WORKSHEET)}`;
const RANGE_PATH = `${WORKSHEET_PATH}/range(address='A1:D20')`;

/** A Redis double: an empty cache that records reads and writes. */
function createRedis() {
  const store = new Map<string, string>();

  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
}

/** Build the real provider (mocked SDK) plus a real service and a fake cache. */
function createService(redis: ReturnType<typeof createRedis> = createRedis()): AzureWorkbookService {
  const authService = {
    getToken: jest.fn().mockResolvedValue({ token: 'vault-token', source: 'vault' }),
  };

  const provider = new AzureGraphClientProvider({} as any, {
    getService: jest.fn(() => authService),
    error: jest.fn(),
  } as any);
  provider.setAzureAuthService(authService);

  const service = new AzureWorkbookService({} as any, {
    getService: jest.fn(() => undefined),
    error: jest.fn(),
  } as any);

  service.setGraphProvider(provider);
  service.setRedisService(redis);

  return service;
}

/** The path of the most recent Graph request. */
function lastPath(): string {
  const calls = client.api.mock.calls;
  return String(calls[calls.length - 1][0]);
}

/** Every path requested during a test, in order. */
function requestedPaths(): string[] {
  return client.api.mock.calls.map((call: any[]) => String(call[0]));
}

/** The header bag of the most recent `.headers()` call, if any. */
function lastHeaders(): Record<string, string> | undefined {
  const calls = chain.headers.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Graph client selection', () => {
  it('builds the client on the generally available version with debug logging off', async () => {
    chain.get.mockResolvedValue({ value: [] });
    await createService().listWorksheets(USER_ID, ITEM_ID);

    const options = (Client.init as jest.Mock).mock.calls[0][0];
    expect(options.defaultVersion).toBe('v1.0');
    expect(options.debugLogging).toBe(false);
  });
});

describe('worksheets', () => {
  it('listWorksheets: GET /me/drive/items/{itemId}/workbook/worksheets', async () => {
    chain.get.mockResolvedValue({ value: [{ id: 'ws-1', name: WORKSHEET, position: 0 }] });

    const worksheets = await createService().listWorksheets(USER_ID, ITEM_ID);

    expect(lastPath()).toBe(WORKSHEETS_PATH);
    expect(chain.get).toHaveBeenCalledTimes(1);
    expect(worksheets).toEqual([{ id: 'ws-1', name: WORKSHEET, position: 0 }]);
  });

  it('listWorksheets: addresses /drives/{driveId}/items/{itemId}/workbook/worksheets', async () => {
    chain.get.mockResolvedValue({ value: [] });

    await createService().listWorksheets(USER_ID, ITEM_ID, { driveId: 'drive-9' });

    expect(lastPath()).toBe(`/drives/${encodeURIComponent('drive-9')}/items/${encodeURIComponent(ITEM_ID)}/workbook/worksheets`);
  });

  it('listWorksheets: caches for two minutes and serves the second call from cache', async () => {
    const redis = createRedis();
    chain.get.mockResolvedValue({ value: [{ id: 'ws-1', name: WORKSHEET }] });

    const service = createService(redis);
    await service.listWorksheets(USER_ID, ITEM_ID);
    await service.listWorksheets(USER_ID, ITEM_ID);

    expect(chain.get).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set.mock.calls[0][0]).toBe(`azure:${USER_ID}:workbook:worksheets:${ITEM_ID}`);
    expect(redis.set.mock.calls[0][2]).toBe(WORKBOOK_WORKSHEETS_CACHE_TTL_SECONDS);
    expect(WORKBOOK_WORKSHEETS_CACHE_TTL_SECONDS).toBe(120);
  });
});

describe('ranges', () => {
  it("getUsedRange: GET …/worksheets/{worksheet}/usedRange", async () => {
    chain.get.mockResolvedValue({ address: 'A1:D20', rowCount: 20, columnCount: 4 });

    await createService().getUsedRange(USER_ID, ITEM_ID, WORKSHEET);

    expect(lastPath()).toBe(`${WORKSHEET_PATH}/usedRange`);
  });

  it("getUsedRange: valuesOnly is sent as Graph's usedRange(valuesOnly=…) argument", async () => {
    chain.get.mockResolvedValue({ address: 'A1:B2' });

    await createService().getUsedRange(USER_ID, ITEM_ID, WORKSHEET, { valuesOnly: true });
    expect(lastPath()).toBe(`${WORKSHEET_PATH}/usedRange(valuesOnly=true)`);

    await createService().getUsedRange(USER_ID, ITEM_ID, WORKSHEET, { valuesOnly: false });
    expect(lastPath()).toBe(`${WORKSHEET_PATH}/usedRange(valuesOnly=false)`);
  });

  it("getRange: GET …/range(address='A1:D20')", async () => {
    chain.get.mockResolvedValue({ address: 'A1:D20', values: [] });

    await createService().getRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:D20');

    expect(lastPath()).toBe(RANGE_PATH);
  });

  it('getRange: encodes an address so it cannot change the request', async () => {
    chain.get.mockResolvedValue({ address: 'A1:B2' });
    const service = createService();

    await service.getRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:B2&x=1?y');

    // `&`, `=` and `?` are encoded, so an address can neither start a query
    // string nor terminate the path.
    expect(lastPath()).toBe(`${WORKSHEET_PATH}/range(address='A1:B2%26x%3D1%3Fy')`);
    expect(lastPath()).not.toContain('?');

    await service.getRange(USER_ID, ITEM_ID, WORKSHEET, "A1:B2'");

    // The single quote is OData's string delimiter: it is doubled before the
    // address is encoded (`encodeURIComponent` leaves `'` alone), so a doubled
    // quote can never terminate the literal.
    expect(lastPath()).toBe(`${WORKSHEET_PATH}/range(address='A1:B2''')`);
  });

  it("updateRange: PATCH …/range(address='A1:D20') with values only", async () => {
    chain.patch.mockResolvedValue({ address: 'A1:B1', values: [[1, 2]] });
    const values = [[1, 2]];

    await createService().updateRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:D20', { values });

    expect(lastPath()).toBe(RANGE_PATH);
    expect(chain.patch).toHaveBeenCalledWith({ values });
    expect(Object.keys(chain.patch.mock.calls[0][0])).toEqual(['values']);
  });

  it('updateRange: forwards formulas and numberFormat when supplied', async () => {
    chain.patch.mockResolvedValue({ address: 'A1:B1' });
    const values = [[1, 2]];
    const formulas = [['=A1+1', '=B1+1']];
    const numberFormat = [['0.00', '0.00']];

    await createService().updateRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:D20', {
      values,
      formulas,
      numberFormat,
    });

    const body = chain.patch.mock.calls[0][0];
    expect(body.values).toBe(values);
    expect(body.formulas).toBe(formulas);
    expect(body.numberFormat).toBe(numberFormat);
    expect(Object.keys(body)).toEqual(['values', 'formulas', 'numberFormat']);
  });

  it('appendRows: reads usedRange, then writes below it with one PATCH', async () => {
    chain.get.mockResolvedValueOnce({
      address: 'A1:C5',
      rowIndex: 0,
      rowCount: 5,
      columnIndex: 0,
      columnCount: 3,
    });
    chain.patch.mockResolvedValue({ address: 'A6:C7' });

    const values = [
      [1, 2, 3],
      [4, 5, 6],
    ];

    await createService().appendRows(USER_ID, ITEM_ID, WORKSHEET, values);

    expect(requestedPaths()).toEqual([
      `${WORKSHEET_PATH}/usedRange`,
      `${WORKSHEET_PATH}/range(address='A6:C7')`,
    ]);
    expect(chain.patch).toHaveBeenCalledWith({ values });
  });

  it('appendRows: starts at row 1 on a pristine A1 worksheet after a values probe', async () => {
    chain.get
      .mockResolvedValueOnce({
        address: 'A1',
        rowIndex: 0,
        rowCount: 1,
        columnIndex: 0,
        columnCount: 1,
      })
      .mockResolvedValueOnce({ address: 'A1', values: [[null]] });
    chain.patch.mockResolvedValue({ address: 'A1:A1' });

    await createService().appendRows(USER_ID, ITEM_ID, WORKSHEET, [['first']]);

    expect(requestedPaths()).toEqual([
      `${WORKSHEET_PATH}/usedRange`,
      `${WORKSHEET_PATH}/usedRange(valuesOnly=true)`,
      `${WORKSHEET_PATH}/range(address='A1:A1')`,
    ]);
  });

  it('clearRange: POST …/range(address=…)/clear with applyTo All by default', async () => {
    chain.post.mockResolvedValue(undefined);

    await createService().clearRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:D20');

    expect(lastPath()).toBe(`${RANGE_PATH}/clear`);
    expect(chain.post).toHaveBeenCalledWith({ applyTo: 'All' });
  });

  it('clearRange: forwards a documented applyTo value', async () => {
    chain.post.mockResolvedValue(undefined);

    await createService().clearRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:D20', { applyTo: 'Contents' });

    expect(chain.post).toHaveBeenCalledWith({ applyTo: 'Contents' });
  });
});

describe('tables', () => {
  it('listTables: GET …/workbook/tables', async () => {
    chain.get.mockResolvedValue({ value: [{ id: TABLE, name: TABLE }] });

    const tables = await createService().listTables(USER_ID, ITEM_ID);

    expect(lastPath()).toBe(`${BASE}/tables`);
    expect(tables).toEqual([{ id: TABLE, name: TABLE }]);
  });

  it('listTables: GET …/worksheets/{worksheet}/tables when scoped', async () => {
    chain.get.mockResolvedValue({ value: [] });

    await createService().listTables(USER_ID, ITEM_ID, { worksheet: WORKSHEET });

    expect(lastPath()).toBe(`${WORKSHEET_PATH}/tables`);
  });

  it('getTable: GET …/workbook/tables/{table}', async () => {
    chain.get.mockResolvedValue({ id: TABLE, name: TABLE });

    await createService().getTable(USER_ID, ITEM_ID, TABLE);

    expect(lastPath()).toBe(`${BASE}/tables/${encodeURIComponent(TABLE)}`);
  });

  it('listTableColumns: GET …/workbook/tables/{table}/columns', async () => {
    chain.get.mockResolvedValue({ value: [{ id: 'col-1', name: 'Amount', index: 0 }] });

    const columns = await createService().listTableColumns(USER_ID, ITEM_ID, TABLE);

    expect(lastPath()).toBe(`${BASE}/tables/${encodeURIComponent(TABLE)}/columns`);
    expect(columns).toHaveLength(1);
  });

  it('addTableRow: POST …/tables/{table}/rows/add with index null to append', async () => {
    chain.post.mockResolvedValue({ index: 3, values: [[7, 8]] });
    const values = [[7, 8]];

    await createService().addTableRow(USER_ID, ITEM_ID, TABLE, values);

    expect(lastPath()).toBe(`${BASE}/tables/${encodeURIComponent(TABLE)}/rows/add`);
    expect(chain.post).toHaveBeenCalledWith({ index: null, values });
  });

  it('addTableRow: forwards an explicit insert index', async () => {
    chain.post.mockResolvedValue({ index: 1 });
    const values = [[7, 8]];

    await createService().addTableRow(USER_ID, ITEM_ID, TABLE, values, { index: 1 });

    expect(chain.post).toHaveBeenCalledWith({ index: 1, values });
  });

  it('deleteTableRow: DELETE …/tables/{table}/rows/{rowId}', async () => {
    chain.delete.mockResolvedValue(undefined);

    await expect(
      createService().deleteTableRow(USER_ID, ITEM_ID, TABLE, '3'),
    ).resolves.toBeUndefined();

    expect(lastPath()).toBe(`${BASE}/tables/${encodeURIComponent(TABLE)}/rows/3`);
    expect(chain.delete).toHaveBeenCalledTimes(1);
  });
});

describe('sessions', () => {
  it('createSession: POST …/workbook/createSession with persistChanges true', async () => {
    chain.post.mockResolvedValue({ id: SESSION_ID });

    const session = await createService().createSession(USER_ID, ITEM_ID);

    expect(lastPath()).toBe(`${BASE}/createSession`);
    expect(chain.post).toHaveBeenCalledWith({ persistChanges: true });
    expect(session).toEqual({ id: SESSION_ID, persistChanges: true });
  });

  it('closeSession: POST …/workbook/closeSession carrying the session header', async () => {
    chain.post.mockResolvedValue(undefined);

    await createService().closeSession(USER_ID, ITEM_ID, SESSION_ID);

    expect(lastPath()).toBe(`${BASE}/closeSession`);
    expect(lastHeaders()).toEqual({ 'workbook-session-id': SESSION_ID });
  });

  it('sends the session id on every subsequent request', async () => {
    chain.get.mockResolvedValue({ address: 'A1:B2' });
    chain.patch.mockResolvedValue({ address: 'A1:B2' });

    const service = createService();

    // Reads go through the provider, which also sends its default Accept header;
    // writes go through the SDK client, which only gets the session header. Both
    // must carry the session id.
    const sessionHeader = { 'workbook-session-id': SESSION_ID };

    await service.getRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:B2', { sessionId: SESSION_ID });
    expect(lastHeaders()).toMatchObject(sessionHeader);

    await service.getUsedRange(USER_ID, ITEM_ID, WORKSHEET, { sessionId: SESSION_ID });
    expect(lastHeaders()).toMatchObject(sessionHeader);

    await service.updateRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:B2', { values: [[1]] }, {
      sessionId: SESSION_ID,
    });
    expect(lastHeaders()).toMatchObject(sessionHeader);

    await service.listTables(USER_ID, ITEM_ID, { sessionId: SESSION_ID });
    expect(lastHeaders()).toMatchObject(sessionHeader);

    await service.clearRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:B2', { sessionId: SESSION_ID });
    expect(lastHeaders()).toMatchObject(sessionHeader);
  });

  it('useSession: true wraps a write in createSession … closeSession', async () => {
    chain.post
      .mockResolvedValueOnce({ id: SESSION_ID })
      .mockResolvedValueOnce(undefined);
    chain.patch.mockResolvedValue({ address: 'A1:B1', values: [[1, 2]] });

    await createService().updateRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:D20', { values: [[1, 2]] }, {
      useSession: true,
    });

    expect(requestedPaths()).toEqual([
      `${BASE}/createSession`,
      RANGE_PATH,
      `${BASE}/closeSession`,
    ]);
    expect(chain.patch).toHaveBeenCalledWith({ values: [[1, 2]] });
    expect(lastHeaders()).toEqual({ 'workbook-session-id': SESSION_ID });
  });

  it('closes the session in a finally when the wrapped operation throws', async () => {
    chain.post
      .mockResolvedValueOnce({ id: SESSION_ID })
      .mockResolvedValueOnce(undefined);

    const service = createService();

    await expect(
      service.withSession(USER_ID, ITEM_ID, async () => {
        throw new Error('operation blew up');
      }),
    ).rejects.toThrow('operation blew up');

    expect(requestedPaths()).toEqual([
      `${BASE}/createSession`,
      `${BASE}/closeSession`,
    ]);
    expect(chain.post).toHaveBeenNthCalledWith(1, { persistChanges: true });
    expect(chain.post).toHaveBeenNthCalledWith(2);
  });

  it('closes the session when the Graph write inside it fails', async () => {
    chain.post
      .mockResolvedValueOnce({ id: SESSION_ID })
      .mockResolvedValueOnce(undefined);
    chain.patch.mockRejectedValue(
      Object.assign(new Error('Range not found'), { statusCode: 404, code: 'itemNotFound' }),
    );

    const service = createService();

    await expect(
      service.updateRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:D20', { values: [[1]] }, {
        useSession: true,
      }),
    ).rejects.toMatchObject({ code: 'itemNotFound' });

    expect(requestedPaths()).toEqual([
      `${BASE}/createSession`,
      RANGE_PATH,
      `${BASE}/closeSession`,
    ]);
    expect(chain.post).toHaveBeenNthCalledWith(2);
  });
});

describe('error translation', () => {
  it('turns a Graph failure into an ApiError that keeps the Graph code', async () => {
    chain.get.mockRejectedValue(
      Object.assign(new Error('The resource could not be found'), {
        statusCode: 404,
        code: 'itemNotFound',
      }),
    );

    let caught: any;
    try {
      await createService().listWorksheets(USER_ID, ITEM_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('itemNotFound');
    expect(caught.operation).toBe('workbook.listWorksheets');
  });
});

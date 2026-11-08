import ApiError from '@reactory/server-core/exceptions';

/**
 * Behaviour suite for AZ-10 (Excel workbooks).
 *
 * The request-shape suite proves the module addresses the right paths; this one
 * proves the three things the ticket calls out as sharp edges:
 *
 *  1. a workbook session is closed even when the operation throws (a leaked
 *     session pins the workbook);
 *  2. `null` (empty cell) and `'#DIV/0!'` (error cell) survive a round trip
 *     unchanged - values are never coerced;
 *  3. a large values payload is not silently truncated.
 *
 * The Graph SDK is mocked; the cache is an in-memory double.
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
import { AzureGraphClientProvider } from '../services/graph/AzureGraphClientProvider';
// eslint-disable-next-line import/first
import {
  AzureWorkbookService,
  WORKBOOK_WORKSHEETS_CACHE_TTL_SECONDS,
  columnLetter,
  worksheetCacheKey,
} from '../services/AzureWorkbookService';
// eslint-disable-next-line import/first
import { WORKBOOK_ERROR_CODE, type WorkbookValues } from '../types/workbook.types';

const sdk: any = jest.requireMock('@microsoft/microsoft-graph-client');
const chain = sdk.__chain;

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const ITEM_ID = '01ABCDEF23HIJKLMNOPQRSTUVWXYZ';
const WORKSHEET = 'Sheet1';
const TABLE = 'Table1';
const SESSION_ID = 'session-42';

const BASE = `/me/drive/items/${encodeURIComponent(ITEM_ID)}/workbook`;

function createRedis(overrides: Record<string, any> = {}) {
  const store = new Map<string, string>();

  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    ...overrides,
  };
}

function createService(redis: any = createRedis()): AzureWorkbookService {
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

function requestedPaths(): string[] {
  const sdkClient = sdk.__client;
  return sdkClient.api.mock.calls.map((call: any[]) => String(call[0]));
}

/** A dense row-major matrix of `rows` x `columns` numbers. */
function matrix(rows: number, columns: number): WorkbookValues {
  const out: WorkbookValues = [];
  for (let row = 0; row < rows; row += 1) {
    const cells: (number | null)[] = [];
    for (let column = 0; column < columns; column += 1) cells.push(row * columns + column);
    out.push(cells);
  }
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('values are passed through untouched', () => {
  const ERROR_CELL = '#DIV/0!';
  const mixed: WorkbookValues = [
    [ERROR_CELL, null, 0],
    ['', 42.5, false],
  ];

  it('getRange: returns null and #DIV/0! exactly as Graph sent them', async () => {
    chain.get.mockResolvedValue({ address: 'A1:C2', values: mixed });

    const range = await createService().getRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:C2');

    expect(range.values).toEqual(mixed);
    // Identity, not just equality: nothing was rebuilt, parsed or normalised.
    expect(range.values).toBe(mixed);
    expect((range.values as WorkbookValues)[0][0]).toBe(ERROR_CELL);
    expect((range.values as WorkbookValues)[0][1]).toBeNull();
    expect((range.values as WorkbookValues)[1][0]).toBe('');
  });

  it('getUsedRange: valuesOnly responses keep error and empty cells', async () => {
    chain.get.mockResolvedValue({
      address: 'A1:B2',
      values: [['#VALUE!', null], [null, '#N/A']],
      valueTypes: [['Error', 'Empty'], ['Empty', 'Error']],
    });

    const range = await createService().getUsedRange(USER_ID, ITEM_ID, WORKSHEET, { valuesOnly: true });

    expect(range.values).toEqual([['#VALUE!', null], [null, '#N/A']]);
    expect(range.valueTypes).toEqual([['Error', 'Empty'], ['Empty', 'Error']]);
  });

  it('updateRange: writes null and #DIV/0! without coercion', async () => {
    chain.patch.mockResolvedValue({ address: 'A1:C2', values: mixed });

    const range = await createService().updateRange(
      USER_ID,
      ITEM_ID,
      WORKSHEET,
      'A1:C2',
      { values: mixed },
    );

    const body = chain.patch.mock.calls[0][0];
    expect(body.values).toBe(mixed);
    expect(body.values[0][0]).toBe(ERROR_CELL);
    expect(body.values[0][1]).toBeNull();
    expect(body.values[1][0]).toBe('');
    expect(body.values[1][2]).toBe(false);
    expect(range.values).toBe(mixed);
  });

  it('addTableRow: forwards the matrix by reference', async () => {
    chain.post.mockResolvedValue({ index: 4, values: mixed });

    await createService().addTableRow(USER_ID, ITEM_ID, TABLE, mixed);

    const body = chain.post.mock.calls[0][0];
    expect(body.index).toBeNull();
    expect(body.values).toBe(mixed);
  });
});

describe('a large payload is not silently truncated', () => {
  it('updateRange writes every row of a 5000 x 12 matrix', async () => {
    const values = matrix(5000, 12);
    chain.patch.mockResolvedValue({ address: 'A1:L5000', values });

    const range = await createService().updateRange(
      USER_ID,
      ITEM_ID,
      WORKSHEET,
      'A1:L5000',
      { values },
    );

    const sent = chain.patch.mock.calls[0][0].values;
    expect(sent).toBe(values);
    expect(sent).toHaveLength(5000);
    expect(sent[4999]).toHaveLength(12);
    expect(sent[4999][11]).toBe(59999);
    expect(range.values).toHaveLength(5000);
  });

  it('getRange returns a large matrix in full', async () => {
    const values = matrix(2000, 20);
    chain.get.mockResolvedValue({ address: 'A1:T2000', rowCount: 2000, columnCount: 20, values });

    const range = await createService().getRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:T2000');

    expect(range.values).toHaveLength(2000);
    expect((range.values as WorkbookValues)[1999]).toHaveLength(20);
    expect((range.values as WorkbookValues)[1999][19]).toBe(39999);
  });

  it('appendRows writes all 200 supplied rows in one range PATCH', async () => {
    chain.get.mockResolvedValueOnce({
      address: 'A1:C10',
      rowIndex: 0,
      rowCount: 10,
      columnIndex: 0,
      columnCount: 3,
    });
    const values = matrix(200, 3);
    chain.patch.mockResolvedValue({ address: 'A11:C210', values });

    await createService().appendRows(USER_ID, ITEM_ID, WORKSHEET, values);

    expect(requestedPaths()[1]).toBe(
      `${BASE}/worksheets/${encodeURIComponent(WORKSHEET)}/range(address='A11:C210')`,
    );
    expect(chain.patch).toHaveBeenCalledTimes(1);
    expect(chain.patch.mock.calls[0][0].values).toHaveLength(200);
  });
});

describe('workbook sessions', () => {
  it('closes the session when the wrapped operation throws', async () => {
    chain.post
      .mockResolvedValueOnce({ id: SESSION_ID })
      .mockResolvedValueOnce(undefined);

    const service = createService();
    const run = jest.fn(async () => {
      throw new Error('boom');
    });

    await expect(service.withSession(USER_ID, ITEM_ID, run)).rejects.toThrow('boom');

    expect(run).toHaveBeenCalledTimes(1);
    expect(requestedPaths()).toEqual([`${BASE}/createSession`, `${BASE}/closeSession`]);
    expect(chain.post.mock.calls[1]).toEqual([]);
  });

  it('closes the session when the wrapped Graph write fails, and keeps the Graph error', async () => {
    chain.post
      .mockResolvedValueOnce({ id: SESSION_ID })
      .mockResolvedValueOnce(undefined);
    chain.patch.mockRejectedValue(
      Object.assign(new Error('The range is invalid'), { statusCode: 400, code: 'InvalidArgument' }),
    );

    const service = createService();

    let caught: any;
    try {
      await service.updateRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:B1', { values: [[1, 2]] }, {
        useSession: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('InvalidArgument');
    expect(requestedPaths()).toEqual([
      `${BASE}/createSession`,
      `${BASE}/worksheets/${encodeURIComponent(WORKSHEET)}/range(address='A1:B1')`,
      `${BASE}/closeSession`,
    ]);
  });

  it('reports a close failure when the operation itself succeeded', async () => {
    chain.post
      .mockResolvedValueOnce({ id: SESSION_ID })
      .mockRejectedValueOnce(Object.assign(new Error('Session already closed'), { code: 'SessionNotFound' }));

    const service = createService();

    await expect(
      service.withSession(USER_ID, ITEM_ID, async () => 'done'),
    ).rejects.toMatchObject({ code: 'SessionNotFound' });
  });

  it('preserves the operation error when the close also fails', async () => {
    chain.post
      .mockResolvedValueOnce({ id: SESSION_ID })
      .mockRejectedValueOnce(Object.assign(new Error('Session already closed'), { code: 'SessionNotFound' }));

    const service = createService();

    await expect(
      service.withSession(USER_ID, ITEM_ID, async () => {
        throw Object.assign(new Error('write failed'), { code: 'WriteFailed' });
      }),
    ).rejects.toMatchObject({ code: 'WriteFailed' });

    expect(requestedPaths()).toEqual([`${BASE}/createSession`, `${BASE}/closeSession`]);
  });

  it('passes the created session to the callback so the id can be used', async () => {
    chain.post.mockResolvedValueOnce({ id: SESSION_ID });
    chain.get.mockResolvedValue({ address: 'A1:B2' });

    const service = createService();
    let observed = '';

    await service.withSession(USER_ID, ITEM_ID, async (session) => {
      observed = session.id;
      await service.getRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:B2', { sessionId: session.id });
      return session;
    });

    expect(observed).toBe(SESSION_ID);
    const headers = chain.headers.mock.calls[chain.headers.mock.calls.length - 1][0];
    expect(headers).toEqual({ 'workbook-session-id': SESSION_ID });
    // createSession, the range read, closeSession.
    expect(requestedPaths()).toHaveLength(3);
    expect(chain.post.mock.calls[1]).toEqual([]);
  });

  it('rejects a createSession response without an id instead of inventing one', async () => {
    chain.post.mockResolvedValue({});

    await expect(createService().createSession(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: WORKBOOK_ERROR_CODE.SESSION_NOT_CREATED,
    });
  });

  it('requires a session id to close', async () => {
    await expect(createService().closeSession(USER_ID, ITEM_ID, '  ')).rejects.toMatchObject({
      code: WORKBOOK_ERROR_CODE.MISSING_PARAMETER,
    });

    expect(sdk.__client.api).not.toHaveBeenCalled();
  });
});

describe('worksheet cache', () => {
  it('serves a second call from the cache for two minutes', async () => {
    const redis = createRedis();
    chain.get.mockResolvedValue({ value: [{ id: 'ws-1', name: WORKSHEET }] });

    const service = createService(redis);
    const first = await service.listWorksheets(USER_ID, ITEM_ID);
    const second = await service.listWorksheets(USER_ID, ITEM_ID);

    expect(chain.get).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(redis.get).toHaveBeenCalledWith(worksheetCacheKey(USER_ID, ITEM_ID));
    expect(redis.set).toHaveBeenCalledWith(
      worksheetCacheKey(USER_ID, ITEM_ID),
      expect.stringContaining('"items"'),
      WORKBOOK_WORKSHEETS_CACHE_TTL_SECONDS,
    );
    expect(WORKBOOK_WORKSHEETS_CACHE_TTL_SECONDS).toBe(120);
  });

  it('keys the cache per user, drive and item', async () => {
    expect(worksheetCacheKey(USER_ID, ITEM_ID)).toBe(`azure:${USER_ID}:workbook:worksheets:${ITEM_ID}`);
    expect(worksheetCacheKey(USER_ID, ITEM_ID, 'drive-1')).toBe(
      `azure:${USER_ID}:workbook:worksheets:drive-1:${ITEM_ID}`,
    );
  });

  it('forceRefresh bypasses the cache read and rewrites it', async () => {
    const redis = createRedis();
    chain.get.mockResolvedValue({ value: [{ id: 'ws-1', name: WORKSHEET }] });

    const service = createService(redis);
    await service.listWorksheets(USER_ID, ITEM_ID);
    await service.listWorksheets(USER_ID, ITEM_ID, { forceRefresh: true });

    expect(chain.get).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('a session call bypasses the cache: a session exists to see current state', async () => {
    const redis = createRedis();
    chain.get.mockResolvedValue({ value: [] });

    const service = createService(redis);
    await service.listWorksheets(USER_ID, ITEM_ID, { sessionId: SESSION_ID });

    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('treats malformed cached data as a miss', async () => {
    const redis = createRedis({ get: jest.fn(async () => '{"not":"a list"}') });
    chain.get.mockResolvedValue({ value: [{ id: 'ws-1', name: WORKSHEET }] });

    const worksheets = await createService(redis).listWorksheets(USER_ID, ITEM_ID);

    expect(chain.get).toHaveBeenCalledTimes(1);
    expect(worksheets).toHaveLength(1);
  });

  it('survives a Redis outage on both read and write', async () => {
    const redis = createRedis({
      get: jest.fn(async () => {
        throw new Error('redis down');
      }),
      set: jest.fn(async () => {
        throw new Error('redis down');
      }),
    });
    chain.get.mockResolvedValue({ value: [{ id: 'ws-1', name: WORKSHEET }] });

    const worksheets = await createService(redis).listWorksheets(USER_ID, ITEM_ID);

    expect(worksheets).toHaveLength(1);
  });
});

describe('client-side validation', () => {
  it('rejects a values payload that is not a matrix before any request is sent', async () => {
    const service = createService();

    await expect(
      service.updateRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:B1', { values: [] }),
    ).rejects.toMatchObject({ code: WORKBOOK_ERROR_CODE.INVALID_VALUES });

    await expect(
      service.updateRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:B1', { values: ['nope'] } as any),
    ).rejects.toMatchObject({ code: WORKBOOK_ERROR_CODE.INVALID_VALUES });

    await expect(
      service.appendRows(USER_ID, ITEM_ID, WORKSHEET, undefined as any),
    ).rejects.toMatchObject({ code: WORKBOOK_ERROR_CODE.INVALID_VALUES });

    await expect(
      service.addTableRow(USER_ID, ITEM_ID, TABLE, []),
    ).rejects.toMatchObject({ code: WORKBOOK_ERROR_CODE.INVALID_VALUES });

    expect(sdk.__client.api).not.toHaveBeenCalled();
  });

  it('requires an address, a worksheet and an item id', async () => {
    const service = createService();

    await expect(
      service.getRange(USER_ID, ITEM_ID, WORKSHEET, '   '),
    ).rejects.toMatchObject({ code: WORKBOOK_ERROR_CODE.INVALID_ADDRESS });

    await expect(
      service.getRange(USER_ID, ITEM_ID, '', 'A1'),
    ).rejects.toMatchObject({ code: WORKBOOK_ERROR_CODE.MISSING_PARAMETER });

    await expect(
      service.listWorksheets(USER_ID, ''),
    ).rejects.toMatchObject({ code: WORKBOOK_ERROR_CODE.MISSING_PARAMETER });

    expect(sdk.__client.api).not.toHaveBeenCalled();
  });

  it('requires a userId', async () => {
    await expect(createService().listWorksheets('', ITEM_ID)).rejects.toMatchObject({
      code: 'NotConnected',
    });
  });

  it('rejects an applyTo value Graph does not accept', async () => {
    await expect(
      createService().clearRange(USER_ID, ITEM_ID, WORKSHEET, 'A1:B1', { applyTo: 'Everything' as any }),
    ).rejects.toMatchObject({ code: WORKBOOK_ERROR_CODE.INVALID_VALUES });

    expect(sdk.__client.api).not.toHaveBeenCalled();
  });

  it('requires a table row id to delete', async () => {
    await expect(
      createService().deleteTableRow(USER_ID, ITEM_ID, TABLE, ''),
    ).rejects.toMatchObject({ code: WORKBOOK_ERROR_CODE.MISSING_PARAMETER });

    expect(sdk.__client.api).not.toHaveBeenCalled();
  });
});

describe('appendRows start row', () => {
  it('never overwrites a used A1: a one-cell used range holding a value appends at row 2', async () => {
    chain.get
      .mockResolvedValueOnce({
        address: 'A1',
        rowIndex: 0,
        rowCount: 1,
        columnIndex: 0,
        columnCount: 1,
      })
      .mockResolvedValueOnce({ address: 'A1', values: [['already here']] });
    chain.patch.mockResolvedValue({ address: 'A2:A2' });

    await createService().appendRows(USER_ID, ITEM_ID, WORKSHEET, [['next']]);

    expect(requestedPaths()[2]).toBe(
      `${BASE}/worksheets/${encodeURIComponent(WORKSHEET)}/range(address='A2:A2')`,
    );
  });

  it('uses the widest supplied row for the address even past column Z', async () => {
    chain.get.mockResolvedValueOnce({
      address: 'A1:A1',
      rowIndex: 0,
      rowCount: 0,
      columnIndex: 0,
      columnCount: 1,
    });
    chain.patch.mockResolvedValue({ address: 'A1:AB2' });

    await createService().appendRows(USER_ID, ITEM_ID, WORKSHEET, [matrix(2, 28)[0], matrix(2, 28)[1]]);

    expect(requestedPaths()[1]).toBe(
      `${BASE}/worksheets/${encodeURIComponent(WORKSHEET)}/range(address='A1:AB2')`,
    );
  });
});

describe('columnLetter', () => {
  it('maps a one-based column index to its A1 label', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(28)).toBe('AB');
    expect(columnLetter(52)).toBe('AZ');
    expect(columnLetter(702)).toBe('ZZ');
    expect(columnLetter(703)).toBe('AAA');
    expect(columnLetter(0)).toBe('A');
  });
});

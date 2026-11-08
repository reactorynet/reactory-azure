import ApiError from '@reactory/server-core/exceptions';

/**
 * Request-shape suite for AZ-06 (Microsoft To Do).
 *
 * The Graph SDK is mocked, so every assertion is about the *request this module
 * would send* - never a live call. That is the whole point of the ticket: the
 * legacy integration failed because it addressed `/me/outlook/tasks` on the
 * preview API version, an endpoint Microsoft states stopped returning data on
 * 20 August 2022. A test that only checked return values would not have caught
 * that; a test that checks the path does.
 *
 * Coverage: all five list operations, all task operations and all five checklist
 * operations.
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
import { AzureTodoService, TODO_ERROR_CODE } from '../services/AzureTodoService';

const sdk: any = jest.requireMock('@microsoft/microsoft-graph-client');
const chain = sdk.__chain;
const client = sdk.__client;

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const LIST_ID = 'AAMkAD-list-1';
const TASK_ID = 'AAMkAD-task-1';
const ITEM_ID = 'AAMkAD-item-1';

const LISTS_PATH = '/me/todo/lists';
const TASKS_PATH = `${LISTS_PATH}/${encodeURIComponent(LIST_ID)}/tasks`;
const CHECKLIST_PATH = `${TASKS_PATH}/${encodeURIComponent(TASK_ID)}/checklistItems`;

/** Build the real provider (mocked SDK) and hand it to the service. */
function createService(): AzureTodoService {
  const authService = {
    getToken: jest.fn().mockResolvedValue({ token: 'vault-token', source: 'vault' }),
  };

  const provider = new AzureGraphClientProvider({} as any, {
    getService: jest.fn(() => authService),
    error: jest.fn(),
  } as any);
  provider.setAzureAuthService(authService);

  const service = new AzureTodoService({} as any, {
    getService: jest.fn(() => undefined),
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

/** The version selected for the most recent write. */
function lastVersion(): string | undefined {
  const calls = chain.version.mock.calls;
  return calls.length ? String(calls[calls.length - 1][0]) : undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Graph client selection', () => {
  it('builds the client on the generally available version', async () => {
    chain.get.mockResolvedValue({ value: [] });
    await createService().listTaskLists(USER_ID);

    const options = (Client.init as jest.Mock).mock.calls[0][0];
    expect(options.defaultVersion).toBe('v1.0');
    expect(options.debugLogging).toBe(false);
  });
});

describe('task list operations (five)', () => {
  it('listTaskLists: GET /me/todo/lists', async () => {
    chain.get.mockResolvedValue({ value: [{ id: LIST_ID, displayName: 'Tasks' }] });

    const lists = await createService().listTaskLists(USER_ID);

    expect(lastPath()).toBe(LISTS_PATH);
    expect(chain.get).toHaveBeenCalledTimes(1);
    expect(lists).toEqual([{ id: LIST_ID, displayName: 'Tasks' }]);
  });

  it('getTaskList: GET /me/todo/lists/{listId}', async () => {
    chain.get.mockResolvedValue({ id: LIST_ID, displayName: 'Tasks' });

    await createService().getTaskList(USER_ID, LIST_ID);

    expect(lastPath()).toBe(`${LISTS_PATH}/${encodeURIComponent(LIST_ID)}`);
  });

  it('createTaskList: POST /me/todo/lists with only displayName', async () => {
    chain.post.mockResolvedValue({ id: LIST_ID, displayName: 'Work' });

    await createService().createTaskList(USER_ID, { displayName: 'Work' });

    expect(lastPath()).toBe(LISTS_PATH);
    expect(chain.post).toHaveBeenCalledWith({ displayName: 'Work' });
    expect(lastVersion()).toBe('v1.0');
  });

  it('updateTaskList: PATCH /me/todo/lists/{listId}', async () => {
    chain.patch.mockResolvedValue({ id: LIST_ID, displayName: 'Renamed' });

    await createService().updateTaskList(USER_ID, LIST_ID, { displayName: 'Renamed' });

    expect(lastPath()).toBe(`${LISTS_PATH}/${encodeURIComponent(LIST_ID)}`);
    expect(chain.patch).toHaveBeenCalledWith({ displayName: 'Renamed' });
  });

  it('deleteTaskList: DELETE /me/todo/lists/{listId}', async () => {
    chain.delete.mockResolvedValue(undefined);

    await expect(createService().deleteTaskList(USER_ID, LIST_ID)).resolves.toBeUndefined();

    expect(lastPath()).toBe(`${LISTS_PATH}/${encodeURIComponent(LIST_ID)}`);
    expect(chain.delete).toHaveBeenCalledTimes(1);
    expect(chain.post).not.toHaveBeenCalled();
  });
});

describe('task operations', () => {
  it('listTasks: GET /me/todo/lists/{listId}/tasks with no server-side $filter', async () => {
    chain.get.mockResolvedValue({ value: [] });

    await createService().listTasks(USER_ID, LIST_ID, { status: 'notStarted' });

    // The path carries no query string: filtering is client-side because the
    // reference does not document a filterable property set (notably not
    // dueDateTime).
    expect(lastPath()).toBe(TASKS_PATH);
    expect(lastPath()).not.toContain('?');
  });

  it('getTask: GET /me/todo/lists/{listId}/tasks/{taskId}', async () => {
    chain.get.mockResolvedValue({ id: TASK_ID, title: 'Write tests' });

    await createService().getTask(USER_ID, LIST_ID, TASK_ID);

    expect(lastPath()).toBe(`${TASKS_PATH}/${encodeURIComponent(TASK_ID)}`);
  });

  it('createTask: POST .../tasks, forwarding recurrence and checklistItems unchanged', async () => {
    const recurrence = {
      pattern: { type: 'daily', interval: 1 },
      range: { type: 'noEnd', startDate: '2026-11-09' },
    };
    const checklistItems = [
      { displayName: 'Draft', isChecked: false },
      { displayName: 'Review', isChecked: true },
    ];

    chain.post.mockResolvedValue({ id: TASK_ID });

    await createService().createTask(USER_ID, LIST_ID, {
      title: 'Write tests',
      status: 'inProgress',
      importance: 'high',
      dueDateTime: { dateTime: '2026-11-09T17:30:00.0000000', timeZone: 'South Africa Standard Time' },
      recurrence,
      checklistItems,
    });

    expect(lastPath()).toBe(TASKS_PATH);

    const body = chain.post.mock.calls[0][0];
    expect(body.title).toBe('Write tests');
    expect(body.status).toBe('inProgress');
    expect(body.importance).toBe('high');
    // Unchanged means the very same value, not a re-serialised copy.
    expect(body.recurrence).toBe(recurrence);
    expect(body.checklistItems).toBe(checklistItems);
    expect(body.dueDateTime).toEqual({
      dateTime: '2026-11-09T17:30:00.0000000',
      timeZone: 'South Africa Standard Time',
    });
  });

  it('updateTask: PATCH .../tasks/{taskId} with a sparse body', async () => {
    chain.patch.mockResolvedValue({ id: TASK_ID, title: 'Renamed' });

    await createService().updateTask(USER_ID, LIST_ID, TASK_ID, { title: 'Renamed' });

    expect(lastPath()).toBe(`${TASKS_PATH}/${encodeURIComponent(TASK_ID)}`);
    expect(chain.patch).toHaveBeenCalledWith({ title: 'Renamed' });
  });

  it('updateTask: forwards recurrence unchanged when it is the only change', async () => {
    const recurrence = {
      pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday'] },
      range: { type: 'endDate', startDate: '2026-11-09', endDate: '2026-12-31' },
    };
    chain.patch.mockResolvedValue({ id: TASK_ID });

    await createService().updateTask(USER_ID, LIST_ID, TASK_ID, { recurrence });

    const body = chain.patch.mock.calls[0][0];
    expect(body.recurrence).toBe(recurrence);
    expect(Object.keys(body)).toEqual(['recurrence']);
  });

  it('deleteTask: DELETE .../tasks/{taskId}', async () => {
    chain.delete.mockResolvedValue(undefined);

    await expect(createService().deleteTask(USER_ID, LIST_ID, TASK_ID)).resolves.toBeUndefined();

    expect(lastPath()).toBe(`${TASKS_PATH}/${encodeURIComponent(TASK_ID)}`);
  });

  it('completeTask: PATCH .../tasks/{taskId} with status completed', async () => {
    chain.patch.mockResolvedValue({ id: TASK_ID, status: 'completed' });

    const task = await createService().completeTask(USER_ID, LIST_ID, TASK_ID);

    expect(lastPath()).toBe(`${TASKS_PATH}/${encodeURIComponent(TASK_ID)}`);
    expect(chain.patch).toHaveBeenCalledWith({ status: 'completed' });
    expect(task).toMatchObject({ status: 'completed' });
  });

  it('listChecklistItems: GET .../tasks/{taskId}/checklistItems', async () => {
    chain.get.mockResolvedValue({ value: [{ id: ITEM_ID, displayName: 'Draft', isChecked: false }] });

    const items = await createService().listChecklistItems(USER_ID, LIST_ID, TASK_ID);

    expect(lastPath()).toBe(CHECKLIST_PATH);
    expect(items).toHaveLength(1);
  });

  it('getChecklistItem: GET .../checklistItems/{checklistItemId}', async () => {
    chain.get.mockResolvedValue({ id: ITEM_ID, displayName: 'Draft' });

    await createService().getChecklistItem(USER_ID, LIST_ID, TASK_ID, ITEM_ID);

    expect(lastPath()).toBe(`${CHECKLIST_PATH}/${encodeURIComponent(ITEM_ID)}`);
  });

  it('createChecklistItem: POST .../checklistItems', async () => {
    chain.post.mockResolvedValue({ id: ITEM_ID, displayName: 'Draft', isChecked: false });

    await createService().createChecklistItem(USER_ID, LIST_ID, TASK_ID, {
      displayName: 'Draft',
      isChecked: false,
    });

    expect(lastPath()).toBe(CHECKLIST_PATH);
    expect(chain.post).toHaveBeenCalledWith({ displayName: 'Draft', isChecked: false });
  });

  it('updateChecklistItem: PATCH .../checklistItems/{checklistItemId}', async () => {
    chain.patch.mockResolvedValue({ id: ITEM_ID, isChecked: true });

    await createService().updateChecklistItem(USER_ID, LIST_ID, TASK_ID, ITEM_ID, { isChecked: true });

    expect(lastPath()).toBe(`${CHECKLIST_PATH}/${encodeURIComponent(ITEM_ID)}`);
    expect(chain.patch).toHaveBeenCalledWith({ isChecked: true });
  });

  it('deleteChecklistItem: DELETE .../checklistItems/{checklistItemId}', async () => {
    chain.delete.mockResolvedValue(undefined);

    await expect(
      createService().deleteChecklistItem(USER_ID, LIST_ID, TASK_ID, ITEM_ID),
    ).resolves.toBeUndefined();

    expect(lastPath()).toBe(`${CHECKLIST_PATH}/${encodeURIComponent(ITEM_ID)}`);
  });
});

describe('client-side validation', () => {
  it('rejects an invalid status before any request is sent', async () => {
    const service = createService();

    await expect(
      service.createTask(USER_ID, LIST_ID, { title: 'Bad status', status: 'done' as any }),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.INVALID_STATUS });

    await expect(
      service.updateTask(USER_ID, LIST_ID, TASK_ID, { status: 'almostDone' as any }),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.INVALID_STATUS });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('rejects an invalid importance before any request is sent', async () => {
    await expect(
      createService().createTask(USER_ID, LIST_ID, { title: 'Bad', importance: 'urgent' as any }),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.INVALID_IMPORTANCE });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('rejects an assignedTo field instead of silently ignoring it', async () => {
    await expect(
      createService().createTask(USER_ID, LIST_ID, {
        title: 'Assign me',
        assignedTo: 'user@contoso.com',
      } as any),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.UNSUPPORTED_ASSIGNMENT });

    await expect(
      createService().updateTask(USER_ID, LIST_ID, TASK_ID, {
        title: 'Assign me',
        assignments: [{ id: 'x' }],
      } as any),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.UNSUPPORTED_ASSIGNMENT });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('requires a title on create', async () => {
    await expect(
      createService().createTask(USER_ID, LIST_ID, { title: '   ' } as any),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.MISSING_PARAMETER });

    expect(client.api).not.toHaveBeenCalled();
  });
});

describe('retired integration guard', () => {
  it('never requests an outlook/tasks path or a preview API version', async () => {
    chain.get.mockResolvedValue({ value: [] });
    chain.post.mockResolvedValue({ id: 'x' });
    chain.patch.mockResolvedValue({ id: 'x' });
    chain.delete.mockResolvedValue(undefined);

    const service = createService();

    await service.listTaskLists(USER_ID);
    await service.getTaskList(USER_ID, LIST_ID);
    await service.createTaskList(USER_ID, { displayName: 'Work' });
    await service.updateTaskList(USER_ID, LIST_ID, { displayName: 'Renamed' });
    await service.deleteTaskList(USER_ID, LIST_ID);
    await service.listTasks(USER_ID, LIST_ID);
    await service.getTask(USER_ID, LIST_ID, TASK_ID);
    await service.createTask(USER_ID, LIST_ID, { title: 'New' });
    await service.updateTask(USER_ID, LIST_ID, TASK_ID, { title: 'Renamed' });
    await service.completeTask(USER_ID, LIST_ID, TASK_ID);
    await service.deleteTask(USER_ID, LIST_ID, TASK_ID);
    await service.listChecklistItems(USER_ID, LIST_ID, TASK_ID);
    await service.getChecklistItem(USER_ID, LIST_ID, TASK_ID, ITEM_ID);
    await service.createChecklistItem(USER_ID, LIST_ID, TASK_ID, { displayName: 'Draft' });
    await service.updateChecklistItem(USER_ID, LIST_ID, TASK_ID, ITEM_ID, { isChecked: true });
    await service.deleteChecklistItem(USER_ID, LIST_ID, TASK_ID, ITEM_ID);

    const paths = requestedPaths();
    expect(paths.length).toBeGreaterThanOrEqual(16);
    for (const path of paths) {
      expect(path).not.toContain('outlook/tasks');
      expect(path.toLowerCase()).not.toContain('beta');
      expect(path.startsWith(LISTS_PATH)).toBe(true);
    }

    for (const call of chain.version.mock.calls) {
      expect(String(call[0])).toBe('v1.0');
    }
  });

  it('fails a write with an ApiError that preserves the Graph code', async () => {
    chain.post.mockRejectedValue(
      Object.assign(new Error('The request is malformed'), {
        statusCode: 400,
        code: 'ErrorInvalidRequest',
      }),
    );

    let caught: any;
    try {
      await createService().createTask(USER_ID, LIST_ID, { title: 'Bad' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('ErrorInvalidRequest');
  });
});

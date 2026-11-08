import fs from 'fs';
import path from 'path';
import ApiError from '@reactory/server-core/exceptions';
import { parse } from 'graphql';

/**
 * Behaviour suite for AZ-06 (Microsoft To Do).
 *
 * Complements `todo.request-shape.test.ts`: that file proves *what is sent*,
 * this file proves *what is done with what comes back* - the client-side
 * filtering the ticket requires, pagination, error translation and the guard
 * rails around the two hard constraints (no `assignedTo`, no preview API
 * version).
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
import { AzureTodoService, TODO_ERROR_CODE, toComparableEpochMs } from '../services/AzureTodoService';
// eslint-disable-next-line import/first
import TasksResolver from '../graphql/resolvers/TasksResolver';

const sdk: any = jest.requireMock('@microsoft/microsoft-graph-client');
const chain = sdk.__chain;
const client = sdk.__client;

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const LIST_ID = 'list-1';
const MODULE_ROOT = path.resolve(__dirname, '..');

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

/** A small fixture set covering every filter dimension. */
function taskFixture() {
  return [
    {
      id: 't1',
      title: 'Past, open',
      status: 'notStarted',
      importance: 'normal',
      dueDateTime: { dateTime: '2026-11-08T10:00:00.0000000', timeZone: 'UTC' },
    },
    {
      id: 't2',
      title: 'Tomorrow, high',
      status: 'inProgress',
      importance: 'high',
      dueDateTime: { dateTime: '2026-11-09T10:00:00.0000000', timeZone: 'UTC' },
    },
    {
      id: 't3',
      title: 'Later, completed',
      status: 'completed',
      importance: 'low',
      dueDateTime: { dateTime: '2026-11-10T10:00:00.0000000', timeZone: 'UTC' },
    },
    {
      id: 't4',
      title: 'No due date',
      status: 'waitingOnOthers',
      importance: 'normal',
    },
    {
      id: 't5',
      title: 'Deferred',
      status: 'deferred',
      importance: 'normal',
      dueDateTime: null,
    },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('listTasks — client-side selection', () => {
  it('follows @odata.nextLink and merges the pages before filtering', async () => {
    const fixture = taskFixture();

    chain.get
      .mockResolvedValueOnce({
        value: fixture.slice(0, 2),
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-1/tasks?$skiptoken=page-2',
      })
      .mockResolvedValueOnce({ value: fixture.slice(2) });

    const tasks = await createService().listTasks(USER_ID, LIST_ID);

    expect(tasks.map((task) => task.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(client.api).toHaveBeenCalledTimes(2);
    expect(String(client.api.mock.calls[1][0])).toContain('$skiptoken=page-2');
  });

  it('filters by status', async () => {
    chain.get.mockResolvedValue({ value: taskFixture() });

    const tasks = await createService().listTasks(USER_ID, LIST_ID, { status: 'inProgress' });

    expect(tasks.map((task) => task.id)).toEqual(['t2']);
  });

  it('filters by importance', async () => {
    chain.get.mockResolvedValue({ value: taskFixture() });

    const tasks = await createService().listTasks(USER_ID, LIST_ID, { importance: 'high' });

    expect(tasks.map((task) => task.id)).toEqual(['t2']);
  });

  it('drops completed tasks when includeCompleted is false', async () => {
    chain.get.mockResolvedValue({ value: taskFixture() });

    const tasks = await createService().listTasks(USER_ID, LIST_ID, { includeCompleted: false });

    expect(tasks.map((task) => task.id)).toEqual(['t1', 't2', 't4', 't5']);
  });

  it('returns completed tasks by default', async () => {
    chain.get.mockResolvedValue({ value: taskFixture() });

    const tasks = await createService().listTasks(USER_ID, LIST_ID);

    expect(tasks.some((task) => task.status === 'completed')).toBe(true);
  });

  it('applies dueAfter / dueBefore on dueDateTime and drops undated tasks', async () => {
    chain.get.mockResolvedValue({ value: taskFixture() });

    const tasks = await createService().listTasks(USER_ID, LIST_ID, {
      dueAfter: '2026-11-09T00:00:00Z',
      dueBefore: '2026-11-10T00:00:00Z',
    });

    expect(tasks.map((task) => task.id)).toEqual(['t2']);
  });

  it('applies skip and top after filtering', async () => {
    chain.get.mockResolvedValue({ value: taskFixture() });

    const tasks = await createService().listTasks(USER_ID, LIST_ID, {
      includeCompleted: false,
      skip: 1,
      top: 2,
    });

    expect(tasks.map((task) => task.id)).toEqual(['t2', 't4']);
  });

  it('rejects invalid query options before any request is sent', async () => {
    const service = createService();

    await expect(
      service.listTasks(USER_ID, LIST_ID, { status: 'done' as any }),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.INVALID_STATUS });

    await expect(
      service.listTasks(USER_ID, LIST_ID, { dueBefore: 'not-a-date' }),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.INVALID_FILTER });

    await expect(
      service.listTasks(USER_ID, LIST_ID, {
        dueAfter: '2026-12-01T00:00:00Z',
        dueBefore: '2026-11-01T00:00:00Z',
      }),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.INVALID_FILTER });

    await expect(
      service.listTasks(USER_ID, LIST_ID, { top: -1 }),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.INVALID_FILTER });

    expect(client.api).not.toHaveBeenCalled();
  });

  it('requires a listId', async () => {
    await expect(createService().listTasks(USER_ID, '')).rejects.toMatchObject({
      code: TODO_ERROR_CODE.MISSING_PARAMETER,
    });
  });
});

describe('toComparableEpochMs', () => {
  it('treats an offset-less todoTask dateTime as wall-clock time', () => {
    expect(toComparableEpochMs('2026-11-09T00:00:00')).toBe(Date.parse('2026-11-09T00:00:00Z'));
  });

  it('honours an explicit zone', () => {
    expect(toComparableEpochMs('2026-11-09T00:00:00+02:00')).toBe(Date.parse('2026-11-08T22:00:00Z'));
  });

  it('returns undefined for empty or unparseable input', () => {
    expect(toComparableEpochMs(undefined)).toBeUndefined();
    expect(toComparableEpochMs('')).toBeUndefined();
    expect(toComparableEpochMs('not-a-date')).toBeUndefined();
  });
});

describe('error contract', () => {
  it('rejects a failed read with an ApiError carrying the Graph code', async () => {
    chain.get.mockRejectedValue(
      Object.assign(new Error('Item not found'), { statusCode: 404, code: 'itemNotFound' }),
    );

    let caught: any;
    try {
      await createService().getTask(USER_ID, LIST_ID, 'missing');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('itemNotFound');
  });

  it('raises NotConnected when the provider is not available', async () => {
    const service = new AzureTodoService({} as any, { getService: jest.fn(() => undefined) } as any);

    await expect(service.listTaskLists(USER_ID)).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('requires a userId for token-authenticated requests', async () => {
    await expect(createService().listTaskLists('')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('createTask / updateTask payload discipline', () => {
  it('sends only supplied fields on a PATCH', async () => {
    chain.patch.mockResolvedValue({ id: 't1' });

    await createService().updateTask(USER_ID, LIST_ID, 't1', {
      importance: 'low',
      categories: ['home'],
    });

    expect(chain.patch).toHaveBeenCalledWith({ importance: 'low', categories: ['home'] });
  });

  it('rejects an empty PATCH instead of sending one', async () => {
    await expect(createService().updateTask(USER_ID, LIST_ID, 't1', {})).rejects.toMatchObject({
      code: TODO_ERROR_CODE.MISSING_PARAMETER,
    });

    expect(chain.patch).not.toHaveBeenCalled();
  });

  it('validates the dateTimeTimeZone shape before sending', async () => {
    await expect(
      createService().createTask(USER_ID, LIST_ID, {
        title: 'Bad date',
        dueDateTime: { dateTime: '2026-11-09T10:00:00' } as any,
      }),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.MISSING_PARAMETER });

    expect(chain.post).not.toHaveBeenCalled();
  });

  it('rejects an invalid status even when it is nested in a checklist item payload', async () => {
    await expect(
      createService().createTask(USER_ID, LIST_ID, {
        title: 'Bad checklist',
        checklistItems: [{ displayName: 'Draft' }, { displayName: 42 } as any],
      }),
    ).rejects.toMatchObject({ code: TODO_ERROR_CODE.MISSING_PARAMETER });
  });
});

describe('hard constraint guards', () => {
  const serviceSource = fs.readFileSync(
    path.join(MODULE_ROOT, 'services', 'AzureTodoService.ts'),
    'utf8',
  );
  const typesSource = fs.readFileSync(path.join(MODULE_ROOT, 'types', 'tasks.types.ts'), 'utf8');
  const schemaSource = fs.readFileSync(path.join(MODULE_ROOT, 'graphql', 'types', 'Tasks.graphql'), 'utf8');

  it('mentions no preview API version in the service', () => {
    expect(serviceSource.toLowerCase()).not.toContain('beta');
  });

  it('declares no assignee property on any task input or entity', () => {
    for (const source of [serviceSource, typesSource, schemaSource]) {
      expect(source).not.toMatch(/assignedTo\s*[?:]/);
      expect(source).not.toMatch(/^\s*assignedTo\s*:/m);
    }
  });

  it('documents why there is no assignee, in the service, the types and the schema', () => {
    expect(serviceSource).toMatch(/Planner/);
    expect(serviceSource).toMatch(/assignments/);
    expect(schemaSource).toMatch(/Planner/);
    expect(schemaSource).toMatch(/assignments/);
  });

  it('documents that dueDateTime filtering is client-side', () => {
    expect(serviceSource).toMatch(/client-side/i);
    expect(serviceSource).toMatch(/dueDateTime/);
  });
});

describe('GraphQL surface alignment', () => {
  const schemaSource = fs.readFileSync(path.join(MODULE_ROOT, 'graphql', 'types', 'Tasks.graphql'), 'utf8');
  const document = parse(schemaSource);

  function fieldsOf(typeName: string): string[] {
    const fields: string[] = [];

    for (const definition of document.definitions) {
      if (definition.kind !== 'ObjectTypeExtension' && definition.kind !== 'ObjectTypeDefinition') continue;
      if ((definition as any).name.value !== typeName) continue;
      for (const field of (definition as any).fields) fields.push(field.name.value);
    }

    return fields.sort();
  }

  /** The decorators install `resolver` on the class *prototype*, not as a static. */
  const resolverMap = (TasksResolver as any).prototype.resolver;

  it('registers exactly the queries the schema declares', () => {
    const registered = Object.keys(resolverMap.Query || {}).sort();

    expect(registered).toEqual(fieldsOf('Query'));
    expect(registered).toEqual(['azureTodoChecklistItems', 'azureTodoLists', 'azureTodoTask', 'azureTodoTasks']);
  });

  it('registers exactly the mutations the schema declares', () => {
    const registered = Object.keys(resolverMap.Mutation || {}).sort();

    expect(registered).toEqual(fieldsOf('Mutation'));
    expect(registered).toEqual(
      [
        'azureCompleteTodoTask',
        'azureCreateTodoChecklistItem',
        'azureCreateTodoList',
        'azureCreateTodoTask',
        'azureDeleteTodoChecklistItem',
        'azureDeleteTodoList',
        'azureDeleteTodoTask',
        'azureUpdateTodoChecklistItem',
        'azureUpdateTodoList',
        'azureUpdateTodoTask',
      ].sort(),
    );
  });

  it('describes the task type without an assignee field', () => {
    const taskType = document.definitions.find(
      (definition: any) => definition.kind === 'ObjectTypeDefinition' && definition.name.value === 'AzureTodoTask',
    ) as any;

    expect(taskType).toBeTruthy();
    const fieldNames = taskType.fields.map((field: any) => field.name.value);

    expect(fieldNames).toEqual(
      expect.arrayContaining([
        'title',
        'body',
        'importance',
        'status',
        'dueDateTime',
        'startDateTime',
        'reminderDateTime',
        'isReminderOn',
        'recurrence',
        'categories',
        'checklistItems',
        'linkedResources',
        'completedDateTime',
      ]),
    );
    expect(fieldNames).not.toContain('assignedTo');
    expect(String(taskType.description?.value || '')).toMatch(/Planner/);
  });

  it('resolver delegates to the AzureTodoService FQN', () => {
    const source = fs.readFileSync(
      path.join(MODULE_ROOT, 'graphql', 'resolvers', 'TasksResolver.ts'),
      'utf8',
    );

    expect(source).toContain('azure.AzureTodoService@1.0.0');
  });
});

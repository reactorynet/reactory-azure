import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import type { AzureGraphClientProvider } from './graph/AzureGraphClientProvider';
import type {
  IAzureChecklistItemInput,
  IAzureChecklistItemUpdateInput,
  IAzureItemBody,
  IAzureTodoChecklistItem,
  IAzureTodoTask,
  IAzureTodoTaskCreateInput,
  IAzureTodoTaskList,
  IAzureTodoTaskListInput,
  IAzureTodoTaskListUpdateInput,
  IAzureTodoTaskQueryOptions,
  IAzureTodoTaskUpdateInput,
} from '../types/tasks.types';
import {
  AZURE_TODO_TASK_IMPORTANCES,
  AZURE_TODO_TASK_STATUSES,
} from '../types/tasks.types';
import type { AzureTodoTaskImportance, AzureTodoTaskStatus } from '../types/tasks.types';
import { encodePathSegment } from '../utils/odata';
import { GraphErrorCode, apiError, toGraphApiError } from '../utils/graph-error';

/**
 * Graph REST version used by this service.
 *
 * Only the generally available version is ever requested: no preview API
 * version appears in this file, and no request below can select one.
 */
const GRAPH_API_VERSION = 'v1.0';

/** Root of the Microsoft To Do resource tree. */
const TODO_LISTS_PATH = '/me/todo/lists';

/** Error codes this service raises itself, in addition to Graph's own codes. */
export const TODO_ERROR_CODE = {
  /** A `status` value Graph would reject - caught before the request is sent. */
  INVALID_STATUS: 'InvalidTodoTaskStatus',
  /** An `importance` value Graph would reject - caught before the request is sent. */
  INVALID_IMPORTANCE: 'InvalidTodoTaskImportance',
  /** A client-side query option that cannot be interpreted (`dueBefore`, `top`, ...). */
  INVALID_FILTER: 'InvalidTodoTaskFilter',
  /**
   * The caller supplied an assignee field. To Do has no task assignment, so this
   * is refused instead of being dropped on the floor.
   */
  UNSUPPORTED_ASSIGNMENT: 'UnsupportedTodoTaskAssignment',
  /** A required id / field is missing or empty. */
  MISSING_PARAMETER: 'MissingTodoParameter',
} as const;

/** Fields that imply per-task assignment. None of them exists on a To Do task. */
const ASSIGNMENT_FIELDS = ['assignedTo', 'assignee', 'assignments', 'assignedToUserId'] as const;

/**
 * Task properties a caller may write, and the only ones sent to Graph.
 *
 * `recurrence` and `checklistItems` are passed through **by reference and
 * unchanged**: Graph expects the recurrence object and the inline checklist
 * array exactly as documented, and re-shaping them here would silently alter a
 * caller's payload.
 */
const TASK_WRITABLE_FIELDS = [
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
] as const;

/** Validate a required, non-empty string identifier. */
function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, `Microsoft To Do requires a non-empty "${field}"`, {
      field,
    });
  }
  return value;
}

/**
 * Reject any assignee field outright.
 *
 * A To Do task has no assignee. Accepting `assignedTo` and ignoring it would be
 * worse than failing: the caller would believe work was handed to someone.
 * Assignment belongs to Planner (`/planner/tasks` with `assignments`).
 */
function rejectAssignmentFields(input: unknown): void {
  if (!input || typeof input !== 'object') return;

  for (const field of ASSIGNMENT_FIELDS) {
    if ((input as Record<string, unknown>)[field] !== undefined) {
      throw apiError(
        TODO_ERROR_CODE.UNSUPPORTED_ASSIGNMENT,
        `Microsoft To Do tasks have no assignee: "${field}" is not supported. `
          + 'Task assignment is a Planner concept - use /planner/tasks with assignments.',
        { field },
      );
    }
  }
}

/** Assert a task status is one of the five values Graph accepts. */
function assertTaskStatus(value: unknown, field: string = 'status'): AzureTodoTaskStatus {
  if (typeof value !== 'string' || !(AZURE_TODO_TASK_STATUSES as readonly string[]).includes(value)) {
    throw apiError(
      TODO_ERROR_CODE.INVALID_STATUS,
      `Invalid Microsoft To Do task status "${String(value)}"; expected one of ${AZURE_TODO_TASK_STATUSES.join(', ')}`,
      { field, value, supported: [...AZURE_TODO_TASK_STATUSES] },
    );
  }
  return value as AzureTodoTaskStatus;
}

/** Assert a task importance is `low`, `normal` or `high`. */
function assertImportance(value: unknown, field: string = 'importance'): AzureTodoTaskImportance {
  if (typeof value !== 'string' || !(AZURE_TODO_TASK_IMPORTANCES as readonly string[]).includes(value)) {
    throw apiError(
      TODO_ERROR_CODE.INVALID_IMPORTANCE,
      `Invalid Microsoft To Do task importance "${String(value)}"; expected one of ${AZURE_TODO_TASK_IMPORTANCES.join(', ')}`,
      { field, value, supported: [...AZURE_TODO_TASK_IMPORTANCES] },
    );
  }
  return value as AzureTodoTaskImportance;
}

/**
 * Convert a Graph date/time value to epoch milliseconds for client-side comparison.
 *
 * `todoTask.dueDateTime.dateTime` is an ISO 8601 **wall-clock** value with no
 * offset, so `Date.parse` on it would be treated as local time by the runtime.
 * When the value carries no zone the comparison therefore appends `Z`: the
 * service has no user time-zone context, so ordering is done on the wall-clock
 * value itself rather than on an assumed locality.
 */
export function toComparableEpochMs(value?: string | null): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;

  const raw = value.trim();
  const hasZone = /(z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const parsed = Date.parse(hasZone ? raw : `${raw}Z`);

  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Validate a `dateTimeTimeZone` value and return it unchanged. */
function assertDateTimeTimeZone(value: unknown, field: string): unknown {
  if (value === null) return null;

  const candidate = value as Record<string, unknown> | undefined;
  if (
    !candidate
    || typeof candidate !== 'object'
    || typeof candidate.dateTime !== 'string'
    || typeof candidate.timeZone !== 'string'
  ) {
    throw apiError(
      TODO_ERROR_CODE.MISSING_PARAMETER,
      `"${field}" must be a dateTimeTimeZone object with string "dateTime" and "timeZone" properties`,
      { field },
    );
  }

  return value;
}

/** Validate the item body shape. */
function assertBody(value: unknown): IAzureItemBody {
  const candidate = value as Record<string, unknown> | undefined;
  if (!candidate || typeof candidate !== 'object' || typeof candidate.content !== 'string') {
    throw apiError(
      TODO_ERROR_CODE.MISSING_PARAMETER,
      '"body" must be an itemBody object with a string "content" property',
      { field: 'body' },
    );
  }
  return value as IAzureItemBody;
}

/** Validate the inline checklist array. */
function assertChecklistItems(value: unknown): IAzureChecklistItemInput[] {
  if (!Array.isArray(value)) {
    throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, '"checklistItems" must be an array', {
      field: 'checklistItems',
    });
  }

  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof (item as any).displayName !== 'string') {
      throw apiError(
        TODO_ERROR_CODE.MISSING_PARAMETER,
        'Each checklist item must have a string "displayName"',
        { field: 'checklistItems' },
      );
    }
  }

  return value as IAzureChecklistItemInput[];
}

/**
 * Build the request body for a task create (`partial: false`) or update
 * (`partial: true`) from a whitelist of writable properties.
 *
 * Anything outside {@link TASK_WRITABLE_FIELDS} - including every assignee field
 * - never reaches Graph.
 */
function buildTaskPayload(
  input: IAzureTodoTaskCreateInput | IAzureTodoTaskUpdateInput | undefined,
  partial: boolean,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    throw apiError(
      TODO_ERROR_CODE.MISSING_PARAMETER,
      `A task ${partial ? 'update' : 'create'} requires an input object`,
      {},
    );
  }

  rejectAssignmentFields(input);

  const source = input as Record<string, unknown>;
  const payload: Record<string, unknown> = {};

  for (const key of TASK_WRITABLE_FIELDS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value === undefined) continue;
    payload[key] = value;
  }

  if (!partial) {
    if (typeof payload.title !== 'string' || payload.title.trim().length === 0) {
      throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, 'A Microsoft To Do task requires a non-empty "title"', {
        field: 'title',
      });
    }
  } else if ('title' in payload && (typeof payload.title !== 'string' || payload.title.trim().length === 0)) {
    throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, '"title" must be a non-empty string', { field: 'title' });
  }

  if ('status' in payload) assertTaskStatus(payload.status);
  if ('importance' in payload) assertImportance(payload.importance);
  if ('body' in payload && payload.body !== null) assertBody(payload.body);
  if ('dueDateTime' in payload) assertDateTimeTimeZone(payload.dueDateTime, 'dueDateTime');
  if ('startDateTime' in payload) assertDateTimeTimeZone(payload.startDateTime, 'startDateTime');
  if ('reminderDateTime' in payload) assertDateTimeTimeZone(payload.reminderDateTime, 'reminderDateTime');
  if ('categories' in payload && payload.categories !== null) {
    if (!Array.isArray(payload.categories) || payload.categories.some((entry) => typeof entry !== 'string')) {
      throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, '"categories" must be an array of strings', {
        field: 'categories',
      });
    }
  }
  if ('checklistItems' in payload && payload.checklistItems !== null) {
    assertChecklistItems(payload.checklistItems);
  }
  if ('isReminderOn' in payload && payload.isReminderOn !== null && typeof payload.isReminderOn !== 'boolean') {
    throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, '"isReminderOn" must be a boolean', {
      field: 'isReminderOn',
    });
  }

  return payload;
}

/** Build the PATCH body for a checklist item. */
function buildChecklistItemPayload(
  input: IAzureChecklistItemInput | IAzureChecklistItemUpdateInput | undefined,
  partial: boolean,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    throw apiError(
      TODO_ERROR_CODE.MISSING_PARAMETER,
      `A checklist item ${partial ? 'update' : 'create'} requires an input object`,
      {},
    );
  }

  const payload: Record<string, unknown> = {};

  if (input.displayName !== undefined) {
    if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0) {
      throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, '"displayName" must be a non-empty string', {
        field: 'displayName',
      });
    }
    payload.displayName = input.displayName;
  }

  if (input.isChecked !== undefined) {
    if (typeof input.isChecked !== 'boolean') {
      throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, '"isChecked" must be a boolean', {
        field: 'isChecked',
      });
    }
    payload.isChecked = input.isChecked;
  }

  if (!partial) {
    if (payload.displayName === undefined) {
      throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, 'A checklist item requires a "displayName"', {
        field: 'displayName',
      });
    }
  } else if (Object.keys(payload).length === 0) {
    throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, 'A checklist item update changes nothing', {});
  }

  return payload;
}

/** Validate and normalise the client-side task query options. */
function normaliseTaskQueryOptions(options: IAzureTodoTaskQueryOptions = {}) {
  if (!options || typeof options !== 'object') {
    throw apiError(TODO_ERROR_CODE.INVALID_FILTER, 'listTasks options must be an object', {});
  }

  const status = options.status === undefined ? undefined : assertTaskStatus(options.status);
  const importance = options.importance === undefined ? undefined : assertImportance(options.importance);

  const dueBeforeMs = (() => {
    if (options.dueBefore === undefined) return undefined;
    const parsed = toComparableEpochMs(options.dueBefore);
    if (parsed === undefined) {
      throw apiError(
        TODO_ERROR_CODE.INVALID_FILTER,
        `"dueBefore" is not a valid ISO 8601 date/time: ${String(options.dueBefore)}`,
        { field: 'dueBefore' },
      );
    }
    return parsed;
  })();

  const dueAfterMs = (() => {
    if (options.dueAfter === undefined) return undefined;
    const parsed = toComparableEpochMs(options.dueAfter);
    if (parsed === undefined) {
      throw apiError(
        TODO_ERROR_CODE.INVALID_FILTER,
        `"dueAfter" is not a valid ISO 8601 date/time: ${String(options.dueAfter)}`,
        { field: 'dueAfter' },
      );
    }
    return parsed;
  })();

  if (dueBeforeMs !== undefined && dueAfterMs !== undefined && dueAfterMs > dueBeforeMs) {
    throw apiError(TODO_ERROR_CODE.INVALID_FILTER, '"dueAfter" must not be later than "dueBefore"', {
      field: 'dueAfter',
    });
  }

  const top = options.top === undefined ? undefined : Math.trunc(Number(options.top));
  if (top !== undefined && (!Number.isFinite(top) || top < 0)) {
    throw apiError(TODO_ERROR_CODE.INVALID_FILTER, '"top" must be a non-negative integer', { field: 'top' });
  }

  const skip = options.skip === undefined ? undefined : Math.trunc(Number(options.skip));
  if (skip !== undefined && (!Number.isFinite(skip) || skip < 0)) {
    throw apiError(TODO_ERROR_CODE.INVALID_FILTER, '"skip" must be a non-negative integer', { field: 'skip' });
  }

  return {
    status,
    importance,
    dueBeforeMs,
    dueAfterMs,
    includeCompleted: options.includeCompleted !== false,
    top,
    skip,
  };
}

/**
 * AzureTodoService - Microsoft To Do over Microsoft Graph **v1.0**.
 *
 * A live replacement for the legacy `services/graph.ts` task block, whose four
 * methods targeted `/me/outlook/tasks` on the retired preview API version -
 * which Microsoft states stopped returning data on 20 August 2022. Every request
 * this service makes is a `/me/todo/...` path on the generally available
 * version; the preview version is never requested anywhere in this file.
 *
 * ### Scope
 *
 * - **Task lists** - `listTaskLists`, `getTaskList`, `createTaskList`,
 *   `updateTaskList`, `deleteTaskList` over `/me/todo/lists`.
 * - **Tasks** - `listTasks`, `getTask`, `createTask`, `updateTask`,
 *   `deleteTask`, `completeTask` over `/me/todo/lists/{listId}/tasks`.
 * - **Checklist items** - `listChecklistItems`, `getChecklistItem`,
 *   `createChecklistItem`, `updateChecklistItem`, `deleteChecklistItem` over
 *   `/me/todo/lists/{listId}/tasks/{taskId}/checklistItems`.
 *
 * The task model is the real To Do shape: `title`, `body`, `importance`,
 * `status` (`notStarted` | `inProgress` | `completed` | `waitingOnOthers` |
 * `deferred`), `dueDateTime`, `startDateTime`, `reminderDateTime`,
 * `isReminderOn`, `recurrence`, `categories`, `checklistItems`,
 * `linkedResources` and `completedDateTime`.
 *
 * ### There is no `assignedTo` - and there never will be
 *
 * A Microsoft To Do task has **no assignee**. To Do shares whole *lists*; it does
 * not assign individual tasks. Per-task assignment is a **Planner** concept,
 * expressed as `/planner/tasks` with an `assignments` collection. This service
 * therefore does not declare an `assignedTo` parameter on any method, does not
 * accept one on a create/update input, and **rejects** a payload that carries
 * `assignedTo` / `assignee` / `assignments` with
 * `UnsupportedTodoTaskAssignment` rather than silently dropping it - a caller
 * must never believe a task was handed to a colleague when it was not.
 *
 * ### Client-side filtering
 *
 * `/me/todo/lists/{id}/tasks` documents only that it *"supports some of the
 * OData query parameters"*; it publishes no list of `$filter`-able properties,
 * and `dueDateTime` - the one every "due this week" view needs - is not
 * documented as filterable. Rather than send an unsupported `$filter` and get a
 * 400 or the wrong rows, `listTasks` reads the list (following
 * `@odata.nextLink` to the provider's page bound) and applies `status`,
 * `importance`, `includeCompleted`, `dueAfter`, `dueBefore`, `top` and `skip`
 * itself. See {@link listTasks}.
 *
 * ### Transport
 *
 * Reads go through {@link AzureGraphClientProvider} (`request` / `requestAll`),
 * so they inherit its retry policy and Graph-code-preserving error translation.
 * Writes go through the same provider's `getClient(userId)` - the provider
 * exposes GET helpers only - and are wrapped here so a failed POST/PATCH/DELETE
 * is still an `ApiError` carrying the Graph `code`.
 */
@service({
  id: 'azure.AzureTodoService@1.0.0',
  name: 'AzureTodoService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft To Do - task lists, tasks and checklist items over Graph v1.0',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
  ],
})
class AzureTodoService implements Reactory.Service.IReactoryService {
  name: string = 'AzureTodoService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphClientProvider?: AzureGraphClientProvider;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the service container from the `graphClientProvider` dependency alias. */
  setGraphClientProvider(provider: AzureGraphClientProvider): void {
    this._graphClientProvider = provider;
  }

  private get provider(): AzureGraphClientProvider {
    const resolved = this._graphClientProvider
      || (this.context?.getService?.('azure.AzureGraphClientProvider@1.0.0') as AzureGraphClientProvider | undefined);

    if (!resolved) {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'AzureGraphClientProvider is not available; the Microsoft Graph client cannot be built',
        { service: 'azure.AzureGraphClientProvider@1.0.0' },
      );
    }

    return resolved;
  }

  /* ------------------------------------------------------------------ paths */

  /** `/me/todo/lists` or `/me/todo/lists/{listId}`. */
  private listsPath(listId?: string): string {
    return listId ? `${TODO_LISTS_PATH}/${encodePathSegment(listId)}` : TODO_LISTS_PATH;
  }

  /** `/me/todo/lists/{listId}/tasks` or `.../tasks/{taskId}`. */
  private tasksPath(listId: string, taskId?: string): string {
    const base = `${this.listsPath(requireId(listId, 'listId'))}/tasks`;
    return taskId ? `${base}/${encodePathSegment(requireId(taskId, 'taskId'))}` : base;
  }

  /** `/me/todo/lists/{listId}/tasks/{taskId}/checklistItems` or `.../{itemId}`. */
  private checklistPath(listId: string, taskId: string, itemId?: string): string {
    const base = `${this.tasksPath(listId, taskId)}/checklistItems`;
    return itemId ? `${base}/${encodePathSegment(requireId(itemId, 'checklistItemId'))}` : base;
  }

  /* -------------------------------------------------------------- transport */

  /**
   * Issue a write (POST / PATCH / DELETE) through the provider's Graph client.
   *
   * The provider only exposes GET helpers, so the fluent client is used
   * directly; the catch block reproduces the provider's error contract - a
   * failed write is an `ApiError` carrying the Graph `code`, never a resolved
   * placeholder. The token provenance recorded on the client is forwarded so a
   * 401 on a legacy token is still reported as `LegacyTokenExpired`.
   */
  private async write<T>(
    userId: string,
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    operation: string,
  ): Promise<T> {
    const client: any = this.provider.getClient(userId, GRAPH_API_VERSION);

    try {
      const request = client.api(path).version(GRAPH_API_VERSION).headers({ Accept: 'application/json' });

      let result: any;
      if (method === 'POST') result = await request.post(body ?? {});
      else if (method === 'PATCH') result = await request.patch(body ?? {});
      else result = await request.delete();

      return result as T;
    } catch (error) {
      const tokenSource = typeof client?.__azureTokenSource === 'function' ? client.__azureTokenSource() : undefined;
      throw toGraphApiError(error, { operation, tokenSource });
    }
  }

  /* ------------------------------------------------------------- task lists */

  /**
   * Every task list the signed-in user can see: `GET /me/todo/lists`.
   *
   * Follows `@odata.nextLink` and fails loudly at the provider's page bound
   * rather than returning a truncated list.
   */
  async listTaskLists(userId: string): Promise<IAzureTodoTaskList[]> {
    return this.provider.requestAll<IAzureTodoTaskList>(userId, this.listsPath(), {
      operation: 'listTaskLists',
    });
  }

  /** One task list: `GET /me/todo/lists/{listId}`. */
  async getTaskList(userId: string, listId: string): Promise<IAzureTodoTaskList> {
    return this.provider.request<IAzureTodoTaskList>(userId, this.listsPath(requireId(listId, 'listId')), {
      operation: 'getTaskList',
    });
  }

  /**
   * Create a task list: `POST /me/todo/lists`.
   *
   * Only `displayName` is writable; Graph creates the well-known list metadata
   * itself.
   */
  async createTaskList(userId: string, input: IAzureTodoTaskListInput): Promise<IAzureTodoTaskList> {
    const displayName = input?.displayName;
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, 'A task list requires a non-empty "displayName"', {
        field: 'displayName',
      });
    }

    return this.write<IAzureTodoTaskList>(
      userId,
      this.listsPath(),
      'POST',
      { displayName },
      'createTaskList',
    );
  }

  /** Rename a task list: `PATCH /me/todo/lists/{listId}`. */
  async updateTaskList(
    userId: string,
    listId: string,
    input: IAzureTodoTaskListUpdateInput,
  ): Promise<IAzureTodoTaskList> {
    const displayName = input?.displayName;
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, 'A task list update requires a non-empty "displayName"', {
        field: 'displayName',
      });
    }

    return this.write<IAzureTodoTaskList>(
      userId,
      this.listsPath(requireId(listId, 'listId')),
      'PATCH',
      { displayName },
      'updateTaskList',
    );
  }

  /**
   * Delete a task list and everything in it: `DELETE /me/todo/lists/{listId}`.
   *
   * Graph answers `204 No Content`; this resolves to `void` on success and
   * throws an `ApiError` on failure.
   */
  async deleteTaskList(userId: string, listId: string): Promise<void> {
    await this.write<unknown>(
      userId,
      this.listsPath(requireId(listId, 'listId')),
      'DELETE',
      undefined,
      'deleteTaskList',
    );
  }

  /* ------------------------------------------------------------------ tasks */

  /**
   * Tasks in a list: `GET /me/todo/lists/{listId}/tasks`.
   *
   * **Filtering is client-side, deliberately.** The v1.0 reference for this
   * operation documents only that it *"supports some of the OData query
   * parameters"* and names no `$filter`-able property; `dueDateTime` in
   * particular is not documented as filterable. An undocumented `$filter` either
   * 400s or returns the wrong rows, so this method:
   *
   * 1. reads every page of the list (`@odata.nextLink` followed to the
   *    provider's page bound, which throws rather than truncating);
   * 2. drops tasks whose `status` is `completed` when
   *    `options.includeCompleted === false`;
   * 3. applies `status` / `importance` exact matches;
   * 4. applies `dueAfter` / `dueBefore` by comparing `dueDateTime` - tasks with
   *    no due date are excluded when either bound is present;
   * 5. applies `skip` then `top`.
   *
   * `status` and `importance` are validated before the request is sent, so an
   * invalid enum never reaches Graph. `dueBefore`/`dueAfter` are ISO 8601; the
   * comparison treats an offset-less `dueDateTime` as wall-clock time because
   * To Do returns no tenant/user time zone to anchor it to (see
   * {@link toComparableEpochMs}).
   */
  async listTasks(
    userId: string,
    listId: string,
    options: IAzureTodoTaskQueryOptions = {},
  ): Promise<IAzureTodoTask[]> {
    const path = this.tasksPath(requireId(listId, 'listId'));
    const query = normaliseTaskQueryOptions(options);

    const tasks = await this.provider.requestAll<IAzureTodoTask>(userId, path, {
      operation: 'listTasks',
    });

    const filtered = tasks.filter((task) => {
      if (!query.includeCompleted && task?.status === 'completed') return false;
      if (query.status !== undefined && task?.status !== query.status) return false;
      if (query.importance !== undefined && task?.importance !== query.importance) return false;

      if (query.dueBeforeMs !== undefined || query.dueAfterMs !== undefined) {
        const due = toComparableEpochMs(task?.dueDateTime?.dateTime);
        if (due === undefined) return false;
        if (query.dueAfterMs !== undefined && due < query.dueAfterMs) return false;
        if (query.dueBeforeMs !== undefined && due > query.dueBeforeMs) return false;
      }

      return true;
    });

    const start = query.skip && query.skip > 0 ? query.skip : 0;
    return query.top === undefined ? filtered.slice(start) : filtered.slice(start, start + query.top);
  }

  /** One task: `GET /me/todo/lists/{listId}/tasks/{taskId}`. */
  async getTask(userId: string, listId: string, taskId: string): Promise<IAzureTodoTask> {
    return this.provider.request<IAzureTodoTask>(userId, this.tasksPath(listId, taskId), {
      operation: 'getTask',
    });
  }

  /**
   * Create a task: `POST /me/todo/lists/{listId}/tasks`.
   *
   * `recurrence` and inline `checklistItems` are forwarded exactly as supplied -
   * the same object references, not a re-serialised copy - because Graph's
   * `patternedRecurrence` and checklist shapes are the caller's contract.
   *
   * No `assignedTo`: a To Do task has no assignee (assignment is Planner,
   * `/planner/tasks` with `assignments`), and a payload carrying one is rejected
   * with `UnsupportedTodoTaskAssignment`.
   */
  async createTask(
    userId: string,
    listId: string,
    input: IAzureTodoTaskCreateInput,
  ): Promise<IAzureTodoTask> {
    const payload = buildTaskPayload(input, false);

    return this.write<IAzureTodoTask>(userId, this.tasksPath(listId), 'POST', payload, 'createTask');
  }

  /**
   * Update a task: `PATCH /me/todo/lists/{listId}/tasks/{taskId}`.
   *
   * Sparse by construction: only the properties present on `input` are sent, so
   * an update cannot blank fields the caller did not mention. `recurrence` and
   * `checklistItems` pass through unchanged. No `assignedTo` - see
   * {@link createTask}.
   */
  async updateTask(
    userId: string,
    listId: string,
    taskId: string,
    input: IAzureTodoTaskUpdateInput,
  ): Promise<IAzureTodoTask> {
    const payload = buildTaskPayload(input, true);

    if (Object.keys(payload).length === 0) {
      throw apiError(TODO_ERROR_CODE.MISSING_PARAMETER, 'A task update changes nothing', {});
    }

    return this.write<IAzureTodoTask>(
      userId,
      this.tasksPath(listId, taskId),
      'PATCH',
      payload,
      'updateTask',
    );
  }

  /**
   * Delete a task: `DELETE /me/todo/lists/{listId}/tasks/{taskId}`.
   *
   * Resolves to `void` on Graph's `204 No Content`.
   */
  async deleteTask(userId: string, listId: string, taskId: string): Promise<void> {
    await this.write<unknown>(userId, this.tasksPath(listId, taskId), 'DELETE', undefined, 'deleteTask');
  }

  /**
   * Mark a task complete: `PATCH /me/todo/lists/{listId}/tasks/{taskId}` with
   * `{ "status": "completed" }`.
   *
   * Graph stamps `completedDateTime` itself. Re-completing an already completed
   * task is idempotent at the API level.
   */
  async completeTask(userId: string, listId: string, taskId: string): Promise<IAzureTodoTask> {
    return this.write<IAzureTodoTask>(
      userId,
      this.tasksPath(listId, taskId),
      'PATCH',
      { status: 'completed' },
      'completeTask',
    );
  }

  /* ------------------------------------------------------- checklist items */

  /** Checklist items on a task: `GET .../tasks/{taskId}/checklistItems`. */
  async listChecklistItems(
    userId: string,
    listId: string,
    taskId: string,
  ): Promise<IAzureTodoChecklistItem[]> {
    return this.provider.requestAll<IAzureTodoChecklistItem>(
      userId,
      this.checklistPath(listId, taskId),
      { operation: 'listChecklistItems' },
    );
  }

  /** One checklist item: `GET .../checklistItems/{checklistItemId}`. */
  async getChecklistItem(
    userId: string,
    listId: string,
    taskId: string,
    checklistItemId: string,
  ): Promise<IAzureTodoChecklistItem> {
    return this.provider.request<IAzureTodoChecklistItem>(
      userId,
      this.checklistPath(listId, taskId, checklistItemId),
      { operation: 'getChecklistItem' },
    );
  }

  /** Add a checklist item: `POST .../tasks/{taskId}/checklistItems`. */
  async createChecklistItem(
    userId: string,
    listId: string,
    taskId: string,
    input: IAzureChecklistItemInput,
  ): Promise<IAzureTodoChecklistItem> {
    const payload = buildChecklistItemPayload(input, false);

    return this.write<IAzureTodoChecklistItem>(
      userId,
      this.checklistPath(listId, taskId),
      'POST',
      payload,
      'createChecklistItem',
    );
  }

  /** Rename or tick a checklist item: `PATCH .../checklistItems/{checklistItemId}`. */
  async updateChecklistItem(
    userId: string,
    listId: string,
    taskId: string,
    checklistItemId: string,
    input: IAzureChecklistItemUpdateInput,
  ): Promise<IAzureTodoChecklistItem> {
    const payload = buildChecklistItemPayload(input, true);

    return this.write<IAzureTodoChecklistItem>(
      userId,
      this.checklistPath(listId, taskId, checklistItemId),
      'PATCH',
      payload,
      'updateChecklistItem',
    );
  }

  /** Delete a checklist item: `DELETE .../checklistItems/{checklistItemId}`. */
  async deleteChecklistItem(
    userId: string,
    listId: string,
    taskId: string,
    checklistItemId: string,
  ): Promise<void> {
    await this.write<unknown>(
      userId,
      this.checklistPath(listId, taskId, checklistItemId),
      'DELETE',
      undefined,
      'deleteChecklistItem',
    );
  }
}

export const AzureTodoServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureTodoService> = {
  service: (props: any, context: any) => new AzureTodoService(props, context),
  id: 'azure.AzureTodoService@1.0.0',
  name: 'AzureTodoService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft To Do - task lists, tasks and checklist items over Graph v1.0',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
  ],
};

export { AzureTodoService };

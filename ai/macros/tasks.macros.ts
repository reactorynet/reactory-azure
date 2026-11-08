import type {
  ChatState,
  MacroComponentDefinition,
} from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

import { DEFAULT_CALENDAR_TIME_ZONE } from '../../types/calendar.types';
import {
  AZURE_NS,
  AZURE_VERSION,
  ROLE_SET,
  asStringArray,
  buildParameters,
  compactObject,
  fail,
  macroFailure,
  notConnected,
  ok,
  optionalString,
  toIsoString,
  userIdFrom,
} from './macro-support';

/**
 * Tasks macro (AZ-13): `azure_create_task`.
 *
 * Resolves `azure.AzureTodoService@1.0.0` from the chat context and creates a
 * Microsoft To Do task.
 *
 * `listId` is optional on purpose. A To Do task always belongs to a list, but a
 * user rarely knows the list id; when it is omitted the macro reads the user's
 * lists and picks the well-known default list (falling back to the first). That
 * is one extra service call, not a second service - the macro still resolves
 * only `azure.AzureTodoService@1.0.0`.
 *
 * The due date is sent as a Graph `dateTimeTimeZone` object, like every other
 * date in this module: a bare string would be anchored to no zone at all.
 */

const TOOL_NAME = 'azure_create_task';

const CreateTask = async (params: any, state: ChatState) => {
  const { context } = state;

  const userId = userIdFrom(context);
  if (!userId) {
    return fail(
      TOOL_NAME,
      params,
      'No authenticated user in context',
      'Tasks are created in the signed-in user\'s To Do lists; a user is required.',
    );
  }

  const todoService = context?.getService('azure.AzureTodoService@1.0.0') as any;
  if (!todoService) {
    return notConnected(TOOL_NAME, params, 'AzureTodoService is not registered');
  }

  const title = optionalString(params?.title);
  if (!title) {
    return fail(TOOL_NAME, params, '"title" is required and must not be empty');
  }

  const timeZone = optionalString(params?.timeZone) || DEFAULT_CALENDAR_TIME_ZONE;
  const dueDateTime = optionalString(params?.dueDateTime);
  const bodyText = optionalString(params?.body);
  const categories = asStringArray(params?.categories);

  let listId = optionalString(params?.listId);

  try {
    if (!listId) {
      const lists = await todoService.listTaskLists(userId);
      const available = Array.isArray(lists) ? lists : [];
      const preferred = available.find((list: any) => list?.wellknownListName === 'defaultList')
        || available[0];

      if (!preferred?.id) {
        return fail(
          TOOL_NAME,
          params,
          'No Microsoft To Do list is available for this user',
          'Ask the user to open Microsoft To Do once so a default list exists, or pass an '
            + 'explicit listId.',
        );
      }

      listId = preferred.id;
    }

    const input = compactObject({
      title,
      body: bodyText ? { content: bodyText, contentType: 'text' } : undefined,
      importance: optionalString(params?.importance),
      dueDateTime: dueDateTime ? { dateTime: dueDateTime, timeZone } : undefined,
      categories: categories.length > 0 ? categories : undefined,
    });

    const task = await todoService.createTask(userId, listId, input);

    return ok(
      TOOL_NAME,
      params,
      {
        id: task?.id,
        listId,
        title: task?.title || title,
        status: task?.status,
        importance: task?.importance,
        dueDateTime: task?.dueDateTime,
        createdDateTime: toIsoString(task?.createdDateTime),
      },
      `Task created: ${task?.title || title}`,
    );
  } catch (error) {
    return macroFailure(TOOL_NAME, params, error);
  }
};

const CreateTaskMacro: MacroComponentDefinition<typeof CreateTask> = {
  nameSpace: AZURE_NS,
  name: TOOL_NAME,
  version: AZURE_VERSION,
  component: CreateTask,
  description: 'Create a task in the connected user\'s Microsoft To Do lists',
  alias: TOOL_NAME,
  runat: 'server',
  icon: 'task_alt',
  roles: ROLE_SET,
  tags: ['azure', 'todo', 'tasks', 'microsoft-to-do', 'create'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      runat: 'server',
      function: {
        name: TOOL_NAME,
        icon: 'task_alt',
        description:
          'Create a task in Microsoft To Do as the connected user. When listId is omitted the '
          + 'default To Do list is used. Optionally set a due date, importance and categories. '
          + 'Returns the created task.',
        parameters: buildParameters([
          {
            name: 'title',
            type: 'string',
            required: true,
            description: 'Task title, shown in the list and in reminders.',
          },
          {
            name: 'listId',
            type: 'string',
            required: false,
            description:
              'Id of the To Do list that should hold the task. When omitted the user\'s '
              + 'default list is used.',
          },
          {
            name: 'body',
            type: 'string',
            required: false,
            description: 'Optional task notes, stored as plain text.',
          },
          {
            name: 'dueDateTime',
            type: 'string',
            required: false,
            description:
              'Optional due date as an ISO 8601 wall-clock value, for example '
              + '2026-11-09T17:00:00. Interpreted in "timeZone".',
          },
          {
            name: 'timeZone',
            type: 'string',
            required: false,
            default: DEFAULT_CALENDAR_TIME_ZONE,
            description:
              'Windows time zone name used to interpret "dueDateTime". Defaults to '
              + `"${DEFAULT_CALENDAR_TIME_ZONE}".`,
          },
          {
            name: 'importance',
            type: 'string',
            required: false,
            enum: ['low', 'normal', 'high'],
            description: 'Optional task importance. Graph defaults to "normal".',
          },
          {
            name: 'categories',
            type: 'array',
            required: false,
            items: { type: 'string' },
            description: 'Optional category labels to attach to the task.',
          },
        ]),
      },
    },
  ],
};

export const TASKS_MACROS: MacroComponentDefinition<unknown>[] = [CreateTaskMacro];

export { CreateTaskMacro };
export default TASKS_MACROS;

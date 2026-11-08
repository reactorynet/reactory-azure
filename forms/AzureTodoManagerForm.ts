import Reactory from '@reactorynet/reactory-core';
import { enumLabel, fieldLabel, formLabel } from './i18n';
import { toTextBodyContentType } from './transforms';

/**
 * Microsoft To Do — the `azureTodoTasks` grid plus the task CRUD.
 *
 * THERE IS NO ASSIGNEE FIELD, AND NONE MAY BE ADDED
 * ------------------------------------------------
 * A Microsoft To Do task has no assignee: To Do shares whole *lists*, and
 * per-task assignment is a Planner concept (`/planner/tasks` with `assignments`).
 * `AzureTodoTaskCreateInput` and `AzureTodoTaskUpdateInput` carry no
 * `assignedTo`/`assignee`/`assignments`, and the service rejects such a payload
 * with `UnsupportedTodoTaskAssignment` rather than dropping it. A form field here
 * would either fail at submit or imply an assignment that never happened.
 *
 * THE GRID OWNS THE READ — THE LIST PAYLOAD PATH
 * ----------------------------------------------
 * `azureTodoTasks` returns `[AzureTodoTask!]!`. The form-level data manager shapes
 * `data.data[query.name]` by `schema.type`, and with `schema.type === 'object'` a
 * list is spread into `{"0": …}` and reaches no declared property. The way to
 * display it is the client's own grid fetch: `MaterialTableWidget` with
 * `ui:options.remoteData: true` runs its own query on mount, wraps an array root
 * field as `{ data: rawResultData }` and pages it client-side — it never passes
 * through `transformData`, so `schema.type` does not constrain it.
 *
 * An earlier revision declared this un-displayable and filed it as needing client
 * support. That was wrong; see the calendar-view form's header for the code path.
 *
 * Accordingly the read lives under `graphql.queries.tasks` named by
 * `ui:options.query`, with no `graphql.query` — so the form-level manager does not
 * issue a duplicate request. `ui:options.variables` is rooted at
 * `formContext.formData` because the widget's mapper source is
 * `{ formContext, query, props }`, not `formData`; that is how the selected list
 * and the filter controls reach `$listId` and `filter.*`.
 *
 * THE QUERY'S `filter` IS A NESTED OBJECT
 * ---------------------------------------
 * `azureTodoTasks(listId, filter: AzureTodoTaskFilterInput)` takes one input
 * object. The form exposes separate controls, so both maps fan them out into
 * `filter.*`.
 *
 * `notes` becomes `input.body.content` (a `{ content, contentType }` pair), and
 * `dueDateTime`/`dueTimeZone` become the non-null `dateTime`/`timeZone` pair of
 * `input.dueDateTime`.
 *
 * MODE CONSTRAINT ON `title`
 * --------------------------
 * `AzureTodoTaskCreateInput.title` is `String!`, but `title` is not in
 * `schema.required`: one schema serves the read, create, update and delete modes,
 * and requiring a title unconditionally would block the delete mode, which sends
 * only ids. A create submitted without a title reaches Graph and is rejected
 * there. Per-mode validation would need client-side fieldMap support. The same
 * applies to `values` on `AzureWorkbookViewForm`.
 */
const AzureTodoManagerForm: Reactory.Forms.IReactoryForm = {
  id: 'azure.AzureTodoManagerForm@1.0.0',
  nameSpace: 'azure',
  name: 'AzureTodoManagerForm',
  version: '1.0.0',
  title: formLabel('todoManager', 'title'),
  description: formLabel('todoManager', 'description'),
  schema: {
    type: 'object',
    title: formLabel('todoManager', 'schemaTitle'),
    required: ['listId'],
    properties: {
      items: {
        type: 'array',
        title: fieldLabel('todoManager', 'items'),
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            importance: { type: 'string' },
            dueDateTime: {
              type: 'object',
              properties: {
                dateTime: { type: 'string' },
                timeZone: { type: 'string' },
              },
            },
            createdDateTime: { type: 'string' },
            isReminderOn: { type: 'boolean' },
          },
        },
      },
      listId: {
        type: 'string',
        title: fieldLabel('todoManager', 'listId'),
      },
      taskId: {
        type: 'string',
        title: fieldLabel('todoManager', 'taskId'),
      },
      title: {
        type: 'string',
        title: fieldLabel('todoManager', 'title'),
      },
      notes: {
        type: 'string',
        title: fieldLabel('todoManager', 'notes'),
      },
      importance: {
        type: 'string',
        title: fieldLabel('todoManager', 'importance'),
        enum: ['low', 'normal', 'high'],
        enumNames: [
          enumLabel('todoManager', 'importance', 'low'),
          enumLabel('todoManager', 'importance', 'normal'),
          enumLabel('todoManager', 'importance', 'high'),
        ],
        default: 'normal',
      },
      status: {
        type: 'string',
        title: fieldLabel('todoManager', 'status'),
        enum: ['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred'],
        enumNames: [
          enumLabel('todoManager', 'status', 'notStarted'),
          enumLabel('todoManager', 'status', 'inProgress'),
          enumLabel('todoManager', 'status', 'completed'),
          enumLabel('todoManager', 'status', 'waitingOnOthers'),
          enumLabel('todoManager', 'status', 'deferred'),
        ],
        default: 'notStarted',
      },
      dueDateTime: {
        type: 'string',
        format: 'date-time',
        title: fieldLabel('todoManager', 'dueDateTime'),
      },
      dueTimeZone: {
        type: 'string',
        title: fieldLabel('todoManager', 'dueTimeZone'),
      },
      includeCompleted: {
        type: 'boolean',
        title: fieldLabel('todoManager', 'includeCompleted'),
        default: false,
      },
      top: {
        type: 'number',
        title: fieldLabel('todoManager', 'top'),
        default: 50,
      },
    },
  },
  uiSchema: {
    items: {
      'ui:title': null,
      'ui:widget': 'MaterialTableWidget',
      'ui:options': {
        remoteData: true,
        query: 'tasks',
        showLabel: false,
        allowAdd: false,
        allowDelete: false,
        search: false,
        columns: [
          { title: formLabel('todoManager', 'columns', 'title'), field: 'title', width: 300 },
          { title: formLabel('todoManager', 'columns', 'status'), field: 'status', width: 140 },
          { title: formLabel('todoManager', 'columns', 'importance'), field: 'importance', width: 120 },
          { title: formLabel('todoManager', 'columns', 'dueDateTime'), field: 'dueDateTime.dateTime', width: 190 },
        ],
        // Rooted at `formContext.formData` — the widget maps from
        // `{ formContext, query, props }`, so `formData.…` would resolve nothing.
        variables: {
          'formContext.formData.listId': 'listId',
          'formContext.formData.status': 'filter.status',
          'formContext.formData.importance': 'filter.importance',
          'formContext.formData.includeCompleted': 'filter.includeCompleted',
          'formContext.formData.top': 'filter.top',
        },
      },
    },
    listId: { 'ui:widget': 'text' },
    taskId: { 'ui:widget': 'text' },
    title: { 'ui:widget': 'text' },
    notes: { 'ui:widget': 'textarea', 'ui:options': { rows: 6 } },
    importance: { 'ui:widget': 'select' },
    status: { 'ui:widget': 'select' },
    dueDateTime: { 'ui:widget': 'DateTimeWidget' },
    dueTimeZone: {
      'ui:widget': 'text',
      'ui:help': formLabel('todoManager', 'help', 'dueTimeZone'),
    },
    includeCompleted: { 'ui:widget': 'checkbox' },
    top: { 'ui:widget': 'updown' },
  },
  roles: ['USER'],
  registerAsComponent: true,
  uiSupport: ['material'],
  graphql: {
    queries: {
      tasks: {
        name: 'azureTodoTasks',
        text: `query AzureTodoTasks($listId: String!, $filter: AzureTodoTaskFilterInput) {
          azureTodoTasks(listId: $listId, filter: $filter) {
            id
            title
            importance
            status
            dueDateTime {
              dateTime
              timeZone
            }
            startDateTime {
              dateTime
              timeZone
            }
            isReminderOn
            completedDateTime {
              dateTime
              timeZone
            }
            createdDateTime
            lastModifiedDateTime
            hasAttachments
          }
        }`,
        // Used only by the form-level data manager (there is no `graphql.query`
        // here), and validated by the suite so the two paths cannot drift.
        variables: {
          'formData.listId': 'listId',
          'formData.status': 'filter.status',
          'formData.importance': 'filter.importance',
          'formData.includeCompleted': 'filter.includeCompleted',
          'formData.top': 'filter.top',
        },
      },
    },
    mutation: {
      new: {
        name: 'azureCreateTodoTask',
        text: `mutation AzureCreateTodoTask($listId: String!, $input: AzureTodoTaskCreateInput!) {
          azureCreateTodoTask(listId: $listId, input: $input) {
            id
            title
            status
            importance
            dueDateTime {
              dateTime
              timeZone
            }
          }
        }`,
        variables: {
          'formData.listId': 'listId',
          'formData.title': 'input.title',
          'formData.notes': [
            'input.body.content',
            { key: 'input.body.contentType', transform: toTextBodyContentType, default: undefined },
          ],
          'formData.importance': 'input.importance',
          'formData.status': 'input.status',
          'formData.dueDateTime': 'input.dueDateTime.dateTime',
          'formData.dueTimeZone': 'input.dueDateTime.timeZone',
        },
      },
      edit: {
        name: 'azureUpdateTodoTask',
        text: `mutation AzureUpdateTodoTask(
          $listId: String!
          $taskId: String!
          $input: AzureTodoTaskUpdateInput!
        ) {
          azureUpdateTodoTask(listId: $listId, taskId: $taskId, input: $input) {
            id
            title
            status
            importance
          }
        }`,
        variables: {
          'formData.listId': 'listId',
          'formData.taskId': 'taskId',
          'formData.title': 'input.title',
          'formData.notes': [
            'input.body.content',
            { key: 'input.body.contentType', transform: toTextBodyContentType, default: undefined },
          ],
          'formData.importance': 'input.importance',
          'formData.status': 'input.status',
          'formData.dueDateTime': 'input.dueDateTime.dateTime',
          'formData.dueTimeZone': 'input.dueDateTime.timeZone',
        },
      },
      delete: {
        name: 'azureDeleteTodoTask',
        text: `mutation AzureDeleteTodoTask($listId: String!, $taskId: String!) {
          azureDeleteTodoTask(listId: $listId, taskId: $taskId)
        }`,
        variables: {
          'formData.listId': 'listId',
          'formData.taskId': 'taskId',
        },
      },
    },
  },
};

export default AzureTodoManagerForm;

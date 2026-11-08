/**
 * Microsoft To Do domain types (AZ-06).
 *
 * These mirror the **v1.0** Microsoft Graph `todoTaskList`, `todoTask` and
 * `checklistItem` resources returned by `/me/todo/lists`,
 * `/me/todo/lists/{id}/tasks` and
 * `/me/todo/lists/{id}/tasks/{id}/checklistItems`.
 *
 * There is deliberately **no `assignedTo`** anywhere in this file. A To Do task
 * has no assignee - sharing a list shares the whole list, and per-item
 * assignment is a Planner concept (`/planner/tasks` with `assignments`). See
 * `services/AzureTodoService.ts`, whose class JSDoc repeats the rule.
 *
 * Date/time values follow Graph's `dateTimeTimeZone` shape: `dateTime` is an
 * ISO 8601 wall-clock value **without** an offset, and `timeZone` names the zone
 * it belongs to. Never treat `dateTime` alone as UTC.
 */

/** To Do task lifecycle status - the exact strings Graph accepts. */
export type AzureTodoTaskStatus =
  | 'notStarted'
  | 'inProgress'
  | 'completed'
  | 'waitingOnOthers'
  | 'deferred';

/** The only values Graph accepts for `todoTask.status`, in schema order. */
export const AZURE_TODO_TASK_STATUSES: readonly AzureTodoTaskStatus[] = [
  'notStarted',
  'inProgress',
  'completed',
  'waitingOnOthers',
  'deferred',
];

/** To Do task importance. */
export type AzureTodoTaskImportance = 'low' | 'normal' | 'high';

/** The only values Graph accepts for `todoTask.importance`. */
export const AZURE_TODO_TASK_IMPORTANCES: readonly AzureTodoTaskImportance[] = ['low', 'normal', 'high'];

/** Body content type of a task body / checklist item display name rendering. */
export type AzureTodoBodyContentType = 'text' | 'html';

/** The `dateTimeTimeZone` complex type shared by every To Do date property. */
export interface IAzureDateTimeTimeZone {
  /** ISO 8601 wall-clock value, *without* an offset (for example `2026-11-09T17:30:00.0000000`). */
  dateTime: string;
  /** Windows time zone name, for example `South Africa Standard Time`. */
  timeZone: string;
}

/** A task body: `content` plus how it should be rendered. */
export interface IAzureItemBody {
  content: string;
  contentType?: AzureTodoBodyContentType | string;
}

/** Recurrence pattern of a recurring task. */
export interface IAzureRecurrencePattern {
  type: string;
  interval: number;
  month?: number;
  dayOfMonth?: number;
  daysOfWeek?: string[];
  firstDayOfWeek?: string;
  index?: string;
}

/** Recurrence range of a recurring task. */
export interface IAzureRecurrenceRange {
  type: string;
  startDate: string;
  endDate?: string;
  numberOfOccurrences?: number;
  recurrenceTimeZone?: string;
}

/** The `patternedRecurrence` complex type used by `todoTask.recurrence`. */
export interface IAzurePatternedRecurrence {
  pattern: IAzureRecurrencePattern;
  range: IAzureRecurrenceRange;
}

/** A single checklist item on a task. */
export interface IAzureTodoChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

/** A linked resource attached to a task (a URL plus optional app metadata). */
export interface IAzureLinkedResource {
  id?: string;
  webUrl?: string;
  applicationName?: string;
  displayName?: string;
  externalId?: string;
}

/** A Microsoft To Do task list (`/me/todo/lists/{id}`). */
export interface IAzureTodoTaskList {
  id: string;
  displayName: string;
  /** `none`, `defaultList` or `flaggedEmails`. */
  wellknownListName?: string;
  isOwner?: boolean;
  isShared?: boolean;
}

/**
 * A Microsoft To Do task (`/me/todo/lists/{id}/tasks/{id}`).
 *
 * Note the absence of an assignee: To Do models *shared lists*, not assigned
 * tasks. Assignment lives in Planner.
 */
export interface IAzureTodoTask {
  id: string;
  title?: string;
  body?: IAzureItemBody;
  importance?: AzureTodoTaskImportance | string;
  status?: AzureTodoTaskStatus | string;
  dueDateTime?: IAzureDateTimeTimeZone | null;
  startDateTime?: IAzureDateTimeTimeZone | null;
  reminderDateTime?: IAzureDateTimeTimeZone | null;
  isReminderOn?: boolean;
  recurrence?: IAzurePatternedRecurrence | null;
  categories?: string[];
  checklistItems?: IAzureTodoChecklistItem[];
  linkedResources?: IAzureLinkedResource[];
  completedDateTime?: IAzureDateTimeTimeZone | null;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  bodyLastModifiedDateTime?: string;
  hasAttachments?: boolean;
}

/** Fields a caller may set on a new task list. */
export interface IAzureTodoTaskListInput {
  displayName: string;
}

/** Fields a caller may change on an existing task list. */
export interface IAzureTodoTaskListUpdateInput {
  displayName: string;
}

/** Fields a caller may set on a new task. */
export interface IAzureTodoTaskCreateInput {
  title: string;
  body?: IAzureItemBody;
  importance?: AzureTodoTaskImportance;
  status?: AzureTodoTaskStatus;
  dueDateTime?: IAzureDateTimeTimeZone;
  startDateTime?: IAzureDateTimeTimeZone;
  reminderDateTime?: IAzureDateTimeTimeZone;
  isReminderOn?: boolean;
  recurrence?: IAzurePatternedRecurrence;
  categories?: string[];
  checklistItems?: IAzureChecklistItemInput[];
  linkedResources?: IAzureLinkedResource[];
}

/**
 * Fields a caller may change on an existing task.
 *
 * A PATCH is sparse: only defined properties are sent to Graph. `assignedTo`,
 * `assignee` and `assignments` are absent by design and are **rejected** at
 * runtime rather than silently dropped - see `AzureTodoService`.
 */
export interface IAzureTodoTaskUpdateInput {
  title?: string;
  body?: IAzureItemBody;
  importance?: AzureTodoTaskImportance;
  status?: AzureTodoTaskStatus;
  dueDateTime?: IAzureDateTimeTimeZone | null;
  startDateTime?: IAzureDateTimeTimeZone | null;
  reminderDateTime?: IAzureDateTimeTimeZone | null;
  isReminderOn?: boolean;
  recurrence?: IAzurePatternedRecurrence | null;
  categories?: string[];
  checklistItems?: IAzureChecklistItemInput[];
  linkedResources?: IAzureLinkedResource[];
}

/** A checklist item supplied inline on a task create/update. */
export interface IAzureChecklistItemInput {
  displayName: string;
  isChecked?: boolean;
}

/** A checklist item PATCH body. */
export interface IAzureChecklistItemUpdateInput {
  displayName?: string;
  isChecked?: boolean;
}

/**
 * Client-side query options for `listTasks`.
 *
 * ### Why these filters are applied in this module, not by Graph
 *
 * The v1.0 `todoTask: list` reference
 * (`/me/todo/lists/{todoTaskListId}/tasks`) documents its query support as
 * little more than *"This method supports some of the OData query parameters to
 * help customize the response"* and publishes **no** list of `$filter`-able
 * properties. `dueDateTime` - the property every "tasks due this week" view
 * needs - is not documented as filterable at all, and the only `$filter` usage
 * the `todoTask` resource page mentions is filtering on single-value extended
 * properties via `$expand`.
 *
 * Sending an undocumented `$filter` therefore either 400s or silently returns
 * the wrong rows. Both outcomes are worse than doing the work here, so
 * `AzureTodoService.listTasks` reads the list (paging with `@odata.nextLink`)
 * and applies status / importance / due-date selection itself. `top` and `skip`
 * are applied after filtering for the same reason.
 */
export interface IAzureTodoTaskQueryOptions {
  /** Exact `status` match. An unknown value is rejected client-side. */
  status?: AzureTodoTaskStatus;
  /** Exact `importance` match. An unknown value is rejected client-side. */
  importance?: AzureTodoTaskImportance;
  /**
   * Keep tasks whose `dueDateTime` is at or before this instant (ISO 8601).
   * Compared client-side; see {@link IAzureTodoTaskQueryOptions}.
   */
  dueBefore?: string;
  /**
   * Keep tasks whose `dueDateTime` is at or after this instant (ISO 8601).
   * Compared client-side; see {@link IAzureTodoTaskQueryOptions}.
   */
  dueAfter?: string;
  /**
   * `false` drops tasks whose status is `completed` and has no other effect.
   * Omitted (the default) returns every task the list holds.
   */
  includeCompleted?: boolean;
  /** Page size, applied after filtering. */
  top?: number;
  /** Offset, applied after filtering. */
  skip?: number;
}

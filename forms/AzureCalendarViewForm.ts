import Reactory from '@reactorynet/reactory-core';
import { fieldLabel, formLabel } from './i18n';

/**
 * The calendar window view — `azureCalendarView(start, end, ...)`.
 *
 * `azureCalendarView`, **not** `azureCalendarEvents`: `/me/events` returns
 * recurrence masters, so a weekly stand-up appears once and the 51 occurrences
 * that fall inside the window never do. `/me/calendarView` expands recurrences
 * and is the only correct read for a ranged view.
 *
 * THE GRID OWNS ITS OWN FETCH — THIS IS THE LIST PAYLOAD PATH
 * ----------------------------------------------------------
 * `azureCalendarView` returns `[AzureCalendarEvent!]!`, and the form-level data
 * manager shapes `data.data[query.name]` by `schema.type` — with
 * `schema.type === 'object'` a list is spread into `{"0": …}` and reaches no
 * declared property. An earlier revision concluded from that alone that a list
 * could not be displayed and filed it as needing client support. **That was
 * wrong**, and the correction matters:
 *
 * `MaterialTableWidget` with `ui:options.remoteData: true` runs its *own*
 * `getData()` on mount (MaterialTableWidget.tsx, the effect that returns early
 * unless `remoteData === true`), maps its variables from
 * `{ formContext, query, props }`, wraps an **array** root field as
 * `{ data: rawResultData }` and renders `data.data`. It never goes through
 * `transformData`, so `schema.type` does not constrain it. Two shipped client
 * forms already use this mode (`myCommentsForm`, `content-management`).
 *
 * Consequences for this definition:
 *
 *   * the query lives under `graphql.queries.calendarView` and the widget names it
 *     with `ui:options.query` — the shipped pattern. There is deliberately no
 *     `graphql.query`, so the form-level manager issues no duplicate request and
 *     writes no numeric keys into the form data;
 *   * `ui:options.variables` is rooted at `formContext.formData` (populated by
 *     `useFormContext`), because the widget's mapper source is
 *     `{ formContext, query, props }` — **not** `formData`. That is how the
 *     window and the calendar id the user picks reach the four date/time parts;
 *   * `events` is a declared array property, so the schema stays
 *     `type: 'object'` and every acceptance criterion is unaffected.
 *
 * KNOWN LIMITATION, NARROWER THAN THE LAST REVISION CLAIMED: a list payload is
 * displayable **only** through a `remoteData` grid. A client that renders this
 * form without `MaterialTableWidget` (e.g. the v5 form engine) will not show the
 * events. That is a renderer constraint, not a missing capability.
 */
const AzureCalendarViewForm: Reactory.Forms.IReactoryForm = {
  id: 'azure.AzureCalendarViewForm@1.0.0',
  nameSpace: 'azure',
  name: 'AzureCalendarViewForm',
  version: '1.0.0',
  title: formLabel('calendarView', 'title'),
  description: formLabel('calendarView', 'description'),
  schema: {
    type: 'object',
    title: formLabel('calendarView', 'schemaTitle'),
    required: ['startDateTime', 'startTimeZone', 'endDateTime', 'endTimeZone'],
    properties: {
      events: {
        type: 'array',
        title: fieldLabel('calendarView', 'events'),
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            start: {
              type: 'object',
              properties: {
                dateTime: { type: 'string' },
                timeZone: { type: 'string' },
              },
            },
            end: {
              type: 'object',
              properties: {
                dateTime: { type: 'string' },
                timeZone: { type: 'string' },
              },
            },
            location: {
              type: 'object',
              properties: {
                displayName: { type: 'string' },
              },
            },
            isAllDay: { type: 'boolean' },
            isCancelled: { type: 'boolean' },
            type: { type: 'string' },
          },
        },
      },
      calendarId: {
        type: 'string',
        title: fieldLabel('calendarView', 'calendarId'),
      },
      startDateTime: {
        type: 'string',
        format: 'date-time',
        title: fieldLabel('calendarView', 'startDateTime'),
      },
      startTimeZone: {
        type: 'string',
        title: fieldLabel('calendarView', 'startTimeZone'),
      },
      endDateTime: {
        type: 'string',
        format: 'date-time',
        title: fieldLabel('calendarView', 'endDateTime'),
      },
      endTimeZone: {
        type: 'string',
        title: fieldLabel('calendarView', 'endTimeZone'),
      },
      orderBy: {
        type: 'string',
        title: fieldLabel('calendarView', 'orderBy'),
        default: 'start/dateTime',
      },
      top: {
        type: 'number',
        title: fieldLabel('calendarView', 'top'),
        default: 50,
      },
    },
  },
  uiSchema: {
    events: {
      'ui:title': null,
      'ui:widget': 'MaterialTableWidget',
      'ui:options': {
        // The grid fetches `graphql.queries.calendarView` itself and pages the
        // array client-side; see the header for why this is the list path.
        remoteData: true,
        query: 'calendarView',
        showLabel: false,
        allowAdd: false,
        allowDelete: false,
        search: false,
        columns: [
          { title: formLabel('calendarView', 'columns', 'subject'), field: 'subject', width: 280 },
          { title: formLabel('calendarView', 'columns', 'start'), field: 'start.dateTime', width: 190 },
          { title: formLabel('calendarView', 'columns', 'end'), field: 'end.dateTime', width: 190 },
          {
            title: formLabel('calendarView', 'columns', 'location'),
            field: 'location.displayName',
            width: 170,
          },
          { title: formLabel('calendarView', 'columns', 'isAllDay'), field: 'isAllDay', width: 100 },
        ],
        // Rooted at `formContext.formData`: the widget maps from
        // `{ formContext, query, props }`, so a `formData.…` source would resolve
        // nothing here.
        variables: {
          'formContext.formData.startDateTime': 'start.dateTime',
          'formContext.formData.startTimeZone': 'start.timeZone',
          'formContext.formData.endDateTime': 'end.dateTime',
          'formContext.formData.endTimeZone': 'end.timeZone',
          'formContext.formData.calendarId': 'calendarId',
          'formContext.formData.orderBy': 'orderBy',
          'formContext.formData.top': 'top',
        },
      },
    },
    calendarId: { 'ui:widget': 'text' },
    startDateTime: { 'ui:widget': 'DateTimeWidget' },
    endDateTime: { 'ui:widget': 'DateTimeWidget' },
    startTimeZone: {
      'ui:widget': 'text',
      'ui:help': formLabel('calendarView', 'help', 'timeZone'),
    },
    endTimeZone: {
      'ui:widget': 'text',
      'ui:help': formLabel('calendarView', 'help', 'timeZone'),
    },
    orderBy: { 'ui:widget': 'text' },
    top: { 'ui:widget': 'updown' },
  },
  roles: ['USER'],
  registerAsComponent: true,
  uiSupport: ['material'],
  graphql: {
    queries: {
      calendarView: {
        name: 'azureCalendarView',
        text: `query AzureCalendarView(
          $start: AzureCalendarDateTimeTimeZoneInput!
          $end: AzureCalendarDateTimeTimeZoneInput!
          $calendarId: String
          $orderBy: String
          $top: Int
        ) {
          azureCalendarView(
            start: $start
            end: $end
            calendarId: $calendarId
            orderBy: $orderBy
            top: $top
          ) {
            id
            subject
            bodyPreview
            start {
              dateTime
              timeZone
            }
            end {
              dateTime
              timeZone
            }
            location {
              displayName
            }
            isAllDay
            isCancelled
            isOnlineMeeting
            type
            responseStatus {
              response
            }
            organizer {
              emailAddress {
                name
                address
              }
            }
            webLink
          }
        }`,
        // Used only by the form-level data manager (there is no `graphql.query`
        // here), and validated by the suite so the two paths cannot drift.
        variables: {
          'formData.startDateTime': 'start.dateTime',
          'formData.startTimeZone': 'start.timeZone',
          'formData.endDateTime': 'end.dateTime',
          'formData.endTimeZone': 'end.timeZone',
          'formData.calendarId': 'calendarId',
          'formData.orderBy': 'orderBy',
          'formData.top': 'top',
        },
      },
    },
  },
};

export default AzureCalendarViewForm;

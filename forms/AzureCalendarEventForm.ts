import Reactory from '@reactorynet/reactory-core';
import { enumLabel, fieldLabel, formLabel } from './i18n';
import { toAttendees, toTextBodyContentType } from './transforms';

/**
 * Create, update and delete one calendar event.
 *
 * `AzureCalendarEventInput` is the target of all three writes:
 *
 *   start / end:  { dateTime, timeZone }      not startDateTime / startTimeZone
 *   body:         { contentType, content }    not bodyContent
 *   location:     { displayName }             not a bare string
 *   attendees:    [{ emailAddress: { address }, type }]  not ['a@b.c']
 *
 * so each write maps field by field, with nested targets and two value-shape
 * transforms. Forwarding the whole `formData` as `$input` would submit six
 * unknown fields and Graph rejects unknown input-object fields.
 *
 * `azureUpdateEvent` takes `eventId` **and** `input`; both are `AzureCalendarEventInput`'s
 * sibling argument and the event's identity respectively, so the map declares
 * both rather than nesting the id inside the input.
 */
const AzureCalendarEventForm: Reactory.Forms.IReactoryForm = {
  id: 'azure.AzureCalendarEventForm@1.0.0',
  nameSpace: 'azure',
  name: 'AzureCalendarEventForm',
  version: '1.0.0',
  title: formLabel('calendarEvent', 'title'),
  description: formLabel('calendarEvent', 'description'),
  schema: {
    type: 'object',
    title: formLabel('calendarEvent', 'schemaTitle'),
    required: ['subject', 'startDateTime', 'startTimeZone', 'endDateTime', 'endTimeZone'],
    properties: {
      eventId: {
        type: 'string',
        title: fieldLabel('calendarEvent', 'eventId'),
      },
      subject: {
        type: 'string',
        title: fieldLabel('calendarEvent', 'subject'),
      },
      bodyContent: {
        type: 'string',
        title: fieldLabel('calendarEvent', 'bodyContent'),
      },
      startDateTime: {
        type: 'string',
        format: 'date-time',
        title: fieldLabel('calendarEvent', 'startDateTime'),
      },
      startTimeZone: {
        type: 'string',
        title: fieldLabel('calendarEvent', 'startTimeZone'),
      },
      endDateTime: {
        type: 'string',
        format: 'date-time',
        title: fieldLabel('calendarEvent', 'endDateTime'),
      },
      endTimeZone: {
        type: 'string',
        title: fieldLabel('calendarEvent', 'endTimeZone'),
      },
      location: {
        type: 'string',
        title: fieldLabel('calendarEvent', 'location'),
      },
      attendeeEmails: {
        type: 'array',
        title: fieldLabel('calendarEvent', 'attendeeEmails'),
        items: { type: 'string', format: 'email' },
      },
      isAllDay: {
        type: 'boolean',
        title: fieldLabel('calendarEvent', 'isAllDay'),
        default: false,
      },
      isOnlineMeeting: {
        type: 'boolean',
        title: fieldLabel('calendarEvent', 'isOnlineMeeting'),
        default: false,
      },
      showAs: {
        type: 'string',
        title: fieldLabel('calendarEvent', 'showAs'),
        enum: ['free', 'tentative', 'busy', 'oof', 'workingElsewhere'],
        enumNames: [
          enumLabel('calendarEvent', 'showAs', 'free'),
          enumLabel('calendarEvent', 'showAs', 'tentative'),
          enumLabel('calendarEvent', 'showAs', 'busy'),
          enumLabel('calendarEvent', 'showAs', 'oof'),
          enumLabel('calendarEvent', 'showAs', 'workingElsewhere'),
        ],
        default: 'busy',
      },
      reminderMinutesBeforeStart: {
        type: 'number',
        title: fieldLabel('calendarEvent', 'reminderMinutesBeforeStart'),
        default: 15,
      },
    },
  },
  uiSchema: {
    eventId: { 'ui:widget': 'text' },
    bodyContent: { 'ui:widget': 'textarea', 'ui:options': { rows: 10 } },
    startDateTime: { 'ui:widget': 'DateTimeWidget' },
    endDateTime: { 'ui:widget': 'DateTimeWidget' },
    startTimeZone: {
      'ui:widget': 'text',
      'ui:help': formLabel('calendarEvent', 'help', 'timeZone'),
    },
    endTimeZone: {
      'ui:widget': 'text',
      'ui:help': formLabel('calendarEvent', 'help', 'timeZone'),
    },
    attendeeEmails: { 'ui:widget': 'tags' },
    isAllDay: { 'ui:widget': 'checkbox' },
    isOnlineMeeting: { 'ui:widget': 'checkbox' },
    showAs: { 'ui:widget': 'select' },
    reminderMinutesBeforeStart: { 'ui:widget': 'updown' },
  },
  roles: ['USER'],
  registerAsComponent: true,
  uiSupport: ['material'],
  graphql: {
    query: {
      name: 'azureCalendarEvent',
      text: `query AzureCalendarEvent($eventId: String!) {
        azureCalendarEvent(eventId: $eventId) {
          id
          subject
          body {
            contentType
            content
          }
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
          attendees {
            type
            emailAddress {
              name
              address
            }
            status {
              response
              time
            }
          }
          isAllDay
          isCancelled
          isOnlineMeeting
          onlineMeetingProvider
          onlineMeeting {
            joinUrl
          }
          recurrence {
            pattern {
              type
              interval
              daysOfWeek
            }
            range {
              type
              startDate
              endDate
            }
          }
          responseStatus {
            response
            time
          }
          showAs
          importance
          sensitivity
          reminderMinutesBeforeStart
          isReminderOn
          categories
          webLink
        }
      }`,
      variables: { 'formData.eventId': 'eventId' },
      // The read payload is an `AzureCalendarEvent`; the form edits its fields.
      // Without this map the object spreads onto Graph names (`body`, `start`,
      // `location`, `id`) that no property declares, so a loaded event renders
      // nothing. Dotted keys walk into the nested dateTime-timeZone and body
      // objects. `attendees` is deliberately not mapped: it arrives as
      // `[{ emailAddress: { address } }]` while the form edits `attendeeEmails`
      // as bare strings, and reshaping one into the other on read would feed
      // objects back into the write transform.
      resultMap: {
        id: 'eventId',
        subject: 'subject',
        'body.content': 'bodyContent',
        'start.dateTime': 'startDateTime',
        'start.timeZone': 'startTimeZone',
        'end.dateTime': 'endDateTime',
        'end.timeZone': 'endTimeZone',
        'location.displayName': 'location',
        isAllDay: 'isAllDay',
        isOnlineMeeting: 'isOnlineMeeting',
        showAs: 'showAs',
        reminderMinutesBeforeStart: 'reminderMinutesBeforeStart',
      },
    },
    mutation: {
      new: {
        name: 'azureCreateEvent',
        text: `mutation AzureCreateEvent($input: AzureCalendarEventInput!) {
          azureCreateEvent(input: $input) {
            id
            subject
            webLink
            start {
              dateTime
              timeZone
            }
            end {
              dateTime
              timeZone
            }
          }
        }`,
        variables: {
          'formData.subject': 'input.subject',
          'formData.bodyContent': [
            'input.body.content',
            { key: 'input.body.contentType', transform: toTextBodyContentType, default: undefined },
          ],
          'formData.startDateTime': 'input.start.dateTime',
          'formData.startTimeZone': 'input.start.timeZone',
          'formData.endDateTime': 'input.end.dateTime',
          'formData.endTimeZone': 'input.end.timeZone',
          'formData.location': 'input.location.displayName',
          'formData.attendeeEmails': [{ key: 'input.attendees', transform: toAttendees, default: undefined }],
          'formData.isAllDay': 'input.isAllDay',
          'formData.isOnlineMeeting': 'input.isOnlineMeeting',
          'formData.showAs': 'input.showAs',
          'formData.reminderMinutesBeforeStart': 'input.reminderMinutesBeforeStart',
        },
      },
      edit: {
        name: 'azureUpdateEvent',
        text: `mutation AzureUpdateEvent($eventId: String!, $input: AzureCalendarEventInput!) {
          azureUpdateEvent(eventId: $eventId, input: $input) {
            id
            subject
            webLink
          }
        }`,
        variables: {
          'formData.eventId': 'eventId',
          'formData.subject': 'input.subject',
          'formData.bodyContent': [
            'input.body.content',
            { key: 'input.body.contentType', transform: toTextBodyContentType, default: undefined },
          ],
          'formData.startDateTime': 'input.start.dateTime',
          'formData.startTimeZone': 'input.start.timeZone',
          'formData.endDateTime': 'input.end.dateTime',
          'formData.endTimeZone': 'input.end.timeZone',
          'formData.location': 'input.location.displayName',
          'formData.attendeeEmails': [{ key: 'input.attendees', transform: toAttendees, default: undefined }],
          'formData.isAllDay': 'input.isAllDay',
          'formData.isOnlineMeeting': 'input.isOnlineMeeting',
          'formData.showAs': 'input.showAs',
          'formData.reminderMinutesBeforeStart': 'input.reminderMinutesBeforeStart',
        },
      },
      delete: {
        name: 'azureDeleteEvent',
        text: `mutation AzureDeleteEvent($eventId: String!) {
          azureDeleteEvent(eventId: $eventId)
        }`,
        variables: { 'formData.eventId': 'eventId' },
      },
    },
  },
};

export default AzureCalendarEventForm;

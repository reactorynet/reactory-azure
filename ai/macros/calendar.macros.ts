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
  optionalBoolean,
  optionalNumber,
  optionalString,
  userIdFrom,
} from './macro-support';

/**
 * Calendar macros (AZ-13): `azure_create_event` and `azure_list_events`.
 *
 * Both resolve `azure.AzureCalendarService@1.0.0` from the chat context.
 *
 * Dates are exchanged as Graph `dateTimeTimeZone` objects, never as bare ISO
 * strings: a bare string is interpreted in an unspecified zone, which is exactly
 * the ambiguity that makes an assistant book a meeting an hour wrong. The macro
 * takes the wall-clock `dateTime` plus an explicit `timeZone` and sends both.
 *
 * `azure_list_events` mirrors the service's range rule: a range needs both ends,
 * because a half-specified range is rejected by the service rather than degraded
 * into an unbounded read. The macro says so in words the model can act on.
 */

const CREATE_TOOL = 'azure_create_event';
const LIST_TOOL = 'azure_list_events';

/** The subset of an event an assistant needs to confirm or summarise it. */
const summariseEvent = (event: any) => ({
  id: event?.id,
  subject: event?.subject,
  start: event?.start,
  end: event?.end,
  isAllDay: event?.isAllDay,
  isCancelled: event?.isCancelled,
  location: event?.location?.displayName,
  organizer: event?.organizer?.emailAddress,
  isOnlineMeeting: event?.isOnlineMeeting,
  joinUrl: event?.onlineMeeting?.joinUrl ?? null,
  webLink: event?.webLink,
  bodyPreview: event?.bodyPreview,
  showAs: event?.showAs,
});

const CreateEvent = async (params: any, state: ChatState) => {
  const { context } = state;

  const userId = userIdFrom(context);
  if (!userId) {
    return fail(
      CREATE_TOOL,
      params,
      'No authenticated user in context',
      'Events are created in the signed-in user\'s calendar; a user is required.',
    );
  }

  const calendarService = context?.getService('azure.AzureCalendarService@1.0.0') as any;
  if (!calendarService) {
    return notConnected(CREATE_TOOL, params, 'AzureCalendarService is not registered');
  }

  const subject = optionalString(params?.subject);
  if (!subject) {
    return fail(CREATE_TOOL, params, '"subject" is required and must not be empty');
  }

  const start = optionalString(params?.start);
  const end = optionalString(params?.end);

  if (!start || !end) {
    return fail(
      CREATE_TOOL,
      params,
      'Both "start" and "end" are required',
      'Pass each as an ISO 8601 wall-clock value (for example 2026-11-09T10:00:00) together '
        + 'with "timeZone" (for example "South Africa Standard Time").',
    );
  }

  const timeZone = optionalString(params?.timeZone) || DEFAULT_CALENDAR_TIME_ZONE;
  const bodyText = optionalString(params?.body);
  const location = optionalString(params?.location);
  const attendees = asStringArray(params?.attendees);
  const isOnlineMeeting = optionalBoolean(params?.isOnlineMeeting) === true;

  const input = compactObject({
    calendarId: optionalString(params?.calendarId),
    subject,
    body: bodyText
      ? {
        contentType: optionalString(params?.bodyContentType) === 'html' ? 'html' : 'text',
        content: bodyText,
      }
      : undefined,
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
    location: location ? { displayName: location } : undefined,
    attendees: attendees.length > 0
      ? attendees.map((address) => ({ emailAddress: { address }, type: 'required' }))
      : undefined,
    isOnlineMeeting: isOnlineMeeting ? true : undefined,
  });

  try {
    const event = await calendarService.createEvent(userId, input);

    return ok(
      CREATE_TOOL,
      params,
      summariseEvent(event),
      `Event created: ${event?.subject || subject}`,
    );
  } catch (error) {
    return macroFailure(CREATE_TOOL, params, error);
  }
};

const ListEvents = async (params: any, state: ChatState) => {
  const { context } = state;

  const userId = userIdFrom(context);
  if (!userId) {
    return fail(LIST_TOOL, params, 'No authenticated user in context');
  }

  const calendarService = context?.getService('azure.AzureCalendarService@1.0.0') as any;
  if (!calendarService) {
    return notConnected(LIST_TOOL, params, 'AzureCalendarService is not registered');
  }

  const start = optionalString(params?.start);
  const end = optionalString(params?.end);

  if ((start && !end) || (!start && end)) {
    return fail(
      LIST_TOOL,
      params,
      'A date range needs both "start" and "end"',
      'Supply both ends of the window, or neither. One end alone would silently read an '
        + 'unbounded calendar.',
    );
  }

  const timeZone = optionalString(params?.timeZone) || DEFAULT_CALENDAR_TIME_ZONE;
  const top = Math.min(Math.max(Math.trunc(optionalNumber(params?.top) ?? 20), 1), 100);

  const options = compactObject({
    start: start ? { dateTime: start, timeZone } : undefined,
    end: end ? { dateTime: end, timeZone } : undefined,
    calendarId: optionalString(params?.calendarId),
    top,
  });

  try {
    const events = await calendarService.listEvents(userId, options);
    const items = (Array.isArray(events) ? events : []).map(summariseEvent);

    return ok(
      LIST_TOOL,
      params,
      {
        count: items.length,
        items,
        range: start && end ? { start, end, timeZone } : undefined,
      },
      `Found ${items.length} event(s)`,
    );
  } catch (error) {
    return macroFailure(LIST_TOOL, params, error);
  }
};

const CreateEventMacro: MacroComponentDefinition<typeof CreateEvent> = {
  nameSpace: AZURE_NS,
  name: CREATE_TOOL,
  version: AZURE_VERSION,
  component: CreateEvent,
  description: 'Create an event in the connected user\'s Outlook calendar',
  alias: CREATE_TOOL,
  runat: 'server',
  icon: 'event',
  roles: ROLE_SET,
  tags: ['azure', 'calendar', 'outlook', 'event', 'meeting', 'create'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      runat: 'server',
      function: {
        name: CREATE_TOOL,
        icon: 'event',
        description:
          'Create a calendar event as the connected Microsoft 365 user. Start and end are '
          + 'wall-clock ISO values interpreted in "timeZone". Optionally invite attendees and '
          + 'create a Teams meeting link. Returns the created event.',
        parameters: buildParameters([
          {
            name: 'subject',
            type: 'string',
            required: true,
            description: 'Event title, shown in the invite and on the calendar.',
          },
          {
            name: 'start',
            type: 'string',
            required: true,
            description:
              'Start as an ISO 8601 wall-clock date/time, for example 2026-11-09T10:00:00. '
              + 'Interpreted in "timeZone".',
          },
          {
            name: 'end',
            type: 'string',
            required: true,
            description:
              'End as an ISO 8601 wall-clock date/time in the same zone as "start". Must be '
              + 'after the start.',
          },
          {
            name: 'timeZone',
            type: 'string',
            required: false,
            default: DEFAULT_CALENDAR_TIME_ZONE,
            description:
              'Windows time zone name used for both ends, for example "South Africa Standard '
              + `Time" or "UTC". Defaults to "${DEFAULT_CALENDAR_TIME_ZONE}".`,
          },
          {
            name: 'body',
            type: 'string',
            required: false,
            description: 'Optional event description or agenda.',
          },
          {
            name: 'bodyContentType',
            type: 'string',
            required: false,
            enum: ['text', 'html'],
            default: 'text',
            description: 'How "body" should be rendered. Defaults to "text".',
          },
          {
            name: 'location',
            type: 'string',
            required: false,
            description: 'Optional free-text location, for example a room name or address.',
          },
          {
            name: 'attendees',
            type: 'array',
            required: false,
            items: { type: 'string' },
            description:
              'Optional attendee SMTP addresses. Each is invited as a required attendee.',
          },
          {
            name: 'isOnlineMeeting',
            type: 'boolean',
            required: false,
            default: false,
            description:
              'When true, Graph creates a Teams meeting and returns the join link. Defaults '
              + 'to false.',
          },
          {
            name: 'calendarId',
            type: 'string',
            required: false,
            description:
              'Optional calendar id. When omitted the event is created in the user\'s default '
              + 'calendar.',
          },
        ]),
      },
    },
  ],
};

const ListEventsMacro: MacroComponentDefinition<typeof ListEvents> = {
  nameSpace: AZURE_NS,
  name: LIST_TOOL,
  version: AZURE_VERSION,
  component: ListEvents,
  description: 'List events from the connected user\'s Outlook calendar',
  alias: LIST_TOOL,
  runat: 'server',
  icon: 'calendar_month',
  roles: ROLE_SET,
  tags: ['azure', 'calendar', 'outlook', 'events', 'schedule', 'read'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      runat: 'server',
      safeForAutoExecution: true,
      function: {
        name: LIST_TOOL,
        icon: 'calendar_month',
        description:
          'List events from the connected user\'s Outlook calendar. Supplying both start and '
          + 'end expands recurring meetings inside that window; supplying neither reads the '
          + 'default event list. Returns event summaries.',
        parameters: buildParameters([
          {
            name: 'start',
            type: 'string',
            required: false,
            description:
              'Window start as an ISO 8601 wall-clock value. Must be supplied together with '
              + '"end".',
          },
          {
            name: 'end',
            type: 'string',
            required: false,
            description:
              'Window end as an ISO 8601 wall-clock value. Must be supplied together with '
              + '"start".',
          },
          {
            name: 'timeZone',
            type: 'string',
            required: false,
            default: DEFAULT_CALENDAR_TIME_ZONE,
            description:
              'Windows time zone name used to interpret a range without an offset. Defaults '
              + `to "${DEFAULT_CALENDAR_TIME_ZONE}".`,
          },
          {
            name: 'calendarId',
            type: 'string',
            required: false,
            description:
              'Optional calendar id. When omitted the user\'s default calendar is read.',
          },
          {
            name: 'top',
            type: 'integer',
            required: false,
            default: 20,
            description: 'Maximum number of events to return, 1-100. Defaults to 20.',
          },
        ]),
      },
    },
  ],
};

export const CALENDAR_MACROS: MacroComponentDefinition<unknown>[] = [CreateEventMacro, ListEventsMacro];

export { CreateEventMacro, ListEventsMacro };
export default CALENDAR_MACROS;

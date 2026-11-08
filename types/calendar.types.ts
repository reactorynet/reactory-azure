/**
 * Calendar domain types (AZ-07).
 *
 * These are the *Graph* shapes, not a simplified projection:
 *
 *   - every date/time that Graph types as `dateTimeTimeZone` is an
 *     {@link ICalendarDateTimeTimeZone} object. It is never flattened to a bare
 *     ISO string, because Graph interprets a bare string in an unspecified zone;
 *   - recurrence is `patternedRecurrence` with an explicit `pattern` and `range`.
 *     It is deliberately NOT modelled as Google's `recurrence: string[]`, which
 *     cannot express `firstDayOfWeek`, `index` or `recurrenceTimeZone`.
 *
 * Every exported name is prefixed (`ICalendar*`, `IAzureCalendar*`,
 * `Calendar*`) because `types/index.ts` re-exports every domain file with
 * `export *` and the other domains are written by parallel tickets.
 */

/**
 * The zone Graph is given when a caller supplies a bare string or a Date.
 *
 * Matches the module's historical default in `services/graph.ts` so a caller
 * migrating from the legacy shim does not silently change zones.
 */
export const DEFAULT_CALENDAR_TIME_ZONE = 'South Africa Standard Time';

/** Seconds `listCalendars` serves a cached page before re-reading Graph. */
export const CALENDAR_LIST_CACHE_TTL_SECONDS = 300;

/** A Graph `dateTimeTimeZone`. `dateTime` is zone-local, not an instant. */
export interface ICalendarDateTimeTimeZone {
  /**
   * An ISO 8601 date/time. Graph accepts a `Z`/offset suffix here, but omits it
   * on responses when `timeZone` is populated - callers must not assume either.
   */
  dateTime: string;
  /** Windows or IANA zone name, e.g. `South Africa Standard Time`. */
  timeZone: string;
}

/**
 * Anything this module accepts where Graph wants a `dateTimeTimeZone`.
 *
 * A `Date` is an absolute instant and is sent as UTC; a string without an
 * offset is interpreted in the supplied/default zone. Only the object form is
 * ever serialised into a request body.
 */
export type CalendarDateTimeInput = ICalendarDateTimeTimeZone | string | Date;

/** Graph `emailAddress`. */
export interface ICalendarEmailAddress {
  name?: string;
  address: string;
}

/** Graph `recipient` / `attendeeBase`. */
export interface ICalendarRecipient {
  emailAddress: ICalendarEmailAddress;
}

/** Graph `attendee`. */
export interface ICalendarAttendee extends ICalendarRecipient {
  type?: 'required' | 'optional' | 'resource' | string;
  status?: ICalendarResponseStatus;
}

/** Graph `responseStatus`. */
export interface ICalendarResponseStatus {
  response?: CalendarResponseType | string;
  time?: string;
}

/** Graph `itemBody`. */
export interface ICalendarEventBody {
  contentType?: 'text' | 'html' | string;
  content?: string;
}

/** Graph `physicalAddress`. */
export interface ICalendarPhysicalAddress {
  street?: string;
  city?: string;
  state?: string;
  countryOrRegion?: string;
  postalCode?: string;
  type?: string;
}

/** Graph `location`. */
export interface ICalendarLocation {
  displayName?: string;
  locationType?: string;
  uniqueId?: string;
  uniqueIdType?: string;
  locationEmailAddress?: string;
  address?: ICalendarPhysicalAddress;
  coordinates?: Record<string, number>;
}

/** Graph `onlineMeeting`. */
export interface ICalendarOnlineMeeting {
  /** The join link Graph created. It is only ever read, never constructed. */
  joinUrl?: string | null;
  /** Legacy/consumer conference id when Graph returns one. */
  conferenceId?: string | null;
  tollNumber?: string | null;
  quickDial?: string | null;
  tollFreeNumbers?: string[];
  dialInUrl?: string | null;
}

export type CalendarRecurrencePatternType =
  | 'daily'
  | 'weekly'
  | 'absoluteMonthly'
  | 'relativeMonthly'
  | 'absoluteYearly'
  | 'relativeYearly';

export type CalendarDayOfWeek =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

export type CalendarRecurrenceRangeType = 'endDate' | 'noEnd' | 'numbered';

/** Graph `recurrencePattern` - the "how often" half of a patterned recurrence. */
export interface ICalendarRecurrencePattern {
  type: CalendarRecurrencePatternType | string;
  /** Gap between occurrences: every N days/weeks/months/years. */
  interval?: number;
  /** Month for `absoluteYearly` / `relativeYearly` (1-12). */
  month?: number;
  /** Day of month for `absoluteMonthly` / `absoluteYearly` (1-31). */
  dayOfMonth?: number;
  /** Days for `weekly` / `relativeWeekly`-style patterns. */
  daysOfWeek?: Array<CalendarDayOfWeek | string>;
  /** Which day starts the week; Graph defaults to `sunday`. */
  firstDayOfWeek?: CalendarDayOfWeek | string;
  /** `first` | `second` | `third` | `fourth` | `last` for relative patterns. */
  index?: string;
}

/** Graph `recurrenceRange` - the "until when" half of a patterned recurrence. */
export interface ICalendarRecurrenceRange {
  type: CalendarRecurrenceRangeType | string;
  /** `YYYY-MM-DD` in `recurrenceTimeZone`. */
  startDate?: string;
  /** `YYYY-MM-DD`; only for `type: endDate`. */
  endDate?: string;
  /** Only for `type: numbered`. */
  numberOfOccurrences?: number;
  /** Zone the `startDate`/`endDate` dates are read in. */
  recurrenceTimeZone?: string;
}

/**
 * Graph `patternedRecurrence`.
 *
 * Kept as a first-class object rather than Google's `recurrence: string[]`: the
 * string form cannot round-trip `firstDayOfWeek`, `index` or
 * `recurrenceTimeZone`, and a recurring master event must survive a read/write
 * cycle unchanged.
 */
export interface ICalendarPatternedRecurrence {
  pattern: ICalendarRecurrencePattern;
  range: ICalendarRecurrenceRange;
}

export type CalendarEventType =
  | 'singleInstance'
  | 'occurrence'
  | 'exception'
  | 'seriesMaster';

export type CalendarResponseType =
  | 'none'
  | 'organizer'
  | 'tentativelyAccepted'
  | 'accepted'
  | 'declined'
  | 'notResponded';

export type CalendarFreeBusyStatus =
  | 'free'
  | 'tentative'
  | 'busy'
  | 'oof'
  | 'workingElsewhere'
  | 'unknown';

export type CalendarOnlineMeetingProvider =
  | 'teamsForBusiness'
  | 'skypeForBusiness'
  | 'skypeForConsumer';

/** Graph `event`. */
export interface ICalendarEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: ICalendarEventBody;
  start: ICalendarDateTimeTimeZone;
  end: ICalendarDateTimeTimeZone;
  originalStartTimeZone?: string;
  originalEndTimeZone?: string;
  location?: ICalendarLocation;
  locations?: ICalendarLocation[];
  organizer?: ICalendarRecipient;
  attendees?: ICalendarAttendee[];
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: CalendarOnlineMeetingProvider | string;
  /** Present only when Graph actually created an online meeting. */
  onlineMeeting?: ICalendarOnlineMeeting | null;
  /** Present on a recurring master (`type: seriesMaster`) and its instances. */
  recurrence?: ICalendarPatternedRecurrence | null;
  seriesMasterId?: string | null;
  type?: CalendarEventType | string;
  responseStatus?: ICalendarResponseStatus;
  webLink?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  iCalUId?: string;
  categories?: string[];
  sensitivity?: string;
  showAs?: CalendarFreeBusyStatus | string;
  importance?: string;
  hasAttachments?: boolean;
  reminderMinutesBeforeStart?: number;
  isReminderOn?: boolean;
  changeKey?: string;
}

/** Graph `calendar`. */
export interface IAzureCalendar {
  id: string;
  name?: string;
  color?: string;
  hexColor?: string;
  changeKey?: string;
  canEdit?: boolean;
  canShare?: boolean;
  canViewPrivateItems?: boolean;
  canEditProperties?: boolean;
  owner?: ICalendarEmailAddress;
  allowedOnlineMeetingProviders?: string[];
  defaultOnlineMeetingProvider?: string;
  isDefaultCalendar?: boolean;
}

/** Options shared by every collection read. */
export interface ICalendarQueryOptions {
  select?: string | string[];
  filter?: string;
  orderBy?: string | string[];
  top?: number;
  skip?: number;
  expand?: string | string[];
  count?: boolean;
}

/** Options for `listCalendars`. */
export interface IListCalendarsOptions {
  select?: string | string[];
  top?: number;
  /** Skip the 5-minute cache and re-read Graph. */
  refresh?: boolean;
}

/** Options for `listEvents` / `listCalendarEvents` / `listCalendarView`. */
export interface IListEventsOptions extends ICalendarQueryOptions {
  /**
   * A range. When supplied, `listEvents` routes to `/me/calendarView` instead of
   * `/me/events` - `/me/events` does not expand recurrences and would silently
   * drop every recurring meeting in the window.
   *
   * A half-specified range is rejected with `InvalidDateRange` before any Graph
   * call; supplying one end must never degrade into an unbounded read.
   */
  start?: CalendarDateTimeInput;
  end?: CalendarDateTimeInput;
  /**
   * Read one calendar instead of the user's flat list.
   *
   * Honoured on both paths - it is never dropped:
   *   - with a range  -> `/me/calendars/{id}/calendarView`;
   *   - without one   -> `/me/calendars/{id}/events` (via `listCalendarEvents`).
   *
   * `listCalendarEvents` also accepts it (as its own argument) and honours a
   * range there too.
   */
  calendarId?: string;
  /** Zone used to interpret a range value that carries no offset. */
  timeZone?: string;
}

/** Options for `getEvent`. */
export interface IGetEventOptions {
  select?: string | string[];
  expand?: string | string[];
}

/** Body accepted by `createEvent` / `updateEvent`. */
export interface ICalendarEventInput {
  /** Applied to the request path, never to the request body. */
  calendarId?: string;
  subject?: string;
  body?: ICalendarEventBody;
  start?: CalendarDateTimeInput;
  end?: CalendarDateTimeInput;
  // NOTE: `originalStartTimeZone` / `originalEndTimeZone` are read-only on
  // Graph's `event` resource. They stay on ICalendarEvent (read) and are absent
  // here, so a client that echoes a fetched event back through create/update
  // cannot make Graph reject the write.
  location?: ICalendarLocation;
  locations?: ICalendarLocation[];
  attendees?: ICalendarAttendeeInput[];
  isAllDay?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: CalendarOnlineMeetingProvider | string;
  recurrence?: ICalendarPatternedRecurrence | null;
  categories?: string[];
  importance?: string;
  sensitivity?: string;
  showAs?: string;
  reminderMinutesBeforeStart?: number;
  isReminderOn?: boolean;
  transactionId?: string;
}

/** A `createEvent` body must carry both ends of the slot. */
export interface ICreateCalendarEventInput extends ICalendarEventInput {
  start: CalendarDateTimeInput;
  end: CalendarDateTimeInput;
}

/** Attendee as accepted on input. */
export interface ICalendarAttendeeInput {
  emailAddress: ICalendarEmailAddress;
  type?: 'required' | 'optional' | 'resource' | string;
}

/** Options for `cancelEvent`. */
export interface ICancelEventOptions {
  /** Shown to attendees as the cancellation reason. Graph calls it `Comment`. */
  comment?: string;
}

/** Options for `acceptEvent` / `declineEvent` / `tentativelyAcceptEvent`. */
export interface IRespondEventOptions {
  comment?: string;
  /** Defaults to `true`, as Graph does. */
  sendResponse?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Availability: /me/calendar/getSchedule                                      */
/* -------------------------------------------------------------------------- */

export interface ICalendarTimeZoneBase {
  name: string;
}

export interface ICalendarWorkingHours {
  daysOfWeek?: string[];
  startTime?: string;
  endTime?: string;
  timeZone?: ICalendarTimeZoneBase;
}

export interface ICalendarFreeBusyError {
  message?: string;
  responseCode?: string;
}

/**
 * One entry of a `getSchedule` response.
 *
 * `availabilityView` is a string of digits - one per `availabilityViewInterval`
 * minutes - where `0` is free, `1` is tentative, `2` is busy, `3` is out of
 * office and `4` is working elsewhere.
 */
export interface ICalendarScheduleInformation {
  scheduleId: string;
  scheduleItems?: ICalendarScheduleItem[];
  availabilityView?: string;
  workingHours?: ICalendarWorkingHours;
  error?: ICalendarFreeBusyError;
}

/**
 * One entry of `scheduleInformation.scheduleItems`.
 *
 * v1.0 `graph.scheduleItem` carries no organizer (only isPrivate, start, end,
 * status, subject, location). An `organizer` field here would always be null and
 * a caller could not tell "no organizer" from "the module cannot read it".
 */
export interface ICalendarScheduleItem {
  isPrivate?: boolean;
  start?: ICalendarDateTimeTimeZone;
  end?: ICalendarDateTimeTimeZone;
  status?: CalendarFreeBusyStatus | string;
  subject?: string;
  location?: string;
}

/* -------------------------------------------------------------------------- */
/* Availability: /me/findMeetingTimes                                          */
/* -------------------------------------------------------------------------- */

export interface ICalendarLocationConstraint {
  isRequired?: boolean;
  suggestLocation?: boolean;
  locations?: ICalendarLocation[];
}

export interface ICalendarTimeSlot {
  start: ICalendarDateTimeTimeZone;
  end: ICalendarDateTimeTimeZone;
}

export interface ICalendarTimeConstraint {
  timeslots: ICalendarTimeSlot[];
  /** `true` renders suggestions as `workHours`; `false` as `free`. */
  activityDomain?: 'unknown' | 'workHours' | 'personal' | string;
}

export interface ICalendarAttendeeAvailability {
  attendee?: ICalendarRecipient;
  availability?: CalendarFreeBusyStatus | string;
}

export interface ICalendarMeetingTimeSlot {
  start: ICalendarDateTimeTimeZone;
  end: ICalendarDateTimeTimeZone;
  startTimeZone?: ICalendarTimeZoneBase;
  endTimeZone?: ICalendarTimeZoneBase;
}

export interface ICalendarMeetingTimeSuggestion {
  confidence?: number;
  order?: number;
  organizerAvailability?: CalendarFreeBusyStatus | string;
  attendeeAvailability?: ICalendarAttendeeAvailability[];
  locations?: ICalendarLocation[];
  meetingTimeSlot?: ICalendarMeetingTimeSlot;
  suggestionReason?: string;
}

export interface ICalendarMeetingTimesResult {
  meetingTimeSuggestions: ICalendarMeetingTimeSuggestion[];
  /** Populated by Graph only when no suggestion exists. */
  emptySuggestionsReason?: string | null;
}

/** Input for `findMeetingTimes`. */
export interface IFindMeetingTimesOptions {
  attendees: ICalendarAttendeeInput[];
  /** Start of the window searched for a slot. */
  start: CalendarDateTimeInput;
  /** End of the window searched for a slot. */
  end: CalendarDateTimeInput;
  /** Zone used to interpret window values that carry no offset. */
  timeZone?: string;
  /** ISO 8601 duration, e.g. `PT30M`. Defaults to `PT30M`. */
  meetingDuration?: string;
  /** 1-100; Graph defaults to 20. */
  maxCandidates?: number;
  isOrganizerOptional?: boolean;
  returnSuggestionReasons?: boolean;
  /** 0-100. */
  minimumAttendeePercentage?: number;
  locationConstraint?: ICalendarLocationConstraint;
  activityDomain?: 'unknown' | 'workHours' | 'personal' | string;
}

/** How an invitee answers an invitation. */
export type CalendarInvitationResponse =
  | 'accept'
  | 'decline'
  | 'tentativelyAccept';

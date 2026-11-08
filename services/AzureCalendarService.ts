import crypto from 'crypto';
import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError, toGraphApiError } from '../utils/graph-error';
import { azureCacheKey, AzureCacheDomain } from '../utils/cache-keys';
import {
  CALENDAR_LIST_CACHE_TTL_SECONDS,
  DEFAULT_CALENDAR_TIME_ZONE,
  type CalendarDateTimeInput,
  type CalendarInvitationResponse,
  type IAzureCalendar,
  type ICancelEventOptions,
  type ICreateCalendarEventInput,
  type ICalendarAttendee,
  type ICalendarAttendeeInput,
  type ICalendarDateTimeTimeZone,
  type ICalendarEvent,
  type ICalendarEventInput,
  type ICalendarLocation,
  type ICalendarMeetingTimesResult,
  type ICalendarPatternedRecurrence,
  type ICalendarScheduleInformation,
  type IFindMeetingTimesOptions,
  type IGetEventOptions,
  type IListCalendarsOptions,
  type IListEventsOptions,
  type IRespondEventOptions,
} from '../types/calendar.types';

/**
 * The slice of the Graph provider this service uses.
 *
 * Declared explicitly (rather than typing the provider `any`) so the generic
 * `request<T>` / `requestAll<T>` calls type-check and a future provider change
 * breaks here instead of at runtime.
 */
interface IGraphClientProviderLike {
  request<T = any>(userId: string, path: string, options?: Record<string, unknown>): Promise<T>;
  requestAll<T = any>(userId: string, path: string, options?: Record<string, unknown>): Promise<T[]>;
  getClient(userId: string): any;
}

/**
 * AzureCalendarService (AZ-07) - Microsoft Graph calendars, events, availability
 * and online meetings.
 *
 * Four rules this service exists to enforce:
 *
 * 1. **A range is read from `/me/calendarView`, never `/me/events`.**
 *    `/me/events` returns recurrence *masters*, not their expanded occurrences,
 *    so a naive window filter silently drops every recurring meeting that
 *    actually happens inside it. `listEvents` therefore refuses (and redirects)
 *    when a range is supplied - see {@link AzureCalendarService.listEvents}.
 *
 * 2. **An argument is honoured or rejected, never discarded.** The same rule
 *    applies to the per-calendar reads: `listCalendarEvents` routes a supplied
 *    window to `/me/calendars/{id}/calendarView` instead of silently returning
 *    the whole calendar, and `listEvents({ calendarId })` without a window routes
 *    to `/me/calendars/{id}/events` instead of widening to every calendar. A
 *    half-specified window throws before any Graph call.
 *
 * 3. **A `dateTimeTimeZone` is never serialised as a bare string.**
 *    Graph's request bodies type `start`, `end`, `startTime` and `endTime` as
 *    `dateTimeTimeZone`. A bare ISO string is interpreted in an unspecified zone,
 *    which shifts a meeting by the caller's UTC offset without any error. Every
 *    body is built through {@link buildCalendarEventBody} /
 *    {@link AzureCalendarService.getSchedule}, which emit `{ dateTime, timeZone }`.
 *    (`calendarView` query parameters are the documented exception: that endpoint
 *    takes `Edm.DateTimeOffset` strings, so the window is resolved to an absolute
 *    offset first - never left zone-less.)
 *
 * 4. **Recurrence is Graph's `patternedRecurrence`, not Google's `string[]`.**
 *    The object shape round-trips `firstDayOfWeek`, `index` and
 *    `recurrenceTimeZone`; a string array cannot.
 *
 * No method returns `[]`, `null` or another placeholder on failure: Graph
 * failures become an `ApiError` that keeps Graph's `code`.
 */
@service({
  id: 'azure.AzureCalendarService@1.0.0',
  name: 'AzureCalendarService',
  nameSpace: 'azure',
  version: '1.0.0',
  description:
    'Microsoft Graph calendar - calendars, calendarView ranges, event CRUD, availability and online meetings',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'azure.AzureAuditService@1.0.0', alias: 'auditService' },
    { id: 'core.RedisService@1.0.0', alias: 'redisService' },
  ],
})
class AzureCalendarService implements Reactory.Service.IReactoryService {
  name: string = 'AzureCalendarService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphClientProvider: any;
  private _redisService: any;
  private _auditService: any;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `graphClientProvider` dependency alias. */
  setGraphClientProvider(serviceInstance: any): void {
    this._graphClientProvider = serviceInstance;
  }

  /** Bound by the Reactory service container from the `redisService` dependency alias. */
  setRedisService(serviceInstance: any): void {
    this._redisService = serviceInstance;
  }

  /** Bound by the Reactory service container from the `auditService` dependency alias. */
  setAuditService(serviceInstance: any): void {
    this._auditService = serviceInstance;
  }

  private get graphProvider(): any {
    if (this._graphClientProvider) return this._graphClientProvider;
    if (this.context && typeof this.context.getService === 'function') {
      try {
        return this.context.getService('azure.AzureGraphClientProvider@1.0.0');
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private get redisService(): any {
    if (this._redisService) return this._redisService;
    if (this.context && typeof this.context.getService === 'function') {
      try {
        return this.context.getService('core.RedisService@1.0.0');
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private get auditService(): any {
    if (this._auditService) return this._auditService;
    if (this.context && typeof this.context.getService === 'function') {
      try {
        return this.context.getService('azure.AzureAuditService@1.0.0');
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Resolve the provider or fail loudly. A missing provider is a wiring error,
   * not an empty mailbox: it must not look like "no calendars".
   */
  private requireProvider(): IGraphClientProviderLike {
    const provider = this.graphProvider;

    if (!provider || typeof provider.request !== 'function') {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Microsoft Graph client provider is not available; the Azure module is not wired',
      );
    }

    return provider;
  }

  private requireUserId(userId: string): string {
    const uid = userId === undefined || userId === null ? '' : String(userId).trim();

    if (!uid) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required for every calendar operation');
    }

    return uid;
  }

  /**
   * Fire-and-forget audit write; never throws, never changes the result.
   *
   * `graphCode` is a first-class field of `IAzureAuditEntry` (not metadata), so a
   * consumer filtering audit documents on the Graph code finds it.
   */
  private async recordAudit(
    userId: string,
    operation: string,
    resource: string,
    outcome: 'success' | 'failure',
    durationMs: number,
    details: { graphCode?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    try {
      const audit = this.auditService;
      if (!audit || typeof audit.logOperation !== 'function') return;

      await audit.logOperation({
        userId,
        operation,
        resource,
        outcome,
        durationMs,
        graphCode: details.graphCode,
        metadata: details.metadata,
      });
    } catch {
      /* an audit failure must never fail the operation it records */
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Calendars                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * `GET /me/calendars` - cached for {@link CALENDAR_LIST_CACHE_TTL_SECONDS}
   * (5 minutes) per user, because the calendar list changes rarely and every
   * calendar view resolves through it. Pass `{ refresh: true }` to bypass.
   *
   * The cache key includes a digest of `select`/`top` (see
   * {@link calendarListCacheKey}): a projected read must never be served to an
   * unqualified caller, because a page cached from `select: ['id','name']` lacks
   * `isDefaultCalendar`/`canEdit` and a caller would read "not editable" off a
   * field the request simply never asked for.
   */
  async listCalendars(
    userId: string,
    options: IListCalendarsOptions = {},
  ): Promise<IAzureCalendar[]> {
    const uid = this.requireUserId(userId);
    const cacheKey = calendarListCacheKey(uid, options);

    if (options.refresh !== true) {
      const cached = await this.readCalendarListCache(cacheKey);
      if (cached) return cached;
    }

    const calendars = await this.requireProvider().requestAll<IAzureCalendar>(uid, '/me/calendars', {
      select: options.select,
      top: options.top,
    });

    await this.writeCalendarListCache(cacheKey, calendars);
    return calendars;
  }

  /** `GET /me/calendars/{id}`. */
  async getCalendar(userId: string, calendarId: string): Promise<IAzureCalendar> {
    const uid = this.requireUserId(userId);
    const id = requireId(calendarId, 'calendarId');

    return this.requireProvider().request<IAzureCalendar>(uid, `/me/calendars/${segment(id)}`);
  }

  /* ------------------------------------------------------------------------ */
  /* Events                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Events for the user - routed by what the caller asked for, never by what is
   * convenient:
   *
   *   - `start` **and** `end` -> {@link listCalendarView} (`/me/calendarView`, or
   *     `/me/calendars/{id}/calendarView` when `calendarId` is also set), which
   *     expands recurrences;
   *   - `calendarId` alone -> {@link listCalendarEvents}, i.e.
   *     `/me/calendars/{id}/events`. Dropping the id here would silently widen
   *     the read to every calendar the user owns;
   *   - neither -> `/me/events`.
   *
   * Every argument the caller supplies is honoured or rejected; none is
   * discarded. A half-specified window throws before any Graph call, because a
   * caller that passed one end wanted a window and would otherwise receive the
   * user's entire history.
   */
  async listEvents(userId: string, options: IListEventsOptions = {}): Promise<ICalendarEvent[]> {
    if (classifyRange(options) === 'range') {
      return this.listCalendarView(userId, options.start, options.end, options);
    }

    if (options.calendarId !== undefined && options.calendarId !== null && String(options.calendarId).trim()) {
      return this.listCalendarEvents(userId, options.calendarId, options);
    }

    const uid = this.requireUserId(userId);

    return this.requireProvider().requestAll<ICalendarEvent>(uid, '/me/events', queryOptions(options));
  }

  /**
   * Events in one calendar, routed by the same rule as {@link listEvents}:
   *
   *   - `start` **and** `end` -> `listCalendarView(userId, start, end, {
   *     ...options, calendarId })`, i.e.
   *     `/me/calendars/{id}/calendarView?startDateTime=…&endDateTime=…`. The
   *     window is the caller's requirement, so it is never dropped: without
   *     `calendarView` a recurring series contributes only its master and the
   *     week the caller asked for is wrong;
   *   - a half-specified window throws `InvalidDateRange` before any Graph call;
   *   - neither -> `GET /me/calendars/{id}/events`, an unwindowed read.
   */
  async listCalendarEvents(
    userId: string,
    calendarId: string,
    options: IListEventsOptions = {},
  ): Promise<ICalendarEvent[]> {
    const id = requireId(calendarId, 'calendarId');

    if (classifyRange(options) === 'range') {
      return this.listCalendarView(userId, options.start, options.end, {
        ...options,
        calendarId: id,
      });
    }

    const uid = this.requireUserId(userId);

    return this.requireProvider().requestAll<ICalendarEvent>(
      uid,
      `/me/calendars/${segment(id)}/events`,
      queryOptions(options),
    );
  }

  /**
   * `GET /me/calendarView?startDateTime=…&endDateTime=…` - **the** endpoint for a
   * date window.
   *
   * `calendarView` returns single instances, expanded occurrences and exceptions
   * for the window, so a recurring series contributes every occurrence that
   * actually falls inside it. That is why every ranged query in this service
   * ends up here.
   *
   * The two query parameters are `Edm.DateTimeOffset` values, not
   * `dateTimeTimeZone` objects, so each end is resolved to an absolute offset
   * from its zone before it is sent - never left zone-less.
   */
  async listCalendarView(
    userId: string,
    start: CalendarDateTimeInput,
    end: CalendarDateTimeInput,
    options: IListEventsOptions = {},
  ): Promise<ICalendarEvent[]> {
    const uid = this.requireUserId(userId);
    const timeZone = options.timeZone || DEFAULT_CALENDAR_TIME_ZONE;
    const startDateTime = toGraphDateTimeOffset(start, timeZone);
    const endDateTime = toGraphDateTimeOffset(end, timeZone);

    assertValidRange(startDateTime, endDateTime);

    const params = new URLSearchParams({ startDateTime, endDateTime });
    const base = options.calendarId
      ? `/me/calendars/${segment(requireId(options.calendarId, 'calendarId'))}/calendarView`
      : '/me/calendarView';

    return this.requireProvider().requestAll<ICalendarEvent>(
      uid,
      `${base}?${params.toString()}`,
      queryOptions(options),
    );
  }

  /** `GET /me/events/{id}` - a single instance, occurrence or series master. */
  async getEvent(
    userId: string,
    eventId: string,
    options: IGetEventOptions = {},
  ): Promise<ICalendarEvent> {
    const uid = this.requireUserId(userId);
    const id = requireId(eventId, 'eventId');

    return this.requireProvider().request<ICalendarEvent>(uid, `/me/events/${segment(id)}`, {
      select: options.select,
      expand: options.expand,
    });
  }

  /**
   * `POST /me/events` (or `/me/calendars/{id}/events`).
   *
   * `isOnlineMeeting: true` also sends
   * `onlineMeetingProvider: 'teamsForBusiness'` unless the caller chose another
   * provider - Graph requires the two together and creates the join link itself.
   */
  async createEvent(
    userId: string,
    input: ICreateCalendarEventInput,
  ): Promise<ICalendarEvent> {
    const uid = this.requireUserId(userId);
    const startedAt = Date.now();
    const body = buildCalendarEventBody(input);

    if (!body.start || !body.end) {
      throw apiError(
        CalendarErrorCode.INVALID_EVENT,
        'createEvent requires both start and end as { dateTime, timeZone }',
        { hasStart: Boolean(body.start), hasEnd: Boolean(body.end) },
      );
    }

    const path = input && input.calendarId
      ? `/me/calendars/${segment(requireId(input.calendarId, 'calendarId'))}/events`
      : '/me/events';

    try {
      const event = await this.send<ICalendarEvent>(uid, 'calendar.createEvent', (client) =>
        client.api(path).post(body));

      await this.recordAudit(uid, 'calendar.createEvent', path, 'success', Date.now() - startedAt, {
        metadata: {
          eventId: event?.id,
          isOnlineMeeting: body.isOnlineMeeting === true,
        },
      });

      return event;
    } catch (error: any) {
      await this.recordAudit(uid, 'calendar.createEvent', path, 'failure', Date.now() - startedAt, {
        graphCode: error?.code,
      });
      throw error;
    }
  }

  /** `PATCH /me/events/{id}`. `start`/`end` are sent as `dateTimeTimeZone` objects. */
  async updateEvent(
    userId: string,
    eventId: string,
    input: ICalendarEventInput,
  ): Promise<ICalendarEvent> {
    const uid = this.requireUserId(userId);
    const id = requireId(eventId, 'eventId');
    const body = buildCalendarEventBody(input);

    if (Object.keys(body).length === 0) {
      throw apiError(
        CalendarErrorCode.INVALID_EVENT,
        'updateEvent requires at least one field to change',
        { eventId: id },
      );
    }

    return this.send<ICalendarEvent>(uid, 'calendar.updateEvent', (client) =>
      client.api(`/me/events/${segment(id)}`).patch(body));
  }

  /** `DELETE /me/events/{id}`. Resolves `true` only when Graph accepted the delete. */
  async deleteEvent(userId: string, eventId: string): Promise<boolean> {
    const uid = this.requireUserId(userId);
    const id = requireId(eventId, 'eventId');

    await this.send(uid, 'calendar.deleteEvent', (client) =>
      client.api(`/me/events/${segment(id)}`).delete());

    return true;
  }

  /**
   * `POST /me/events/{id}/cancel` with the attendee-facing `Comment`.
   *
   * Graph spells this body property with a capital `C` (unlike the response
   * actions, which use a lower-case `comment`); keep the documented casing.
   */
  async cancelEvent(
    userId: string,
    eventId: string,
    options: ICancelEventOptions = {},
  ): Promise<boolean> {
    const uid = this.requireUserId(userId);
    const id = requireId(eventId, 'eventId');

    const body = { Comment: options.comment === undefined || options.comment === null
      ? ''
      : String(options.comment) };

    await this.send(uid, 'calendar.cancelEvent', (client) =>
      client.api(`/me/events/${segment(id)}/cancel`).post(body));

    return true;
  }

  /** `POST /me/events/{id}/accept`. */
  async acceptEvent(
    userId: string,
    eventId: string,
    options: IRespondEventOptions = {},
  ): Promise<boolean> {
    return this.respondToEvent(userId, eventId, 'accept', options);
  }

  /** `POST /me/events/{id}/decline`. */
  async declineEvent(
    userId: string,
    eventId: string,
    options: IRespondEventOptions = {},
  ): Promise<boolean> {
    return this.respondToEvent(userId, eventId, 'decline', options);
  }

  /** `POST /me/events/{id}/tentativelyAccept`. */
  async tentativelyAcceptEvent(
    userId: string,
    eventId: string,
    options: IRespondEventOptions = {},
  ): Promise<boolean> {
    return this.respondToEvent(userId, eventId, 'tentativelyAccept', options);
  }

  private async respondToEvent(
    userId: string,
    eventId: string,
    response: CalendarInvitationResponse,
    options: IRespondEventOptions,
  ): Promise<boolean> {
    const uid = this.requireUserId(userId);
    const id = requireId(eventId, 'eventId');
    const action = RESPONSE_ACTION[response];

    if (!action) {
      throw apiError(CalendarErrorCode.INVALID_RESPONSE, `Unsupported RSVP response: ${response}`, {
        response,
      });
    }

    const body = {
      comment: options.comment === undefined || options.comment === null
        ? ''
        : String(options.comment),
      sendResponse: options.sendResponse !== false,
    };

    await this.send(uid, `calendar.${response}`, (client) =>
      client.api(`/me/events/${segment(id)}/${action}`).post(body));

    return true;
  }

  /* ------------------------------------------------------------------------ */
  /* Availability                                                             */
  /* ------------------------------------------------------------------------ */

  /**
   * `POST /me/calendar/getSchedule` - free/busy for one or more mailboxes.
   *
   * The documented body is
   * `{ schedules, startTime, endTime, availabilityViewInterval }` where both
   * times are `dateTimeTimeZone` and the interval is **minutes** (Graph default
   * 30, range 5-1440). `availabilityViewInterval` is always sent: omitting it
   * makes Graph fall back to its own default, which changes the width of
   * `availabilityView`.
   *
   * `timeZone` mirrors `findMeetingTimes`: it is the zone used to read a value
   * that carries no offset. It exists so the two availability methods behave
   * identically - without it a bare `'2026-01-05T09:00:00'` is silently read in
   * `DEFAULT_CALENDAR_TIME_ZONE`, which is only right for one tenant.
   */
  async getSchedule(
    userId: string,
    schedules: string[],
    start: CalendarDateTimeInput,
    end: CalendarDateTimeInput,
    availabilityViewInterval: number = 30,
    timeZone: string = DEFAULT_CALENDAR_TIME_ZONE,
  ): Promise<ICalendarScheduleInformation[]> {
    const uid = this.requireUserId(userId);

    if (!Array.isArray(schedules) || schedules.length === 0) {
      throw apiError(
        CalendarErrorCode.INVALID_SCHEDULES,
        'getSchedule requires at least one schedule (SMTP address or user id)',
      );
    }

    const addresses = schedules
      .map((entry) => (entry === undefined || entry === null ? '' : String(entry).trim()))
      .filter((entry) => entry.length > 0);

    if (addresses.length === 0) {
      throw apiError(
        CalendarErrorCode.INVALID_SCHEDULES,
        'getSchedule requires at least one non-empty schedule (SMTP address or user id)',
      );
    }

    const zone = timeZone || DEFAULT_CALENDAR_TIME_ZONE;
    const startTime = toCalendarDateTimeTimeZone(start, zone);
    const endTime = toCalendarDateTimeTimeZone(end, zone);
    assertValidRange(
      toGraphDateTimeOffset(startTime, zone),
      toGraphDateTimeOffset(endTime, zone),
    );

    const body = {
      schedules: addresses,
      startTime,
      endTime,
      availabilityViewInterval: normaliseAvailabilityViewInterval(availabilityViewInterval),
    };

    const response = await this.send<{ value?: ICalendarScheduleInformation[] }>(
      uid,
      'calendar.getSchedule',
      (client) => client.api('/me/calendar/getSchedule').post(body),
    );

    return Array.isArray(response?.value) ? response.value : [];
  }

  /**
   * `POST /me/findMeetingTimes` - Graph's suggestion engine.
   *
   * `timeConstraint.timeslots[].start/end` are `dateTimeTimeZone`, and the
   * suggestions come back as `meetingTimeSuggestions` with Graph's own
   * `confidence` and `order`. This has no Google equivalent; it is a first-class
   * query rather than a fan-out of free/busy calls.
   */
  async findMeetingTimes(
    userId: string,
    options: IFindMeetingTimesOptions,
  ): Promise<ICalendarMeetingTimesResult> {
    const uid = this.requireUserId(userId);

    if (!options || !Array.isArray(options.attendees) || options.attendees.length === 0) {
      throw apiError(
        CalendarErrorCode.INVALID_ATTENDEES,
        'findMeetingTimes requires at least one attendee',
      );
    }

    const attendees = options.attendees.map((attendee, index) => {
      const address = attendee && attendee.emailAddress
        ? String(attendee.emailAddress.address || '').trim()
        : '';

      if (!address) {
        throw apiError(
          CalendarErrorCode.INVALID_ATTENDEES,
          `findMeetingTimes attendee ${index} has no email address`,
          { index },
        );
      }

      const normalised: Record<string, unknown> = {
        type: attendee.type || 'required',
        emailAddress: compact({
          address,
          name: attendee.emailAddress.name,
        }),
      };

      return normalised;
    });

    const timeZone = options.timeZone || DEFAULT_CALENDAR_TIME_ZONE;
    const start = toCalendarDateTimeTimeZone(options.start, timeZone);
    const end = toCalendarDateTimeTimeZone(options.end, timeZone);
    assertValidRange(toGraphDateTimeOffset(start), toGraphDateTimeOffset(end));

    const timeConstraint: Record<string, unknown> = {
      timeslots: [{ start, end }],
    };

    if (options.activityDomain) timeConstraint.activityDomain = options.activityDomain;

    const body: Record<string, unknown> = compact({
      attendees,
      timeConstraint,
      locationConstraint: options.locationConstraint,
      meetingDuration: options.meetingDuration || 'PT30M',
      maxCandidates: clampInteger(options.maxCandidates, 1, 100, 20),
      isOrganizerOptional: options.isOrganizerOptional === true,
      returnSuggestionReasons: options.returnSuggestionReasons === true,
      minimumAttendeePercentage: options.minimumAttendeePercentage === undefined
        ? undefined
        : clampNumber(options.minimumAttendeePercentage, 0, 100),
    });

    const response = await this.send<ICalendarMeetingTimesResult>(
      uid,
      'calendar.findMeetingTimes',
      (client) => client.api('/me/findMeetingTimes').post(body),
    );

    return {
      meetingTimeSuggestions: Array.isArray(response?.meetingTimeSuggestions)
        ? response.meetingTimeSuggestions
        : [],
      emptySuggestionsReason: response?.emptySuggestionsReason ?? null,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Transport                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * POST/PATCH/DELETE through the provider's client.
   *
   * The provider only exposes GET helpers (`request`, `requestAll`, `delta`,
   * `batch`), so writes borrow `getClient(userId)` - still the single Graph
   * client factory, with `debugLogging` disabled - and translate failures with
   * the same `toGraphApiError` contract as every read.
   */
  private async send<T>(
    userId: string,
    operation: string,
    run: (client: any) => Promise<T>,
  ): Promise<T> {
    const provider = this.requireProvider();

    if (typeof provider.getClient !== 'function') {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Microsoft Graph client provider cannot build a client for a write operation',
        { operation },
      );
    }

    const client = provider.getClient(userId);

    try {
      return await run(client);
    } catch (error: any) {
      const tokenSource = typeof client?.__azureTokenSource === 'function'
        ? client.__azureTokenSource()
        : undefined;

      throw toGraphApiError(error, { operation, tokenSource });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Calendar cache                                                           */
  /* ------------------------------------------------------------------------ */

  private async readCalendarListCache(cacheKey: string): Promise<IAzureCalendar[] | undefined> {
    try {
      const redis = this.redisService;
      if (!redis || typeof redis.get !== 'function') return undefined;

      const cached = await redis.get(cacheKey);
      if (!cached) return undefined;

      const parsed = JSON.parse(cached);
      return Array.isArray(parsed) ? (parsed as IAzureCalendar[]) : undefined;
    } catch {
      // A cache miss must never fail the read; Graph is the source of truth.
      return undefined;
    }
  }

  private async writeCalendarListCache(cacheKey: string, calendars: IAzureCalendar[]): Promise<void> {
    try {
      const redis = this.redisService;
      if (!redis || typeof redis.set !== 'function') return;

      await redis.set(
        cacheKey,
        JSON.stringify(calendars),
        CALENDAR_LIST_CACHE_TTL_SECONDS,
      );
    } catch {
      /* caching is an optimisation, never a correctness requirement */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Error codes raised by this service (Graph codes are preserved elsewhere)    */
/* -------------------------------------------------------------------------- */

export const CalendarErrorCode = {
  INVALID_DATE_TIME: 'InvalidDateTime',
  INVALID_DATE_TIME_ZONE: 'InvalidDateTimeZone',
  INVALID_DATE_RANGE: 'InvalidDateRange',
  INVALID_EVENT: 'InvalidEvent',
  INVALID_RECURRENCE: 'InvalidRecurrence',
  INVALID_SCHEDULES: 'InvalidSchedules',
  INVALID_ATTENDEES: 'InvalidAttendees',
  INVALID_RESPONSE: 'InvalidInvitationResponse',
} as const;

/** Graph response-action path segment per invitation response. */
const RESPONSE_ACTION: Record<CalendarInvitationResponse, string> = {
  accept: 'accept',
  decline: 'decline',
  tentativelyAccept: 'tentativelyAccept',
};

/**
 * Windows zone names → IANA, mirroring the CLDR windowsZones mapping Graph uses.
 *
 * Graph sends and expects Windows zone ids (`South Africa Standard Time`), while
 * `Intl` needs an IANA name. An IANA name is accepted as-is, so this table only
 * has to cover the Windows spellings; a zone that appears in neither raises
 * `InvalidDateTimeZone` rather than being assumed to be UTC - an assumption that
 * would silently move a window by the tenant's offset.
 *
 * The set below is the territory-001 entry of every CLDR windowsZone, so the
 * usual tenants (US/EU/APAC/Africa, including `Singapore Standard Time`,
 * `Taipei Standard Time` and `AUS Central Standard Time`) all resolve.
 */
export const WINDOWS_TIME_ZONES: Record<string, string> = {
  // UTC and its offsets.
  UTC: 'Etc/UTC',
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'UTC-09': 'Etc/GMT+9',
  'UTC-08': 'Etc/GMT+8',
  'UTC-02': 'Etc/GMT+2',
  'UTC+12': 'Etc/GMT-12',
  'UTC+13': 'Etc/GMT-13',

  // North and South America.
  'Aleutian Standard Time': 'America/Adak',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Marquesas Standard Time': 'Pacific/Marquesas',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Mountain Standard Time': 'America/Denver',
  'Yukon Standard Time': 'America/Whitehorse',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Easter Island Standard Time': 'Pacific/Easter',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Eastern Standard Time': 'America/New_York',
  'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Venezuela Standard Time': 'America/Caracas',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Tocantins Standard Time': 'America/Araguaina',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Greenland Standard Time': 'America/Nuuk',
  'Montevideo Standard Time': 'America/Montevideo',
  'Magallanes Standard Time': 'America/Punta_Arenas',
  'Saint Pierre Standard Time': 'America/Miquelon',
  'Bahia Standard Time': 'America/Bahia',

  // Europe, Middle East and Africa.
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Sao Tome Standard Time': 'Africa/Sao_Tome',
  'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Syria Standard Time': 'Asia/Damascus',
  'West Bank Standard Time': 'Asia/Hebron',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Sudan Standard Time': 'Africa/Juba',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Sudan Standard Time': 'Africa/Khartoum',
  'Libya Standard Time': 'Africa/Tripoli',
  'Namibia Standard Time': 'Africa/Windhoek',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Russia Time Zone 3': 'Europe/Samara',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Saratov Standard Time': 'Europe/Saratov',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Caucasus Standard Time': 'Asia/Yerevan',

  // South and East Asia.
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Pakistan Standard Time': 'Asia/Karachi',
  'Qyzylorda Standard Time': 'Asia/Qyzylorda',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Omsk Standard Time': 'Asia/Omsk',
  'Myanmar Standard Time': 'Asia/Yangon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Altai Standard Time': 'Asia/Barnaul',
  'W. Mongolia Standard Time': 'Asia/Hovd',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Tomsk Standard Time': 'Asia/Tomsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Korea Standard Time': 'Asia/Seoul',
  'Yakutsk Standard Time': 'Asia/Yakutsk',

  // Oceania.
  'W. Australia Standard Time': 'Australia/Perth',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'Bougainville Standard Time': 'Pacific/Bougainville',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Magadan Standard Time': 'Asia/Magadan',
  'Norfolk Standard Time': 'Pacific/Norfolk',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Chatham Islands Standard Time': 'Pacific/Chatham',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
  'Line Islands Standard Time': 'Pacific/Kiritimati',
};

/** `DateTimeOffset` suffix: `Z` or `±HH:MM` (`±HHMM` tolerated). */
const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

const MIN_AVAILABILITY_VIEW_INTERVAL = 5;
const MAX_AVAILABILITY_VIEW_INTERVAL = 1440;

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported so the request-shape tests can prove serialisation)  */
/* -------------------------------------------------------------------------- */

/**
 * Normalise any accepted date value into a Graph `dateTimeTimeZone`.
 *
 * This is the ONLY shape this service puts into a request body for a field Graph
 * types as `dateTimeTimeZone`. It never returns a bare string, and it does not
 * convert the zone-local `dateTime` - Graph interprets it in `timeZone`.
 */
export function toCalendarDateTimeTimeZone(
  value: CalendarDateTimeInput,
  defaultTimeZone: string = DEFAULT_CALENDAR_TIME_ZONE,
): ICalendarDateTimeTimeZone {
  if (value === undefined || value === null) {
    throw apiError(CalendarErrorCode.INVALID_DATE_TIME, 'A date/time value is required');
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw apiError(CalendarErrorCode.INVALID_DATE_TIME, 'An invalid Date was supplied');
    }

    return { dateTime: value.toISOString(), timeZone: 'UTC' };
  }

  if (typeof value === 'string') {
    const dateTime = value.trim();
    if (!dateTime) {
      throw apiError(CalendarErrorCode.INVALID_DATE_TIME, 'A date/time string cannot be empty');
    }

    return { dateTime, timeZone: defaultTimeZone };
  }

  if (typeof value === 'object') {
    const dateTime = typeof value.dateTime === 'string' ? value.dateTime.trim() : '';
    if (!dateTime) {
      throw apiError(CalendarErrorCode.INVALID_DATE_TIME, 'dateTime is required on a dateTimeTimeZone', {
        received: value,
      });
    }

    const timeZone = typeof value.timeZone === 'string' && value.timeZone.trim()
      ? value.timeZone.trim()
      : defaultTimeZone;

    return { dateTime, timeZone };
  }

  throw apiError(CalendarErrorCode.INVALID_DATE_TIME, 'Unsupported date/time value', {
    type: typeof value,
  });
}

/**
 * Resolve a value to an absolute `Edm.DateTimeOffset` string, honouring the zone
 * when the `dateTime` carries no offset.
 *
 * Used only for `calendarView`'s `startDateTime`/`endDateTime` query parameters
 * (and for range validation), which Graph types as DateTimeOffset rather than
 * `dateTimeTimeZone`.
 */
export function toGraphDateTimeOffset(
  value: CalendarDateTimeInput,
  defaultTimeZone: string = DEFAULT_CALENDAR_TIME_ZONE,
): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw apiError(CalendarErrorCode.INVALID_DATE_TIME, 'An invalid Date was supplied');
    }

    return value.toISOString();
  }

  if (typeof value === 'string') {
    const dateTime = value.trim();
    if (!dateTime) {
      throw apiError(CalendarErrorCode.INVALID_DATE_TIME, 'A date/time string cannot be empty');
    }

    return withResolvedOffset(dateTime, defaultTimeZone);
  }

  const normalised = toCalendarDateTimeTimeZone(value, defaultTimeZone);
  return withResolvedOffset(normalised.dateTime, normalised.timeZone);
}

/**
 * Cache key for a calendar list read.
 *
 * An option-free read keeps the stable `azure:{userId}:calendar:list` key. Any
 * read that projects the page (`select`, `top`) is filed under a key that
 * carries a digest of those options, so a projected page is never served to a
 * caller that did not ask for the projection: a page cached from
 * `select: ['id','name']` has no `isDefaultCalendar`/`canEdit`, and a caller
 * reading those fields as `false` would draw the wrong permission conclusion.
 *
 * `select` is sorted and de-duplicated first, so `['id','name']` and
 * `['name','id']` share one entry.
 */
export function calendarListCacheKey(
  userId: string,
  options: IListCalendarsOptions = {},
): string {
  const select = normaliseSelect(options.select);
  const top = typeof options.top === 'number' && Number.isFinite(options.top)
    ? Math.trunc(options.top)
    : undefined;

  if (!select && top === undefined) {
    return azureCacheKey(userId, AzureCacheDomain.CALENDAR_LIST);
  }

  const digest = crypto
    .createHash('sha1')
    .update(`select=${select}|top=${top === undefined ? '' : top}`)
    .digest('hex')
    .slice(0, 12);

  return azureCacheKey(userId, AzureCacheDomain.CALENDAR_LIST, digest);
}

/**
 * `+02:00` / `Z` for a zone at a given zone-local date-time.
 *
 * An explicit offset on the value wins. `UTC`/`GMT` resolve to `Z`. Anything else
 * is looked up as an IANA name or through {@link WINDOWS_TIME_ZONES}; an unknown
 * zone raises `InvalidDateTimeZone` rather than silently treating the value as
 * UTC, which would move the meeting.
 */
export function resolveTimeZoneOffset(dateTime: string, timeZone: string): string {
  const value = String(dateTime || '').trim();

  if (!value) {
    throw apiError(CalendarErrorCode.INVALID_DATE_TIME, 'A date/time value is required');
  }

  const explicit = OFFSET_SUFFIX.exec(value);
  if (explicit) return explicit[1].toUpperCase();

  const zone = String(timeZone || '').trim();
  if (!zone) {
    throw apiError(
      CalendarErrorCode.INVALID_DATE_TIME_ZONE,
      'A time zone is required when the date/time carries no offset',
      { dateTime: value },
    );
  }

  if (/^(utc|gmt|z|etc\/utc)$/i.test(zone)) return 'Z';

  const iana = WINDOWS_TIME_ZONES[zone] || (isIanaTimeZone(zone) ? zone : undefined);

  if (!iana) {
    throw apiError(
      CalendarErrorCode.INVALID_DATE_TIME_ZONE,
      `Unsupported time zone "${zone}"; supply an IANA name or a date/time with an explicit offset`,
      { timeZone: zone },
    );
  }

  const offsetMinutes = zoneOffsetMinutes(value, iana);
  return offsetMinutes === 0 ? 'Z' : formatOffset(offsetMinutes);
}

/**
 * Build the Graph event body for create/update.
 *
 * Only `start`/`end` are transformed into `{ dateTime, timeZone }`; everything
 * else is copied. Three things are deliberately NOT copied because Graph treats
 * them as read-only and rejects a write that carries them:
 *
 *   - `calendarId` (a path concern, already applied to the request URL);
 *   - `originalStartTimeZone` / `originalEndTimeZone`;
 *   - `onlineMeeting` / any join link - Graph produces those when
 *     `isOnlineMeeting` is true, and this module never synthesises one.
 */
export function buildCalendarEventBody(
  input: ICalendarEventInput,
  defaultTimeZone: string = DEFAULT_CALENDAR_TIME_ZONE,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    throw apiError(CalendarErrorCode.INVALID_EVENT, 'An event body is required');
  }

  const body: Record<string, unknown> = {};

  if (input.subject !== undefined) body.subject = input.subject;

  if (input.body !== undefined) {
    body.body = compact({
      contentType: input.body.contentType || 'html',
      content: input.body.content,
    });
  }

  if (input.start !== undefined) {
    body.start = toCalendarDateTimeTimeZone(input.start, defaultTimeZone);
  }

  if (input.end !== undefined) {
    body.end = toCalendarDateTimeTimeZone(input.end, defaultTimeZone);
  }

  if (input.location !== undefined) body.location = normaliseLocation(input.location);
  if (input.locations !== undefined) {
    body.locations = input.locations.map((location) => normaliseLocation(location));
  }

  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map((attendee, index) => normaliseAttendee(attendee, index));
  }

  if (input.isAllDay !== undefined) body.isAllDay = input.isAllDay;

  // The two go together: Graph rejects an online-meeting provider without the
  // flag, and defaults to Teams for Business when the flag is set.
  if (input.isOnlineMeeting === true) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = input.onlineMeetingProvider || 'teamsForBusiness';
  } else if (input.isOnlineMeeting === false) {
    body.isOnlineMeeting = false;
  }

  if (input.recurrence !== undefined) {
    body.recurrence = input.recurrence === null ? null : normaliseRecurrence(input.recurrence);
  }

  if (input.categories !== undefined) body.categories = [...input.categories];
  if (input.importance !== undefined) body.importance = input.importance;
  if (input.sensitivity !== undefined) body.sensitivity = input.sensitivity;
  if (input.showAs !== undefined) body.showAs = input.showAs;
  if (input.reminderMinutesBeforeStart !== undefined) {
    body.reminderMinutesBeforeStart = input.reminderMinutesBeforeStart;
  }
  if (input.isReminderOn !== undefined) body.isReminderOn = input.isReminderOn;
  if (input.transactionId !== undefined) body.transactionId = input.transactionId;

  return body;
}

/**
 * Copy a Graph `patternedRecurrence`, validating its two halves.
 *
 * The shape is preserved exactly - it is never converted to Google's
 * `recurrence: string[]`, because that form loses `firstDayOfWeek`, `index` and
 * `recurrenceTimeZone` and cannot reproduce a recurring master on write.
 */
export function normaliseRecurrence(
  recurrence: ICalendarPatternedRecurrence,
): ICalendarPatternedRecurrence {
  if (!recurrence || typeof recurrence !== 'object' || Array.isArray(recurrence)) {
    throw apiError(
      CalendarErrorCode.INVALID_RECURRENCE,
      'recurrence must be a patternedRecurrence object ({ pattern, range }), not a string array',
      { receivedType: Array.isArray(recurrence) ? 'array' : typeof recurrence },
    );
  }

  const { pattern, range } = recurrence;

  if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) {
    throw apiError(CalendarErrorCode.INVALID_RECURRENCE, 'recurrence.pattern is required');
  }

  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw apiError(CalendarErrorCode.INVALID_RECURRENCE, 'recurrence.range is required');
  }

  return {
    pattern: compact({
      type: pattern.type,
      interval: pattern.interval,
      month: pattern.month,
      dayOfMonth: pattern.dayOfMonth,
      daysOfWeek: pattern.daysOfWeek ? [...pattern.daysOfWeek] : undefined,
      firstDayOfWeek: pattern.firstDayOfWeek,
      index: pattern.index,
    }) as unknown as ICalendarPatternedRecurrence['pattern'],
    range: compact({
      type: range.type,
      startDate: range.startDate,
      endDate: range.endDate,
      numberOfOccurrences: range.numberOfOccurrences,
      recurrenceTimeZone: range.recurrenceTimeZone,
    }) as unknown as ICalendarPatternedRecurrence['range'],
  };
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Sorted, de-duplicated, comma-joined `$select` - the canonical projection.
 *
 * The array and the pre-joined string forms produce the same Graph request, so
 * they must produce the same cache entry.
 */
function normaliseSelect(select: string | string[] | undefined): string {
  if (select === undefined || select === null) return '';

  const raw = Array.isArray(select) ? select.join(',') : String(select);
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(entries)).sort().join(',');
}

/** Percent-encode one Graph path segment; Graph ids are base64 and contain `/`. */
function segment(value: string): string {
  return encodeURIComponent(String(value));
}

function requireId(value: string, name: string): string {
  const id = value === undefined || value === null ? '' : String(value).trim();

  if (!id) {
    throw apiError(CalendarErrorCode.INVALID_EVENT, `${name} is required`, { field: name });
  }

  return id;
}

/**
 * Classify `options.start`/`options.end` for the event listing methods.
 *
 * Returns `'range'` when both ends are present and `'none'` when neither is. A
 * half-specified window throws here - before any Graph call - so the caller can
 * never be handed the user's entire history when they asked for a slice of it.
 */
function classifyRange(options: IListEventsOptions): 'none' | 'range' {
  const hasStart = options.start !== undefined && options.start !== null;
  const hasEnd = options.end !== undefined && options.end !== null;

  if (hasStart !== hasEnd) {
    throw apiError(
      CalendarErrorCode.INVALID_DATE_RANGE,
      'A calendar range needs both start and end; omit both to list events without a window',
      { hasStart, hasEnd },
    );
  }

  return hasStart && hasEnd ? 'range' : 'none';
}

/** Drop `undefined` only: `false`, `0` and `''` are meaningful Graph values. */
function compact<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input || {})) {
    if (value !== undefined) output[key] = value;
  }

  return output as T;
}

/** Build the OData options bag, omitting keys the caller did not set. */
function queryOptions(options: IListEventsOptions): Record<string, unknown> {
  return compact({
    select: options.select,
    filter: options.filter,
    orderBy: options.orderBy,
    top: options.top,
    skip: options.skip,
    expand: options.expand,
    count: options.count,
  });
}

function normaliseLocation(location: ICalendarLocation): Record<string, unknown> {
  if (!location || typeof location !== 'object') {
    return { displayName: String(location) };
  }

  return compact({
    displayName: location.displayName,
    locationType: location.locationType,
    locationEmailAddress: location.locationEmailAddress,
    uniqueId: location.uniqueId,
    uniqueIdType: location.uniqueIdType,
    address: location.address,
    coordinates: location.coordinates,
  });
}

function normaliseAttendee(attendee: ICalendarAttendeeInput, index: number): ICalendarAttendee {
  const address = attendee && attendee.emailAddress
    ? String(attendee.emailAddress.address || '').trim()
    : '';

  if (!address) {
    throw apiError(
      CalendarErrorCode.INVALID_ATTENDEES,
      `attendee ${index} has no email address`,
      { index },
    );
  }

  return compact({
    type: attendee.type || 'required',
    emailAddress: compact({
      address,
      name: attendee.emailAddress.name,
    }),
  }) as unknown as ICalendarAttendee;
}

function withResolvedOffset(dateTime: string, timeZone: string): string {
  const explicit = OFFSET_SUFFIX.exec(dateTime);
  if (explicit) return dateTime;

  const offset = resolveTimeZoneOffset(dateTime, timeZone);
  return `${dateTime}${offset}`;
}

function assertValidRange(startDateTime: string, endDateTime: string): void {
  const start = Date.parse(startDateTime);
  const end = Date.parse(endDateTime);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw apiError(
      CalendarErrorCode.INVALID_DATE_TIME,
      'The range could not be parsed as absolute date/time values',
      { startDateTime, endDateTime },
    );
  }

  if (end <= start) {
    throw apiError(
      CalendarErrorCode.INVALID_DATE_RANGE,
      'The range end must be after the range start',
      { startDateTime, endDateTime },
    );
  }
}

function normaliseAvailabilityViewInterval(value: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(numeric)) return 30;

  return clampInteger(
    Math.trunc(numeric),
    MIN_AVAILABILITY_VIEW_INTERVAL,
    MAX_AVAILABILITY_VIEW_INTERVAL,
    30,
  );
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return fallback;

  return Math.max(min, Math.min(max, Math.trunc(Number(value))));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number(value)));
}

function isIanaTimeZone(zone: string): boolean {
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Offset, in minutes, of `iana` at the given zone-local date-time.
 *
 * Evaluated twice: once assuming the wall clock is UTC, then again at the
 * implied instant, so a DST boundary resolves correctly.
 */
function zoneOffsetMinutes(naiveDateTime: string, iana: string): number {
  const asUtc = Date.parse(`${naiveDateTime}Z`);

  if (!Number.isFinite(asUtc)) {
    throw apiError(
      CalendarErrorCode.INVALID_DATE_TIME,
      `"${naiveDateTime}" is not a parseable date/time`,
      { dateTime: naiveDateTime },
    );
  }

  const firstGuess = offsetAt(asUtc, iana);
  return offsetAt(asUtc - firstGuess * 60_000, iana);
}

function offsetAt(instantMs: number, iana: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: iana,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));

  const valueOf = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    return part ? Number(part.value) : 0;
  };

  const asUtc = Date.UTC(
    valueOf('year'),
    valueOf('month') - 1,
    valueOf('day'),
    valueOf('hour') % 24,
    valueOf('minute'),
    valueOf('second'),
  );

  return Math.round((asUtc - instantMs) / 60_000);
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');

  return `${sign}${hours}:${minutes}`;
}

export const AzureCalendarServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureCalendarService> = {
  service: (props: any, context: any) => new AzureCalendarService(props, context),
  id: 'azure.AzureCalendarService@1.0.0',
  name: 'AzureCalendarService',
  nameSpace: 'azure',
  version: '1.0.0',
  description:
    'Microsoft Graph calendar - calendars, calendarView ranges, event CRUD, availability and online meetings',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'azure.AzureAuditService@1.0.0', alias: 'auditService' },
    { id: 'core.RedisService@1.0.0', alias: 'redisService' },
  ],
};

export { AzureCalendarService };

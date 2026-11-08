import fs from 'fs';
import path from 'path';
import { buildSchema, graphql, GraphQLObjectType } from 'graphql';
import ApiError from '@reactory/server-core/exceptions';

/**
 * Calendar behaviour + schema-execution suite (AZ-07).
 *
 * Two layers are covered here:
 *
 *   1. the *service* contract - which endpoint, which body, which cache key -
 *      through an injected fake provider, so no live Graph call is possible;
 *   2. the *schema* contract - the SDL is executed with the stock graphql-js
 *      executor against Graph-shaped fixtures. A resolver-map key assertion
 *      cannot catch a field whose declared type does not match the payload
 *      Graph actually returns (that was QQ-1: `organizer` declared as a bare
 *      `emailAddress` while Graph sends a `recipient`), so the schema is run.
 */
// eslint-disable-next-line import/first
import {
  AzureCalendarService,
  AzureCalendarServiceDefinition,
  CalendarErrorCode,
  calendarListCacheKey,
} from '../services/AzureCalendarService';
// eslint-disable-next-line import/first
import { CALENDAR_LIST_CACHE_TTL_SECONDS } from '../types/calendar.types';
// eslint-disable-next-line import/first
import { azureCacheKey, AzureCacheDomain } from '../utils/cache-keys';
// eslint-disable-next-line import/first
import CalendarResolver from '../graphql/resolvers/CalendarResolver';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const ZONE = 'South Africa Standard Time';

const SLOT_START = { dateTime: '2026-01-05T09:00:00', timeZone: ZONE };
const SLOT_END = { dateTime: '2026-01-05T10:00:00', timeZone: ZONE };

interface IHarness {
  service: AzureCalendarService;
  provider: {
    request: jest.Mock;
    requestAll: jest.Mock;
    getClient: jest.Mock;
  };
  chain: {
    api: jest.Mock;
    get: jest.Mock;
    post: jest.Mock;
    patch: jest.Mock;
    delete: jest.Mock;
  };
  redis: { get: jest.Mock; set: jest.Mock };
  audit: { logOperation: jest.Mock };
}

function createHarness(): IHarness {
  const chain: any = {};
  chain.api = jest.fn(() => chain);
  chain.get = jest.fn();
  chain.post = jest.fn().mockResolvedValue({ id: 'event-1' });
  chain.patch = jest.fn().mockResolvedValue({ id: 'event-1' });
  chain.delete = jest.fn().mockResolvedValue(undefined);

  const provider = {
    request: jest.fn().mockResolvedValue({}),
    requestAll: jest.fn().mockResolvedValue([]),
    getClient: jest.fn(() => chain),
  };

  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };

  const audit = { logOperation: jest.fn().mockResolvedValue(undefined) };

  const context: any = {
    getService: jest.fn(() => undefined),
    user: { _id: USER_ID },
  };

  const service = new AzureCalendarService({} as any, context);
  service.setGraphClientProvider(provider);
  service.setRedisService(redis);
  service.setAuditService(audit);

  return { service, provider, chain, redis, audit };
}

describe('AzureCalendarService — calendars', () => {
  it('lists /me/calendars and caches the page for five minutes', async () => {
    const { service, provider, redis } = createHarness();
    const calendars = [{ id: 'cal-1', name: 'Calendar' }];

    provider.requestAll.mockResolvedValueOnce(calendars);
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify(calendars));

    await expect(service.listCalendars(USER_ID)).resolves.toEqual(calendars);
    await expect(service.listCalendars(USER_ID)).resolves.toEqual(calendars);

    expect(provider.requestAll).toHaveBeenCalledTimes(1);
    expect(provider.requestAll).toHaveBeenCalledWith(USER_ID, '/me/calendars', expect.any(Object));

    expect(redis.set).toHaveBeenCalledWith(
      azureCacheKey(USER_ID, AzureCacheDomain.CALENDAR_LIST),
      JSON.stringify(calendars),
      CALENDAR_LIST_CACHE_TTL_SECONDS,
    );
    expect(CALENDAR_LIST_CACHE_TTL_SECONDS).toBe(300);
  });

  it('serves the cached list without touching Graph', async () => {
    const { service, provider, redis } = createHarness();
    redis.get.mockResolvedValue(JSON.stringify([{ id: 'cached' }]));

    await expect(service.listCalendars(USER_ID)).resolves.toEqual([{ id: 'cached' }]);
    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('bypasses the cache when refresh is requested', async () => {
    const { service, provider, redis } = createHarness();
    redis.get.mockResolvedValue(JSON.stringify([{ id: 'stale' }]));
    provider.requestAll.mockResolvedValue([{ id: 'fresh' }]);

    await expect(service.listCalendars(USER_ID, { refresh: true })).resolves.toEqual([
      { id: 'fresh' },
    ]);
    expect(provider.requestAll).toHaveBeenCalledTimes(1);
  });

  it('treats a corrupt cache entry as a miss rather than failing', async () => {
    const { service, provider, redis } = createHarness();
    redis.get.mockResolvedValue('{not json');
    provider.requestAll.mockResolvedValue([{ id: 'from-graph' }]);

    await expect(service.listCalendars(USER_ID)).resolves.toEqual([{ id: 'from-graph' }]);
  });

  it('reads one calendar by id', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ id: 'cal-1' });

    await service.getCalendar(USER_ID, 'cal-1');
    expect(provider.request).toHaveBeenCalledWith(USER_ID, '/me/calendars/cal-1');
  });

  it('rejects a missing calendar id before calling Graph', async () => {
    const { service, provider } = createHarness();

    await expect(service.getCalendar(USER_ID, '  ')).rejects.toMatchObject({
      code: CalendarErrorCode.INVALID_EVENT,
    });
    expect(provider.request).not.toHaveBeenCalled();
  });
});

describe('AzureCalendarService — calendar-list cache key (QQ-2 regression)', () => {
  /** A cache that actually stores, so a shared key is observable. */
  function cachedHarness() {
    const harness = createHarness();
    const store = new Map<string, string>();

    harness.redis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
    harness.redis.set.mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    });

    return { ...harness, store };
  }

  it('keeps the stable key for an option-free read', () => {
    expect(calendarListCacheKey(USER_ID)).toBe(
      azureCacheKey(USER_ID, AzureCacheDomain.CALENDAR_LIST),
    );
    expect(calendarListCacheKey(USER_ID, {})).toBe(
      azureCacheKey(USER_ID, AzureCacheDomain.CALENDAR_LIST),
    );
  });

  it('files a projected read under a different key than an unqualified read', () => {
    const plain = calendarListCacheKey(USER_ID);
    const projected = calendarListCacheKey(USER_ID, { select: ['id', 'name'] });
    const topped = calendarListCacheKey(USER_ID, { top: 5 });

    expect(projected).not.toBe(plain);
    expect(topped).not.toBe(plain);
    expect(projected).not.toBe(topped);
    expect(projected.startsWith(`${plain}:`)).toBe(true);
  });

  it('is insensitive to select order and duplicates', () => {
    expect(calendarListCacheKey(USER_ID, { select: ['name', 'id'] })).toBe(
      calendarListCacheKey(USER_ID, { select: ['id', 'name', 'id'] }),
    );
  });

  it('never serves a projected page to an unqualified caller', async () => {
    const { service, provider } = cachedHarness();
    const projected = [{ id: 'cal-1', name: 'Calendar' }];
    const full = [{ id: 'cal-1', name: 'Calendar', isDefaultCalendar: true, canEdit: true }];

    provider.requestAll
      .mockResolvedValueOnce(projected)
      .mockResolvedValueOnce(full);

    // A projected read caches only the projection.
    await expect(service.listCalendars(USER_ID, { select: ['id', 'name'] })).resolves.toEqual(projected);

    // An unqualified read must NOT be served the projection - it re-reads Graph.
    await expect(service.listCalendars(USER_ID)).resolves.toEqual(full);
    expect(provider.requestAll).toHaveBeenCalledTimes(2);

    // ... and is then served from its own cache entry.
    await expect(service.listCalendars(USER_ID)).resolves.toEqual(full);
    expect(provider.requestAll).toHaveBeenCalledTimes(2);

    // The projection is still cached under its own key (no extra Graph call).
    await expect(service.listCalendars(USER_ID, { select: ['name', 'id'] })).resolves.toEqual(
      projected,
    );
    expect(provider.requestAll).toHaveBeenCalledTimes(2);
  });
});

describe('AzureCalendarService — events and date windows', () => {
  it('uses /me/events when no window is supplied', async () => {
    const { service, provider } = createHarness();

    await service.listEvents(USER_ID, { top: 10 });
    expect(provider.requestAll).toHaveBeenCalledWith(USER_ID, '/me/events', { top: 10 });
  });

  it('routes a ranged list to /me/calendarView and never /me/events', async () => {
    const { service, provider } = createHarness();

    await service.listEvents(USER_ID, { start: SLOT_START, end: SLOT_END });

    const requestPath = provider.requestAll.mock.calls[0][1];
    expect(requestPath).toContain('/me/calendarView?');
    expect(requestPath).not.toContain('/me/events');
    expect(requestPath).toContain('startDateTime=');
    expect(requestPath).toContain('endDateTime=');
  });

  it('rejects a half-specified range instead of silently returning everything', async () => {
    const { service, provider } = createHarness();

    await expect(service.listEvents(USER_ID, { start: SLOT_START })).rejects.toMatchObject({
      code: CalendarErrorCode.INVALID_DATE_RANGE,
    });
    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('reads listCalendarView from /me/calendarView', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarView(USER_ID, SLOT_START, SLOT_END);

    expect(provider.requestAll).toHaveBeenCalledTimes(1);
    expect(provider.requestAll.mock.calls[0][1]).toContain('/me/calendarView?');
  });

  it('scopes a calendarView to one calendar when calendarId is given', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarView(USER_ID, SLOT_START, SLOT_END, { calendarId: 'cal-1' });

    expect(provider.requestAll.mock.calls[0][1]).toContain('/me/calendars/cal-1/calendarView?');
  });

  it('rejects an inverted window before calling Graph', async () => {
    const { service, provider } = createHarness();

    await expect(service.listCalendarView(USER_ID, SLOT_END, SLOT_START)).rejects.toMatchObject({
      code: CalendarErrorCode.INVALID_DATE_RANGE,
    });
    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('reads one calendar’s events and encodes the calendar id', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarEvents(USER_ID, 'AAMk+/=');

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      '/me/calendars/AAMk%2B%2F%3D/events',
      expect.any(Object),
    );
  });

  it('rejects a missing calendar id on listCalendarEvents', async () => {
    const { service, provider } = createHarness();

    await expect(service.listCalendarEvents(USER_ID, '')).rejects.toMatchObject({
      code: CalendarErrorCode.INVALID_EVENT,
    });
    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('reads a single event by id', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ id: 'ev-1' });

    await service.getEvent(USER_ID, 'ev-1', { select: ['id', 'subject'] });

    expect(provider.request).toHaveBeenCalledWith(USER_ID, '/me/events/ev-1', {
      select: ['id', 'subject'],
      expand: undefined,
    });
  });

  it('rejects a missing event id on getEvent', async () => {
    const { service, provider } = createHarness();

    await expect(service.getEvent(USER_ID, '')).rejects.toMatchObject({
      code: CalendarErrorCode.INVALID_EVENT,
    });
    expect(provider.request).not.toHaveBeenCalled();
  });
});

describe('AzureCalendarService — event write operations', () => {
  it('creates an event with dateTimeTimeZone objects and Teams online meeting', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({
      id: 'ev-1',
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
    });

    const event = await service.createEvent(USER_ID, {
      subject: 'Design review',
      start: SLOT_START,
      end: SLOT_END,
      isOnlineMeeting: true,
    });

    expect(chain.api).toHaveBeenCalledWith('/me/events');

    const body = chain.post.mock.calls[0][0];
    expect(body).toMatchObject({
      subject: 'Design review',
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
      start: SLOT_START,
      end: SLOT_END,
    });
    expect(body.joinUrl).toBeUndefined();
    expect(body.onlineMeeting).toBeUndefined();

    // Graph owns the join link; it is read back, never constructed.
    expect(event.onlineMeeting.joinUrl).toBe('https://teams.microsoft.com/l/meetup-join/abc');
  });

  it('honours an explicit online meeting provider', async () => {
    const { service, chain } = createHarness();

    await service.createEvent(USER_ID, {
      subject: 'Skype call',
      start: SLOT_START,
      end: SLOT_END,
      isOnlineMeeting: true,
      onlineMeetingProvider: 'skypeForBusiness',
    });

    expect(chain.post.mock.calls[0][0].onlineMeetingProvider).toBe('skypeForBusiness');
  });

  it('does not send an online meeting provider when the meeting is not online', async () => {
    const { service, chain } = createHarness();

    await service.createEvent(USER_ID, {
      subject: 'Room booking',
      start: SLOT_START,
      end: SLOT_END,
      isOnlineMeeting: false,
    });

    const body = chain.post.mock.calls[0][0];
    expect(body.isOnlineMeeting).toBe(false);
    expect(body.onlineMeetingProvider).toBeUndefined();
  });

  it('creates in a named calendar and keeps calendarId out of the body', async () => {
    const { service, chain } = createHarness();

    await service.createEvent(USER_ID, {
      calendarId: 'cal-1',
      subject: 'Team sync',
      start: SLOT_START,
      end: SLOT_END,
    });

    expect(chain.api).toHaveBeenCalledWith('/me/calendars/cal-1/events');
    expect(chain.post.mock.calls[0][0].calendarId).toBeUndefined();
  });

  it('refuses to create an event without both ends of the slot', async () => {
    const { service, chain } = createHarness();

    await expect(
      service.createEvent(USER_ID, { subject: 'No slot' } as any),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_EVENT });
    expect(chain.post).not.toHaveBeenCalled();
  });

  it('updates an event with PATCH and dateTimeTimeZone objects', async () => {
    const { service, chain } = createHarness();

    await service.updateEvent(USER_ID, 'ev-1', { start: SLOT_START, end: SLOT_END });

    expect(chain.api).toHaveBeenCalledWith('/me/events/ev-1');
    expect(chain.patch).toHaveBeenCalledWith({ start: SLOT_START, end: SLOT_END });
  });

  it('refuses an empty update', async () => {
    const { service, chain } = createHarness();

    await expect(service.updateEvent(USER_ID, 'ev-1', {})).rejects.toMatchObject({
      code: CalendarErrorCode.INVALID_EVENT,
    });
    expect(chain.patch).not.toHaveBeenCalled();
  });

  it('deletes an event', async () => {
    const { service, chain } = createHarness();

    await expect(service.deleteEvent(USER_ID, 'ev-1')).resolves.toBe(true);
    expect(chain.api).toHaveBeenCalledWith('/me/events/ev-1');
    expect(chain.delete).toHaveBeenCalledTimes(1);
  });

  it('cancels with the documented capitalised Comment property', async () => {
    const { service, chain } = createHarness();

    await expect(service.cancelEvent(USER_ID, 'ev-1', { comment: 'Moved' })).resolves.toBe(true);

    expect(chain.api).toHaveBeenCalledWith('/me/events/ev-1/cancel');
    expect(chain.post).toHaveBeenCalledWith({ Comment: 'Moved' });
  });

  it('sends an empty Comment when the caller supplies none', async () => {
    const { service, chain } = createHarness();

    await service.cancelEvent(USER_ID, 'ev-1');

    expect(chain.post).toHaveBeenCalledWith({ Comment: '' });
  });

  it('accepts, declines and tentatively accepts over the documented actions', async () => {
    const { service, chain } = createHarness();

    await expect(service.acceptEvent(USER_ID, 'ev-1', { comment: 'ok' })).resolves.toBe(true);
    expect(chain.api).toHaveBeenCalledWith('/me/events/ev-1/accept');
    expect(chain.post).toHaveBeenLastCalledWith({ comment: 'ok', sendResponse: true });

    await expect(service.declineEvent(USER_ID, 'ev-1', { sendResponse: false })).resolves.toBe(true);
    expect(chain.api).toHaveBeenCalledWith('/me/events/ev-1/decline');
    expect(chain.post).toHaveBeenLastCalledWith({ comment: '', sendResponse: false });

    await expect(service.tentativelyAcceptEvent(USER_ID, 'ev-1')).resolves.toBe(true);
    expect(chain.api).toHaveBeenCalledWith('/me/events/ev-1/tentativelyAccept');
    expect(chain.post).toHaveBeenLastCalledWith({ comment: '', sendResponse: true });
  });

  it('surfaces a Graph failure as an ApiError that keeps the Graph code', async () => {
    const { service, chain } = createHarness();
    chain.post.mockRejectedValue({
      statusCode: 404,
      code: 'ErrorItemNotFound',
      message: 'The specified object was not found in the store.',
    });

    let caught: any;
    try {
      await service.acceptEvent(USER_ID, 'missing');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('ErrorItemNotFound');
    expect(caught.status).toBe(404);
  });
});

describe('AzureCalendarService — audit trail (QQ-4)', () => {
  it('records a successful create with its metadata and no graphCode', async () => {
    const { service, chain, audit } = createHarness();
    chain.post.mockResolvedValue({ id: 'ev-1' });

    await service.createEvent(USER_ID, { subject: 'S', start: SLOT_START, end: SLOT_END });

    expect(audit.logOperation).toHaveBeenCalledTimes(1);
    expect(audit.logOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        operation: 'calendar.createEvent',
        resource: '/me/events',
        outcome: 'success',
        metadata: { eventId: 'ev-1', isOnlineMeeting: false },
      }),
    );
    expect(audit.logOperation.mock.calls[0][0].graphCode).toBeUndefined();
  });

  it('puts the Graph code in the dedicated graphCode field on failure', async () => {
    const { service, chain, audit } = createHarness();
    chain.post.mockRejectedValue({
      statusCode: 400,
      code: 'ErrorInvalidRequest',
      message: 'bad request',
    });

    await expect(
      service.createEvent(USER_ID, { subject: 'S', start: SLOT_START, end: SLOT_END }),
    ).rejects.toMatchObject({ code: 'ErrorInvalidRequest' });

    const entry = audit.logOperation.mock.calls[0][0];
    expect(entry.outcome).toBe('failure');
    expect(entry.graphCode).toBe('ErrorInvalidRequest');
    // Not buried in metadata - a consumer filtering on graphCode must find it.
    expect(entry.metadata).toBeUndefined();
  });

  it('never fails the operation when the audit service throws', async () => {
    const { service, chain, audit } = createHarness();
    chain.post.mockResolvedValue({ id: 'ev-1' });
    audit.logOperation.mockRejectedValue(new Error('audit store down'));

    await expect(
      service.createEvent(USER_ID, { subject: 'S', start: SLOT_START, end: SLOT_END }),
    ).resolves.toMatchObject({ id: 'ev-1' });
  });

  it('works without an audit service at all', async () => {
    const { service, chain } = createHarness();
    (service as any).setAuditService(undefined);
    (service as any)._auditService = undefined;
    chain.post.mockResolvedValue({ id: 'ev-1' });

    await expect(
      service.createEvent(USER_ID, { subject: 'S', start: SLOT_START, end: SLOT_END }),
    ).resolves.toMatchObject({ id: 'ev-1' });
  });
});

describe('AzureCalendarService — availability', () => {
  it('sends the documented getSchedule body with availabilityViewInterval', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({
      value: [{ scheduleId: 'someone@example.test', availabilityView: '0002' }],
    });

    const result = await service.getSchedule(
      USER_ID,
      ['someone@example.test'],
      SLOT_START,
      SLOT_END,
    );

    expect(chain.api).toHaveBeenCalledWith('/me/calendar/getSchedule');
    expect(chain.post).toHaveBeenCalledWith({
      schedules: ['someone@example.test'],
      startTime: SLOT_START,
      endTime: SLOT_END,
      availabilityViewInterval: 30,
    });
    expect(result).toEqual([{ scheduleId: 'someone@example.test', availabilityView: '0002' }]);
  });

  it('honours an explicit availability view interval', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ value: [] });

    await service.getSchedule(USER_ID, ['a@example.test'], SLOT_START, SLOT_END, 15);

    expect(chain.post.mock.calls[0][0].availabilityViewInterval).toBe(15);
  });

  it('clamps the interval into Graph’s documented 5-1440 minute range', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ value: [] });

    await service.getSchedule(USER_ID, ['a@example.test'], SLOT_START, SLOT_END, 1);
    expect(chain.post.mock.calls[0][0].availabilityViewInterval).toBe(5);

    await service.getSchedule(USER_ID, ['a@example.test'], SLOT_START, SLOT_END, 5000);
    expect(chain.post.mock.calls[1][0].availabilityViewInterval).toBe(1440);
  });

  it('refuses getSchedule without schedules', async () => {
    const { service, chain } = createHarness();

    await expect(
      service.getSchedule(USER_ID, [], SLOT_START, SLOT_END),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_SCHEDULES });
    expect(chain.post).not.toHaveBeenCalled();
  });

  it('refuses getSchedule when every schedule is blank', async () => {
    const { service, chain } = createHarness();

    await expect(
      service.getSchedule(USER_ID, ['  ', ''], SLOT_START, SLOT_END),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_SCHEDULES });
    expect(chain.post).not.toHaveBeenCalled();
  });

  it('returns [] when Graph omits the value array rather than throwing', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({});

    await expect(
      service.getSchedule(USER_ID, ['a@example.test'], SLOT_START, SLOT_END),
    ).resolves.toEqual([]);
  });

  it('posts findMeetingTimes with timeConstraint timeslots and returns the suggestions', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({
      meetingTimeSuggestions: [
        { confidence: 100, order: 1, suggestionReason: 'Suggested because it is the earliest time' },
      ],
      emptySuggestionsReason: '',
    });

    const result = await service.findMeetingTimes(USER_ID, {
      attendees: [{ emailAddress: { address: 'b@example.test', name: 'B' }, type: 'required' }],
      start: SLOT_START,
      end: SLOT_END,
    });

    expect(chain.api).toHaveBeenCalledWith('/me/findMeetingTimes');
    expect(chain.post).toHaveBeenCalledWith({
      attendees: [{ type: 'required', emailAddress: { address: 'b@example.test', name: 'B' } }],
      timeConstraint: { timeslots: [{ start: SLOT_START, end: SLOT_END }] },
      meetingDuration: 'PT30M',
      maxCandidates: 20,
      isOrganizerOptional: false,
      returnSuggestionReasons: false,
    });

    expect(result.meetingTimeSuggestions).toHaveLength(1);
    expect(result.emptySuggestionsReason).toBe('');
  });

  it('passes suggestion options and a location constraint through', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ meetingTimeSuggestions: [] });

    const locationConstraint = {
      isRequired: true,
      suggestLocation: false,
      locations: [{ displayName: 'Boardroom' }],
    };

    await service.findMeetingTimes(USER_ID, {
      attendees: [{ emailAddress: { address: 'b@example.test' } }],
      start: SLOT_START,
      end: SLOT_END,
      meetingDuration: 'PT45M',
      maxCandidates: 500,
      isOrganizerOptional: true,
      returnSuggestionReasons: true,
      minimumAttendeePercentage: 150,
      activityDomain: 'workHours',
      locationConstraint,
    });

    const body = chain.post.mock.calls[0][0];
    expect(body.meetingDuration).toBe('PT45M');
    expect(body.maxCandidates).toBe(100);
    expect(body.isOrganizerOptional).toBe(true);
    expect(body.returnSuggestionReasons).toBe(true);
    expect(body.minimumAttendeePercentage).toBe(100);
    expect(body.timeConstraint.activityDomain).toBe('workHours');
    expect(body.locationConstraint).toEqual(locationConstraint);
  });

  it('normalises an empty suggestion result', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ emptySuggestionsReason: 'AttendeesUnavailable' });

    await expect(
      service.findMeetingTimes(USER_ID, {
        attendees: [{ emailAddress: { address: 'b@example.test' } }],
        start: SLOT_START,
        end: SLOT_END,
      }),
    ).resolves.toEqual({
      meetingTimeSuggestions: [],
      emptySuggestionsReason: 'AttendeesUnavailable',
    });
  });

  it('refuses findMeetingTimes without attendees', async () => {
    const { service, chain } = createHarness();

    await expect(
      service.findMeetingTimes(USER_ID, { attendees: [], start: SLOT_START, end: SLOT_END }),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_ATTENDEES });
    expect(chain.post).not.toHaveBeenCalled();
  });

  it('refuses an attendee with no email address', async () => {
    const { service, chain } = createHarness();

    await expect(
      service.findMeetingTimes(USER_ID, {
        attendees: [{ emailAddress: { address: '   ' } }],
        start: SLOT_START,
        end: SLOT_END,
      }),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_ATTENDEES });
    expect(chain.post).not.toHaveBeenCalled();
  });
});

describe('AzureCalendarService — recurrence', () => {
  const recurrence = {
    pattern: {
      type: 'weekly',
      interval: 1,
      daysOfWeek: ['monday', 'wednesday'],
      firstDayOfWeek: 'sunday',
    },
    range: {
      type: 'noEnd',
      startDate: '2026-01-05',
      recurrenceTimeZone: ZONE,
    },
  };

  it('returns a recurring master’s patternedRecurrence intact', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({
      id: 'master-1',
      type: 'seriesMaster',
      start: SLOT_START,
      end: SLOT_END,
      recurrence,
    });

    const event = await service.getEvent(USER_ID, 'master-1');

    expect(event.type).toBe('seriesMaster');
    expect(event.recurrence).toEqual(recurrence);
    expect(Array.isArray(event.recurrence)).toBe(false);
  });

  it('writes recurrence as a patternedRecurrence object, never a string array', async () => {
    const { service, chain } = createHarness();

    await service.createEvent(USER_ID, {
      subject: 'Weekly sync',
      start: SLOT_START,
      end: SLOT_END,
      recurrence,
    });

    const sent = chain.post.mock.calls[0][0].recurrence;
    expect(Array.isArray(sent)).toBe(false);
    expect(typeof sent).toBe('object');
    expect(sent).toEqual(recurrence);
    expect(sent.pattern.firstDayOfWeek).toBe('sunday');
  });

  it('rejects Google-style string-array recurrence at the boundary', async () => {
    const { service, chain } = createHarness();

    await expect(
      service.createEvent(USER_ID, {
        subject: 'Weekly sync',
        start: SLOT_START,
        end: SLOT_END,
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] as any,
      }),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_RECURRENCE });
    expect(chain.post).not.toHaveBeenCalled();
  });

  it('clears a recurrence with an explicit null', async () => {
    const { service, chain } = createHarness();

    await service.updateEvent(USER_ID, 'ev-1', { recurrence: null });

    expect(chain.patch).toHaveBeenCalledWith({ recurrence: null });
  });
});

/* -------------------------------------------------------------------------- */
/* Schema execution (stock graphql-js executor) - the QQ-1 regression guard    */
/* -------------------------------------------------------------------------- */

const BASE_SDL = `
  scalar DateTime
  type Query { _empty: Boolean }
  type Mutation { _empty: Boolean }
`;

/** Build the module's Calendar schema and attach this resolver's field map. */
function buildCalendarSchema() {
  const sdl = fs.readFileSync(
    path.resolve(__dirname, '..', 'graphql', 'types', 'Calendar.graphql'),
    'utf8',
  );

  const schema = buildSchema(`${BASE_SDL}\n${sdl}`);
  const resolverMap: any = (CalendarResolver as any).prototype.resolver;

  for (const [name, entry] of Object.entries(resolverMap.Query || {})) {
    const field = schema.getQueryType()?.getFields()[name];
    if (field) (field as any).resolve = entry;
  }

  for (const [name, entry] of Object.entries(resolverMap.Mutation || {})) {
    const field = schema.getMutationType()?.getFields()[name];
    if (field) (field as any).resolve = entry;
  }

  return schema;
}

/**
 * Executes a query with the stock executor against Graph-shaped fixtures.
 *
 * Fixtures are copied from the shapes Microsoft Graph actually returns, not from
 * the module's own TS types - a fixture derived from our types would agree with
 * a wrong SDL and prove nothing.
 */
function execute(query: string, service: any) {
  const schema = buildCalendarSchema();
  const contextValue: any = {
    user: { _id: USER_ID },
    hasRole: jest.fn(() => true),
    getService: jest.fn(() => service),
  };

  return graphql({ schema, source: query, contextValue });
}

const GRAPH_EVENT: Record<string, any> = {
  id: 'AAMkAD-event-1',
  subject: 'Weekly sync',
  bodyPreview: 'Agenda attached',
  start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: ZONE },
  end: { dateTime: '2026-01-05T10:00:00.0000000', timeZone: ZONE },
  isAllDay: false,
  isCancelled: false,
  isOnlineMeeting: true,
  onlineMeetingProvider: 'teamsForBusiness',
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting' },
  // Graph types this as `Recipient` - an address wrapped in `emailAddress`.
  organizer: { emailAddress: { name: 'Werner Weber', address: 'werner@example.test' } },
  attendees: [
    {
      type: 'required',
      status: { response: 'none', time: '0001-01-01T00:00:00Z' },
      emailAddress: { name: 'Attendee One', address: 'one@example.test' },
    },
  ],
  seriesMasterId: null,
  type: 'seriesMaster',
  responseStatus: { response: 'organizer', time: '0001-01-01T00:00:00Z' },
  webLink: 'https://outlook.office365.com/owa/?itemid=AAMkAD-event-1',
  createdDateTime: '2026-01-01T08:00:00Z',
  lastModifiedDateTime: '2026-01-01T08:00:00Z',
  iCalUId: 'iCal-uid-1',
  categories: ['Design'],
  sensitivity: 'normal',
  showAs: 'busy',
  importance: 'normal',
  hasAttachments: false,
  reminderMinutesBeforeStart: 15,
  isReminderOn: true,
  changeKey: 'change-1',
  recurrence: {
    pattern: {
      type: 'weekly',
      interval: 1,
      daysOfWeek: ['monday', 'wednesday'],
      firstDayOfWeek: 'sunday',
    },
    range: { type: 'noEnd', startDate: '2026-01-05', recurrenceTimeZone: ZONE },
  },
};

const GRAPH_SCHEDULE_INFORMATION: Record<string, any> = {
  scheduleId: 'someone@example.test',
  availabilityView: '00022200',
  workingHours: {
    daysOfWeek: ['monday', 'tuesday'],
    startTime: '08:00:00.0000000',
    endTime: '17:00:00.0000000',
    timeZone: { name: ZONE },
  },
  scheduleItems: [
    {
      isPrivate: false,
      start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: ZONE },
      end: { dateTime: '2026-01-05T10:00:00.0000000', timeZone: ZONE },
      status: 'busy',
      subject: 'Standup',
      location: 'Teams',
    },
  ],
  error: undefined,
};

const GRAPH_MEETING_TIMES: Record<string, any> = {
  meetingTimeSuggestions: [
    {
      confidence: 100,
      order: 1,
      organizerAvailability: 'free',
      suggestionReason: 'Suggested because it is the earliest time',
      // Graph types this as `AttendeeBase`, which extends `Recipient`.
      attendeeAvailability: [
        {
          availability: 'free',
          attendee: { emailAddress: { name: 'Attendee One', address: 'one@example.test' } },
        },
      ],
      meetingTimeSlot: {
        start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: ZONE },
        end: { dateTime: '2026-01-05T09:30:00.0000000', timeZone: ZONE },
        startTimeZone: { name: ZONE },
        endTimeZone: { name: ZONE },
      },
    },
  ],
  emptySuggestionsReason: '',
};

describe('Calendar GraphQL schema execution (QQ-1)', () => {
  it('exposes the eleven documented operations and no placeholder', () => {
    const schema = buildCalendarSchema();
    const queries = Object.keys(schema.getQueryType()!.getFields()).filter((name) => name !== '_empty');
    const mutations = Object.keys(schema.getMutationType()!.getFields()).filter((name) => name !== '_empty');

    expect(queries.sort()).toEqual([
      'azureCalendarEvent',
      'azureCalendarEvents',
      'azureCalendarSchedule',
      'azureCalendarView',
      'azureCalendars',
      'azureFindMeetingTimes',
    ]);
    expect(mutations.sort()).toEqual([
      'azureCancelEvent',
      'azureCreateEvent',
      'azureDeleteEvent',
      'azureRespondToEvent',
      'azureUpdateEvent',
    ]);
    expect(schema.getQueryType()!.getFields()._azureCalendarPlaceholder).toBeUndefined();
  });

  it('models organizer and attendeeAvailability.attendee as recipients', () => {
    const schema = buildCalendarSchema();
    const event = schema.getType('AzureCalendarEvent') as GraphQLObjectType;
    const availability = schema.getType('AzureCalendarAttendeeAvailability') as GraphQLObjectType;

    expect((event.getFields().organizer.type as any).name).toBe('AzureCalendarRecipient');
    expect((availability.getFields().attendee.type as any).name).toBe('AzureCalendarRecipient');
  });

  it('advertises azureCalendarEvents as unwindowed and points clients at azureCalendarView', () => {
    const schema = buildCalendarSchema();
    const field = schema.getQueryType()!.getFields().azureCalendarEvents;

    // The field declares no start/end: a description promising that supplying
    // them "routes to azureCalendarView" would send a client into a validation
    // error, so the schema must say where windows belong instead.
    expect(field.args.map((arg) => arg.name)).toEqual([
      'calendarId',
      'filter',
      'orderBy',
      'select',
      'top',
      'skip',
    ]);
    expect(field.description).toMatch(/no start\/end arguments/);
    expect(field.description).toMatch(/azureCalendarView/);
  });

  it('routes azureCalendarEvents(calendarId) to that calendar through listEvents', async () => {
    const service = { listEvents: jest.fn().mockResolvedValue([GRAPH_EVENT]) };

    const result = await execute(
      `query { azureCalendarEvents(calendarId: "cal-1", top: 5) { id } }`,
      service,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.azureCalendarEvents).toEqual([{ id: 'AAMkAD-event-1' }]);
    // One call, one rule: `listEvents` honours the calendarId (routing to
    // /me/calendars/{id}/events) instead of the resolver widening the read.
    expect(service.listEvents).toHaveBeenCalledWith(USER_ID, {
      filter: undefined,
      orderBy: undefined,
      select: undefined,
      top: 5,
      skip: undefined,
      calendarId: 'cal-1',
    });
  });

  it('resolves organizer as a recipient for azureCalendarEvents', async () => {

    const service = {
      listEvents: jest.fn().mockResolvedValue([GRAPH_EVENT]),
    };

    const result = await execute(
      `query {
        azureCalendarEvents {
          id
          subject
          organizer { emailAddress { name address } }
          attendees { type emailAddress { name address } status { response } }
        }
      }`,
      service,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.azureCalendarEvents).toEqual([
      {
        id: 'AAMkAD-event-1',
        subject: 'Weekly sync',
        organizer: { emailAddress: { name: 'Werner Weber', address: 'werner@example.test' } },
        attendees: [
          {
            type: 'required',
            emailAddress: { name: 'Attendee One', address: 'one@example.test' },
            status: { response: 'none' },
          },
        ],
      },
    ]);
  });

  it('resolves a full Graph event, including onlineMeeting and recurrence', async () => {
    const service = { getEvent: jest.fn().mockResolvedValue(GRAPH_EVENT) };

    const result = await execute(
      `query {
        azureCalendarEvent(eventId: "AAMkAD-event-1") {
          id type isOnlineMeeting onlineMeetingProvider
          start { dateTime timeZone }
          end { dateTime timeZone }
          onlineMeeting { joinUrl }
          organizer { emailAddress { address } }
          recurrence {
            pattern { type interval daysOfWeek firstDayOfWeek }
            range { type startDate recurrenceTimeZone }
          }
          categories
          reminderMinutesBeforeStart
          createdDateTime
        }
      }`,
      service,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      azureCalendarEvent: {
        id: 'AAMkAD-event-1',
        type: 'seriesMaster',
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: ZONE },
        end: { dateTime: '2026-01-05T10:00:00.0000000', timeZone: ZONE },
        onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting' },
        organizer: { emailAddress: { address: 'werner@example.test' } },
        recurrence: {
          pattern: {
            type: 'weekly',
            interval: 1,
            daysOfWeek: ['monday', 'wednesday'],
            firstDayOfWeek: 'sunday',
          },
          range: { type: 'noEnd', startDate: '2026-01-05', recurrenceTimeZone: ZONE },
        },
        categories: ['Design'],
        reminderMinutesBeforeStart: 15,
        createdDateTime: '2026-01-01T08:00:00Z',
      },
    });
  });

  it('resolves a calendarView page of occurrences', async () => {
    const occurrence = {
      ...GRAPH_EVENT,
      id: 'AAMkAD-occurrence-1',
      type: 'occurrence',
      seriesMasterId: 'AAMkAD-event-1',
    };
    const service = { listCalendarView: jest.fn().mockResolvedValue([occurrence]) };

    const result = await execute(
      `query {
        azureCalendarView(
          start: { dateTime: "2026-01-05T00:00:00", timeZone: "South Africa Standard Time" }
          end: { dateTime: "2026-01-12T00:00:00", timeZone: "South Africa Standard Time" }
        ) {
          id type seriesMasterId organizer { emailAddress { address } }
        }
      }`,
      service,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.azureCalendarView).toEqual([
      {
        id: 'AAMkAD-occurrence-1',
        type: 'occurrence',
        seriesMasterId: 'AAMkAD-event-1',
        organizer: { emailAddress: { address: 'werner@example.test' } },
      },
    ]);
    expect(service.listCalendarView).toHaveBeenCalledWith(
      USER_ID,
      { dateTime: '2026-01-05T00:00:00', timeZone: ZONE },
      { dateTime: '2026-01-12T00:00:00', timeZone: ZONE },
      expect.objectContaining({ calendarId: undefined }),
    );
  });

  it('resolves schedule information, whose scheduleItem has no organizer', async () => {
    const service = {
      getSchedule: jest.fn().mockResolvedValue([GRAPH_SCHEDULE_INFORMATION]),
    };

    const result = await execute(
      `query {
        azureCalendarSchedule(
          schedules: ["someone@example.test"]
          start: { dateTime: "2026-01-05T08:00:00", timeZone: "South Africa Standard Time" }
          end: { dateTime: "2026-01-05T18:00:00", timeZone: "South Africa Standard Time" }
          availabilityViewInterval: 30
        ) {
          scheduleId
          availabilityView
          workingHours { daysOfWeek startTime endTime timeZone { name } }
          scheduleItems { subject status isPrivate start { dateTime timeZone } location }
        }
      }`,
      service,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.azureCalendarSchedule).toEqual([
      {
        scheduleId: 'someone@example.test',
        availabilityView: '00022200',
        workingHours: {
          daysOfWeek: ['monday', 'tuesday'],
          startTime: '08:00:00.0000000',
          endTime: '17:00:00.0000000',
          timeZone: { name: ZONE },
        },
        scheduleItems: [
          {
            subject: 'Standup',
            status: 'busy',
            isPrivate: false,
            start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: ZONE },
            location: 'Teams',
          },
        ],
      },
    ]);
  });

  it('does not expose a phantom organizer on AzureCalendarScheduleItem', () => {
    const schema = buildCalendarSchema();
    const scheduleItem = schema.getType('AzureCalendarScheduleItem') as GraphQLObjectType;

    // v1.0 graph.scheduleItem has no organizer; an always-null field would read
    // as "this meeting has no organizer" to a client.
    expect(scheduleItem.getFields().organizer).toBeUndefined();
  });

  it('resolves meeting-time suggestions with recipient-shaped attendees', async () => {
    const service = { findMeetingTimes: jest.fn().mockResolvedValue(GRAPH_MEETING_TIMES) };

    const result = await execute(
      `query {
        azureFindMeetingTimes(
          attendees: [{ emailAddress: { address: "one@example.test", name: "Attendee One" }, type: "required" }]
          start: { dateTime: "2026-01-05T08:00:00", timeZone: "South Africa Standard Time" }
          end: { dateTime: "2026-01-05T18:00:00", timeZone: "South Africa Standard Time" }
        ) {
          meetingTimeSuggestions {
            confidence order suggestionReason organizerAvailability
            attendeeAvailability { availability attendee { emailAddress { name address } } }
            meetingTimeSlot {
              start { dateTime timeZone }
              end { dateTime timeZone }
              startTimeZone { name }
            }
          }
          emptySuggestionsReason
        }
      }`,
      service,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      azureFindMeetingTimes: {
        meetingTimeSuggestions: [
          {
            confidence: 100,
            order: 1,
            suggestionReason: 'Suggested because it is the earliest time',
            organizerAvailability: 'free',
            attendeeAvailability: [
              {
                availability: 'free',
                attendee: { emailAddress: { name: 'Attendee One', address: 'one@example.test' } },
              },
            ],
            meetingTimeSlot: {
              start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: ZONE },
              end: { dateTime: '2026-01-05T09:30:00.0000000', timeZone: ZONE },
              startTimeZone: { name: ZONE },
            },
          },
        ],
        emptySuggestionsReason: '',
      },
    });
  });

  it('runs all five mutations through the schema', async () => {
    const event = { ...GRAPH_EVENT, id: 'ev-new' };
    const updated = { ...GRAPH_EVENT, id: 'ev-new', subject: 'Design review (moved)' };
    const service = {
      createEvent: jest.fn().mockResolvedValue(event),
      updateEvent: jest.fn().mockResolvedValue(updated),
      deleteEvent: jest.fn().mockResolvedValue(true),
      cancelEvent: jest.fn().mockResolvedValue(true),
      acceptEvent: jest.fn().mockResolvedValue(true),
      declineEvent: jest.fn().mockResolvedValue(true),
      tentativelyAcceptEvent: jest.fn().mockResolvedValue(true),
    };

    const result = await execute(
      `mutation {
        azureCreateEvent(input: {
          subject: "Design review"
          start: { dateTime: "2026-01-05T09:00:00", timeZone: "South Africa Standard Time" }
          end: { dateTime: "2026-01-05T10:00:00", timeZone: "South Africa Standard Time" }
          isOnlineMeeting: true
        }) { id organizer { emailAddress { address } } }
        azureUpdateEvent(eventId: "ev-new", input: {
          subject: "Design review (moved)"
          start: { dateTime: "2026-01-05T11:00:00", timeZone: "South Africa Standard Time" }
          end: { dateTime: "2026-01-05T12:00:00", timeZone: "South Africa Standard Time" }
        }) { id subject start { dateTime timeZone } }
        azureDeleteEvent(eventId: "ev-new")
        azureCancelEvent(eventId: "ev-new", comment: "Moved")
        azureRespondToEvent(eventId: "ev-new", response: accept)
      }`,
      service,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      azureCreateEvent: {
        id: 'ev-new',
        organizer: { emailAddress: { address: 'werner@example.test' } },
      },
      azureUpdateEvent: {
        id: 'ev-new',
        subject: 'Design review (moved)',
        start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: ZONE },
      },
      azureDeleteEvent: true,
      azureCancelEvent: true,
      azureRespondToEvent: true,
    });

    expect(service.createEvent).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        subject: 'Design review',
        isOnlineMeeting: true,
        start: { dateTime: '2026-01-05T09:00:00', timeZone: ZONE },
      }),
    );
    expect(service.updateEvent).toHaveBeenCalledWith(USER_ID, 'ev-new', {
      subject: 'Design review (moved)',
      start: { dateTime: '2026-01-05T11:00:00', timeZone: ZONE },
      end: { dateTime: '2026-01-05T12:00:00', timeZone: ZONE },
    });
    expect(service.acceptEvent).toHaveBeenCalledWith(USER_ID, 'ev-new', {
      comment: undefined,
      sendResponse: undefined,
    });
  });

  it('has no placeholder field left on the schema', () => {
    const schema = buildCalendarSchema();

    expect(schema.getQueryType()!.getFields()._azureCalendarPlaceholder).toBeUndefined();
    expect(schema.getMutationType()!.getFields()._azureCalendarPlaceholder).toBeUndefined();
  });

  it('passes the schedule timeZone argument through to the service', async () => {
    const service = { getSchedule: jest.fn().mockResolvedValue([]) };

    const result = await execute(
      `query {
        azureCalendarSchedule(
          schedules: ["someone@example.test"]
          start: { dateTime: "2026-01-05T08:00:00", timeZone: "UTC" }
          end: { dateTime: "2026-01-05T18:00:00", timeZone: "UTC" }
          availabilityViewInterval: 15
          timeZone: "Europe/London"
        ) { scheduleId }
      }`,
      service,
    );

    expect(result.errors).toBeUndefined();
    expect(service.getSchedule).toHaveBeenCalledWith(
      USER_ID,
      ['someone@example.test'],
      { dateTime: '2026-01-05T08:00:00', timeZone: 'UTC' },
      { dateTime: '2026-01-05T18:00:00', timeZone: 'UTC' },
      15,
      'Europe/London',
    );
  });

  it('surfaces a service failure as a GraphQL error rather than a null field', async () => {
    const service = {
      listEvents: jest.fn().mockRejectedValue(
        Object.assign(new ApiError('expired'), { code: 'InvalidAuthenticationToken' }),
      ),
    };

    const result = await execute(`query { azureCalendarEvents { id } }`, service);

    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0].message).toContain('expired');
    // The field is non-null, so the error propagates to the root and `data` is
    // null - never a silently-empty list.
    expect(result.data).toBeNull();
  });
});

describe('AzureCalendarService — wiring and failures', () => {
  it('fails loudly when the Graph provider is not wired', async () => {
    const context: any = { getService: jest.fn(() => undefined) };
    const service = new AzureCalendarService({} as any, context);

    await expect(service.listCalendars(USER_ID)).rejects.toMatchObject({
      code: 'NotConnected',
    });
  });

  it('requires a userId on every operation', async () => {
    const { service } = createHarness();

    await expect(service.listEvents('')).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('fails a write when the provider cannot build a client', async () => {
    const { service, provider } = createHarness();
    delete (provider as any).getClient;

    await expect(
      service.createEvent(USER_ID, { subject: 'S', start: SLOT_START, end: SLOT_END }),
    ).rejects.toMatchObject({ code: 'NotConnected' });
  });

  it('propagates a provider failure instead of returning an empty list', async () => {
    const { service, provider } = createHarness();
    provider.requestAll.mockRejectedValue(
      Object.assign(new ApiError('expired'), { code: 'InvalidAuthenticationToken' }),
    );

    await expect(service.listEvents(USER_ID)).rejects.toMatchObject({
      code: 'InvalidAuthenticationToken',
    });
  });

  it('declares the dependencies whose setters it exposes (QQ-3)', () => {
    const aliases = AzureCalendarServiceDefinition.dependencies.map((entry: any) => entry.alias);

    // Declared, so the container binds the setters instead of leaving the
    // context.getService fallback as the only live path.
    expect(aliases).toEqual(['graphClientProvider', 'auditService', 'redisService']);
    expect(AzureCalendarServiceDefinition.dependencies.map((entry: any) => entry.id)).toEqual([
      'azure.AzureGraphClientProvider@1.0.0',
      'azure.AzureAuditService@1.0.0',
      'core.RedisService@1.0.0',
    ]);
  });
});

describe('AzureCalendarService — option and input normalisation (QQ-6)', () => {
  it('accepts a pre-joined select string on the cache key', () => {
    expect(calendarListCacheKey(USER_ID, { select: 'name,id' })).toBe(
      calendarListCacheKey(USER_ID, { select: ['id', 'name'] }),
    );
  });

  it('defaults an omitted options object', async () => {
    const { service, provider } = createHarness();

    await service.listEvents(USER_ID);

    expect(provider.requestAll).toHaveBeenCalledWith(USER_ID, '/me/events', {});
  });

  it('accepts the availability interval as a numeric string', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ value: [] });

    await service.getSchedule(USER_ID, ['a@example.test'], SLOT_START, SLOT_END, '15' as any);

    expect(chain.post.mock.calls[0][0].availabilityViewInterval).toBe(15);
  });

  it('survives a cache implementation that cannot write', async () => {
    const { service, provider, redis } = createHarness();
    provider.requestAll.mockResolvedValue([{ id: 'cal-1' }]);
    delete (redis as any).set;

    await expect(service.listCalendars(USER_ID)).resolves.toEqual([{ id: 'cal-1' }]);
  });

  it('survives a cache implementation that cannot read', async () => {
    const { service, provider, redis } = createHarness();
    provider.requestAll.mockResolvedValue([{ id: 'cal-1' }]);
    delete (redis as any).get;

    await expect(service.listCalendars(USER_ID)).resolves.toEqual([{ id: 'cal-1' }]);
    expect(provider.requestAll).toHaveBeenCalledTimes(1);
  });
});

describe('CalendarResolver — field adapters (QQ-6)', () => {
  function contextFor(service: any): any {
    return {
      user: { _id: USER_ID },
      hasRole: jest.fn(() => true),
      getService: jest.fn(() => service),
    };
  }

  it('defaults every optional argument and forwards the calling user', async () => {
    const service = {
      listCalendars: jest.fn().mockResolvedValue([]),
      listEvents: jest.fn().mockResolvedValue([]),
      listCalendarEvents: jest.fn().mockResolvedValue([]),
      getEvent: jest.fn().mockResolvedValue({}),
      cancelEvent: jest.fn().mockResolvedValue(true),
      updateEvent: jest.fn().mockResolvedValue({}),
    };
    const context = contextFor(service);
    const instance: any = new (CalendarResolver as any)();

    await instance.listCalendars({}, undefined, context);
    await instance.listEvents({}, undefined, context);
    await instance.listEvents({}, { calendarId: 'cal-1' }, context);
    await instance.getEvent({}, { eventId: 'ev-1' }, context);
    await instance.cancelEvent({}, { eventId: 'ev-1' }, context);
    await instance.updateEvent({}, { eventId: 'ev-1', input: { subject: 'x' } }, context);

    expect(service.listCalendars).toHaveBeenCalledWith(USER_ID, {
      refresh: false,
      top: undefined,
      select: undefined,
    });
    // The resolver no longer branches on calendarId: `listEvents` owns the rule
    // (calendarId alone -> that calendar's events; + window -> its calendarView).
    expect(service.listEvents).toHaveBeenCalledWith(USER_ID, {
      filter: undefined,
      orderBy: undefined,
      select: undefined,
      top: undefined,
      skip: undefined,
      calendarId: undefined,
    });
    expect(service.listEvents).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      calendarId: 'cal-1',
    }));
    expect(service.listCalendarEvents).not.toHaveBeenCalled();
    expect(service.getEvent).toHaveBeenCalledWith(USER_ID, 'ev-1', {
      select: undefined,
      expand: undefined,
    });
    expect(service.cancelEvent).toHaveBeenCalledWith(USER_ID, 'ev-1', { comment: undefined });
    expect(service.updateEvent).toHaveBeenCalledWith(USER_ID, 'ev-1', { subject: 'x' });
  });

  it('maps the remaining RSVP responses and rejects an unknown one', async () => {
    const service = {
      acceptEvent: jest.fn().mockResolvedValue(true),
      declineEvent: jest.fn().mockResolvedValue(true),
      tentativelyAcceptEvent: jest.fn().mockResolvedValue(true),
    };
    const context = contextFor(service);
    const instance: any = new (CalendarResolver as any)();

    await instance.respondToEvent({}, { eventId: 'ev-1', response: 'decline' }, context);
    await instance.respondToEvent({}, { eventId: 'ev-1', response: 'tentativelyAccept' }, context);

    expect(service.declineEvent).toHaveBeenCalledWith(USER_ID, 'ev-1', {
      comment: undefined,
      sendResponse: undefined,
    });
    expect(service.tentativelyAcceptEvent).toHaveBeenCalledTimes(1);

    await expect(
      instance.respondToEvent({}, { eventId: 'ev-1', response: 'maybe' }, context),
    ).rejects.toThrow(/Unsupported RSVP response/);
  });

  it('fails loudly when the calendar service is not wired', async () => {
    const instance: any = new (CalendarResolver as any)();
    const context: any = {
      user: { _id: USER_ID },
      hasRole: (): boolean => true,
      getService: (): any => undefined,
    };

    await expect(instance.listCalendars({}, {}, context)).rejects.toThrow(
      /Azure Calendar Service not available/,
    );
  });
});

describe('CalendarResolver — nullish argument handling (QQ-6)', () => {
  it('normalises a missing params object on every field', async () => {
    const service = {
      listCalendars: jest.fn().mockResolvedValue([]),
      listEvents: jest.fn().mockResolvedValue([]),
      listCalendarEvents: jest.fn().mockResolvedValue([]),
      listCalendarView: jest.fn().mockResolvedValue([]),
      getEvent: jest.fn().mockResolvedValue({}),
      getSchedule: jest.fn().mockResolvedValue([]),
      findMeetingTimes: jest.fn().mockResolvedValue({ meetingTimeSuggestions: [] }),
      createEvent: jest.fn().mockResolvedValue({}),
      updateEvent: jest.fn().mockResolvedValue({}),
      deleteEvent: jest.fn().mockResolvedValue(true),
      cancelEvent: jest.fn().mockResolvedValue(true),
      acceptEvent: jest.fn().mockResolvedValue(true),
    };
    const context: any = {
      user: { _id: USER_ID },
      hasRole: jest.fn(() => true),
      getService: jest.fn(() => service),
    };
    const instance: any = new (CalendarResolver as any)();

    // Every field guards its arguments with `const p = params || {}`, so an
    // absent params object must not blow up before the service is reached.
    await instance.listCalendars({}, undefined, context);
    await instance.listEvents({}, undefined, context);
    await instance.listCalendarView({}, undefined, context);
    await instance.getEvent({}, undefined, context);
    await instance.getSchedule({}, undefined, context);
    await instance.findMeetingTimes({}, undefined, context);
    await instance.createEvent({}, undefined, context);
    await instance.updateEvent({}, undefined, context);
    await instance.deleteEvent({}, undefined, context);
    await instance.cancelEvent({}, undefined, context);

    expect(service.listEvents).toHaveBeenCalledWith(USER_ID, expect.any(Object));
    expect(service.cancelEvent).toHaveBeenCalledWith(USER_ID, undefined, { comment: undefined });

    // The one exception: an undefined RSVP response cannot be mapped, so this
    // must throw rather than calling acceptEvent with a null id.
    await expect(instance.respondToEvent({}, undefined, context)).rejects.toThrow(
      /Unsupported RSVP response/,
    );
    expect(service.acceptEvent).not.toHaveBeenCalled();
  });
});

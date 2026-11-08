/**
 * Request-shape suite (AZ-07).
 *
 * These tests exist because Graph accepts a *plausible-looking* wrong request:
 *
 *   - a bare ISO string where a `dateTimeTimeZone` is expected is accepted and
 *     interpreted in an unspecified zone, silently moving a meeting;
 *   - `/me/events` returns recurrence masters, so a window filter quietly drops
 *     recurring occurrences;
 *   - recurrence sent as Google's `string[]` is either rejected or loses
 *     `firstDayOfWeek` / `index` / `recurrenceTimeZone`.
 *
 * None of that produces an error at runtime, so it has to be asserted here.
 */
// eslint-disable-next-line import/first
import {
  AzureCalendarService,
  WINDOWS_TIME_ZONES,
  buildCalendarEventBody,
  normaliseRecurrence,
  resolveTimeZoneOffset,
  toCalendarDateTimeTimeZone,
  toGraphDateTimeOffset,
} from '../services/AzureCalendarService';
// eslint-disable-next-line import/first
import type { ICalendarPatternedRecurrence } from '../types/calendar.types';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const ZONE = 'South Africa Standard Time';

const SLOT_START = { dateTime: '2026-01-05T09:00:00', timeZone: ZONE };
const SLOT_END = { dateTime: '2026-01-05T10:00:00', timeZone: ZONE };

const ISO_DATE_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A valid Graph `dateTimeTimeZone` is an object with both members. */
function isDateTimeTimeZone(value: any): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.dateTime === 'string'
    && typeof value.timeZone === 'string',
  );
}

/**
 * Walk a request body and collect every string that *looks* like an ISO date/time
 * outside a `dateTimeTimeZone` object.
 *
 * A non-empty result is exactly the defect this ticket forbids: a date Graph will
 * interpret in an unspecified zone.
 */
function bareDateTimes(value: any, path: string = 'body', found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => bareDateTimes(entry, `${path}[${index}]`, found));
    return found;
  }

  if (value && typeof value === 'object') {
    // The object form is the correct one; do not descend into its `dateTime`.
    if (isDateTimeTimeZone(value)) return found;

    for (const [key, entry] of Object.entries(value)) {
      bareDateTimes(entry, `${path}.${key}`, found);
    }

    return found;
  }

  if (typeof value === 'string' && ISO_DATE_TIME.test(value)) {
    found.push(`${path}=${value}`);
  }

  return found;
}

interface IHarness {
  service: AzureCalendarService;
  chain: any;
  provider: any;
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

  const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
  const context: any = { getService: jest.fn(() => undefined), user: { _id: USER_ID } };

  const service = new AzureCalendarService({} as any, context);
  service.setGraphClientProvider(provider);
  service.setRedisService(redis);

  return { service, chain, provider };
}

describe('dateTimeTimeZone normalisation', () => {
  it('never returns a bare string for a caller-supplied zone-local date', () => {
    const value = toCalendarDateTimeTimeZone('2026-01-05T09:00:00', ZONE);

    expect(typeof value).not.toBe('string');
    expect(value).toEqual({ dateTime: '2026-01-05T09:00:00', timeZone: ZONE });
  });

  it('turns a Date into an explicit UTC dateTimeTimeZone', () => {
    const value = toCalendarDateTimeTimeZone(new Date('2026-01-05T07:00:00.000Z'));

    expect(value).toEqual({ dateTime: '2026-01-05T07:00:00.000Z', timeZone: 'UTC' });
  });

  it('keeps an object form intact and fills a missing zone with the default', () => {
    expect(toCalendarDateTimeTimeZone({ dateTime: '2026-01-05T09:00:00' } as any, ZONE)).toEqual({
      dateTime: '2026-01-05T09:00:00',
      timeZone: ZONE,
    });
  });

  it('rejects a value with no dateTime', () => {
    expect(() => toCalendarDateTimeTimeZone({ timeZone: ZONE } as any)).toThrow(/dateTime is required/);
  });
});

describe('absolute offset resolution for ranged queries', () => {
  it('emits an explicit offset for a Windows zone', () => {
    expect(resolveTimeZoneOffset('2026-01-05T09:00:00', ZONE)).toBe('+02:00');
    expect(toGraphDateTimeOffset(SLOT_START)).toBe('2026-01-05T09:00:00+02:00');
  });

  it('emits Z for UTC and for a value that already carries an offset', () => {
    expect(toGraphDateTimeOffset({ dateTime: '2026-01-05T09:00:00', timeZone: 'UTC' }))
      .toBe('2026-01-05T09:00:00Z');
    expect(toGraphDateTimeOffset('2026-07-01T09:00:00-07:00'))
      .toBe('2026-07-01T09:00:00-07:00');
  });

  it('accepts an IANA zone as well as a Windows name', () => {
    expect(resolveTimeZoneOffset('2026-01-05T09:00:00', 'Africa/Johannesburg')).toBe('+02:00');
  });

  it('honours daylight saving for a zone that observes it', () => {
    // London is UTC in January and UTC+1 in July.
    expect(resolveTimeZoneOffset('2026-01-05T09:00:00', 'Europe/London')).toBe('Z');
    expect(resolveTimeZoneOffset('2026-07-05T09:00:00', 'Europe/London')).toBe('+01:00');
  });

  it('refuses to guess an unknown zone instead of assuming UTC', () => {
    expect(() => resolveTimeZoneOffset('2026-01-05T09:00:00', 'Middle Earth Standard Time'))
      .toThrow(/Unsupported time zone/);
  });

  it('requires a zone when the value carries no offset', () => {
    expect(() => resolveTimeZoneOffset('2026-01-05T09:00:00', '')).toThrow(/time zone is required/i);
  });

  it('accepts every zone in the supported Windows set (QQ-5)', () => {
    const entries = Object.entries(WINDOWS_TIME_ZONES);

    // The map now mirrors CLDR windowsZones; a small hand-picked table made the
    // ranged-read feature unavailable to many tenants.
    expect(entries.length).toBeGreaterThan(100);

    for (const [windowsZone, iana] of entries) {
      // The IANA target must be a zone ICU knows.
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: iana })).not.toThrow();
      // ... and the Windows name must resolve through the public path.
      expect(resolveTimeZoneOffset('2026-01-05T09:00:00', windowsZone)).toMatch(/^(Z|[+-]\d{2}:\d{2})$/);
    }

    // The zones the reviewer called out explicitly.
    expect(resolveTimeZoneOffset('2026-01-05T09:00:00', 'Singapore Standard Time')).toBe('+08:00');
    expect(resolveTimeZoneOffset('2026-01-05T09:00:00', 'Taipei Standard Time')).toBe('+08:00');
    expect(resolveTimeZoneOffset('2026-01-05T09:00:00', 'AUS Central Standard Time')).toBe('+09:30');
    expect(resolveTimeZoneOffset('2026-01-05T09:00:00', 'India Standard Time')).toBe('+05:30');
    expect(resolveTimeZoneOffset('2026-01-05T09:00:00', 'Newfoundland Standard Time')).toBe('-03:30');
    expect(resolveTimeZoneOffset('2026-01-05T09:00:00', 'Nepal Standard Time')).toBe('+05:45');
  });

  it('turns a Date into a UTC instant', () => {
    expect(toGraphDateTimeOffset(new Date('2026-01-05T07:30:00.000Z')))
      .toBe('2026-01-05T07:30:00.000Z');
  });

  it('rejects an unparseable value and an invalid Date', () => {
    expect(() => toCalendarDateTimeTimeZone(undefined as any)).toThrow(/date\/time value is required/i);
    expect(() => toCalendarDateTimeTimeZone(null as any)).toThrow(/date\/time value is required/i);
    expect(() => toCalendarDateTimeTimeZone('' as any)).toThrow(/cannot be empty/i);
    expect(() => toCalendarDateTimeTimeZone(42 as any)).toThrow(/Unsupported date\/time value/);
    expect(() => toCalendarDateTimeTimeZone(new Date('not a date'))).toThrow(/invalid Date/i);
    expect(() => toGraphDateTimeOffset(new Date('not a date'))).toThrow(/invalid Date/i);
  });

  it('rejects a range that cannot be parsed as an absolute instant', async () => {
    const { service, provider } = createHarness();

    await expect(
      service.listCalendarView(USER_ID, { dateTime: 'nope', timeZone: 'UTC' }, SLOT_END),
    ).rejects.toMatchObject({ code: 'InvalidDateTime' });

    // A malformed window must never reach Graph as a half-built request.
    expect(provider.requestAll).not.toHaveBeenCalled();
  });
});

describe('buildCalendarEventBody', () => {
  it('serialises start and end as dateTimeTimeZone objects', () => {
    const body = buildCalendarEventBody({
      subject: 'Design review',
      start: SLOT_START,
      end: SLOT_END,
    });

    expect(body.start).toEqual(SLOT_START);
    expect(body.end).toEqual(SLOT_END);
    expect(typeof body.start).toBe('object');
    expect(bareDateTimes(body)).toEqual([]);
  });

  it('defaults an online meeting to teamsForBusiness', () => {
    const body = buildCalendarEventBody({
      start: SLOT_START,
      end: SLOT_END,
      isOnlineMeeting: true,
    });

    expect(body.isOnlineMeeting).toBe(true);
    expect(body.onlineMeetingProvider).toBe('teamsForBusiness');
  });

  it('never puts an online meeting (or a join link) in the request body', () => {
    const body = buildCalendarEventBody({
      start: SLOT_START,
      end: SLOT_END,
      isOnlineMeeting: true,
      // A client smuggling a joinUrl must not be able to make this module claim
      // it created a meeting it did not.
      ...({ onlineMeeting: { joinUrl: 'https://evil.example.test' } } as any),
    });

    expect(body.onlineMeeting).toBeUndefined();
    expect(body.joinUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('evil.example.test');
  });

  it('keeps recurrence in the Graph patternedRecurrence shape', () => {
    const recurrence: ICalendarPatternedRecurrence = {
      pattern: { type: 'relativeMonthly', interval: 2, daysOfWeek: ['tuesday'], index: 'last' },
      range: { type: 'numbered', numberOfOccurrences: 6, startDate: '2026-01-06', recurrenceTimeZone: ZONE },
    };

    const body = buildCalendarEventBody({ start: SLOT_START, end: SLOT_END, recurrence });

    expect(body.recurrence).toEqual(recurrence);
    expect(Array.isArray(body.recurrence)).toBe(false);
    expect(JSON.stringify(body.recurrence)).not.toMatch(/RRULE|EXDATE/);
  });

  it('rejects Google-style recurrence strings', () => {
    expect(() => buildCalendarEventBody({
      start: SLOT_START,
      end: SLOT_END,
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] as any,
    })).toThrow(/patternedRecurrence/);
  });

  it('requires both halves of a patterned recurrence', () => {
    expect(() => normaliseRecurrence({ range: { type: 'noEnd' } } as any))
      .toThrow(/recurrence.pattern is required/);
    expect(() => normaliseRecurrence({ pattern: { type: 'daily' } } as any))
      .toThrow(/recurrence.range is required/);
    expect(() => normaliseRecurrence(null as any)).toThrow(/patternedRecurrence object/);
  });

  it('strips unknown keys from a recurrence instead of forwarding them', () => {
    const recurrence: any = normaliseRecurrence({
      pattern: { type: 'daily', interval: 2, bogus: 'x' },
      range: { type: 'numbered', numberOfOccurrences: 3, startDate: '2026-01-05', extra: 1 },
    } as any);

    expect(recurrence.pattern.bogus).toBeUndefined();
    expect(recurrence.range.extra).toBeUndefined();
    expect(recurrence.pattern).toEqual({ type: 'daily', interval: 2 });
    expect(recurrence.range).toEqual({
      type: 'numbered',
      numberOfOccurrences: 3,
      startDate: '2026-01-05',
    });
  });

  it('does not send an online meeting provider when isOnlineMeeting is false', () => {
    const body = buildCalendarEventBody({
      start: SLOT_START,
      end: SLOT_END,
      isOnlineMeeting: false,
      onlineMeetingProvider: 'teamsForBusiness',
    });

    expect(body.isOnlineMeeting).toBe(false);
    expect(body.onlineMeetingProvider).toBeUndefined();
  });

  it('carries every remaining editable field onto the body', () => {
    const body = buildCalendarEventBody({
      subject: 'Full event',
      body: { contentType: 'text', content: 'Agenda' },
      start: SLOT_START,
      end: SLOT_END,
      location: { displayName: 'Boardroom', locationEmailAddress: 'room@example.test' },
      locations: [{ displayName: 'Boardroom' }, { displayName: 'Teams' }],
      attendees: [{ emailAddress: { address: 'a@example.test', name: 'A' }, type: 'optional' }],
      isAllDay: false,
      categories: ['Design'],
      importance: 'high',
      sensitivity: 'private',
      showAs: 'tentative',
      reminderMinutesBeforeStart: 10,
      isReminderOn: true,
      transactionId: 'tx-1',
    });

    expect(body).toMatchObject({
      subject: 'Full event',
      body: { contentType: 'text', content: 'Agenda' },
      location: { displayName: 'Boardroom', locationEmailAddress: 'room@example.test' },
      locations: [{ displayName: 'Boardroom' }, { displayName: 'Teams' }],
      attendees: [{ type: 'optional', emailAddress: { address: 'a@example.test', name: 'A' } }],
      isAllDay: false,
      categories: ['Design'],
      importance: 'high',
      sensitivity: 'private',
      showAs: 'tentative',
      reminderMinutesBeforeStart: 10,
      isReminderOn: true,
      transactionId: 'tx-1',
    });
  });

  it('never forwards Graph’s read-only event properties into a write body', () => {
    const body = buildCalendarEventBody({
      start: SLOT_START,
      end: SLOT_END,
      // A client echoing a fetched event back must not be able to send these:
      // Graph rejects a write that carries them.
      ...({ originalStartTimeZone: ZONE, originalEndTimeZone: ZONE, onlineMeeting: { joinUrl: 'x' } } as any),
    });

    expect(body.originalStartTimeZone).toBeUndefined();
    expect(body.originalEndTimeZone).toBeUndefined();
    expect(body.onlineMeeting).toBeUndefined();
  });

  it('defaults a plain-text body type and accepts a bare location string', () => {
    const body = buildCalendarEventBody({
      start: SLOT_START,
      end: SLOT_END,
      body: { content: 'No type given' },
      location: 'Boardroom' as any,
    });

    expect(body.body).toEqual({ contentType: 'html', content: 'No type given' });
    expect(body.location).toEqual({ displayName: 'Boardroom' });
  });

  it('rejects an attendee without an address when building the body', () => {
    expect(() => buildCalendarEventBody({
      start: SLOT_START,
      end: SLOT_END,
      attendees: [{ emailAddress: { address: '  ' } }],
    })).toThrow(/attendee 0 has no email address/);
  });

  it('rejects a non-object body', () => {
    expect(() => buildCalendarEventBody(null as any)).toThrow(/event body is required/i);
  });
});

describe('wired request bodies (what actually reaches Graph)', () => {
  it('createEvent posts dateTimeTimeZone objects and no bare ISO strings', async () => {
    const { service, chain } = createHarness();

    await service.createEvent(USER_ID, {
      subject: 'Weekly sync',
      start: SLOT_START,
      end: SLOT_END,
      isOnlineMeeting: true,
    });

    const body = chain.post.mock.calls[0][0];
    expect(bareDateTimes(body)).toEqual([]);
    expect(body.start).toEqual(SLOT_START);
    expect(body.end).toEqual(SLOT_END);
    expect(body.onlineMeetingProvider).toBe('teamsForBusiness');
  });

  it('updateEvent patches dateTimeTimeZone objects and no bare ISO strings', async () => {
    const { service, chain } = createHarness();

    await service.updateEvent(USER_ID, 'ev-1', { start: SLOT_START, end: SLOT_END });

    const body = chain.patch.mock.calls[0][0];
    expect(bareDateTimes(body)).toEqual([]);
    expect(body.start).toEqual(SLOT_START);
  });

  it('getSchedule posts startTime/endTime objects with availabilityViewInterval', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ value: [] });

    await service.getSchedule(USER_ID, ['a@example.test'], SLOT_START, SLOT_END);

    const body = chain.post.mock.calls[0][0];
    expect(bareDateTimes(body)).toEqual([]);
    expect(body.startTime).toEqual(SLOT_START);
    expect(body.endTime).toEqual(SLOT_END);
    expect(body.availabilityViewInterval).toBe(30);
    expect(chain.api).toHaveBeenCalledWith('/me/calendar/getSchedule');
  });

  it('findMeetingTimes posts a dateTimeTimeZone timeslot', async () => {
    const { service, chain } = createHarness();
    chain.post.mockResolvedValue({ meetingTimeSuggestions: [] });

    await service.findMeetingTimes(USER_ID, {
      attendees: [{ emailAddress: { address: 'b@example.test' } }],
      start: SLOT_START,
      end: SLOT_END,
    });

    const body = chain.post.mock.calls[0][0];
    expect(bareDateTimes(body)).toEqual([]);
    expect(body.timeConstraint.timeslots).toHaveLength(1);
    expect(body.timeConstraint.timeslots[0].start).toEqual(SLOT_START);
    expect(body.timeConstraint.timeslots[0].end).toEqual(SLOT_END);
    expect(chain.api).toHaveBeenCalledWith('/me/findMeetingTimes');
  });

  it('a ranged read hits /me/calendarView and the window is an absolute instant', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarView(USER_ID, SLOT_START, SLOT_END);

    const path: string = provider.requestAll.mock.calls[0][1];
    expect(path).toContain('/me/calendarView?');
    expect(path).not.toContain('/me/events');
    // calendarView takes DateTimeOffset strings (documented exception); each one
    // must carry the offset, never be left zone-less.
    expect(path).toContain('startDateTime=2026-01-05T09%3A00%3A00%2B02%3A00');
    expect(path).toContain('endDateTime=2026-01-05T10%3A00%3A00%2B02%3A00');
  });

  it('a ranged listEvents call never reaches /me/events', async () => {
    const { service, provider } = createHarness();

    await service.listEvents(USER_ID, { start: SLOT_START, end: SLOT_END });

    const path: string = provider.requestAll.mock.calls[0][1];
    expect(path.startsWith('/me/calendarView?')).toBe(true);
    expect(provider.requestAll.mock.calls.some((call: any[]) => String(call[1]).includes('/me/events')))
      .toBe(false);
  });
});

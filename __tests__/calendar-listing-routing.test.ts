/**
 * Event-listing routing suite (AZ-07, round 3).
 *
 * The rule under test: **an argument is honoured or rejected, never discarded.**
 *
 * The defect this suite exists for was exactly that: `listCalendarEvents` accepted
 * `start`/`end` (its options are `IListEventsOptions`, whose `start`/`end` are
 * documented as the range that routes to `/me/calendarView`) and then called
 * `queryOptions(options)`, which forwards select/filter/orderBy/top/skip/expand/count
 * and drops the window. A caller asking for one calendar's week received the whole
 * calendar. The sibling trap: `listEvents({ calendarId })` dropped the id and read
 * `/me/events` across every calendar.
 *
 * None of that produces an error - it produces a *plausible but wrong* payload - so
 * it has to be asserted on the exact path and options handed to the provider.
 */
// eslint-disable-next-line import/first
import {
  AzureCalendarService,
  CalendarErrorCode,
} from '../services/AzureCalendarService';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const ZONE = 'South Africa Standard Time';

const SLOT_START = { dateTime: '2026-01-05T09:00:00', timeZone: ZONE };
const SLOT_END = { dateTime: '2026-01-05T10:00:00', timeZone: ZONE };

interface IHarness {
  service: AzureCalendarService;
  provider: { request: jest.Mock; requestAll: jest.Mock; getClient: jest.Mock };
  chain: any;
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

  const context: any = { getService: jest.fn(() => undefined), user: { _id: USER_ID } };
  const service = new AzureCalendarService({} as any, context);
  service.setGraphClientProvider(provider);
  service.setRedisService({ get: jest.fn().mockResolvedValue(null), set: jest.fn() });

  return { service, provider, chain };
}

/** The single path/options pair handed to the provider on the last call. */
function lastCall(provider: IHarness['provider']): { path: string; options: any } {
  const call = provider.requestAll.mock.calls[provider.requestAll.mock.calls.length - 1];
  return { path: String(call[1]), options: call[2] };
}

describe('listCalendarEvents — a supplied window is honoured (QQ-1)', () => {
  it('routes start+end to /me/calendars/{id}/calendarView', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarEvents(USER_ID, 'cal-1', { start: SLOT_START, end: SLOT_END });

    expect(provider.requestAll).toHaveBeenCalledTimes(1);
    const { path } = lastCall(provider);

    expect(path).toContain('/me/calendars/cal-1/calendarView?');
    expect(path).not.toContain('/events');
    expect(path).toContain('startDateTime=2026-01-05T09%3A00%3A00%2B02%3A00');
    expect(path).toContain('endDateTime=2026-01-05T10%3A00%3A00%2B02%3A00');
  });

  it('percent-encodes the calendar id in the calendarView path', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarEvents(USER_ID, 'AAMk+/=', { start: SLOT_START, end: SLOT_END });

    expect(lastCall(provider).path).toContain('/me/calendars/AAMk%2B%2F%3D/calendarView?');
  });

  it('honours the calendar id even when the caller also passed one in options', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarEvents(USER_ID, 'cal-1', {
      start: SLOT_START,
      end: SLOT_END,
      // A stale copy in options must not win over the positional argument.
      calendarId: 'other-calendar',
    });

    expect(lastCall(provider).path).toContain('/me/calendars/cal-1/calendarView?');
  });

  it('keeps the OData options on the calendarView request', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarEvents(USER_ID, 'cal-1', {
      start: SLOT_START,
      end: SLOT_END,
      top: 25,
      select: ['id', 'subject'],
    });

    const { options } = lastCall(provider);
    expect(options).toEqual({ top: 25, select: ['id', 'subject'] });
    // The window is a path concern on calendarView, not an OData option.
    expect(options.start).toBeUndefined();
    expect(options.end).toBeUndefined();
  });

  it('resolves a bare string window in the requested zone', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarEvents(USER_ID, 'cal-1', {
      start: '2026-01-05T09:00:00',
      end: '2026-01-05T10:00:00',
      timeZone: 'Europe/London',
    });

    const { path } = lastCall(provider);
    // January in London is UTC - the zone must be honoured, not defaulted.
    expect(path).toContain('startDateTime=2026-01-05T09%3A00%3A00Z');
    expect(path).toContain('endDateTime=2026-01-05T10%3A00%3A00Z');
  });
});

describe('event listing — a half-specified window is refused', () => {
  it('rejects start-only on listCalendarEvents with no Graph call', async () => {
    const { service, provider } = createHarness();

    await expect(
      service.listCalendarEvents(USER_ID, 'cal-1', { start: SLOT_START }),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_DATE_RANGE });

    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('rejects end-only on listCalendarEvents with no Graph call', async () => {
    const { service, provider } = createHarness();

    await expect(
      service.listCalendarEvents(USER_ID, 'cal-1', { end: SLOT_END }),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_DATE_RANGE });

    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('rejects a half window before validating the calendar id', async () => {
    const { service, provider } = createHarness();

    // A blank id and a half window are both caller errors; the window is
    // reported first because it is the one that would silently widen the read.
    await expect(
      service.listCalendarEvents(USER_ID, '  ', { start: SLOT_START }),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_EVENT });

    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('rejects start-only on listEvents with no Graph call', async () => {
    const { service, provider } = createHarness();

    await expect(service.listEvents(USER_ID, { start: SLOT_START })).rejects.toMatchObject({
      code: CalendarErrorCode.INVALID_DATE_RANGE,
    });

    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('rejects a half window that also carries a calendarId', async () => {
    const { service, provider } = createHarness();

    await expect(
      service.listEvents(USER_ID, { calendarId: 'cal-1', end: SLOT_END }),
    ).rejects.toMatchObject({ code: CalendarErrorCode.INVALID_DATE_RANGE });

    expect(provider.requestAll).not.toHaveBeenCalled();
  });
});

describe('event listing — the unwindowed paths are unchanged', () => {
  it('listCalendarEvents without a window reads /me/calendars/{id}/events', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarEvents(USER_ID, 'cal-1', { top: 10 });

    const { path, options } = lastCall(provider);
    expect(path).toBe('/me/calendars/cal-1/events');
    expect(path).not.toContain('calendarView');
    expect(options).toEqual({ top: 10 });
  });

  it('listEvents without a window or calendarId reads /me/events', async () => {
    const { service, provider } = createHarness();

    await service.listEvents(USER_ID, { top: 5 });

    const { path } = lastCall(provider);
    expect(path).toBe('/me/events');
  });

  it('listCalendarEvents without options at all reads /me/calendars/{id}/events', async () => {
    const { service, provider } = createHarness();

    await service.listCalendarEvents(USER_ID, 'cal-1');

    expect(lastCall(provider)).toEqual({ path: '/me/calendars/cal-1/events', options: {} });
  });
});

describe('listEvents — a calendarId is never dropped (QQ-1 sibling)', () => {
  it('routes calendarId without a window to that calendar’s events', async () => {
    const { service, provider } = createHarness();

    await service.listEvents(USER_ID, { calendarId: 'cal-1', top: 10 });

    const { path, options } = lastCall(provider);
    expect(path).toBe('/me/calendars/cal-1/events');
    // The trap this replaces: `/me/events` across every calendar.
    expect(path).not.toBe('/me/events');
    expect(options).toEqual({ top: 10 });
  });

  it('routes calendarId with a window to that calendar’s calendarView', async () => {
    const { service, provider } = createHarness();

    await service.listEvents(USER_ID, {
      calendarId: 'cal-1',
      start: SLOT_START,
      end: SLOT_END,
    });

    const { path } = lastCall(provider);
    expect(path).toContain('/me/calendars/cal-1/calendarView?');
    expect(path).not.toContain('/events');
  });

  it('percent-encodes the calendar id in both routed paths', async () => {
    const { service, provider } = createHarness();

    await service.listEvents(USER_ID, { calendarId: 'AAMk+/=' });
    expect(lastCall(provider).path).toBe('/me/calendars/AAMk%2B%2F%3D/events');

    await service.listEvents(USER_ID, { calendarId: 'AAMk+/=', start: SLOT_START, end: SLOT_END });
    expect(lastCall(provider).path).toContain('/me/calendars/AAMk%2B%2F%3D/calendarView?');
  });

  it('treats a blank calendarId as absent rather than reading a bogus calendar', async () => {
    const { service, provider } = createHarness();

    await service.listEvents(USER_ID, { calendarId: '   ' });

    // Falls through to the user's flat list - the only sensible reading of
    // "no calendar specified" - instead of requesting /me/calendars/%20%20/events.
    expect(lastCall(provider).path).toBe('/me/events');
  });
});

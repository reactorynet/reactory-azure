import Reactory from '@reactorynet/reactory-core';
import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation } from '@reactory/server-core/models/graphql/decorators/resolver';
import type { CalendarInvitationResponse } from '../../types/calendar.types';

/**
 * GraphQL surface for Microsoft Graph calendars (AZ-07).
 *
 * A thin adapter over `azure.AzureCalendarService@1.0.0`: every field resolves
 * the service from the context and passes the calling user's id, so the
 * service - not the resolver - owns Graph shapes, caching and error translation.
 *
 * Note the deliberate split between `azureCalendarEvents` (no window) and
 * `azureCalendarView` (a window, served by `/me/calendarView`): `/me/events` does
 * not expand recurrences, so a client that wants "what happens next week" must
 * call `azureCalendarView`.
 *
 * Each field normalises its arguments to an object once (`const p = params || {}`)
 * rather than guarding every member: a field with no required argument can be
 * called with `undefined`, and one guard is easier to keep correct than a dozen
 * optional chains.
 */
@resolver
class CalendarResolver {
  resolver: any;

  private calendarService(context: Reactory.Server.IReactoryContext): any {
    const service = context.getService('azure.AzureCalendarService@1.0.0') as any;
    if (!service) throw new Error('Azure Calendar Service not available');

    return service;
  }

  private userId(context: Reactory.Server.IReactoryContext): string {
    return String(context.user._id);
  }

  /* ------------------------------------------------------------------------ */
  /* Queries                                                                  */
  /* ------------------------------------------------------------------------ */

  /** Calendars, cached for 5 minutes by the service. */
  @roles(['USER'], 'args.context')
  @query('azureCalendars')
  async listCalendars(
    _obj: any,
    params: { refresh?: boolean; top?: number; select?: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.calendarService(context).listCalendars(this.userId(context), {
      refresh: p.refresh === true,
      top: p.top,
      select: p.select,
    });
  }

  /**
   * Events without a date window.
   *
   * `calendarId` scopes the read to one calendar (`/me/calendars/{id}/events`);
   * without it this is the user's flat `/me/events` list. For a window use
   * `azureCalendarView` - `/me/events` does not expand recurrences.
   */
  @roles(['USER'], 'args.context')
  @query('azureCalendarEvents')
  async listEvents(
    _obj: any,
    params: {
      calendarId?: string;
      filter?: string;
      orderBy?: string;
      select?: string[];
      top?: number;
      skip?: number;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;
    const service = this.calendarService(context);
    const userId = this.userId(context);
    const options = {
      filter: p.filter,
      orderBy: p.orderBy,
      select: p.select,
      top: p.top,
      skip: p.skip,
    };

    // `listEvents` itself honours `calendarId` (routing to listCalendarEvents),
    // so this adapter no longer needs to branch - one call, one rule, no path
    // where a supplied calendarId is silently widened to every calendar.
    return service.listEvents(userId, { ...options, calendarId: p.calendarId });
  }

  /** The window read: `/me/calendarView`, which expands recurring series. */
  @roles(['USER'], 'args.context')
  @query('azureCalendarView')
  async listCalendarView(
    _obj: any,
    params: {
      start: any;
      end: any;
      calendarId?: string;
      filter?: string;
      orderBy?: string;
      select?: string[];
      top?: number;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.calendarService(context).listCalendarView(
      this.userId(context),
      p.start,
      p.end,
      {
        calendarId: p.calendarId,
        filter: p.filter,
        orderBy: p.orderBy,
        select: p.select,
        top: p.top,
      },
    );
  }

  /** One event, occurrence, exception or recurring master. */
  @roles(['USER'], 'args.context')
  @query('azureCalendarEvent')
  async getEvent(
    _obj: any,
    params: { eventId: string; select?: string[]; expand?: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.calendarService(context).getEvent(this.userId(context), p.eventId, {
      select: p.select,
      expand: p.expand,
    });
  }

  /** Free/busy over `POST /me/calendar/getSchedule`. */
  @roles(['USER'], 'args.context')
  @query('azureCalendarSchedule')
  async getSchedule(
    _obj: any,
    params: {
      schedules: string[];
      start: any;
      end: any;
      availabilityViewInterval?: number;
      timeZone?: string;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.calendarService(context).getSchedule(
      this.userId(context),
      p.schedules,
      p.start,
      p.end,
      p.availabilityViewInterval,
      p.timeZone,
    );
  }

  /** Meeting-time suggestions over `POST /me/findMeetingTimes`. */
  @roles(['USER'], 'args.context')
  @query('azureFindMeetingTimes')
  async findMeetingTimes(
    _obj: any,
    params: {
      attendees: any[];
      start: any;
      end: any;
      meetingDuration?: string;
      maxCandidates?: number;
      isOrganizerOptional?: boolean;
      returnSuggestionReasons?: boolean;
      minimumAttendeePercentage?: number;
      locationConstraint?: any;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.calendarService(context).findMeetingTimes(this.userId(context), {
      attendees: p.attendees,
      start: p.start,
      end: p.end,
      meetingDuration: p.meetingDuration,
      maxCandidates: p.maxCandidates,
      isOrganizerOptional: p.isOrganizerOptional,
      returnSuggestionReasons: p.returnSuggestionReasons,
      minimumAttendeePercentage: p.minimumAttendeePercentage,
      locationConstraint: p.locationConstraint,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Mutations                                                                */
  /* ------------------------------------------------------------------------ */

  @roles(['USER'], 'args.context')
  @mutation('azureCreateEvent')
  async createEvent(
    _obj: any,
    params: { input: any },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.calendarService(context).createEvent(this.userId(context), p.input);
  }

  @roles(['USER'], 'args.context')
  @mutation('azureUpdateEvent')
  async updateEvent(
    _obj: any,
    params: { eventId: string; input: any },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.calendarService(context).updateEvent(
      this.userId(context),
      p.eventId,
      p.input,
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureDeleteEvent')
  async deleteEvent(
    _obj: any,
    params: { eventId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.calendarService(context).deleteEvent(this.userId(context), p.eventId);
  }

  @roles(['USER'], 'args.context')
  @mutation('azureCancelEvent')
  async cancelEvent(
    _obj: any,
    params: { eventId: string; comment?: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.calendarService(context).cancelEvent(this.userId(context), p.eventId, {
      comment: p.comment,
    });
  }

  @roles(['USER'], 'args.context')
  @mutation('azureRespondToEvent')
  async respondToEvent(
    _obj: any,
    params: {
      eventId: string;
      response: CalendarInvitationResponse;
      comment?: string;
      sendResponse?: boolean;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;
    const service = this.calendarService(context);
    const userId = this.userId(context);
    const options = { comment: p.comment, sendResponse: p.sendResponse };

    switch (p.response) {
      case 'accept':
        return service.acceptEvent(userId, p.eventId, options);
      case 'decline':
        return service.declineEvent(userId, p.eventId, options);
      case 'tentativelyAccept':
        return service.tentativelyAcceptEvent(userId, p.eventId, options);
      default:
        throw new Error(`Unsupported RSVP response: ${p.response}`);
    }
  }
}

export default CalendarResolver;

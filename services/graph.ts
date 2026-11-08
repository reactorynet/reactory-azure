/**
 * LEGACY COMPATIBILITY SHIM - DO NOT ADD FEATURES HERE.
 *
 * @deprecated since AZ-01. This module is retired by **AZ-19** (`docs/implementation-plan.md`).
 * Removal is gated on the owner restarting the server, signing in through the
 * Microsoft provider and confirming the migrated path works (plan §6.6).
 *
 * WHY THIS FILE STILL EXISTS
 * --------------------------
 * `reactory-core` has three live importers of `reactory-azure/services/graph`, in a
 * different repository this module does not own:
 *
 *   - resolvers/Emails/UserEmails.ts:9,22  - `O365.getEmails(token, filter)`
 *   - resolvers/User/ProfileResolver.ts:6,223,254 - `MSGraph.getUserDetails(token, options)`
 *                                                 on the Microsoft **sign-in** path
 *   - services/EmailService.ts:9
 *
 * Deleting it would break sign-in for every existing Microsoft user, because
 * `ProfileResolver` passes the **User document's** access token, refreshed by its
 * local `isTokenValid` closure - not a token from the new vault.
 *
 * WHAT CHANGED (AZ-01)
 * --------------------
 *   - The Graph `Client` is no longer constructed here. Every client - including
 *     this shim's token-authenticated client - is built in
 *     `services/graph/AzureGraphClientProvider.ts`, so `debugLogging` can never be
 *     re-enabled by accident.
 *   - `sendEmail` used to catch its error, log it and `return response;` where
 *     `response` was an import of express's `response` (audit D6). It now rejects.
 *   - `getEmails` used to swallow its error and return `undefined`, which the
 *     caller mapped to an empty list (audit D5). It now rejects.
 *   - `debugLogging: true` is gone (audit D7): it logged request headers, i.e. the
 *     bearer token.
 *
 * CONTRACT KEPT ON PURPOSE
 * ------------------------
 * The nine method names, their argument order and their success shapes are
 * unchanged: `getEmails` still returns the raw Graph page (`{ value: [...] }`)
 * because `UserEmails.ts` maps `'value[].id'`, and `getUserDetails` still returns
 * the raw `/me` payload with an `avatar` property because `ProfileResolver.ts`
 * reads `msuser.avatar`. Failures now throw `ApiError` instead of returning a
 * placeholder.
 */
import moment from 'moment';
import logger from '@reactory/server-core/logging';
import { ResponseType, type Client } from '@microsoft/microsoft-graph-client';
// `Reactory` is the ambient namespace declared by this module's types.d.ts - the
// legacy `IMicrosoftGraph` contract lives there. Importing the core default export
// here would shadow it and hide the interface (each name would resolve to a
// different namespace).
import '../types';
import { createTokenGraphClient } from './graph/AzureGraphClientProvider';
import { readHeader, toGraphApiError } from '../utils/graph-error';

/**
 * The legacy Graph version. `beta` is used only here, for the retired
 * `/me/outlook/tasks` endpoints: those are Microsoft To Do's predecessor and have
 * no v1.0 equivalent, which is exactly why AZ-06 replaces them. Nothing else in
 * this module may reference `beta`.
 */
const LEGACY_TASKS_VERSION = 'beta';

function clientFor(accessToken: string): Client {
  return createTokenGraphClient(accessToken);
}

/** Wrap a failure so the caller gets a typed `ApiError`, never a placeholder. */
function fail(operation: string, error: any): never {
  logger.error(`Microsoft Graph shim: ${operation} failed (${error?.code || error?.message})`);
  throw toGraphApiError(error, { operation });
}

/** Read a RAW Graph response body into a base64 data URI. */
async function dataUriFromRawResponse(response: any): Promise<string | null> {
  const body = response?.body ?? response;
  let buffer: Buffer;

  if (Buffer.isBuffer(body)) {
    buffer = body;
  } else if (body && typeof body.arrayBuffer === 'function') {
    buffer = Buffer.from(await body.arrayBuffer());
  } else if (body && typeof body.on === 'function') {
    buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      body.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      body.on('end', () => resolve(Buffer.concat(chunks)));
      body.on('error', reject);
    });
  } else {
    return null;
  }

  if (!buffer.length) return null;

  // The SDK returns a fetch `Headers` instance, but a plain header bag must work too.
  const contentType = readHeader(response?.headers, 'content-type') || 'image/jpeg';

  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

/**
 * Format a date the way Graph expects a `dateTimeTimeZone`, using local
 * components and the caller's zone - identical to the previous
 * `moment().format()` behaviour.
 */
function toDateTimeTimeZone(value: any, timeZone: string): { dateTime: string; timeZone: string } {
  const momentValue = moment(value);
  return {
    dateTime: `${momentValue.format('YYYY-MM-DD')}T${momentValue.format('HH:mm:ss')}`,
    timeZone,
  };
}

const MSGraph: Reactory.MicrosoftGraph.Service.IMicrosoftGraph = {
  /**
   * `/me/photos/{size}/$value` as a data URI.
   *
   * Returns `null` when Microsoft has no photo for the user (or cannot return
   * one) - an avatar is cosmetic and must not fail the profile read. This is the
   * only shim method that does not throw, and it is preserved from the original.
   */
  async getProfileImage(accessToken: string, size: string = '120x120'): Promise<string | null> {
    try {
      const client = clientFor(accessToken);
      const response = await client
        .api(`/me/photos/${size}/$value`)
        .headers({ accept: 'image/jpeg' })
        .responseType(ResponseType.RAW)
        .get();

      return await dataUriFromRawResponse(response);
    } catch (error: any) {
      logger.debug(`Microsoft Graph shim: could not read the profile image (${error?.code || error?.message})`);
      return null;
    }
  },

  /**
   * `/me` plus an optional photo - the raw Graph payload, as before.
   *
   * `ProfileResolver.ts` reads `avatar`; consumers that already read `givenName`,
   * `surname` or `mail` keep working because the raw payload is returned
   * unchanged.
   */
  async getUserDetails(
    accessToken: string,
    options: { profileImage?: boolean; imageSize?: string } = {},
  ): Promise<any> {
    let user: any;

    try {
      user = await clientFor(accessToken)
        .api('/me')
        .select('mail,givenName,surname')
        .get();
    } catch (error: any) {
      fail('getUserDetails', error);
    }

    if (options?.profileImage === true) {
      user.avatar = await MSGraph.getProfileImage(accessToken, options.imageSize || '120x120');
    }

    return user;
  },

  /** `/me/events` - unchanged select and ordering. */
  async getEvents(accessToken: string): Promise<any> {
    try {
      return await clientFor(accessToken)
        .api('/me/events')
        .select('subject,organizer,start,end')
        .orderby('createdDateTime DESC')
        .get();
    } catch (error: any) {
      fail('getEvents', error);
    }
  },

  /**
   * `/me/messages` - returns the **raw Graph page** (`{ value: [...] }`) because
   * `UserEmails.ts` maps `value[]`.
   */
  async getEmails(accessToken: string, filter: any): Promise<any> {
    const select = 'id,subject,receivedDateTime,sentDateTime,bodyPreview,body,sender,from,toRecipients';

    try {
      const request = clientFor(accessToken).api('/me/messages').select(select);

      if (filter && filter.search) {
        return await request.search(`"${filter.search}"`).get();
      }

      return await request.get();
    } catch (error: any) {
      fail('getEmails', error);
    }
  },

  /** `/me/outlook/tasks` (beta) - the retired Outlook Tasks endpoint. */
  async getTasks(accessToken: string, filter: any): Promise<any> {
    try {
      return await clientFor(accessToken)
        .api('/me/outlook/tasks')
        .version(LEGACY_TASKS_VERSION)
        .select('id,dueDateTime,assignedTo,subject,body')
        .get();
    } catch (error: any) {
      fail('getTasks', error);
    }
  },

  /** `/me/outlook/tasks/{id}` (beta). */
  async getTask(accessToken: string, id: string): Promise<any> {
    try {
      return await clientFor(accessToken)
        .api(`/me/outlook/tasks/${id}`)
        .version(LEGACY_TASKS_VERSION)
        .select('id,dueDateTime,assignedTo,subject,body')
        .get();
    } catch (error: any) {
      fail('getTask', error);
    }
  },

  /** `DELETE /me/outlook/tasks/{id}` (beta). */
  async deleteTask(accessToken: string, id: string): Promise<any> {
    try {
      return await clientFor(accessToken)
        .api(`/me/outlook/tasks/${id}`)
        .version(LEGACY_TASKS_VERSION)
        .delete();
    } catch (error: any) {
      fail('deleteTask', error);
    }
  },

  /** `POST /me/outlook/tasks` (beta). */
  async createTask(
    accessToken: string,
    subject: string,
    assignedTo: string = null,
    startDate: moment.Moment,
    dueDate: moment.Moment,
    timeZone: string = 'South Africa Standard Time',
  ): Promise<any> {
    const task = {
      subject,
      assignedTo,
      startDateTime: toDateTimeTimeZone(startDate, timeZone),
      dueDateTime: toDateTimeTimeZone(dueDate, timeZone),
    };

    try {
      return await clientFor(accessToken)
        .api('/me/outlook/tasks')
        .version(LEGACY_TASKS_VERSION)
        .post(task);
    } catch (error: any) {
      fail('createTask', error);
    }
  },

  /**
   * `POST /me/sendMail`.
   *
   * Rejects on failure. The previous implementation caught the error and
   * `return response;` - an import of express's `response` object - so a failed
   * send reported success to the caller (audit D6). It resolves to `undefined` on
   * success, to make the absence of a result unambiguous.
   */
  async sendEmail(
    accessToken: string,
    subject: string,
    contentType: any,
    content: string,
    recipients: any[],
    saveToSentItems: boolean = true,
    ccRecipients?: any[],
    bccRecipients?: any[],
    attachments?: any[],
  ): Promise<void> {
    const message = {
      subject,
      body: {
        contentType: contentType || 'text',
        content,
      },
      toRecipients: recipients,
      ccRecipients,
      bccRecipients,
      attachments,
    };

    try {
      await clientFor(accessToken)
        .api('/me/sendMail')
        .post({ message, saveToSentItems });
    } catch (error: any) {
      fail('sendEmail', error);
    }
  },
};

export default MSGraph;

'use strict';
import "isomorphic-fetch";
import moment from 'moment';
import { response } from "express";
import logger from '@reactory/server-core/logging';
import ApiError from '@reactory/server-core/exceptions';
import { Reactory } from "@reactory/server-modules/reactory-azure/types";
import { Stream } from "stream";

const getAuthenticatedClient = (accessToken: string, apiVersion = 'v1.0') => {
  // Initialize Graph client
  const client = Client.init({
    // Use the provided access token to authenticate
    // requests
    defaultVersion: apiVersion,
    debugLogging: true,
    authProvider: (done) => {
      done(null, accessToken);
    },
  });

  return client;
};



const MSGraph: Reactory.MicrosoftGraph.Service.IMicrosoftGraph = {
  async getProfileImage(accessToken: string, size: string = '120x120') {
    const client = getAuthenticatedClient(accessToken);

    try {

      const imageResponse = await client
        .api(`/me/photos/${size}/$value`)
        .headers({
          'accept': 'image/jpeg'
        })
        .responseType(ResponseType.RAW)
        .get();

      const s2b = async (readStream: Stream) => {

        return await new Promise((resolve, reject) => {
          const chunks = [];

          readStream.on("data", function (chunk) {
            chunks.push(chunk);
          });

          // Send the buffer or you can put it into a var
          readStream.on("end", function () {
            resolve(Buffer.concat(chunks));
          });

        }).then();
      };
      const imageBuffer = await s2b(imageResponse.body);
      return `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
    } catch (getImageError) {
      logger.debug(`Could not get image`, getImageError);
      return null;
    }
  },
  async getUserDetails(accessToken: string, options: any = { profileImage: false, imageSize: '120x120' }) {

    const client = getAuthenticatedClient(accessToken);
    let user = {
      firstName: '',
      lastName: '',
      email: '',
      avatar: null,
    };

    try {
      user = await client
        .api('/me')
        .select('mail,givenName,surname')
        .get();
    } catch (userGetError) {
      logger.error(`Could not retrieve the user detauls from MS Graph ${userGetError.message}`);
      throw new ApiError(`Could not connect with Microsoft Graph API: ${userGetError.message}`, { MicrosoftError: userGetError });
    }

    if (options.profileImage === true) {
      user.avatar = await MSGraph.getProfileImage(accessToken, options.imageSize);
    }

    logger.debug(`MSGraph /me ${options.profileImage ? 'with profile image fetch' : ''} result`)

    return user;
  },

  async getEvents(accessToken: string) {
    const client = getAuthenticatedClient(accessToken);

    const events = await client
      .api('/me/events')
      .select('subject,organizer,start,end')
      .orderby('createdDateTime DESC')
      .get();

    return events;
  },

  async getEmails(accessToken: string, filter: any) {
    logger.debug(`Getting emails via MS graph`, filter);
    const client = getAuthenticatedClient(accessToken);
    let emails = [];
    try {

      if (filter && filter.search) {
        emails = await client
          .api('/me/messages')
          .select('id,subject,receivedDateTime,sentDateTime,bodyPreview,body,sender,from,toRecipients')
          .search(`"${filter.search}"`)
          .get()
          .then();

      } else {

        emails = await client
          .api('/me/messages')
          .select('id,subject,receivedDateTime,sentDateTime,bodyPreview,body,sender,from,toRecipients')
          .get()
          .then();
      }

    } catch (error) {
      logger.debug('Error fetching emails from MS', error);
    }

    return emails;
  },

  async getTasks(accessToken: string, filter: any) {
    const tasks = await getAuthenticatedClient(accessToken, 'beta')
      .api('/me/outlook/tasks')
      .select('id,dueDateTime,assignedTo,subject,body')
      .get()
      .then();

    return tasks;
  },

  async getTask(accessToken: string, id: string) {
    const tasks = await getAuthenticatedClient(accessToken, 'beta')
      .api(`/me/outlook/tasks/${id}`)
      .select('id,dueDateTime,assignedTo,subject,body')
      .get()
      .then();

    return tasks;
  },

  async deleteTask(accessToken: string, id: string) {

    logger.debug(`MS DELETING TASK - ID:: ${id}`)

    const tasks = await getAuthenticatedClient(accessToken, 'beta')
      .api(`/me/outlook/tasks/${id}`)
      .delete()
      .then();

    return tasks;
  },

  async createTask(accessToken: string, subject: string, assignedTo = null, startDate: moment.Moment, dueDate: moment.Moment, timeZone = 'South Africa Standard Time') {

    startDate = moment(startDate);
    dueDate = moment(dueDate);

    const task = {
      subject,
      assignedTo,
      startDateTime: {
        dateTime: `${startDate.format('YYYY-MM-DD')}T${startDate.format('HH:mm:ss')}`,
        timeZone
      },
      dueDateTime: {
        dateTime: `${dueDate.format('YYYY-MM-DD')}T${dueDate.format('HH:mm:ss')}`,
        timeZone
      }
    };

    const response = await getAuthenticatedClient(accessToken, 'beta')
      .api('/me/outlook/tasks')
      .version('beta')
      .post(task);

    return response;
  },

  async sendEmail(
    accessToken: string,
    subject: string,
    contentType: Microsoft.BodyType = 'text',
    content: string,
    recipients: Microsoft.Recipient[],
    saveToSentItems?: boolean,
    ccRecipients?: Microsoft.Recipient[],
    bccRecipients?: Microsoft.Recipient[],
    attachments?: Microsoft.Attachment[]) {

    const message: Microsoft.Message = {
      subject,
      body: {
        contentType,
        content
      },
      toRecipients: recipients,
      ccRecipients: ccRecipients,
      bccRecipients: bccRecipients,
      attachments: attachments
    };

    try {
      const response = await getAuthenticatedClient(accessToken, 'beta')
        .api('/me/sendMail')
        .post(message)
        .then();
    } catch (msGraphError) {
      logger.error(`Could not send the email due to an error ${msGraphError}`);
    }

    return response;
  }
};

export default MSGraph;

/// <reference path="../../types/reactory.d.ts" />
import type * as Microsoft from "@microsoft/microsoft-graph-types";
import type moment from "moment";

declare module Reactory {
  namespace Azure {
    namespace Service {

    }
  }
  namespace MicrosoftGraph {
    namespace Service {
      export interface IMicrosoftGraph {
        getProfileImage(token: string, size?: string): Promise<string>;
        getUserDetails(token: string, options?: { profileImage: boolean, imageSize: string }): Promise<any>;
        getEvents(token: string): Promise<string>;
        getTasks(token: string, filter: any): Promise<any>;
        getTask(token: string, id: string): Promise<any>;
        deleteTask(token: string, id: string): Promise<any>;
        createTask(accessToken: string, subject: string, assignedTo: string, startDate: moment.Moment, dueDate: moment.Moment, timeZone: string): Promise<any>;
        sendEmail(accessToken: string,
          subject: string,
          contentType: Microsoft.BodyType,
          content: string,
          recipients: Microsoft.Recipient[],
          saveToSentItems?: boolean,
          ccRecipients?: Microsoft.Recipient[],
          bccRecipients?: Microsoft.Recipient[],
          attachments?: Microsoft.Attachment[]): Promise<any>
      }
    }
  }
}
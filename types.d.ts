import type * as Microsoft from "@microsoft/microsoft-graph-types";
import type moment from "moment";

/**
 * AMBIENT CONTRACT FOR THE LEGACY SHIM.
 *
 * `services/graph.ts` still exposes the pre-AZ-01 `MSGraph` surface for the three
 * `reactory-core` importers it cannot yet drop (see that file's header, and AZ-19
 * in docs/implementation-plan.md). This file is what declares that surface, so it
 * survives until the shim does.
 *
 * AZ-01 added `getEmails`, which the shim has always implemented but which was
 * never declared here (audit D3). The method returns the raw Graph page
 * (`{ value: [...] }`), not an array - `UserEmails.ts` maps `value[]`.
 *
 * HOW THE AUGMENTATION WORKS
 * -------------------------
 * `@reactorynet/reactory-core` publishes `export as namespace Reactory`, so
 * `Reactory` is a UMD **global** namespace as well as a module. The interface is
 * therefore added inside `declare global`; a bare `declare module Reactory { ... }`
 * declares an unrelated ambient module and is silently ignored, which is why the
 * previous spelling here never type-checked.
 *
 * The old `/// <reference path="../../types/reactory.d.ts" />` pointed at a file
 * that does not exist in any layout and has been removed.
 *
 * AZ-19 deletes BOTH this file and services/graph.ts, once the owner has restarted
 * the server and confirmed the Microsoft sign-in path works on the migrated
 * services (plan §6.6).
 */
declare global {
  namespace Reactory {
    namespace MicrosoftGraph {
      namespace Service {
        export interface IMicrosoftGraph {
          getProfileImage(token: string, size?: string): Promise<string>;
          // Both members are optional because the implementation defaults them;
          // the pre-AZ-01 declaration required them, which no caller satisfied.
          getUserDetails(token: string, options?: { profileImage?: boolean; imageSize?: string }): Promise<any>;
          getEvents(token: string): Promise<string>;
          getEmails(token: string, filter?: any): Promise<any>;
          getTasks(token: string, filter: any): Promise<any>;
          getTask(token: string, id: string): Promise<any>;
          deleteTask(token: string, id: string): Promise<any>;
          createTask(
            accessToken: string,
            subject: string,
            assignedTo?: string,
            startDate: moment.Moment,
            dueDate: moment.Moment,
            timeZone?: string,
          ): Promise<any>;
          sendEmail(
            accessToken: string,
            subject: string,
            contentType: Microsoft.BodyType,
            content: string,
            recipients: Microsoft.Recipient[],
            saveToSentItems?: boolean,
            ccRecipients?: Microsoft.Recipient[],
            bccRecipients?: Microsoft.Recipient[],
            attachments?: Microsoft.Attachment[],
          ): Promise<any>;
        }
      }
    }
  }
}

export {};

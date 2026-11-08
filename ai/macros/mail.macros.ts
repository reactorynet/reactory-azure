import type {
  ChatState,
  MacroComponentDefinition,
} from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

import {
  AZURE_NS,
  AZURE_VERSION,
  ROLE_SET,
  asStringArray,
  buildParameters,
  compactObject,
  fail,
  macroFailure,
  notConnected,
  ok,
  optionalBoolean,
  optionalNumber,
  optionalString,
  userIdFrom,
} from './macro-support';

/**
 * Mail macros (AZ-13): `azure_send_email` and `azure_search_email`.
 *
 * Both resolve `azure.AzureMailService@1.0.0` from the chat context and return a
 * plain object. Validation that belongs to Graph stays in the service (recipient
 * shape, attachment limits, `$search` grammar); the macro only rejects the
 * requests it can describe better than a provider error can - an empty
 * recipient list, a missing subject, a missing body.
 *
 * `azure_search_email` passes the caller's `$search` value through unchanged:
 * Graph's mailbox search is KQL, not Gmail syntax, and silently rewriting it
 * would make the tool answer a question the user did not ask.
 */

const SEND_TOOL = 'azure_send_email';
const SEARCH_TOOL = 'azure_search_email';

/** A message summary - the fields an assistant can act on, no attachments. */
const summariseMessage = (message: any) => ({
  id: message?.id,
  subject: message?.subject,
  from: message?.from,
  to: message?.toRecipients,
  receivedDateTime: message?.receivedDateTime,
  isRead: message?.isRead,
  hasAttachments: message?.hasAttachments,
  importance: message?.importance,
  bodyPreview: message?.bodyPreview,
  webLink: message?.webLink,
});

const SendEmail = async (params: any, state: ChatState) => {
  const { context } = state;

  const userId = userIdFrom(context);
  if (!userId) {
    return fail(
      SEND_TOOL,
      params,
      'No authenticated user in context',
      'Mail is sent as the signed-in user; it cannot be sent without one.',
    );
  }

  const mailService = context?.getService('azure.AzureMailService@1.0.0') as any;
  if (!mailService) {
    return notConnected(SEND_TOOL, params, 'AzureMailService is not registered');
  }

  const to = asStringArray(params?.to);
  if (to.length === 0) {
    return fail(
      SEND_TOOL,
      params,
      '"to" must contain at least one email address',
      'Pass the recipient addresses (one string, a comma-separated string, or an array).',
    );
  }

  const subject = optionalString(params?.subject);
  if (!subject) {
    return fail(SEND_TOOL, params, '"subject" is required and must not be empty');
  }

  const body = optionalString(params?.body);
  if (!body) {
    return fail(
      SEND_TOOL,
      params,
      '"body" is required and must not be empty',
      'Pass the message text in "body"; set "contentType" to "html" when it contains markup.',
    );
  }

  const cc = asStringArray(params?.cc);
  const bcc = asStringArray(params?.bcc);

  const input = compactObject({
    subject,
    body: {
      // Graph accepts either casing and the service normalises it; the enum is
      // enforced in the tool schema, so a stray value falls back to plain text.
      contentType: optionalString(params?.contentType) === 'html' ? 'html' : 'text',
      content: body,
    },
    toRecipients: to,
    ccRecipients: cc.length > 0 ? cc : undefined,
    bccRecipients: bcc.length > 0 ? bcc : undefined,
    importance: optionalString(params?.importance),
  });

  const saveToSentItems = optionalBoolean(params?.saveToSentItems) !== false;

  try {
    const sent = await mailService.sendMessage(userId, input, { saveToSentItems });

    return ok(
      SEND_TOOL,
      params,
      {
        // The service resolves `true` only once Graph accepted the send. It never
        // resolves a placeholder, so `sent: false` here would be a contract bug -
        // map it explicitly rather than echoing a truthy value.
        sent: sent === true,
        to,
        cc,
        bcc,
        subject,
        saveToSentItems,
      },
      sent === true ? 'Email sent' : 'Graph did not confirm the send',
    );
  } catch (error) {
    return macroFailure(SEND_TOOL, params, error);
  }
};

const SearchEmail = async (params: any, state: ChatState) => {
  const { context } = state;

  const userId = userIdFrom(context);
  if (!userId) {
    return fail(SEARCH_TOOL, params, 'No authenticated user in context');
  }

  const mailService = context?.getService('azure.AzureMailService@1.0.0') as any;
  if (!mailService) {
    return notConnected(SEARCH_TOOL, params, 'AzureMailService is not registered');
  }

  const query = optionalString(params?.query);
  if (!query) {
    return fail(
      SEARCH_TOOL,
      params,
      '"query" is required and must not be empty',
      'Pass a Microsoft Graph mailbox search expression, for example from:alice@example.com '
        + 'or subject:"quarterly report".',
    );
  }

  const top = Math.min(Math.max(Math.trunc(optionalNumber(params?.top) ?? 10), 1), 50);
  const folderId = optionalString(params?.folderId);

  const options = { search: query, top };

  try {
    const page = folderId
      ? await mailService.listMessagesInFolder(userId, folderId, options)
      : await mailService.listMessages(userId, options);

    const items = (Array.isArray(page?.items) ? page.items : []).map(summariseMessage);

    return ok(
      SEARCH_TOOL,
      params,
      {
        count: items.length,
        items,
        nextLink: page?.nextLink,
        folderId,
      },
      `Found ${items.length} message(s)`,
    );
  } catch (error) {
    return macroFailure(SEARCH_TOOL, params, error);
  }
};

const SendEmailMacro: MacroComponentDefinition<typeof SendEmail> = {
  nameSpace: AZURE_NS,
  name: SEND_TOOL,
  version: AZURE_VERSION,
  component: SendEmail,
  description: 'Send an Outlook email as the connected Microsoft 365 user',
  alias: SEND_TOOL,
  runat: 'server',
  icon: 'send',
  roles: ROLE_SET,
  tags: ['azure', 'mail', 'outlook', 'email', 'send'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      runat: 'server',
      function: {
        name: SEND_TOOL,
        icon: 'send',
        description:
          'Send an email from the connected user\'s Outlook mailbox via Microsoft Graph. '
          + 'Requires at least one recipient, a subject and a non-empty body. Returns whether '
          + 'Graph accepted the send.',
        parameters: buildParameters([
          {
            name: 'to',
            type: 'array',
            required: true,
            items: { type: 'string' },
            description:
              'Primary recipients. An array of SMTP addresses; a single comma-separated string '
              + 'is also accepted.',
          },
          {
            name: 'subject',
            type: 'string',
            required: true,
            description: 'Message subject line.',
          },
          {
            name: 'body',
            type: 'string',
            required: true,
            description:
              'Message content. Plain text by default; set contentType to "html" when it '
              + 'contains markup.',
          },
          {
            name: 'contentType',
            type: 'string',
            required: false,
            enum: ['text', 'html'],
            default: 'text',
            description: 'How "body" should be rendered. Defaults to "text".',
          },
          {
            name: 'cc',
            type: 'array',
            required: false,
            items: { type: 'string' },
            description: 'Optional carbon-copy recipients as SMTP addresses.',
          },
          {
            name: 'bcc',
            type: 'array',
            required: false,
            items: { type: 'string' },
            description: 'Optional blind carbon-copy recipients as SMTP addresses.',
          },
          {
            name: 'importance',
            type: 'string',
            required: false,
            enum: ['low', 'normal', 'high'],
            description: 'Optional message importance. Graph defaults to "normal".',
          },
          {
            name: 'saveToSentItems',
            type: 'boolean',
            required: false,
            default: true,
            description:
              'Whether Graph should keep a copy in Sent Items. Defaults to true. A message '
              + 'with an oversized attachment is sent through a draft and always keeps a copy.',
          },
        ]),
      },
    },
  ],
};

const SearchEmailMacro: MacroComponentDefinition<typeof SearchEmail> = {
  nameSpace: AZURE_NS,
  name: SEARCH_TOOL,
  version: AZURE_VERSION,
  component: SearchEmail,
  description: 'Search the connected user\'s Outlook mailbox with Microsoft Graph $search',
  alias: SEARCH_TOOL,
  runat: 'server',
  icon: 'search',
  roles: ROLE_SET,
  tags: ['azure', 'mail', 'outlook', 'email', 'search', 'read'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      runat: 'server',
      safeForAutoExecution: true,
      function: {
        name: SEARCH_TOOL,
        icon: 'search',
        description:
          'Search the connected user\'s Outlook mailbox and return message summaries. The '
          + 'query is a Microsoft Graph $search expression (KQL), for example '
          + 'from:alice@example.com, subject:"quarterly report" or hasAttachments:true. '
          + 'Optionally restrict to one mail folder.',
        parameters: buildParameters([
          {
            name: 'query',
            type: 'string',
            required: true,
            description:
              'Microsoft Graph $search (KQL) expression. Not Gmail syntax: use '
              + 'from:/to:/subject:/received>= and quote multi-word values.',
          },
          {
            name: 'folderId',
            type: 'string',
            required: false,
            description:
              'Optional mail folder id. When supplied, only that folder is searched; when '
              + 'omitted the whole mailbox is searched.',
          },
          {
            name: 'top',
            type: 'integer',
            required: false,
            default: 10,
            description: 'Maximum number of messages to return, 1-50. Defaults to 10.',
          },
        ]),
      },
    },
  ],
};

export const MAIL_MACROS: MacroComponentDefinition<unknown>[] = [SendEmailMacro, SearchEmailMacro];

export { SendEmailMacro, SearchEmailMacro };
export default MAIL_MACROS;

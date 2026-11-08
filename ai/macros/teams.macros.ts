import type {
  ChatState,
  MacroComponentDefinition,
} from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

/**
 * Teams macros (AZ-14).
 *
 * One macro: `azure_send_teams_message`. Teams has no equivalent in the Google
 * module, so there is no parity name to mirror - the tool is named after the
 * Graph capability it drives.
 *
 * It resolves `azure.AzureTeamsService@1.0.0` from `state.context` (never holds a
 * service reference) and returns a JSON-serialisable envelope. All validation that
 * matters - content type, empty body, id encoding - lives in the service, so the
 * macro cannot drift from the GraphQL path: a message the mutation would reject is
 * rejected here with the same error.
 *
 * `ai/macros/index.ts` (owned by AZ-01) spreads this array into `AZURE_MACROS`, so
 * this file adds the entry and never edits the barrel.
 */

const AZURE_NS = 'azure';
const AZURE_VERSION = '1.0.0';
const ROLE_SET = ['USER', 'ADMIN'];

/** The macro's registry name, its tool-function name and its `AZURE_MACROS` identity. */
const TOOL_NAME = 'azure_send_teams_message';

/** Structured success envelope returned by the macro. */
const ok = (params: any, data: any, message?: string) => ({
  success: true,
  data,
  tool: TOOL_NAME,
  params,
  ...(message ? { message } : {}),
});

/** Structured failure envelope returned by the macro. */
const fail = (params: any, error: string, instructions?: string) => ({
  success: false,
  error,
  tool: TOOL_NAME,
  params,
  ...(instructions ? { instructions } : {}),
});

/** A trimmed, non-empty string parameter, or `undefined`. */
const optionalId = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim().length > 0 ? value : undefined
);

const SendTeamsMessage = async (params: any, state: ChatState) => {
  const { context } = state;
  const teamsService = context?.getService('azure.AzureTeamsService@1.0.0') as any;

  if (!teamsService) return fail(params, 'Azure Teams Service not available');

  const userId = String(context.user?._id);
  if (!userId || userId === 'undefined') {
    return fail(
      params,
      'No authenticated user in context',
      'azure_send_teams_message sends as the signed-in user; it cannot send without one.',
    );
  }

  const chatId = optionalId(params?.chatId);
  const teamId = optionalId(params?.teamId);
  const channelId = optionalId(params?.channelId);

  if (chatId && (teamId || channelId)) {
    return fail(
      params,
      'Provide either "chatId" or "teamId" + "channelId", not both',
      'A message goes to one destination: a chat, or a channel inside a team.',
    );
  }

  if (!chatId && !(teamId && channelId)) {
    return fail(
      params,
      'A destination is required',
      'Pass "chatId" for a chat message, or both "teamId" and "channelId" for a channel message.',
    );
  }

  // The service owns payload validation; passing `content`/`contentType` through
  // unchanged means the macro surfaces exactly the error the mutation would.
  const input = { content: params?.content, contentType: params?.contentType };

  try {
    const data = chatId
      ? await teamsService.sendChatMessage(userId, chatId, input)
      : await teamsService.sendChannelMessage(userId, teamId, channelId, input);

    return ok(params, data, 'Message sent');
  } catch (error) {
    return fail(params, error instanceof Error ? error.message : 'Unknown error');
  }
};

const SendTeamsMessageMacro: MacroComponentDefinition<typeof SendTeamsMessage> = {
  nameSpace: AZURE_NS,
  name: TOOL_NAME,
  version: AZURE_VERSION,
  component: SendTeamsMessage,
  description: "Send a Microsoft Teams message to a chat or to a team channel as the connected user",
  alias: TOOL_NAME,
  runat: 'server',
  icon: 'send',
  roles: ROLE_SET,
  tags: ['azure', 'teams', 'chat', 'channel', 'message', 'send'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      function: {
        name: TOOL_NAME,
        icon: 'send',
        description:
          'Send a Microsoft Teams message as the connected user. Target either a chat (chatId) '
          + 'or a team channel (teamId + channelId). contentType is "html" or "text" (default "text"). '
          + 'Returns the created message.',
        parameters: {
          type: 'object',
          properties: {
            chatId: {
              type: 'string',
              description: 'Chat id, exactly as Graph returned it. Do not URL-encode it.',
            },
            teamId: {
              type: 'string',
              description: 'Team id for a channel message. Must be supplied with channelId.',
            },
            channelId: {
              type: 'string',
              description: 'Channel id for a channel message. Must be supplied with teamId.',
            },
            content: {
              type: 'string',
              description: 'Message content. HTML when contentType is "html", plain text otherwise.',
            },
            contentType: {
              type: 'string',
              enum: ['html', 'text'],
              description: 'How to render content: "html" for rich content, "text" for literal text. Defaults to "text".',
            },
          },
          required: ['content'],
        },
      },
    },
  ],
};

export const TEAMS_MACROS: MacroComponentDefinition<unknown>[] = [SendTeamsMessageMacro];

export { SendTeamsMessageMacro };
export default TEAMS_MACROS;

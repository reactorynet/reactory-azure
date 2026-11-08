import type {
  ChatState,
  MacroComponentDefinition,
} from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

import {
  AZURE_NS,
  AZURE_VERSION,
  ROLE_SET,
  buildParameters,
  fail,
  macroFailure,
  notConnected,
  ok,
  toIsoString,
  userIdFrom,
} from './macro-support';

/**
 * Connection-status macro (AZ-13).
 *
 * `azure_connection_status` is the first tool the assistant should reach for
 * when any Microsoft 365 action fails: it answers "is this user connected, and
 * to what?" without touching Graph. It resolves the module facade
 * (`azure.AzureService@1.0.0`), whose `getConnectionStatus` reads the vaulted
 * token record through `AzureAuthService` - no Graph request is made.
 *
 * It never throws: a missing facade, a missing user or a service error all come
 * back as a JSON payload the assistant can relay.
 */

const TOOL_NAME = 'azure_connection_status';

const ConnectionStatus = async (params: any, state: ChatState) => {
  const { context } = state;

  const userId = userIdFrom(context);
  if (!userId) {
    return fail(
      TOOL_NAME,
      params,
      'No authenticated user in context',
      'Connection status is per user; it cannot be read without a signed-in user.',
    );
  }

  const azureService = context?.getService('azure.AzureService@1.0.0') as any;

  if (!azureService) {
    return notConnected(
      TOOL_NAME,
      params,
      'AzureService is not registered, so the Microsoft 365 connection state cannot be read',
    );
  }

  try {
    const connection = await azureService.getConnectionStatus(userId);
    const status = connection?.status || 'DISCONNECTED';

    // CONNECTED is the only state that needs no user action. TOKEN_EXPIRED and
    // LEGACY are still "connected" in the sense that a token exists and may be
    // refreshed; DISCONNECTED, AUTHORIZING and REVOKED are not.
    const connected = status === 'CONNECTED' || status === 'TOKEN_EXPIRED' || status === 'LEGACY';

    return ok(
      TOOL_NAME,
      params,
      {
        connected,
        status,
        userId: connection?.userId || userId,
        email: connection?.email,
        upn: connection?.upn,
        tenantId: connection?.tenantId,
        tokenSource: connection?.tokenSource,
        grantedScopes: params?.includeScopes === false
          ? undefined
          : (Array.isArray(connection?.grantedScopes) ? [...connection.grantedScopes] : []),
        connectedAt: toIsoString(connection?.connectedAt),
        lastRefreshedAt: toIsoString(connection?.lastRefreshedAt),
        expiresAt: toIsoString(connection?.expiresAt),
      },
      connected
        ? 'Microsoft 365 is connected'
        : 'Microsoft 365 is not connected - the user must connect their account',
    );
  } catch (error) {
    return macroFailure(TOOL_NAME, params, error);
  }
};

const ConnectionStatusMacro: MacroComponentDefinition<typeof ConnectionStatus> = {
  nameSpace: AZURE_NS,
  name: TOOL_NAME,
  version: AZURE_VERSION,
  component: ConnectionStatus,
  description: 'Report whether the signed-in user has a working Microsoft 365 connection',
  alias: TOOL_NAME,
  runat: 'server',
  icon: 'check_circle',
  roles: ROLE_SET,
  tags: ['azure', 'microsoft-365', 'connection', 'status', 'health'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      runat: 'server',
      safeForAutoExecution: true,
      function: {
        name: TOOL_NAME,
        icon: 'check_circle',
        description:
          'Report whether the current user is connected to Microsoft 365, which status the '
          + 'connection is in (CONNECTED, TOKEN_EXPIRED, LEGACY, DISCONNECTED, AUTHORIZING, '
          + 'REVOKED) and, unless suppressed, which Graph scopes were granted. Makes no Graph '
          + 'call. Use it before or after any other azure_* tool to explain a failure to the user.',
        parameters: buildParameters([
          {
            name: 'includeScopes',
            type: 'boolean',
            required: false,
            default: true,
            description:
              'Whether to include the granted Graph scopes in the response. Defaults to true; '
              + 'pass false when only the connection state matters.',
          },
        ]),
      },
    },
  ],
};

export const STATUS_MACROS: MacroComponentDefinition<unknown>[] = [ConnectionStatusMacro];

export { ConnectionStatusMacro };
export default STATUS_MACROS;

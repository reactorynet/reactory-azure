import type {
  ChatState,
  MacroComponentDefinition,
} from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

import {
  AZURE_NS,
  AZURE_VERSION,
  ROLE_SET,
  buildParameters,
  compactObject,
  fail,
  macroFailure,
  notConnected,
  ok,
  optionalNumber,
  optionalString,
  userIdFrom,
} from './macro-support';

/**
 * Drive macro (AZ-13): `azure_search_drive`.
 *
 * Resolves `azure.AzureDriveService@1.0.0` from the chat context and returns one
 * page of search hits. `query` is passed to Graph's `/root/search(q='...')`
 * verbatim - the service quotes and percent-encodes it - so the macro neither
 * rewrites the term nor escapes it a second time.
 *
 * The result is a summary, not a raw `IDriveItem`: an assistant needs a name, an
 * id it can hand to `azure_read_workbook`, a web URL and whether the item is a
 * folder. Graph's hashes, thumbnails and permission blobs would only add noise.
 */

const TOOL_NAME = 'azure_search_drive';

/** One search hit, reduced to the fields an assistant acts on. */
const summariseItem = (item: any) => ({
  id: item?.id,
  name: item?.name,
  webUrl: item?.webUrl,
  size: item?.size,
  isFolder: Boolean(item?.folder),
  childCount: item?.folder?.childCount,
  mimeType: item?.file?.mimeType,
  path: item?.parentReference?.path,
  lastModifiedDateTime: item?.lastModifiedDateTime,
  createdDateTime: item?.createdDateTime,
});

const SearchDrive = async (params: any, state: ChatState) => {
  const { context } = state;

  const userId = userIdFrom(context);
  if (!userId) {
    return fail(
      TOOL_NAME,
      params,
      'No authenticated user in context',
      'Drive search runs against the signed-in user\'s OneDrive; a user is required.',
    );
  }

  const driveService = context?.getService('azure.AzureDriveService@1.0.0') as any;
  if (!driveService) {
    return notConnected(TOOL_NAME, params, 'AzureDriveService is not registered');
  }

  const query = optionalString(params?.query);
  if (!query) {
    return fail(
      TOOL_NAME,
      params,
      '"query" is required and must not be empty',
      'Pass the file or folder name (or part of it) to search for.',
    );
  }

  const top = Math.min(Math.max(Math.trunc(optionalNumber(params?.top) ?? 10), 1), 100);

  const options = compactObject({
    top,
    driveId: optionalString(params?.driveId),
  });

  try {
    const page = await driveService.search(userId, query, options);
    const items = (Array.isArray(page?.items) ? page.items : []).map(summariseItem);

    return ok(
      TOOL_NAME,
      params,
      {
        count: items.length,
        items,
        nextLink: page?.nextLink,
        query,
      },
      `Found ${items.length} item(s) matching "${query}"`,
    );
  } catch (error) {
    return macroFailure(TOOL_NAME, params, error);
  }
};

const SearchDriveMacro: MacroComponentDefinition<typeof SearchDrive> = {
  nameSpace: AZURE_NS,
  name: TOOL_NAME,
  version: AZURE_VERSION,
  component: SearchDrive,
  description: 'Search the connected user\'s OneDrive for files and folders',
  alias: TOOL_NAME,
  runat: 'server',
  icon: 'search',
  roles: ROLE_SET,
  tags: ['azure', 'drive', 'onedrive', 'files', 'search', 'read'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      runat: 'server',
      safeForAutoExecution: true,
      function: {
        name: TOOL_NAME,
        icon: 'search',
        description:
          'Search the connected user\'s OneDrive (or a specified drive) by file or folder '
          + 'name. Returns matching items with an id, web URL and whether each is a folder. '
          + 'Use the returned id with azure_read_workbook for a spreadsheet.',
        parameters: buildParameters([
          {
            name: 'query',
            type: 'string',
            required: true,
            description:
              'Search text: a file or folder name, or part of one. Graph matches on name, '
              + 'not on file contents.',
          },
          {
            name: 'top',
            type: 'integer',
            required: false,
            default: 10,
            description: 'Maximum number of items to return, 1-100. Defaults to 10.',
          },
          {
            name: 'driveId',
            type: 'string',
            required: false,
            description:
              'Optional drive id. When omitted the user\'s default OneDrive is searched.',
          },
        ]),
      },
    },
  ],
};

export const DRIVE_MACROS: MacroComponentDefinition<unknown>[] = [SearchDriveMacro];

export { SearchDriveMacro };
export default DRIVE_MACROS;

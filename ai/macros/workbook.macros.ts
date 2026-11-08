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
  optionalBoolean,
  optionalString,
  userIdFrom,
} from './macro-support';

/**
 * Workbook macro (AZ-13): `azure_read_workbook`.
 *
 * Resolves `azure.AzureWorkbookService@1.0.0` from the chat context and reads a
 * worksheet's values out of an Excel file in OneDrive.
 *
 * Two entry shapes, both explicit:
 *
 *   - `range` supplied  -> that exact A1 address (`getRange`);
 *   - `range` omitted   -> the used range (`getUsedRange`), which is what
 *     "read the workbook" means when the caller does not know the extent.
 *
 * `worksheet` is optional. When it is omitted the macro lists the worksheets and
 * uses the first one, so an assistant that only has a file id still gets an
 * answer instead of a validation error. The response always names the worksheet
 * it actually read.
 *
 * Only values and display text are returned. Formulas and number formats are
 * available from the service but would double the payload for no assistant use.
 */

const TOOL_NAME = 'azure_read_workbook';

const ReadWorkbook = async (params: any, state: ChatState) => {
  const { context } = state;

  const userId = userIdFrom(context);
  if (!userId) {
    return fail(
      TOOL_NAME,
      params,
      'No authenticated user in context',
      'Workbooks are read from the signed-in user\'s OneDrive; a user is required.',
    );
  }

  const workbookService = context?.getService('azure.AzureWorkbookService@1.0.0') as any;
  if (!workbookService) {
    return notConnected(TOOL_NAME, params, 'AzureWorkbookService is not registered');
  }

  const itemId = optionalString(params?.itemId);
  if (!itemId) {
    return fail(
      TOOL_NAME,
      params,
      '"itemId" is required',
      'Pass the OneDrive item id of the .xlsx file. Use azure_search_drive to find it.',
    );
  }

  const driveId = optionalString(params?.driveId);
  const requestOptions = compactObject({ driveId });
  const valuesOnly = optionalBoolean(params?.valuesOnly) !== false;
  const address = optionalString(params?.range);

  let worksheet = optionalString(params?.worksheet);

  try {
    if (!worksheet) {
      const worksheets = await workbookService.listWorksheets(userId, itemId, requestOptions);
      const first = Array.isArray(worksheets) ? worksheets[0] : undefined;

      if (!first) {
        return fail(
          TOOL_NAME,
          params,
          'The workbook has no worksheets',
          'The item id may not point at an Excel workbook. Use azure_search_drive to confirm '
            + 'the file and its id.',
        );
      }

      // The service accepts either the worksheet id or its name on every
      // worksheet-scoped path; the name is friendlier in the response.
      worksheet = first.name || first.id;
    }

    const range = address
      ? await workbookService.getRange(userId, itemId, worksheet, address, requestOptions)
      : await workbookService.getUsedRange(userId, itemId, worksheet, {
        ...requestOptions,
        valuesOnly,
      });

    return ok(
      TOOL_NAME,
      params,
      {
        itemId,
        worksheet,
        address: range?.address,
        addressLocal: range?.addressLocal,
        rowCount: range?.rowCount,
        columnCount: range?.columnCount,
        cellCount: range?.cellCount,
        values: Array.isArray(range?.values) ? range.values : [],
        text: Array.isArray(range?.text) ? range.text : undefined,
      },
      `Read ${range?.address || 'the used range'} from worksheet "${worksheet}"`,
    );
  } catch (error) {
    return macroFailure(TOOL_NAME, params, error);
  }
};

const ReadWorkbookMacro: MacroComponentDefinition<typeof ReadWorkbook> = {
  nameSpace: AZURE_NS,
  name: TOOL_NAME,
  version: AZURE_VERSION,
  component: ReadWorkbook,
  description: 'Read cell values from an Excel workbook stored in OneDrive',
  alias: TOOL_NAME,
  runat: 'server',
  icon: 'table_chart',
  roles: ROLE_SET,
  tags: ['azure', 'workbook', 'excel', 'onedrive', 'spreadsheet', 'read'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      runat: 'server',
      safeForAutoExecution: true,
      function: {
        name: TOOL_NAME,
        icon: 'table_chart',
        description:
          'Read an Excel workbook from OneDrive via Microsoft Graph. Reads the worksheet\'s '
          + 'used range by default, or an explicit A1 range when one is supplied. Returns the '
          + 'cell values as a row-major matrix plus the address that was read.',
        parameters: buildParameters([
          {
            name: 'itemId',
            type: 'string',
            required: true,
            description:
              'OneDrive item id of the workbook (.xlsx). Obtain it from azure_search_drive.',
          },
          {
            name: 'worksheet',
            type: 'string',
            required: false,
            description:
              'Worksheet name or id. When omitted the first worksheet in the workbook is read.',
          },
          {
            name: 'range',
            type: 'string',
            required: false,
            description:
              'Optional A1 range, for example "A1:D20". When omitted the worksheet\'s used '
              + 'range is read.',
          },
          {
            name: 'valuesOnly',
            type: 'boolean',
            required: false,
            default: true,
            description:
              'Whether a used-range read should include the cell values (true) or only the '
              + 'address and counts (false). Defaults to true. Ignored when "range" is given.',
          },
          {
            name: 'driveId',
            type: 'string',
            required: false,
            description:
              'Optional drive id, for a workbook in a SharePoint document library rather than '
              + 'the user\'s OneDrive.',
          },
        ]),
      },
    },
  ],
};

export const WORKBOOK_MACROS: MacroComponentDefinition<unknown>[] = [ReadWorkbookMacro];

export { ReadWorkbookMacro };
export default WORKBOOK_MACROS;

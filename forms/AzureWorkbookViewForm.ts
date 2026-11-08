import Reactory from '@reactorynet/reactory-core';
import { fieldLabel, formLabel } from './i18n';

/**
 * Read and write an Excel workbook that lives in a drive.
 *
 * This is the one component `reactory-google`'s eight do **not** have; it exists
 * because `azureWorkbook*` is a first-class surface here. Nine forms, not eight.
 *
 * WHY THE RANGE IS THE PRIMARY READ
 * ---------------------------------
 * A form has exactly one `graphql.query` document and the data manager selects
 * `data.data[query.name]`, so the declared read decides what the form can show.
 * `azureWorkbookWorksheets` would show a list of tab names and nothing else;
 * `azureWorkbookRange(itemId, worksheet, address, valuesOnly, driveId)` shows the
 * cells, which is what "view a workbook" means. `itemId` + `worksheet` are
 * therefore required, and `address` left empty reads the used range.
 *
 * VALUES ARE `Any`, NEVER `[String]`
 * ----------------------------------
 * A range matrix carries `null` for an empty cell and `'#DIV/0!'` for an error
 * cell. A String matrix would stringify numbers and erase the empty-vs-error
 * distinction, so `values` is a nested array that is sent through untouched, and
 * `AzureWorkbookRangeInput.values` is `Any!` for the same reason.
 *
 * `useSession: true` keeps the used-range read and the write inside one workbook
 * session; the service closes that session in a `finally`.
 *
 * MODE CONSTRAINT ON `values`
 * ----------------------------
 * `AzureWorkbookRangeInput.values` is `Any!` and `azureAppendWorkbookRows` takes
 * `$values: Any!`, but `values` is not in `schema.required`: one schema serves the
 * read, append and update modes, and requiring it unconditionally would block
 * reading a range. A write submitted without values reaches Graph and is rejected
 * there. Per-mode validation would need client-side fieldMap support.
 */
const AzureWorkbookViewForm: Reactory.Forms.IReactoryForm = {
  id: 'azure.AzureWorkbookViewForm@1.0.0',
  nameSpace: 'azure',
  name: 'AzureWorkbookViewForm',
  version: '1.0.0',
  title: formLabel('workbookView', 'title'),
  description: formLabel('workbookView', 'description'),
  schema: {
    type: 'object',
    title: formLabel('workbookView', 'schemaTitle'),
    required: ['itemId', 'worksheet'],
    properties: {
      itemId: {
        type: 'string',
        title: fieldLabel('workbookView', 'itemId'),
      },
      driveId: {
        type: 'string',
        title: fieldLabel('workbookView', 'driveId'),
      },
      worksheet: {
        type: 'string',
        title: fieldLabel('workbookView', 'worksheet'),
      },
      address: {
        type: 'string',
        title: fieldLabel('workbookView', 'address'),
      },
      valuesOnly: {
        type: 'boolean',
        title: fieldLabel('workbookView', 'valuesOnly'),
        default: true,
      },
      values: {
        type: 'array',
        title: fieldLabel('workbookView', 'values'),
        items: {
          type: 'array',
          title: fieldLabel('workbookView', 'row'),
          items: { type: 'string' },
        },
      },
      useSession: {
        type: 'boolean',
        title: fieldLabel('workbookView', 'useSession'),
        default: true,
      },
    },
  },
  uiSchema: {
    itemId: { 'ui:widget': 'text' },
    driveId: { 'ui:widget': 'text' },
    worksheet: {
      'ui:widget': 'text',
      'ui:placeholder': formLabel('workbookView', 'placeholder', 'worksheet'),
    },
    address: {
      'ui:widget': 'text',
      'ui:help': formLabel('workbookView', 'help', 'address'),
    },
    valuesOnly: { 'ui:widget': 'checkbox' },
    values: {
      'ui:widget': 'textarea',
      'ui:help': formLabel('workbookView', 'help', 'values'),
    },
    useSession: { 'ui:widget': 'checkbox' },
  },
  roles: ['USER'],
  registerAsComponent: true,
  uiSupport: ['material'],
  graphql: {
    query: {
      name: 'azureWorkbookRange',
      text: `query AzureWorkbookRange(
        $itemId: String!
        $worksheet: String!
        $address: String
        $valuesOnly: Boolean
        $driveId: String
      ) {
        azureWorkbookRange(
          itemId: $itemId
          worksheet: $worksheet
          address: $address
          valuesOnly: $valuesOnly
          driveId: $driveId
        ) {
          address
          addressLocal
          cellCount
          columnCount
          rowCount
          rowIndex
          columnIndex
          values
          text
          valueTypes
        }
      }`,
      variables: {
        'formData.itemId': 'itemId',
        'formData.worksheet': 'worksheet',
        'formData.address': 'address',
        'formData.valuesOnly': 'valuesOnly',
        'formData.driveId': 'driveId',
      },
      // `azureWorkbookRange` returns the range object; only `address` and
      // `values` are declared on this form, so only those are mapped. The rest
      // of the payload (counts, text, valueTypes) has no property to land on
      // and would be dropped by rjsf anyway.
      resultMap: { address: 'address', values: 'values' },
    },
    mutation: {
      new: {
        name: 'azureAppendWorkbookRows',
        text: `mutation AzureAppendWorkbookRows(
          $itemId: String!
          $worksheet: String!
          $values: Any!
          $useSession: Boolean
          $driveId: String
        ) {
          azureAppendWorkbookRows(
            itemId: $itemId
            worksheet: $worksheet
            values: $values
            useSession: $useSession
            driveId: $driveId
          ) {
            address
            rowCount
            columnCount
            values
          }
        }`,
        variables: {
          'formData.itemId': 'itemId',
          'formData.worksheet': 'worksheet',
          'formData.values': 'values',
          'formData.useSession': 'useSession',
          'formData.driveId': 'driveId',
        },
      },
      edit: {
        name: 'azureUpdateWorkbookRange',
        text: `mutation AzureUpdateWorkbookRange(
          $itemId: String!
          $worksheet: String!
          $address: String!
          $input: AzureWorkbookRangeInput!
          $useSession: Boolean
          $driveId: String
        ) {
          azureUpdateWorkbookRange(
            itemId: $itemId
            worksheet: $worksheet
            address: $address
            input: $input
            useSession: $useSession
            driveId: $driveId
          ) {
            address
            rowCount
            columnCount
            values
          }
        }`,
        variables: {
          'formData.itemId': 'itemId',
          'formData.worksheet': 'worksheet',
          'formData.address': 'address',
          'formData.values': 'input.values',
          'formData.useSession': 'useSession',
          'formData.driveId': 'driveId',
        },
      },
    },
  },
};

export default AzureWorkbookViewForm;

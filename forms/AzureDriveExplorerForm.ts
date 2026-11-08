import Reactory from '@reactorynet/reactory-core';
import { fieldLabel, formLabel } from './i18n';

/**
 * Browse, create folders in and clean up OneDrive —
 * `azureDriveItems(driveId, itemId, top, orderBy)`.
 *
 * `itemId` is the folder whose children are listed; omitted means the drive
 * root. `selectedItemId` is the row the delete acts on, kept separate from
 * `itemId` so browsing into a folder does not change what a delete targets.
 *
 * THE READ LANDS ON A DECLARED PROPERTY
 * -------------------------------------
 * `azureDriveItems` returns `AzureDriveItemPage` (`{ items, nextLink, count }`).
 * The data manager spreads that object and applies `resultMap`; it does not read
 * `resultType`. The `items` array is declared and rendered through
 * `MaterialTableWidget`, so the folder listing is actually visible — without it
 * the rows land on a key no property declares.
 *
 * No `downloadUrl` anywhere: Graph's content URLs are pre-authenticated and
 * exposing one would let a client bypass the user's grant. Bytes go through
 * `GET /azure/files/:itemId`, which proxies the stream.
 *
 * No search field: `azureDriveSearch` is a different root field and a form has one
 * fixed `graphql.query` document. Drive search needs its own form.
 */
const AzureDriveExplorerForm: Reactory.Forms.IReactoryForm = {
  id: 'azure.AzureDriveExplorerForm@1.0.0',
  nameSpace: 'azure',
  name: 'AzureDriveExplorerForm',
  version: '1.0.0',
  title: formLabel('driveExplorer', 'title'),
  description: formLabel('driveExplorer', 'description'),
  schema: {
    type: 'object',
    title: formLabel('driveExplorer', 'schemaTitle'),
    properties: {
      items: {
        type: 'array',
        title: fieldLabel('driveExplorer', 'items'),
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            kind: { type: 'string' },
            size: { type: 'number' },
            lastModifiedDateTime: { type: 'string' },
          },
        },
      },
      nextLink: {
        type: 'string',
        title: fieldLabel('driveExplorer', 'nextLink'),
      },
      count: {
        type: 'number',
        title: fieldLabel('driveExplorer', 'count'),
      },
      driveId: {
        type: 'string',
        title: fieldLabel('driveExplorer', 'driveId'),
      },
      itemId: {
        type: 'string',
        title: fieldLabel('driveExplorer', 'itemId'),
      },
      orderBy: {
        type: 'string',
        title: fieldLabel('driveExplorer', 'orderBy'),
        default: 'name asc',
      },
      top: {
        type: 'number',
        title: fieldLabel('driveExplorer', 'top'),
        default: 50,
      },
      newFolderName: {
        type: 'string',
        title: fieldLabel('driveExplorer', 'newFolderName'),
      },
      selectedItemId: {
        type: 'string',
        title: fieldLabel('driveExplorer', 'selectedItemId'),
      },
    },
  },
  uiSchema: {
    items: {
      'ui:title': null,
      'ui:widget': 'MaterialTableWidget',
      'ui:options': {
        showLabel: false,
        allowAdd: false,
        allowDelete: false,
        search: false,
        columns: [
          { title: formLabel('driveExplorer', 'columns', 'name'), field: 'name', width: 300 },
          { title: formLabel('driveExplorer', 'columns', 'kind'), field: 'kind', width: 120 },
          { title: formLabel('driveExplorer', 'columns', 'size'), field: 'size', width: 120 },
          {
            title: formLabel('driveExplorer', 'columns', 'lastModifiedDateTime'),
            field: 'lastModifiedDateTime',
            width: 200,
          },
        ],
      },
    },
    nextLink: { 'ui:widget': 'text' },
    count: { 'ui:widget': 'updown' },
    driveId: { 'ui:widget': 'text' },
    itemId: { 'ui:widget': 'text' },
    orderBy: { 'ui:widget': 'text' },
    top: { 'ui:widget': 'updown' },
    newFolderName: { 'ui:widget': 'text' },
    selectedItemId: { 'ui:widget': 'text' },
  },
  roles: ['USER'],
  registerAsComponent: true,
  uiSupport: ['material'],
  graphql: {
    query: {
      name: 'azureDriveItems',
      text: `query AzureDriveItems($driveId: String, $itemId: String, $top: Int, $orderBy: String) {
        azureDriveItems(driveId: $driveId, itemId: $itemId, top: $top, orderBy: $orderBy) {
          items {
            id
            name
            size
            webUrl
            kind
            mimeType
            isFolder
            childCount
            lastModifiedDateTime
            parentReference {
              id
              path
            }
          }
          nextLink
          count
        }
      }`,
      variables: {
        'formData.driveId': 'driveId',
        'formData.itemId': 'itemId',
        'formData.top': 'top',
        'formData.orderBy': 'orderBy',
      },
      resultMap: { items: 'items', nextLink: 'nextLink', count: 'count' },
    },
    mutation: {
      new: {
        name: 'azureCreateDriveFolder',
        text: `mutation AzureCreateDriveFolder($name: String!, $parentId: String, $driveId: String) {
          azureCreateDriveFolder(name: $name, parentId: $parentId, driveId: $driveId) {
            id
            name
            webUrl
            isFolder
          }
        }`,
        variables: {
          'formData.newFolderName': 'name',
          'formData.itemId': 'parentId',
          'formData.driveId': 'driveId',
        },
      },
      delete: {
        name: 'azureDeleteDriveItem',
        text: `mutation AzureDeleteDriveItem($itemId: String!, $driveId: String) {
          azureDeleteDriveItem(itemId: $itemId, driveId: $driveId)
        }`,
        variables: {
          'formData.selectedItemId': 'itemId',
          'formData.driveId': 'driveId',
        },
      },
    },
  },
};

export default AzureDriveExplorerForm;

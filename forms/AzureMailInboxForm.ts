import Reactory from '@reactorynet/reactory-core';
import { fieldLabel, formLabel } from './i18n';

/**
 * The mailbox listing — `azureMailMessages(options: AzureMailListOptions)`.
 *
 * THE READ LANDS ON A DECLARED PROPERTY
 * -------------------------------------
 * The field returns `AzureMailPage` (`{ items, nextLink, count }`). The live data
 * manager spreads `data.data[query.name]` and applies `resultMap`; it never reads
 * `resultType` (`ReactoryFormDataManager.fromGraphResult`, its only consumer, has
 * no callers). Without a `resultMap` and a declared `items` array, the messages
 * arrive on a key no property declares and the form displays nothing — a previous
 * revision shipped exactly that. `items` is a declared array rendered through
 * `MaterialTableWidget`, whose column titles are i18n keys (the widget resolves a
 * dotted title via `reactory.i18n.t`).
 *
 * FILTERS COME FROM `AzureMailListOptions`, NOT FROM OData
 * -------------------------------------------------------
 * `allPages` maps to the service's own `all` flag. There is no `folderId` or
 * `isRead` property: the options input has neither, and expressing them would
 * mean synthesising a `$filter` string inside a form definition — Graph semantics
 * that cannot be verified without a tenant and would return the wrong mailbox
 * rather than an error.
 */
const AzureMailInboxForm: Reactory.Forms.IReactoryForm = {
  id: 'azure.AzureMailInboxForm@1.0.0',
  nameSpace: 'azure',
  name: 'AzureMailInboxForm',
  version: '1.0.0',
  title: formLabel('mailInbox', 'title'),
  description: formLabel('mailInbox', 'description'),
  schema: {
    type: 'object',
    title: formLabel('mailInbox', 'schemaTitle'),
    properties: {
      items: {
        type: 'array',
        title: fieldLabel('mailInbox', 'items'),
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            bodyPreview: { type: 'string' },
            importance: { type: 'string' },
            receivedDateTime: { type: 'string' },
          },
        },
      },
      nextLink: {
        type: 'string',
        title: fieldLabel('mailInbox', 'nextLink'),
      },
      count: {
        type: 'number',
        title: fieldLabel('mailInbox', 'count'),
      },
      search: {
        type: 'string',
        title: fieldLabel('mailInbox', 'search'),
      },
      orderBy: {
        type: 'string',
        title: fieldLabel('mailInbox', 'orderBy'),
        default: 'receivedDateTime desc',
      },
      top: {
        type: 'number',
        title: fieldLabel('mailInbox', 'top'),
        default: 25,
      },
      allPages: {
        type: 'boolean',
        title: fieldLabel('mailInbox', 'allPages'),
        default: false,
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
          { title: formLabel('mailInbox', 'columns', 'subject'), field: 'subject', width: 300 },
          { title: formLabel('mailInbox', 'columns', 'bodyPreview'), field: 'bodyPreview', width: 360 },
          { title: formLabel('mailInbox', 'columns', 'importance'), field: 'importance', width: 110 },
          {
            title: formLabel('mailInbox', 'columns', 'receivedDateTime'),
            field: 'receivedDateTime',
            width: 180,
          },
        ],
      },
    },
    nextLink: { 'ui:widget': 'text' },
    count: { 'ui:widget': 'updown' },
    search: {
      'ui:widget': 'text',
      'ui:placeholder': formLabel('mailInbox', 'placeholder', 'search'),
    },
    orderBy: { 'ui:widget': 'text' },
    top: { 'ui:widget': 'updown' },
    allPages: { 'ui:widget': 'checkbox' },
  },
  roles: ['USER'],
  registerAsComponent: true,
  uiSupport: ['material'],
  graphql: {
    query: {
      name: 'azureMailMessages',
      text: `query AzureMailMessages($options: AzureMailListOptions) {
        azureMailMessages(options: $options) {
          items {
            id
            conversationId
            subject
            bodyPreview
            from {
              name
              address
            }
            toRecipients {
              name
              address
            }
            receivedDateTime
            sentDateTime
            isRead
            isDraft
            hasAttachments
            importance
            categories
            parentFolderId
            webLink
          }
          nextLink
          count
        }
      }`,
      variables: {
        'formData.search': 'options.search',
        'formData.orderBy': 'options.orderBy',
        'formData.top': 'options.top',
        'formData.allPages': 'options.all',
      },
      resultMap: { items: 'items', nextLink: 'nextLink', count: 'count' },
    },
  },
};

export default AzureMailInboxForm;

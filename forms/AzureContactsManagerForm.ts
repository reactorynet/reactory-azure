import Reactory from '@reactorynet/reactory-core';
import { fieldLabel, formLabel } from './i18n';
import { toAddressList } from './transforms';

/**
 * Contacts — four bindings: the `azureContacts` read, and `azureCreateContact`,
 * `azureUpdateContact`, `azureDeleteContact`.
 *
 * THE EMAIL FIELD IS AN ARRAY BECAUSE THE INPUT TYPE IS
 * ----------------------------------------------------
 * `AzureContactInput.emailAddresses` is `[AzureContactEmailAddressInput!]`, and
 * the map reshapes a list of bare addresses into Graph's `[{ address }]` via
 * `toAddressList`. Declaring `email` as a *string* here — as an earlier revision
 * did — was a silent data-loss bug: `toAddressList` only accepts an array, so it
 * returned `undefined` for a typed address and the contact was saved without an
 * email (object-mapper 5.x omits the target, 6.x emits `null`, and
 * `AzureContactInput.emailAddresses` is nullable, so Graph accepted either).
 * A `tags` widget over an array of `format: 'email'` strings is the shape the
 * transform expects and mirrors `AzureMailComposeForm`.
 *
 * `__tests__/forms.test.ts` now asserts that every declared source -> target pair
 * produces a present, non-null value from populated form data, under both
 * object-mapper builds the platform has shipped — that is what keeps this class
 * of mismatch from returning.
 *
 * THE READ LANDS ON A DECLARED PROPERTY
 * -------------------------------------
 * `azureContacts` returns `AzureContactPage` (`{ items, nextLink, count }`). The
 * data manager spreads `data.data[query.name]` — it does not read `resultType` —
 * so without a `resultMap` and a declared `items` array the rows arrive on a key
 * no property declares and the grid shows nothing. Both are declared here, and
 * `items` renders through `MaterialTableWidget` (whose column titles are i18n
 * keys, resolved by the widget via `reactory.i18n.t`).
 *
 * NO people SEARCH: `azurePeople` is a different root field, and a form has one
 * fixed `graphql.query` document. People search belongs in its own form.
 */
const AzureContactsManagerForm: Reactory.Forms.IReactoryForm = {
  id: 'azure.AzureContactsManagerForm@1.0.0',
  nameSpace: 'azure',
  name: 'AzureContactsManagerForm',
  version: '1.0.0',
  title: formLabel('contactsManager', 'title'),
  description: formLabel('contactsManager', 'description'),
  schema: {
    type: 'object',
    title: formLabel('contactsManager', 'schemaTitle'),
    required: ['displayName'],
    properties: {
      items: {
        type: 'array',
        title: fieldLabel('contactsManager', 'items'),
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            companyName: { type: 'string' },
            jobTitle: { type: 'string' },
            department: { type: 'string' },
          },
        },
      },
      nextLink: {
        type: 'string',
        title: fieldLabel('contactsManager', 'nextLink'),
      },
      count: {
        type: 'number',
        title: fieldLabel('contactsManager', 'count'),
      },
      contactId: {
        type: 'string',
        title: fieldLabel('contactsManager', 'contactId'),
      },
      top: {
        type: 'number',
        title: fieldLabel('contactsManager', 'top'),
        default: 50,
      },
      displayName: {
        type: 'string',
        title: fieldLabel('contactsManager', 'displayName'),
      },
      givenName: {
        type: 'string',
        title: fieldLabel('contactsManager', 'givenName'),
      },
      surname: {
        type: 'string',
        title: fieldLabel('contactsManager', 'surname'),
      },
      email: {
        type: 'array',
        title: fieldLabel('contactsManager', 'email'),
        items: { type: 'string', format: 'email' },
      },
      mobilePhone: {
        type: 'string',
        title: fieldLabel('contactsManager', 'mobilePhone'),
      },
      companyName: {
        type: 'string',
        title: fieldLabel('contactsManager', 'companyName'),
      },
      jobTitle: {
        type: 'string',
        title: fieldLabel('contactsManager', 'jobTitle'),
      },
      department: {
        type: 'string',
        title: fieldLabel('contactsManager', 'department'),
      },
      officeLocation: {
        type: 'string',
        title: fieldLabel('contactsManager', 'officeLocation'),
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
          { title: formLabel('contactsManager', 'columns', 'displayName'), field: 'displayName', width: 220 },
          { title: formLabel('contactsManager', 'columns', 'companyName'), field: 'companyName', width: 180 },
          { title: formLabel('contactsManager', 'columns', 'jobTitle'), field: 'jobTitle', width: 180 },
          { title: formLabel('contactsManager', 'columns', 'department'), field: 'department', width: 160 },
        ],
      },
    },
    nextLink: { 'ui:widget': 'text' },
    count: { 'ui:widget': 'updown' },
    contactId: { 'ui:widget': 'text' },
    top: { 'ui:widget': 'updown' },
    displayName: { 'ui:widget': 'text' },
    givenName: { 'ui:widget': 'text' },
    surname: { 'ui:widget': 'text' },
    email: { 'ui:widget': 'tags' },
    mobilePhone: { 'ui:widget': 'text' },
    companyName: { 'ui:widget': 'text' },
    jobTitle: { 'ui:widget': 'text' },
    department: { 'ui:widget': 'text' },
    officeLocation: { 'ui:widget': 'text' },
  },
  roles: ['USER'],
  registerAsComponent: true,
  uiSupport: ['material'],
  graphql: {
    query: {
      name: 'azureContacts',
      text: `query AzureContacts($options: AzureContactListOptions) {
        azureContacts(options: $options) {
          items {
            id
            displayName
            givenName
            surname
            emailAddresses {
              name
              address
            }
            businessPhones
            mobilePhone
            companyName
            jobTitle
            department
            officeLocation
            parentFolderId
          }
          nextLink
          count
        }
      }`,
      variables: { 'formData.top': 'options.top' },
      resultMap: { items: 'items', nextLink: 'nextLink', count: 'count' },
    },
    mutation: {
      new: {
        name: 'azureCreateContact',
        text: `mutation AzureCreateContact($input: AzureContactInput!) {
          azureCreateContact(input: $input) {
            id
            displayName
            emailAddresses {
              name
              address
            }
          }
        }`,
        variables: {
          'formData.displayName': 'input.displayName',
          'formData.givenName': 'input.givenName',
          'formData.surname': 'input.surname',
          'formData.email': [{ key: 'input.emailAddresses', transform: toAddressList, default: undefined }],
          'formData.mobilePhone': 'input.mobilePhone',
          'formData.companyName': 'input.companyName',
          'formData.jobTitle': 'input.jobTitle',
          'formData.department': 'input.department',
          'formData.officeLocation': 'input.officeLocation',
        },
      },
      edit: {
        name: 'azureUpdateContact',
        text: `mutation AzureUpdateContact($contactId: String!, $input: AzureContactInput!) {
          azureUpdateContact(contactId: $contactId, input: $input) {
            id
            displayName
          }
        }`,
        variables: {
          'formData.contactId': 'contactId',
          'formData.displayName': 'input.displayName',
          'formData.givenName': 'input.givenName',
          'formData.surname': 'input.surname',
          'formData.email': [{ key: 'input.emailAddresses', transform: toAddressList, default: undefined }],
          'formData.mobilePhone': 'input.mobilePhone',
          'formData.companyName': 'input.companyName',
          'formData.jobTitle': 'input.jobTitle',
          'formData.department': 'input.department',
          'formData.officeLocation': 'input.officeLocation',
        },
      },
      delete: {
        name: 'azureDeleteContact',
        text: `mutation AzureDeleteContact($contactId: String!) {
          azureDeleteContact(contactId: $contactId)
        }`,
        variables: { 'formData.contactId': 'contactId' },
      },
    },
  },
};

export default AzureContactsManagerForm;

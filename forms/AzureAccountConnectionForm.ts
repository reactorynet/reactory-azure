import Reactory from '@reactorynet/reactory-core';
import { enumLabel, fieldLabel, formLabel } from './i18n';

/**
 * Connect / disconnect / status for the Microsoft Graph account.
 *
 * Mirrors `reactory-google`'s `GoogleAccountConnectionForm` in shape and
 * behaviour, with Microsoft's wire shape: `azureConnectionStatus` answers an
 * `AzureConnection`, which carries `userId`, `upn`, `tenantId` and the token
 * `source` as well, and whose status enum names the LEGACY case explicitly (a
 * User-document token that was never vaulted).
 *
 * MAPS — this is the part that has to be right
 * --------------------------------------------
 * * `resultMap` is keyed by the **properties of `AzureConnection`**, because the
 *   data manager applies it to `data.data['azureConnectionStatus']` — the object
 *   under the root field — not to the whole response. Prefixing a key with the
 *   root field name resolves nothing and the form's data becomes `undefined`.
 * * `variables` is **source -> variable**:
 *   `{ 'formData.servicesToConnect': 'services' }`. The inverse spelling resolves
 *   no source and `objectMapper` returns `undefined`, which becomes
 *   `variables = {}` — the authorisation URL request would go out with no
 *   services at all.
 *
 * `azureDisconnect` takes no arguments, so its map is empty and the document
 * declares no variables.
 *
 * CONNECT MINTS THE CONSENT URL; OPENING IT IS THE HOST SURFACE'S JOB
 * ------------------------------------------------------------------
 * `azureAuthUrl` returns `AzureAuthUrl { url }`. The mutation now declares a
 * `resultMap`, so the URL lands on the `authorizationUrl` property instead of
 * being discarded, and a notification tells the user it was minted. It is not
 * auto-opened here because nothing on this side can do that safely:
 * `onSuccessMethod: 'redirect'` navigates to `onSuccessUrl` **literally** (the
 * client does not template it from the result), and this module registers no
 * client component or event listener that could read the property. A host
 * surface (or a client plugin) that wants to launch the consent flow reads
 * `authorizationUrl` from the form data. Stated here rather than implied.
 */
const AzureAccountConnectionForm: Reactory.Forms.IReactoryForm = {
  id: 'azure.AzureAccountConnectionForm@1.0.0',
  nameSpace: 'azure',
  name: 'AzureAccountConnectionForm',
  version: '1.0.0',
  title: formLabel('accountConnection', 'title'),
  description: formLabel('accountConnection', 'description'),
  schema: {
    type: 'object',
    title: formLabel('accountConnection', 'schemaTitle'),
    properties: {
      connectionStatus: {
        type: 'string',
        title: fieldLabel('accountConnection', 'connectionStatus'),
      },
      email: {
        type: 'string',
        format: 'email',
        title: fieldLabel('accountConnection', 'email'),
      },
      upn: {
        type: 'string',
        title: fieldLabel('accountConnection', 'upn'),
      },
      tenantId: {
        type: 'string',
        title: fieldLabel('accountConnection', 'tenantId'),
      },
      tokenSource: {
        type: 'string',
        title: fieldLabel('accountConnection', 'tokenSource'),
      },
      grantedScopes: {
        type: 'array',
        title: fieldLabel('accountConnection', 'grantedScopes'),
        items: { type: 'string' },
      },
      authorizationUrl: {
        type: 'string',
        title: fieldLabel('accountConnection', 'authorizationUrl'),
      },
      connectedAt: {
        type: 'string',
        format: 'date-time',
        title: fieldLabel('accountConnection', 'connectedAt'),
      },
      lastRefreshedAt: {
        type: 'string',
        format: 'date-time',
        title: fieldLabel('accountConnection', 'lastRefreshedAt'),
      },
      expiresAt: {
        type: 'string',
        format: 'date-time',
        title: fieldLabel('accountConnection', 'expiresAt'),
      },
      servicesToConnect: {
        type: 'array',
        title: fieldLabel('accountConnection', 'servicesToConnect'),
        items: {
          type: 'string',
          enum: ['mail', 'calendar', 'drive', 'workbook', 'contacts', 'tasks'],
          enumNames: [
            enumLabel('accountConnection', 'servicesToConnect', 'mail'),
            enumLabel('accountConnection', 'servicesToConnect', 'calendar'),
            enumLabel('accountConnection', 'servicesToConnect', 'drive'),
            enumLabel('accountConnection', 'servicesToConnect', 'workbook'),
            enumLabel('accountConnection', 'servicesToConnect', 'contacts'),
            enumLabel('accountConnection', 'servicesToConnect', 'tasks'),
          ],
        },
      },
    },
  },
  uiSchema: {
    connectionStatus: { 'ui:widget': 'label' },
    email: { 'ui:widget': 'label' },
    upn: { 'ui:widget': 'label' },
    tenantId: { 'ui:widget': 'label' },
    tokenSource: { 'ui:widget': 'label' },
    grantedScopes: { 'ui:widget': 'tags' },
    authorizationUrl: {
      'ui:widget': 'label',
      'ui:help': formLabel('accountConnection', 'help', 'authorizationUrl'),
    },
    connectedAt: { 'ui:widget': 'label' },
    lastRefreshedAt: { 'ui:widget': 'label' },
    expiresAt: { 'ui:widget': 'label' },
    servicesToConnect: {
      'ui:widget': 'checkboxes',
      'ui:options': { inline: true },
      'ui:help': formLabel('accountConnection', 'help', 'servicesToConnect'),
    },
  },
  roles: ['USER'],
  registerAsComponent: true,
  uiSupport: ['material'],
  graphql: {
    query: {
      name: 'azureConnectionStatus',
      text: `query AzureConnectionStatus {
        azureConnectionStatus {
          userId
          status
          email
          upn
          tenantId
          grantedScopes
          tokenSource
          connectedAt
          lastRefreshedAt
          expiresAt
        }
      }`,
      variables: {},
      // Keys are AzureConnection's own properties: the map runs against the
      // object under `azureConnectionStatus`. `status` is the Graph name; the
      // form's read-only field is `connectionStatus`.
      resultMap: {
        status: 'connectionStatus',
        email: 'email',
        upn: 'upn',
        tenantId: 'tenantId',
        tokenSource: 'tokenSource',
        grantedScopes: 'grantedScopes',
        connectedAt: 'connectedAt',
        lastRefreshedAt: 'lastRefreshedAt',
        expiresAt: 'expiresAt',
      },
    },
    mutation: {
      new: {
        name: 'azureAuthUrl',
        text: `mutation AzureAuthUrl($services: [String!]) {
          azureAuthUrl(services: $services) {
            url
          }
        }`,
        variables: { 'formData.servicesToConnect': 'services' },
        // `azureAuthUrl` returns `AzureAuthUrl { url: String! }`. Without this map
        // the result is discarded: the data manager computes `transformed` from it
        // but only acts on that under an `onSuccessMethod`, so the minted consent
        // URL was previously dropped on the floor and submitting did nothing.
        resultMap: { url: 'authorizationUrl' },
        // Feedback the platform can actually deliver. Opening the URL is a client
        // action: `redirect` navigates to `onSuccessUrl` literally (it is not
        // templated from the result), and this module registers no client
        // component or event listener that could read `authorizationUrl`. A
        // notification at least tells the user the URL was minted; the field
        // above carries it into the form data for a host surface to use.
        onSuccessMethod: 'notification',
        notification: {
          title: formLabel('accountConnection', 'notification', 'authorizationUrlReady'),
        },
      },
      delete: {
        name: 'azureDisconnect',
        text: `mutation AzureDisconnect {
          azureDisconnect
        }`,
        variables: {},
      },
    },
  },
};

export default AzureAccountConnectionForm;

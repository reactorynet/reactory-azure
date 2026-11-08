import Reactory from '@reactorynet/reactory-core';
import { enumLabel, fieldLabel, formLabel } from './i18n';
import { toAddressList } from './transforms';

/**
 * Compose and send a message —
 * `azureSendMail(message: AzureMailMessageInput!, saveToSentItems: Boolean)`.
 *
 * THE INPUT SHAPE DRIVES THE MAP
 * ------------------------------
 * `AzureMailMessageInput` is not the form:
 *
 *   body:          { contentType, content }   (contentType is non-null)
 *   toRecipients:  [{ address }]              (not `['a@b.c']`)
 *   importance:    String
 *
 * and `saveToSentItems` is a **sibling argument**, not part of `message`.
 * Sending the whole `formData` as `$message` would submit unknown fields
 * (`to`, `cc`, `body` as a string, `saveToSentItems`) and Graph rejects unknown
 * input-object fields, so every send would fail. Hence one mapping per field,
 * with nested targets for the body pair and `toAddressList` for the recipients.
 *
 * `saveToSentItems` maps to the sibling variable, so the caller can opt out of
 * saving a copy; its absence is not "do not save".
 */
const AzureMailComposeForm: Reactory.Forms.IReactoryForm = {
  id: 'azure.AzureMailComposeForm@1.0.0',
  nameSpace: 'azure',
  name: 'AzureMailComposeForm',
  version: '1.0.0',
  title: formLabel('mailCompose', 'title'),
  description: formLabel('mailCompose', 'description'),
  schema: {
    type: 'object',
    title: formLabel('mailCompose', 'schemaTitle'),
    required: ['to', 'subject', 'body'],
    properties: {
      to: {
        type: 'array',
        title: fieldLabel('mailCompose', 'to'),
        items: { type: 'string', format: 'email' },
      },
      cc: {
        type: 'array',
        title: fieldLabel('mailCompose', 'cc'),
        items: { type: 'string', format: 'email' },
      },
      bcc: {
        type: 'array',
        title: fieldLabel('mailCompose', 'bcc'),
        items: { type: 'string', format: 'email' },
      },
      replyTo: {
        type: 'array',
        title: fieldLabel('mailCompose', 'replyTo'),
        items: { type: 'string', format: 'email' },
      },
      subject: {
        type: 'string',
        title: fieldLabel('mailCompose', 'subject'),
      },
      body: {
        type: 'string',
        title: fieldLabel('mailCompose', 'body'),
      },
      contentType: {
        type: 'string',
        title: fieldLabel('mailCompose', 'contentType'),
        enum: ['Text', 'HTML'],
        enumNames: [
          enumLabel('mailCompose', 'contentType', 'text'),
          enumLabel('mailCompose', 'contentType', 'html'),
        ],
        default: 'Text',
      },
      importance: {
        type: 'string',
        title: fieldLabel('mailCompose', 'importance'),
        enum: ['low', 'normal', 'high'],
        enumNames: [
          enumLabel('mailCompose', 'importance', 'low'),
          enumLabel('mailCompose', 'importance', 'normal'),
          enumLabel('mailCompose', 'importance', 'high'),
        ],
        default: 'normal',
      },
      saveToSentItems: {
        type: 'boolean',
        title: fieldLabel('mailCompose', 'saveToSentItems'),
        default: true,
      },
    },
  },
  uiSchema: {
    to: { 'ui:widget': 'tags' },
    cc: { 'ui:widget': 'tags' },
    bcc: { 'ui:widget': 'tags' },
    replyTo: { 'ui:widget': 'tags' },
    subject: {
      'ui:widget': 'text',
      'ui:placeholder': formLabel('mailCompose', 'placeholder', 'subject'),
    },
    body: { 'ui:widget': 'textarea', 'ui:options': { rows: 14 } },
    contentType: { 'ui:widget': 'select' },
    importance: { 'ui:widget': 'select' },
    saveToSentItems: { 'ui:widget': 'checkbox' },
  },
  roles: ['USER'],
  registerAsComponent: true,
  uiSupport: ['material'],
  graphql: {
    mutation: {
      new: {
        name: 'azureSendMail',
        text: `mutation AzureSendMail($message: AzureMailMessageInput!, $saveToSentItems: Boolean) {
          azureSendMail(message: $message, saveToSentItems: $saveToSentItems)
        }`,
        variables: {
          'formData.to': [{ key: 'message.toRecipients', transform: toAddressList, default: undefined }],
          'formData.cc': [{ key: 'message.ccRecipients', transform: toAddressList, default: undefined }],
          'formData.bcc': [{ key: 'message.bccRecipients', transform: toAddressList, default: undefined }],
          'formData.replyTo': [{ key: 'message.replyTo', transform: toAddressList, default: undefined }],
          'formData.subject': 'message.subject',
          'formData.contentType': 'message.body.contentType',
          'formData.body': 'message.body.content',
          'formData.importance': 'message.importance',
          'formData.saveToSentItems': 'saveToSentItems',
        },
      },
    },
  },
};

export default AzureMailComposeForm;

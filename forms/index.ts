import Reactory from '@reactorynet/reactory-core';
import AzureAccountConnectionForm from './AzureAccountConnectionForm';
import AzureMailInboxForm from './AzureMailInboxForm';
import AzureMailComposeForm from './AzureMailComposeForm';
import AzureCalendarViewForm from './AzureCalendarViewForm';
import AzureCalendarEventForm from './AzureCalendarEventForm';
import AzureDriveExplorerForm from './AzureDriveExplorerForm';
import AzureWorkbookViewForm from './AzureWorkbookViewForm';
import AzureContactsManagerForm from './AzureContactsManagerForm';
import AzureTodoManagerForm from './AzureTodoManagerForm';

/**
 * The forms this module contributes.
 *
 * This barrel was created empty by AZ-01 so that `index.ts` (which AZ-01 owns and
 * freezes) never has to change when the forms arrive; AZ-17 fills it. The root
 * module definition wires it as `forms: Forms`, and nothing else needs editing.
 *
 * NINE forms, and that count is deliberate. `reactory-google` ships eight; the
 * extra one here is `AzureWorkbookViewForm`, because `azureWorkbook*` is a
 * first-class Graph surface in this module (worksheets, ranges, tables,
 * append/update with session control) and folding it into the Drive explorer
 * would hide it. It adds a form, it does not mirror one.
 *
 * Every form is a `Reactory.Forms.IReactoryForm` in the `azure` namespace, with
 * `schema.type === 'object'`, a `uiSchema` whose keys are all declared
 * properties, and GraphQL documents that are validated against
 * `graphql/types/*.graphql` by `__tests__/forms.test.ts`.
 *
 * Two conventions every definition here follows, because getting either wrong
 * silently disables the form rather than failing:
 *
 *   * `variables` is **source -> variable** — `{ 'formData.itemId': 'itemId' }`.
 *     That is how `useGraphQLDataManager` calls `objectMapper(kwargs, map)` with
 *     `kwargs = { form, formData, formContext, reactory, api, props }`, and how
 *     `reactory-product` and `reactory-classroom` spell it. The inverse resolves
 *     no source and `variables` collapses to `{}`.
 *   * `resultMap` is keyed by the properties of the object **under** the root
 *     field (the data manager maps `data.data[query.name]`), never by a path
 *     prefixed with the root field's name.
 *
 * `__tests__/forms.test.ts` executes every map with the real `object-mapper`
 * against schema-derived form data and validates the result against the GraphQL
 * variable types, so neither mistake can return.
 */
const forms: Reactory.Forms.IReactoryForm[] = [
  AzureAccountConnectionForm,
  AzureMailInboxForm,
  AzureMailComposeForm,
  AzureCalendarViewForm,
  AzureCalendarEventForm,
  AzureDriveExplorerForm,
  AzureWorkbookViewForm,
  AzureContactsManagerForm,
  AzureTodoManagerForm,
];

export {
  AzureAccountConnectionForm,
  AzureMailInboxForm,
  AzureMailComposeForm,
  AzureCalendarViewForm,
  AzureCalendarEventForm,
  AzureDriveExplorerForm,
  AzureWorkbookViewForm,
  AzureContactsManagerForm,
  AzureTodoManagerForm,
};

export default forms;

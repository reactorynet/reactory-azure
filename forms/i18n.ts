/**
 * Translation-key vocabulary shared by every form in this directory.
 *
 * Nothing under `forms/` may carry a literal English label. Each form `title`,
 * `description`, schema `title`, property `title`, enum label, `ui:placeholder`
 * and `ui:help` is stored as a dotted key built by `formLabel(...)` and resolved
 * from `i18n/en.json` (mirroring `reactory-google/forms`, which externalises its
 * strings the same way).
 *
 * A key that does not resolve renders as its raw key in the client, so
 * `__tests__/forms.test.ts` walks every label-bearing string in every form and
 * fails unless `i18n/en.json` carries it. That is what keeps the two files from
 * drifting apart.
 */
export const FORMS_I18N_PREFIX = 'azure.forms';

/**
 * Build a dotted translation key rooted at `azure.forms`.
 *
 * @example formLabel('mailInbox', 'fields', 'search') // 'azure.forms.mailInbox.fields.search'
 */
export function formLabel(...segments: string[]): string {
  return [FORMS_I18N_PREFIX, ...segments].join('.');
}

/**
 * The label of a schema property: `azure.forms.<form>.fields.<property>`.
 */
export function fieldLabel(form: string, property: string): string {
  return formLabel(form, 'fields', property);
}

/**
 * The label of one `enum` member: `azure.forms.<form>.enum.<property>.<value>`.
 */
export function enumLabel(form: string, property: string, value: string): string {
  return formLabel(form, 'enum', property, value);
}

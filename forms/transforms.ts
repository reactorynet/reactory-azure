/**
 * Value-shape transforms for the form variable maps.
 *
 * HOW A MAP IS EXECUTED
 * ---------------------
 * Reactory runs a form's variable map with `object-mapper`:
 * `useGraphQLDataManager` builds `kwargs = { form, formData, formContext,
 * reactory, api, props }` and calls `objectMapper(kwargs, parseObjectMap(map))`.
 * The map is therefore **source path -> GraphQL variable name**
 * (`{ 'formData.courseId': 'input.courseId' }`), and the inverse spelling
 * resolves no source at all.
 *
 * `parseObjectMapper` passes a function-valued `transform` through untouched, so
 * a transform can live in this module next to the maps that use it — no
 * component registration is required.
 *
 * SCOPE OF WHAT BELONGS HERE
 * --------------------------
 * These adapt **value shapes only**: an array of bare addresses into Graph's
 * `[{ address }]`, a bare address into `{ emailAddress: { address } }`, a body
 * into the `contentType` its input object expects. They never invent Graph
 * semantics — never synthesise an OData filter, never rename a field the input
 * type does not have. Every field they populate is declared by the input type
 * in `graphql/types/*.graphql`.
 */

/**
 * `['a@b.c', 'd@e.f']` -> `[{ address: 'a@b.c' }, { address: 'd@e.f' }]`
 *
 * Fits `AzureMailRecipientInput` (`{ name, address }`) and
 * `AzureContactEmailAddressInput` (`{ name, address }`), both of which require
 * `address` and accept `name` as optional.
 *
 * Returns `undefined` for an absent/empty list so object-mapper omits the target
 * entirely rather than sending `[]`, which Graph would read as "no recipients"
 * instead of "not specified".
 */
export function toAddressList(source: unknown): { address: string }[] | undefined {
  if (!Array.isArray(source)) return undefined;

  const addresses = source
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (addresses.length === 0) return undefined;

  return addresses.map((address) => ({ address }));
}

/**
 * `['a@b.c']` -> `[{ emailAddress: { address: 'a@b.c' }, type: 'required' }]`
 *
 * Fits `AzureCalendarAttendeeInput`, whose `emailAddress` is a **non-null**
 * `AzureCalendarEmailAddressInput` — an attendee without an address is rejected
 * by Graph, so each entry nests the address rather than flattening it.
 */
export function toAttendees(
  source: unknown,
): { emailAddress: { address: string }; type: string }[] | undefined {
  const addresses = toAddressList(source);
  if (!addresses) return undefined;

  return addresses.map(({ address }) => ({ emailAddress: { address }, type: 'required' }));
}

/**
 * `'some notes'` -> `'text'`, or `undefined` when there is no body.
 *
 * `AzureCalendarEventBodyInput.contentType` and `AzureTodoItemBodyInput.contentType`
 * are nullable, so an empty body must send **neither** `content` nor
 * `contentType`; sending a content type with no content would be a body Graph
 * stores as empty rather than one the caller never set.
 *
 * THE `default` ON A TRANSFORM ENTRY MUST BE `undefined`, NOT `null`
 * ----------------------------------------------------------------
 * The map entries that call this transform declare `default: undefined`
 * deliberately. With `default: null`, an empty body is written as
 * `body: { content: '', contentType: null }` under object-mapper 6.x — a
 * present-but-null content type, the opposite of omitting the field. Measured:
 *
 *   default: null      5.x -> { content: '' }                 6.x -> { content: '', contentType: null }
 *   default: undefined 5.x -> { content: '' }                 6.x -> { content: '' }
 *
 * `undefined` is also what the published `ObjectTransform` type requires the key to
 * hold when there is no default, so it keeps the entry type-correct.
 */
export function toTextBodyContentType(source: unknown): string | undefined {
  if (typeof source !== 'string' || source.trim().length === 0) return undefined;
  return 'text';
}

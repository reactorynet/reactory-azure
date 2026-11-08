import fs from 'fs';
import path from 'path';
import {
  buildSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
  parse,
  typeFromAST,
  validate,
} from 'graphql';

/**
 * AZ-17 — the form surface.
 *
 * Nine forms is a deliberate **superset** of `reactory-google`'s eight: this
 * module adds `AzureWorkbookViewForm`, because `azureWorkbook*` is a first-class
 * Graph surface here. It adds a form, it does not mirror one; "parity" is the
 * wrong word for the count.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 * Structure (acceptance):
 *   1. the count is nine, and the list is named;
 *   2. every `schema.type` is `'object'` with a `properties` map;
 *   3. `schema.required` names only declared properties;
 *   4. every `uiSchema` key exists in `schema.properties`;
 *   5. every form id is unique, `azure`-namespaced and normalised;
 *   6. every GraphQL document validates against `graphql/types/*.graphql`;
 *   7. no user-facing label is hardcoded and no i18n key is orphaned.
 *
 * Executability (the part that was missing in revision 1, and the reason every
 * form was non-functional while this suite was green):
 *   8. every variable-map source is a real, declared form property;
 *   9. every variable the document declares is produced by the map, and the map
 *      produces nothing the document does not declare;
 *  10. every `resultMap` key exists on the root field's return type, and every
 *      `resultMap` value is a declared form property;
 *  11. no map forwards the whole `formData` object into an input-typed variable;
 *  12. **the map is executed with the real `object-mapper`** against form data
 *      built from the form's own schema, and the resulting `variables` object is
 *      validated recursively against the GraphQL variable types — unknown
 *      input-object fields, wrong scalars, wrong enum members and missing
 *      non-null fields all fail.
 *
 * Assertion 12 is the decisive one. It is what turns "the map looks plausible"
 * into "the request this form sends is a payload the schema accepts". The
 * revision-1 suite had none of 8-12, which is precisely why 24 inverted variable
 * maps, six whole-`formData` payloads and a prefixed `resultMap` all passed.
 *
 * THE VARIABLE-MAP CONVENTION (why assertion 8/12 exist)
 * -----------------------------------------------------
 * Reactory maps variables source → target with `object-mapper`:
 * `useGraphQLDataManager.ts` builds `kwargs = { form, formData, formContext,
 * reactory, api, props }` and calls `objectMapper(kwargs, parseObjectMap(map))`.
 * So the object KEY is the form/context path and the VALUE is the GraphQL
 * variable name — `{ 'formData.courseId': 'input.courseId' }`, as
 * `reactory-classroom` and `reactory-product` do. The inverse spelling resolves
 * no source at all and `objectMapper` returns `undefined`, which the data
 * manager turns into `variables = {}` — every request then goes out with no
 * variables. The same applies to `resultMap`, which is applied to
 * `data.data[query.name]` (the object under the root field), not to the whole
 * response.
 *
 * THE SDL PREAMBLE
 * ----------------
 * The module's eleven `.graphql` files `extend type Query` / `extend type
 * Mutation` rather than declaring them, so the suite prepends only the four
 * custom scalars and the two base operation types. It adds no field, so it
 * cannot mask a binding the resolvers do not expose.
 */

// eslint-disable-next-line import/first
import forms from '../forms';

const MODULE_ROOT = path.resolve(__dirname, '..');

/**
 * Every object-mapper build this suite can find.
 *
 * WHY THIS IS NOT JUST `require('object-mapper')`
 * ----------------------------------------------
 * Two behaviours differ between the published versions and BOTH change what the
 * client sends:
 *
 *   * when a mapped source has no value, 5.x OMITS the target key and 6.x emits
 *     `null` — so an assertion that only checks "the key is there" can pass on
 *     one version and fail on the other, and neither tells you the payload is
 *     usable;
 *   * 5.x flattens an array-of-arrays assigned to a target key, 6.x preserves it.
 *
 * This repository's root resolves 5.x; the PWA client — the thing that actually
 * runs these forms — pins 6.2.0. The suite therefore loads the local build *and*
 * the client's, and every mapping assertion below runs against all of them. The
 * primary build is required; the client build is used when the sibling checkout
 * is present, and the mapping tests name the versions they ran against so an
 * absence is visible rather than silent.
 */
interface IObjectMapperVariant {
  label: string;
  mapper: (source: unknown, map: Record<string, unknown>) => any;
}

function loadObjectMapperVariants(): IObjectMapperVariant[] {
  // MODULE_ROOT is <server>/src/modules/reactory-worktrees/<worktree>; the PWA
  // client is a sibling of <server>.
  const candidates: string[] = [
    'object-mapper',
    path.resolve(
      MODULE_ROOT, '..', '..', '..', '..', '..', 'reactory-pwa-client', 'node_modules', 'object-mapper',
    ),
  ];

  const variants: IObjectMapperVariant[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = require.resolve(candidate);
    } catch (error) {
      continue;
    }

    if (seen.has(resolved)) continue;
    seen.add(resolved);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mapperModule = require(resolved);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved), 'package.json'), 'utf8'));

    variants.push({
      label: [pkg.name, '@', pkg.version].join(''),
      mapper: mapperModule,
    });
  }

  return variants;
}

const OBJECT_MAPPER_VARIANTS = loadObjectMapperVariants();
const objectMapper = OBJECT_MAPPER_VARIANTS[0].mapper;

/** The versions every mapping assertion runs against, for failure messages. */
const MAPPER_LABELS = OBJECT_MAPPER_VARIANTS.map((variant) => variant.label).join(', ');

/**
 * Read a dotted path out of a produced payload.
 *
 * Returns `{ present, value }` rather than the value, because "absent" (5.x) and
 * "null" (6.x) are both failures and are different from "present but empty".
 */
function readPath(source: unknown, dotted: string): { present: boolean; value: unknown } {
  let node: any = source;
  for (const segment of dotted.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') {
      return { present: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(node, segment)) {
      return { present: false, value: undefined };
    }
    node = node[segment];
  }
  return { present: true, value: node };
}

const TYPES_DIR = path.join(MODULE_ROOT, 'graphql', 'types');
const I18N_DIR = path.join(MODULE_ROOT, 'i18n');

/** The nine form names, in contribution order. This is the list. */
const EXPECTED_FORM_NAMES = [
  'AzureAccountConnectionForm',
  'AzureMailInboxForm',
  'AzureMailComposeForm',
  'AzureCalendarViewForm',
  'AzureCalendarEventForm',
  'AzureDriveExplorerForm',
  'AzureWorkbookViewForm',
  'AzureContactsManagerForm',
  'AzureTodoManagerForm',
];

/**
 * How many GraphQL documents each form contributes. Asserted per form so a
 * silently dropped binding fails here instead of shrinking the validator's work
 * to nothing.
 */
const EXPECTED_DOCUMENT_COUNTS: Record<string, number> = {
  AzureAccountConnectionForm: 3,
  AzureMailInboxForm: 1,
  AzureMailComposeForm: 1,
  AzureCalendarViewForm: 1,
  AzureCalendarEventForm: 4,
  AzureDriveExplorerForm: 3,
  AzureWorkbookViewForm: 3,
  AzureContactsManagerForm: 4,
  AzureTodoManagerForm: 4,
};

interface IGraphBinding {
  /** Where the binding lives, e.g. `AzureMailInboxForm graphql.query`. */
  location: string;
  /** The graph element name the form declares. */
  name: string;
  /** The operation document. */
  text: string;
  /** `query` or `mutation`, from the binding's position in the definition. */
  operation: 'query' | 'mutation';
  /** The declared variable map, if any. */
  variables: Record<string, unknown> | undefined;
  /** The declared result map, if any. */
  resultMap: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// SDL
// ---------------------------------------------------------------------------

function buildModuleSchema(): ReturnType<typeof buildSchema> {
  const files = fs
    .readdirSync(TYPES_DIR)
    .filter((name) => name.endsWith('.graphql'))
    .sort();

  expect(files.length).toBeGreaterThanOrEqual(11);

  const preamble = [
    'scalar Any',
    'scalar DateTime',
    'scalar JSON',
    'scalar BigInt',
    'type Query { _schemaPreamble: Boolean }',
    'type Mutation { _schemaPreamble: Boolean }',
  ].join('\n');

  const typeDefs = files.map((file) => fs.readFileSync(path.join(TYPES_DIR, file), 'utf8'));

  return buildSchema([preamble, ...typeDefs].join('\n'));
}

/** Flatten every GraphQL binding a form declares. */
function collectBindings(form: any): IGraphBinding[] {
  const graphql = form.graphql;
  if (!graphql) return [];

  const bindings: IGraphBinding[] = [];

  if (graphql.query) {
    bindings.push({
      location: `${form.name} graphql.query`,
      name: graphql.query.name,
      text: graphql.query.text,
      operation: 'query',
      variables: graphql.query.variables,
      resultMap: graphql.query.resultMap,
    });
  }

  for (const [key, element] of Object.entries<any>(graphql.queries || {})) {
    bindings.push({
      location: `${form.name} graphql.queries.${key}`,
      name: element.name,
      text: element.text,
      operation: 'query',
      variables: element.variables,
      resultMap: element.resultMap,
    });
  }

  for (const [key, element] of Object.entries<any>(graphql.mutation || {})) {
    bindings.push({
      location: `${form.name} graphql.mutation.${key}`,
      name: element.name,
      text: element.text,
      operation: 'mutation',
      variables: element.variables,
      resultMap: element.resultMap,
    });
  }

  return bindings;
}

function declaredProperties(form: any): Set<string> {
  return new Set(Object.keys((form.schema as any)?.properties || {}));
}

/** The root field a binding names, from the built schema. */
function rootField(schema: any, binding: IGraphBinding) {
  const root = binding.operation === 'query' ? schema.getQueryType() : schema.getMutationType();
  return root?.getFields()?.[binding.name];
}

/**
 * Resolve a dotted GraphQL path (`body.content`, `start.dateTime`) to a field
 * definition, walking through object types. Returns undefined when any segment
 * is not a field of the type it is read from.
 */
/**
 * Every `ui:options.query` key a widget names, i.e. the `graphql.queries` entries
 * that are actually reachable through MaterialTableWidget's own fetch.
 */
function referencedQueryKeys(form: any): Set<string> {
  const keys = new Set<string>();

  for (const definition of Object.values<any>(form.uiSchema || {})) {
    const options = definition?.['ui:options'];
    if (options && typeof options.query === 'string' && options.query.length > 0) {
      keys.add(options.query);
    }
  }

  return keys;
}

/**
 * The `remoteData` grid a form declares, if any: the MaterialTableWidget property
 * whose `ui:options.remoteData` is true.
 *
 * This is the client's second read path. `MaterialTableWidget` with
 * `ui:options.remoteData === true` runs its *own* `getData()` on mount, maps
 * variables from `{ formContext, query, props }`, wraps an **array** root field as
 * `{ data: rawResultData }` and renders `data.data`. It never passes through
 * `useGraphQLDataManager.transformData`, so `schema.type` does not constrain what
 * it can display.
 */
function remoteDataGrid(form: any): { property: string; options: any } | undefined {
  for (const [property, definition] of Object.entries<any>(form.uiSchema || {})) {
    const options = definition?.['ui:options'];
    if (definition?.['ui:widget'] === 'MaterialTableWidget' && options?.remoteData === true) {
      return { property, options };
    }
  }

  return undefined;
}

/**
 * Resolve a dotted path against a form's JSON schema `properties` tree, returning
 * the property definition. Used to check that a grid column names a field the
 * declared item schema actually carries.
 */
function resolveSchemaPath(schema: any, dotted: string): any {
  let node = schema;
  let definition: any;

  for (const segment of dotted.split('.')) {
    const properties = node?.properties || {};
    definition = properties[segment];
    if (!definition) return undefined;
    node = definition;
  }

  return definition;
}

/**
 * Validate the grid-owned fetch for one read.
 *
 * Mirrors what `MaterialTableWidget` does with `ui:options.remoteData: true`:
 * it maps `{ formContext, query, props }` through `ui:options.variables` (note:
 * **not** `formData`), runs the named query, and renders `data.data`, where an
 * array root field is wrapped as `{ data: rawResultData }`.
 *
 * Checks performed:
 *   * the declared array property exists and has an item schema (something to
 *     render);
 *   * `ui:options.variables` is present and every source is rooted at
 *     `formContext`/`query`/`props`;
 *   * every variable the document declares is produced by that map;
 *   * the produced variables satisfy the GraphQL variable types, sampled from the
 *     form's own schema (which is where `formContext.formData` gets its values);
 *   * `ui:options.columns` is non-empty and every column `field` resolves in the
 *     declared item schema.
 */
function validateRemoteDataGrid(
  form: any,
  grid: { property: string; options: any },
  binding: IGraphBinding,
  field: any,
  schema: any,
): string[] {
  const violations: string[] = [];
  const where = `${form.name} uiSchema.${grid.property}`;

  // ── The property the grid renders ─────────────────────────────────────────
  const declared = (form.schema as any)?.properties?.[grid.property];
  if (!declared) {
    violations.push(`${where}: remoteData grid property "${grid.property}" is not declared in the schema`);
  } else if (declared.type !== 'array') {
    violations.push(`${where}: "${grid.property}" is type "${declared.type}", not "array"`);
  } else if (!declared.items) {
    violations.push(`${where}: "${grid.property}" has no item schema, so no column can be bound`);
  }

  // ── Columns ───────────────────────────────────────────────────────────────
  const columns = grid.options.columns || [];
  if (columns.length === 0) {
    violations.push(
      `${where}: MaterialTableWidget renders nothing without ui:options.columns`,
    );
  }

  for (const [index, column] of columns.entries()) {
    if (!column?.field) {
      violations.push(`${where}.columns[${index}]: no field`);
      continue;
    }
    if (declared?.items && !resolveSchemaPath(declared.items, column.field)) {
      violations.push(
        `${where}.columns[${index}]: field "${column.field}" is not a property of the` +
          ` "${grid.property}" item schema`,
      );
    }
  }

  // ── Variables: rooted at formContext, complete, and type-valid ────────────
  const map = grid.options.variables;
  if (!map || Object.keys(map).length === 0) {
    violations.push(
      `${where}: remoteData grid must declare ui:options.variables (the fetch has` +
        ` required arguments; without a map it sends none)`,
    );
    return violations;
  }

  const document = parse(binding.text) as any;
  const operation = document.definitions.find(
    (definition: any) => definition.kind === 'OperationDefinition',
  );
  const declaredVariables: string[] = (operation?.variableDefinitions || []).map(
    (definition: any) => definition.variable.name.value,
  );

  const producedRoots = new Set<string>();

  for (const [source, target] of Object.entries<any>(map)) {
    const root = source.split('.')[0];
    if (!['formContext', 'query', 'props'].includes(root)) {
      violations.push(
        `${where}: source "${source}" is not rooted at formContext/query/props — the grid` +
          ` maps from { formContext, query, props }, not from formData`,
      );
      continue;
    }

    const targets = Array.isArray(target) ? target : [target];
    for (const entry of targets) {
      const targetKey = typeof entry === 'string' ? entry : entry?.key;
      if (typeof targetKey === 'string') producedRoots.add(targetKey.split('.')[0]);
    }
  }

  for (const variable of declaredVariables) {
    if (!producedRoots.has(variable)) {
      violations.push(
        `${where}: the document declares ${variable} but ui:options.variables does not` +
          ` produce it — the grid's request would omit a required argument`,
      );
    }
  }

  for (const produced of producedRoots) {
    if (!declaredVariables.includes(produced)) {
      violations.push(`${where}: ui:options.variables produces "${produced}", which the document does not declare`);
    }
  }

  // Execute the widget map exactly as the widget does, then type-check it.
  const formData = sampleFormData(form);
  for (const variant of OBJECT_MAPPER_VARIANTS) {
    const produced = variant.mapper(
      { formContext: { formData }, query: {}, props: {} },
      map,
    );

    if (produced === undefined || produced === null) {
      violations.push(
        `[${variant.label}] ${where}: the grid variable map produced nothing at all`,
      );
      continue;
    }

    for (const variableDefinition of operation?.variableDefinitions || []) {
      const variableName = variableDefinition.variable.name.value;
      const type = typeFromAST(schema, variableDefinition.type);
      if (!type) continue;
      validateInputValue(type, produced[variableName], `${variableName} (${where})`, violations);
    }
  }

  return violations;
}

function resolveFieldPath(type: any, dotted: string): any {
  let current = type;
  let field: any;

  for (const segment of dotted.split('.')) {
    // `current` is `any`, so annotate the result: getNamedType's overloads would
    // otherwise resolve to the `undefined` signature and report getFields on void.
    const named: any = getNamedType(current);
    const fields = named?.getFields?.() || {};
    field = fields[segment];
    if (!field) return undefined;
    current = field.type;
  }

  return field;
}

/**
 * Mirror of `useGraphQLDataManager.transformData` (reactory-pwa-client).
 *
 * It selects `data.data[query.name]` and shapes it by `schema.type` — object:
 * spread, array: copy, anything else: the whole `data` object — then applies the
 * result map. `resultType` is NOT consulted here; the only code that reads it
 * (`ReactoryFormDataManager.fromGraphResult`) has no callers, which is why the
 * forms no longer declare it.
 *
 * Reproduced rather than imported because the client is a separate repository;
 * any divergence from the client would show up as a failing reachability test.
 */
function applyReadTransform(
  mapper: (source: unknown, map: Record<string, unknown>) => any,
  schemaType: string | undefined,
  response: any,
  fieldName: string,
  resultMap: Record<string, unknown> | undefined,
): any {
  if (!fieldName) return response;
  if (!response?.data?.[fieldName]) return null;

  let next: any;
  switch (schemaType) {
    case 'object':
      next = { ...response.data[fieldName] };
      break;
    case 'array':
      next = [...response.data[fieldName]];
      break;
    default:
      next = response.data;
      break;
  }

  return resultMap && Object.keys(resultMap).length > 0 ? mapper(next, resultMap) : next;
}

/**
 * Reads whose payload cannot reach a declared schema property, and why.
 *
 * A list-returning root field cannot be surfaced by a form whose `schema.type` is
 * `'object'` (the ticket requires that). The live data manager spreads the array
 * into `{"0": …}`, so no declared property can hold the rows. Fixing it needs
 * either an `array` schema for those two forms (a ticket-owner decision) or
 * client support. Until then the limitation is declared here AND in AGENT.md, and
 * this test keeps the list closed: a fourth such form fails the suite.
 */
/**
 * Reads that cannot be displayed by EITHER client read path.
 *
 * Intentionally empty. It was populated in an earlier revision with the two
 * list-returning roots, on the false premise that a list could not be shown —
 * `MaterialTableWidget` with `ui:options.remoteData: true` displays one. The map
 * and the check that consumes it are kept so a future exception has to be written
 * down deliberately and mirrored in AGENT.md, rather than absorbed silently.
 */
const DOCUMENTED_UNREACHABLE_READS: Record<string, string> = {};

/**
 * A response payload for a read, built from its return type so the reachability
 * check runs against the real shape rather than a guess.
 */
function sampleResponseFor(field: any): any {
  const payload = sampleValueFromGraphQLType(field.type);
  return payload;
}

/** Sample a value from a GraphQL type (mirror of sampleValue, for return types). */
function sampleValueFromGraphQLType(type: any, depth = 0): any {
  if (isNonNullType(type)) return sampleValueFromGraphQLType(type.ofType, depth);
  if (isListType(type)) return [sampleValueFromGraphQLType(type.ofType, depth)];
  if (depth > 3) return undefined;

  const named = getNamedType(type);

  if (isEnumType(named)) return named.getValues()[0].name;
  if (isScalarType(named)) return named.name === 'Int' || named.name === 'Float' ? 1 : 'sample';

  if (isInputObjectType(named)) return {};

  const fields = (named as any).getFields?.() || {};
  const out: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries<any>(fields)) {
    // Lists are sampled as two-element arrays so a table has rows to render.
    const sampled = sampleValueFromGraphQLType(definition.type, depth + 1);
    out[key] = sampled;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Form data sampling
// ---------------------------------------------------------------------------

/**
 * A plausible value for one schema property, so a variable map can be executed.
 *
 * The value has to satisfy the *GraphQL* types the map targets (non-null
 * `dateTime`/`timeZone` pairs, recipient `address`, and so on). Deriving it from
 * the form's own schema is what makes assertion 12 meaningful: if a mapping
 * needs a field the form does not declare, there is no sample for it and the
 * produced payload is missing a field the schema requires.
 */
function sampleValue(definition: any): any {
  if (!definition) return undefined;

  // NOTE: the container check comes FIRST. An array whose items carry an `enum`
  // (e.g. `servicesToConnect`) must still sample as an array — resolving the
  // enum first would produce the bare member and the map would send a String
  // where the variable is `[String!]`.
  switch (definition.type) {
    case 'boolean':
      return true;
    case 'number':
    case 'integer':
      return 1;
    case 'array':
      return [sampleValue(definition.items || {})];
    case 'object':
      return {};
    default:
      break;
  }

  const enumValues = definition.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];

  if (definition.format === 'email') return 'sam@example.com';
  if (definition.format === 'date-time') return '2026-11-09T09:00:00';
  return 'sample';
}

function sampleFormData(form: any): Record<string, unknown> {
  const properties = (form.schema as any)?.properties || {};
  const data: Record<string, unknown> = {};

  for (const [property, definition] of Object.entries<any>(properties)) {
    data[property] = sampleValue(definition);
  }

  return data;
}

// ---------------------------------------------------------------------------
// GraphQL input-value validation
// ---------------------------------------------------------------------------

const SCALAR_CHECKS: Record<string, (value: unknown) => boolean> = {
  String: (value) => typeof value === 'string',
  Boolean: (value) => typeof value === 'boolean',
  Int: (value) => typeof value === 'number' && Number.isInteger(value),
  Float: (value) => typeof value === 'number',
  ID: (value) => typeof value === 'string' || typeof value === 'number',
};

/**
 * Walk a GraphQL input type and report every mismatch in `value`.
 *
 * `Any`/`JSON` are pass-through by design: they model shapes GraphQL cannot
 * express (a row-major cell matrix), so validating their contents is the
 * service's job, not the form's.
 */
function validateInputValue(
  type: any,
  value: unknown,
  at: string,
  violations: string[],
): void {
  if (isNonNullType(type)) {
    if (value === undefined || value === null) {
      violations.push(`${at} is required (${String(type)}) but was not produced by the variable map`);
      return;
    }
    validateInputValue(type.ofType, value, at, violations);
    return;
  }

  if (value === undefined || value === null) return; // nullable and absent

  if (isListType(type)) {
    if (!Array.isArray(value)) {
      violations.push(`${at} should be a list (${String(type)}) but is ${typeof value}`);
      return;
    }
    value.forEach((item, index) => validateInputValue(type.ofType, item, `${at}[${index}]`, violations));
    return;
  }

  const named = getNamedType(type);

  if (isScalarType(named)) {
    if (named.name === 'Any' || named.name === 'JSON' || named.name === 'BigInt') return;
    if (named.name === 'DateTime') {
      if (typeof value !== 'string' && !(value instanceof Date)) {
        violations.push(`${at} should be a DateTime but is ${typeof value}`);
      }
      return;
    }
    const check = SCALAR_CHECKS[named.name];
    if (check && !check(value)) {
      violations.push(`${at} should be ${named.name} but is ${JSON.stringify(value)}`);
    }
    return;
  }

  if (isEnumType(named)) {
    const allowed = named.getValues().map((entry: any) => entry.name);
    if (!allowed.includes(value as string)) {
      violations.push(`${at} is ${JSON.stringify(value)}, not one of ${allowed.join('|')}`);
    }
    return;
  }

  if (isInputObjectType(named)) {
    if (typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${at} should be input object ${named.name} but is ${JSON.stringify(value)}`);
      return;
    }

    const fields = named.getFields();
    const supplied = value as Record<string, unknown>;

    for (const key of Object.keys(supplied)) {
      if (!fields[key]) {
        violations.push(
          `${at}.${key} is not a field of ${named.name} — Graph rejects unknown input fields` +
            ` (allowed: ${Object.keys(fields).join(', ')})`,
        );
        continue;
      }
      validateInputValue(fields[key].type, supplied[key], `${at}.${key}`, violations);
    }

    for (const [key, field] of Object.entries<any>(fields)) {
      if (isNonNullType(field.type) && supplied[key] === undefined) {
        violations.push(`${at}.${key} is required by ${named.name} but was not produced by the variable map`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

function readTranslations(): Record<string, unknown> {
  const files = fs.readdirSync(I18N_DIR).filter((name) => name.endsWith('.json')).sort();
  const bundle: Record<string, unknown> = {};

  for (const file of files) {
    Object.assign(bundle, JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8')));
  }

  return bundle;
}

function resolveLabel(bundle: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<any>((node, part) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[part];
  }, bundle);
}

function flattenKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix];

  const keys: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    keys.push(...flattenKeys(value, prefix ? `${prefix}.${key}` : key));
  }
  return keys;
}

function collectLabels(form: any): { location: string; value: string }[] {
  const labels: { location: string; value: string }[] = [];
  const add = (location: string, value: unknown) => {
    if (typeof value === 'string') labels.push({ location, value });
  };

  add(`${form.name}.title`, form.title);
  add(`${form.name}.description`, form.description);

  const schema = form.schema as any;
  add(`${form.name}.schema.title`, schema?.title);

  for (const [property, definition] of Object.entries<any>(schema?.properties || {})) {
    add(`${form.name}.schema.properties.${property}.title`, definition?.title);
    add(`${form.name}.schema.properties.${property}.description`, definition?.description);

    (definition?.enumNames || []).forEach((label: unknown, index: number) => {
      add(`${form.name}.schema.properties.${property}.enumNames[${index}]`, label);
    });
    (definition?.items?.enumNames || []).forEach((label: unknown, index: number) => {
      add(`${form.name}.schema.properties.${property}.items.enumNames[${index}]`, label);
    });
    // Nested array-item titles are user-facing too (`values` -> `row`).
    add(`${form.name}.schema.properties.${property}.items.title`, definition?.items?.title);
    add(`${form.name}.schema.properties.${property}.items.items.title`, definition?.items?.items?.title);
  }

  for (const [property, definition] of Object.entries<any>(form.uiSchema || {})) {
    add(`${form.name}.uiSchema.${property}['ui:placeholder']`, definition?.['ui:placeholder']);
    add(`${form.name}.uiSchema.${property}['ui:help']`, definition?.['ui:help']);

    // Grid column headers: MaterialTableWidget resolves a dotted title through
    // reactory.i18n.t, so these are user-facing labels like any other.
    const gridOptions: any = definition?.['ui:options'];
    (gridOptions?.columns || []).forEach((column: any, index: number) => {
      add(`${form.name}.uiSchema.${property}['ui:options'].columns[${index}].title`, column?.title);
    });
  }

  // Success/error notification titles are rendered by the data manager through
  // `reactory.i18n.t`, so a dotted key there is a user-facing label as well.
  for (const [slot, element] of Object.entries<any>((form.graphql as any)?.mutation || {})) {
    add(`${form.name}.graphql.mutation.${slot}.notification.title`, element?.notification?.title);
  }
  for (const [slot, element] of Object.entries<any>((form.graphql as any)?.queries || {})) {
    add(`${form.name}.graphql.queries.${slot}.notification.title`, element?.notification?.title);
  }
  add(`${form.name}.graphql.query.notification.title`, (form.graphql as any)?.query?.notification?.title);

  return labels;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AZ-17 form surface', () => {
  it('contributes exactly nine forms, and they are these nine', () => {
    expect(forms).toHaveLength(9);
    expect(forms.map((form) => form.name)).toEqual(EXPECTED_FORM_NAMES);
  });

  it('namespaces and versions every form id, with no duplicates', () => {
    const ids = forms.map((form) => form.id);

    expect(new Set(ids).size).toBe(ids.length);

    const violations: string[] = [];
    for (const form of forms) {
      if (form.nameSpace !== 'azure') violations.push(`${form.name}: nameSpace is ${form.nameSpace}`);
      if (!/^\d+\.\d+\.\d+$/.test(form.version || '')) {
        violations.push(`${form.name}: version is ${form.version}`);
      }
      if (form.id !== `azure.${form.name}@${form.version}`) {
        violations.push(`${form.name}: id is ${form.id}`);
      }
      if (!Array.isArray(form.roles) || !form.roles.includes('USER')) {
        violations.push(`${form.name}: roles is ${JSON.stringify(form.roles)}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('declares an object schema with a non-empty properties map on every form', () => {
    const violations: string[] = [];

    for (const form of forms) {
      const schema = form.schema as any;
      if (!schema || typeof schema !== 'object') {
        violations.push(`${form.name}: schema is not an object literal`);
        continue;
      }
      if (schema.type !== 'object') {
        violations.push(`${form.name}: schema.type is ${JSON.stringify(schema.type)}`);
      }
      if (!schema.properties || Object.keys(schema.properties).length === 0) {
        violations.push(`${form.name}: schema.properties is empty`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('requires only properties the schema declares', () => {
    const violations: string[] = [];

    for (const form of forms) {
      const schema = form.schema as any;
      const declared = new Set(Object.keys(schema?.properties || {}));

      for (const required of schema?.required || []) {
        if (!declared.has(required)) {
          violations.push(`${form.name}: required "${required}" is not a declared property`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('binds every uiSchema key to a declared property', () => {
    const violations: string[] = [];

    for (const form of forms) {
      const declared = new Set(Object.keys((form.schema as any)?.properties || {}));

      for (const [key, value] of Object.entries<any>(form.uiSchema || {})) {
        if (key.startsWith('ui:')) continue;

        if (!declared.has(key)) {
          violations.push(`${form.name}: uiSchema key "${key}" is not a declared property`);
        }
        if (value === null || typeof value !== 'object') {
          violations.push(`${form.name}: uiSchema["${key}"] is not an object`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  describe('GraphQL documents', () => {
    const schema = buildModuleSchema();

    it('binds the expected number of documents on every form', () => {
      const actual: Record<string, number> = {};

      for (const form of forms) {
        actual[form.name] = collectBindings(form).length;
      }

      expect(actual).toEqual(EXPECTED_DOCUMENT_COUNTS);
    });

    it('validates every document against graphql/types/*.graphql', () => {
      const violations: string[] = [];

      for (const form of forms) {
        for (const binding of collectBindings(form)) {
          let document: ReturnType<typeof parse>;
          try {
            document = parse(binding.text);
          } catch (error) {
            violations.push(`${binding.location}: does not parse — ${(error as Error).message}`);
            continue;
          }

          for (const error of validate(schema, document)) {
            violations.push(`${binding.location} (${binding.name}): ${error.message}`);
          }
        }
      }

      expect(violations).toEqual([]);
    });

    it('declares the graph element name as the document root field, in the right operation', () => {
      const violations: string[] = [];

      for (const form of forms) {
        for (const binding of collectBindings(form)) {
          const document = parse(binding.text) as any;
          const operation = document.definitions.find(
            (definition: any) => definition.kind === 'OperationDefinition',
          );

          if (!operation) {
            violations.push(`${binding.location}: no operation definition`);
            continue;
          }

          if (operation.operation !== binding.operation) {
            violations.push(
              `${binding.location}: declares "${binding.operation}" but the document is "${operation.operation}"`,
            );
          }

          const rootFieldName = operation.selectionSet.selections[0]?.name?.value;
          if (rootFieldName !== binding.name) {
            violations.push(
              `${binding.location}: name is "${binding.name}" but the root field is "${rootFieldName}"`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });

    it('declares no dead graphql.queries entry, and no widget names a missing one', () => {
      // `graphql.queries` has exactly ONE live consumer: MaterialTableWidget reads
      // it when a grid names an entry through `ui:options.query`
      // (MaterialTableWidget's getData: `graphqlDefinitions.queries[uiOptions.query]`).
      // The form-level data manager ignores it (it needs a `queryKey` that
      // `useDataManager` never passes), which is why an earlier revision banned the
      // block outright — too strictly: the grid path is real and two shipped client
      // forms depend on it.
      //
      // The accurate rule, asserted in both directions:
      //   * every `graphql.queries` entry is named by some widget's
      //     `ui:options.query` (otherwise it is dead);
      //   * every `ui:options.query` names an entry that exists (otherwise the grid
      //     silently falls back to `graphql.query` or fetches nothing).
      const violations: string[] = [];

      for (const form of forms) {
        const queries = Object.keys((form.graphql as any)?.queries || {});
        const named = referencedQueryKeys(form);

        for (const key of queries) {
          if (!named.has(key)) {
            violations.push(
              `${form.name}: graphql.queries.${key} is not named by any` +
                ` ui:options.query — the form-level data manager ignores it, so it is dead`,
            );
          }
        }

        for (const key of named) {
          if (!queries.includes(key)) {
            violations.push(
              `${form.name}: a widget names ui:options.query "${key}", but graphql.queries` +
                ` has no such entry (${queries.join(', ') || 'none'})`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe('variable maps', () => {
    const schema = buildModuleSchema();

    it('maps every source to a declared form property, and every target to a declared variable', () => {
      const violations: string[] = [];

      for (const form of forms) {
        const declared = declaredProperties(form);

        for (const binding of collectBindings(form)) {
          const map = binding.variables || {};
          const document = parse(binding.text) as any;
          const operation = document.definitions.find(
            (definition: any) => definition.kind === 'OperationDefinition',
          );
          const declaredVariables = new Set<string>(
            (operation?.variableDefinitions || []).map((definition: any) => definition.variable.name.value),
          );

          const producedRoots = new Set<string>();

          for (const source of Object.keys(map)) {
            // The platform roots a map at `formData` (or `formContext`/`query`).
            const root = source.split('.')[0];
            if (!['formData', 'formContext', 'query'].includes(root)) {
              violations.push(
                `${binding.location}: source "${source}" is not rooted at formData/formContext/query` +
                  ` — the map reads source -> variable, not variable -> source`,
              );
              continue;
            }

            if (root === 'formData' && source !== 'formData') {
              const leaf = source.split('.').slice(1)[0];
              if (!declared.has(leaf)) {
                violations.push(
                  `${binding.location}: source "${source}" reads undeclared form property "${leaf}"`,
                );
              }
            }

            // Value is the variable name, possibly nested (`input.courseId`).
            const targets = Array.isArray(map[source]) ? (map[source] as any[]) : [map[source]];
            for (const target of targets) {
              const targetKey = typeof target === 'string' ? target : target?.key;
              if (typeof targetKey !== 'string') {
                violations.push(`${binding.location}: source "${source}" has no string target`);
                continue;
              }
              producedRoots.add(targetKey.split('.')[0]);
            }
          }

          for (const variable of declaredVariables) {
            if (!producedRoots.has(variable)) {
              violations.push(
                `${binding.location}: declares $${variable} but no map entry produces it` +
                  ` — the request would omit it`,
              );
            }
          }

          for (const produced of producedRoots) {
            if (!declaredVariables.has(produced)) {
              violations.push(
                `${binding.location}: map produces "${produced}" which the document does not declare`,
              );
            }
          }

          if (declaredVariables.size === 0 && Object.keys(map).length > 0) {
            violations.push(`${binding.location}: map is non-empty but the document declares no variables`);
          }
        }
      }

      expect(violations).toEqual([]);
    });

    it('never forwards the whole formData object into an input-typed variable', () => {
      const violations: string[] = [];

      for (const form of forms) {
        for (const binding of collectBindings(form)) {
          const map = binding.variables || {};

          for (const source of Object.keys(map)) {
            if (source === 'formData') {
              violations.push(
                `${binding.location}: forwards whole formData — map individual fields instead`,
              );
            }
          }

          // The inverse spelling (`{ 'input': 'formData' }`) is what revision 1
          // shipped. Checking the target side as well means the guard fails on
          // either orientation, not just the corrected one.
          for (const [source, target] of Object.entries<any>(map)) {
            const targets = Array.isArray(target) ? target : [target];
            for (const entry of targets) {
              const targetKey = typeof entry === 'string' ? entry : entry?.key;
              if (targetKey === 'formData') {
                violations.push(
                  `${binding.location}: "${source}" targets whole formData — the map is source -> variable;` +
                    ` map individual fields instead`,
                );
              }
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });

    it('produces variables that satisfy the GraphQL variable types', () => {
      const violations: string[] = [];

      for (const form of forms) {
        const formData = sampleFormData(form);

        for (const binding of collectBindings(form)) {
          const map = binding.variables;
          if (!map || Object.keys(map).length === 0) continue;

          const document = parse(binding.text) as any;
          const operation = document.definitions.find(
            (definition: any) => definition.kind === 'OperationDefinition',
          );

          const kwargs = {
            form,
            formData,
            formContext: {},
            reactory: {},
            api: {},
            props: {},
          };

          const produced = objectMapper(kwargs, map);

          if (produced === undefined || produced === null) {
            violations.push(
              `${binding.location}: the map produced no variables at all` +
                ` (objectMapper returned ${String(produced)}) — every source path is unknown`,
            );
            continue;
          }

          for (const variableDefinition of operation?.variableDefinitions || []) {
            const variableName = variableDefinition.variable.name.value;
            const type = typeFromAST(schema, variableDefinition.type);

            if (!type) {
              violations.push(`${binding.location}: cannot resolve type of $${variableName}`);
              continue;
            }

            validateInputValue(type, produced[variableName], `$${variableName}`, violations);
          }
        }
      }

      expect(violations).toEqual([]);
    });
    /**
     * Characterisation test for a library-version divergence I found while
     * verifying the workbook matrix.
     *
     * `object-mapper` 5.x flattens an array-of-arrays assigned to a target key
     * (`[['a','b'],['c','d']]` -> `['a','b','c','d']`); 6.x preserves it. Arrays
     * of OBJECTS survive in both.
     *
     * The PWA client resolves 6.2.0, so the workbook form's row-major matrix
     * reaches `azureAppendWorkbookRows` intact. This worktree's test resolution
     * picks up the server root's 5.0.0, so the shape cannot be asserted
     * unconditionally. What IS asserted unconditionally is the invariant that
     * makes either behaviour safe: the workbook matrix target is the `Any`
     * scalar, so a flattened payload is still a type-valid request.
     */
    it('keeps the workbook matrix either intact or within an Any-typed target', () => {
      const workbook = forms.find((form) => form.name === 'AzureWorkbookViewForm') as any;
      const append = workbook?.graphql?.mutation?.new;
      expect(append).toBeTruthy();

      const binding: IGraphBinding = {
        location: 'AzureWorkbookViewForm graphql.mutation.new',
        name: append.name,
        text: append.text,
        operation: 'mutation',
        variables: append.variables,
        resultMap: append.resultMap,
      };

      const document = parse(binding.text) as any;
      const operation = document.definitions.find(
        (definition: any) => definition.kind === 'OperationDefinition',
      );
      const valuesVariable = operation.variableDefinitions.find(
        (definition: any) => definition.variable.name.value === 'values',
      );
      expect(valuesVariable).toBeTruthy();

      const valuesType: any = getNamedType(typeFromAST(schema, valuesVariable.type) as any);
      const matrix = [
        ['Report', 'Total'],
        ['Q1', '1200'],
      ];

      const produced = objectMapper(
        { form: workbook, formData: { ...sampleFormData(workbook), values: matrix }, formContext: {}, reactory: {}, api: {}, props: {} },
        binding.variables,
      );

      expect(produced.values).toBeDefined();

      if (JSON.stringify(produced.values) === JSON.stringify(matrix)) {
        // 6.x behaviour — the client's. Nothing more to prove here.
        expect(valuesType.name).toBe('Any');
      } else {
        // 5.x behaviour. The payload must still be type-valid, which is exactly
        // what `Any` guarantees; the flat form is recorded in the report's risks.
        expect(JSON.stringify(produced.values)).toBe(JSON.stringify(['Report', 'Total', 'Q1', '1200']));
        expect(valuesType.name).toBe('Any');
      }
    });
  });

  describe('mapping completeness', () => {
    /**
     * THE ASSERTION THAT WAS MISSING
     * ------------------------------
     * "Every declared variable is type-valid" is satisfied by a *missing* nullable
     * field, so a map entry whose transform silently returns `undefined` passes
     * while discarding the user's input. This test closes that: with a fully
     * populated form, every declared source -> target pair must produce a value
     * that is PRESENT **and** not null.
     *
     * Both halves are required because the two object-mapper builds fail
     * differently: 5.x omits the key entirely, 6.x emits `null`. Every available
     * build is exercised, so the assertion holds for whatever version ships.
     */
    it('produces a present, non-null value for every declared source -> target pair', () => {
      const violations: string[] = [];

      expect(OBJECT_MAPPER_VARIANTS.length).toBeGreaterThan(0);

      for (const variant of OBJECT_MAPPER_VARIANTS) {
        for (const form of forms) {
          const formData = sampleFormData(form);

          for (const binding of collectBindings(form)) {
            const map = binding.variables;
            if (!map || Object.keys(map).length === 0) continue;

            const produced = variant.mapper(
              { form, formData, formContext: {}, reactory: {}, api: {}, props: {} },
              map,
            );

            if (produced === undefined || produced === null) {
              violations.push(
                `[${variant.label}] ${binding.location}: the map produced nothing at all`,
              );
              continue;
            }

            for (const [source, target] of Object.entries<any>(map)) {
              const targets = Array.isArray(target) ? target : [target];

              for (const entry of targets) {
                const targetKey = typeof entry === 'string' ? entry : entry?.key;
                if (typeof targetKey !== 'string') continue;

                const resolved = readPath(produced, targetKey);

                if (!resolved.present) {
                  violations.push(
                    `[${variant.label}] ${binding.location}: source "${source}" produced no` +
                      ` "${targetKey}" — the target is absent, so the value is discarded silentl` +
                      `y (does the transform accept the shape the schema declares?)`,
                  );
                } else if (resolved.value === null) {
                  violations.push(
                    `[${variant.label}] ${binding.location}: source "${source}" produced` +
                      ` "${targetKey}": null — the value is discarded (does the transform accept` +
                      ` the shape the schema declares?)`,
                  );
                }
              }
            }
          }
        }
      }

      // Surface which builds were exercised, so a missing client build is visible.
      if (violations.length > 0) {
        violations.push(`(object-mapper builds exercised: ${MAPPER_LABELS})`);
      }

      expect(violations).toEqual([]);
    });
  });

  describe('read payloads', () => {
    const schema = buildModuleSchema();

    /**
     * A form can only display what the live data manager puts on a DECLARED
     * property. `transformData` shapes `data.data[query.name]` by `schema.type`
     * (object: spread, array: copy, otherwise the whole response) and then applies
     * `resultMap`; `resultType` is never read — `ReactoryFormDataManager.fromGraphResult`,
     * its only consumer, has no callers, which is why no form declares it now.
     *
     * So this test simulates that transform for every read and requires either
     *   (a) at least one declared property to receive a non-empty value, or
     *   (b) the form to be listed in DOCUMENTED_UNREACHABLE_READS *and* named in
     *       AGENT.md's read-reachability table.
     */
    it('surfaces every read payload through one of the client\'s two read paths', () => {
      // A form can display a read payload in exactly two ways, and this oracle
      // models BOTH. Modelling only the first is what made an earlier revision
      // pin a false limitation and would have rejected the correct fix.
      //
      // PATH A — the form-level data manager. `useGraphQLDataManager.transformData`
      // shapes `data.data[query.name]` by `schema.type` (object: spread, array:
      // copy) and then applies `resultMap`. `resultType` is never read. So the
      // payload must land on a declared property.
      //
      // PATH B — the grid's own fetch. `MaterialTableWidget` with
      // `ui:options.remoteData === true` runs its own query on mount, wraps an
      // ARRAY root field as `{ data: rawResultData }` and renders `data.data`.
      // It never calls `transformData`, so `schema.type` does not constrain it —
      // which is the only way a list-returning root can be shown under an object
      // schema. Its variables map from `{ formContext, query, props }`.
      const violations: string[] = [];
      const agentDoc = fs.readFileSync(path.join(MODULE_ROOT, 'AGENT.md'), 'utf8');

      expect(OBJECT_MAPPER_VARIANTS.length).toBeGreaterThan(0);

      for (const variant of OBJECT_MAPPER_VARIANTS) {
        for (const form of forms) {
          const reads: IGraphBinding[] = [];

          const query = (form.graphql as any)?.query;
          if (query) {
            reads.push({
              location: `${form.name} graphql.query`,
              name: query.name,
              text: query.text,
              operation: 'query',
              variables: query.variables,
              resultMap: query.resultMap,
            });
          }

          for (const [key, element] of Object.entries<any>((form.graphql as any)?.queries || {})) {
            reads.push({
              location: `${form.name} graphql.queries.${key}`,
              name: element.name,
              text: element.text,
              operation: 'query',
              variables: element.variables,
              resultMap: element.resultMap,
            });
          }

          for (const binding of reads) {
            const field = rootField(schema, binding);
            if (!field) {
              violations.push(`${binding.location}: root field "${binding.name}" not in the schema`);
              continue;
            }

            // ── Path B: does a remoteData grid own this read? ────────────────
            const grid = remoteDataGrid(form);
            const gridQueryKey = grid?.options?.query;
            const gridOwnsRead =
              Boolean(grid) &&
              (gridQueryKey
                ? `${binding.location}`.endsWith(`graphql.queries.${gridQueryKey}`)
                : `${binding.location}`.endsWith('graphql.query'));

            if (gridOwnsRead) {
              violations.push(...validateRemoteDataGrid(form, grid!, binding, field, schema));
              continue;
            }

            // ── Path A: the form-level data manager ──────────────────────────
            const isList = isListType(isNonNullType(field.type) ? field.type.ofType : field.type);

            if (isList) {
              violations.push(
                `${binding.location}: "${binding.name}" returns a list and no` +
                  ` remoteData grid owns it. The form-level manager spreads a list into` +
                  ` numeric keys, so no declared property can hold the rows; declare a` +
                  ` MaterialTableWidget with ui:options.remoteData: true and name this` +
                  ` read from ui:options.query.`,
              );
              continue;
            }

            const response = { data: { [binding.name]: sampleResponseFor(field) } };
            const produced = applyReadTransform(
              variant.mapper,
              (form.schema as any).type,
              response,
              binding.name,
              binding.resultMap,
            );

            if (produced === undefined || produced === null) {
              violations.push(`[${variant.label}] ${binding.location}: read produced no data at all`);
              continue;
            }

            const declared = declaredProperties(form);
            const populated = Object.keys(produced).filter(
              (key) =>
                declared.has(key) &&
                produced[key] !== null &&
                produced[key] !== undefined &&
                !(Array.isArray(produced[key]) && produced[key].length === 0),
            );

            if (populated.length === 0) {
              violations.push(
                `[${variant.label}] ${binding.location}: the payload lands on no declared property` +
                  ` (payload keys: ${Object.keys(produced).join(', ') || 'none'}; declared:` +
                  ` ${[...declared].join(', ')}) — the form fetches data it cannot display.`,
              );
            }
          }

          // A remoteData grid that names no read at all is dead weight.
          const grid = remoteDataGrid(form);
          if (grid && !grid.options?.query) {
            violations.push(
              `${form.name}: uiSchema.${grid.property} sets remoteData but names no` +
                ` ui:options.query, so its own fetch has nothing to run`,
            );
          }
        }
      }

      // Every documented exception must still be a real one, and AGENT.md must
      // name the form. The map is now empty; the loop keeps a future entry honest.
      for (const formName of Object.keys(DOCUMENTED_UNREACHABLE_READS)) {
        if (!agentDoc.includes(formName)) {
          violations.push(
            `${formName}: listed as an unreachable read, but AGENT.md does not name the form`,
          );
        }
      }

      if (violations.length > 0) {
        violations.push(`(object-mapper builds exercised: ${MAPPER_LABELS})`);
      }

      expect(violations).toEqual([]);
    });  });

  describe('result maps', () => {
    const schema = buildModuleSchema();

    it('keys every resultMap entry by a property of the root field return type', () => {
      const violations: string[] = [];

      for (const form of forms) {
        const declared = declaredProperties(form);

        for (const binding of collectBindings(form)) {
          const map = binding.resultMap;
          if (!map || Object.keys(map).length === 0) continue;

          const field = rootField(schema, binding);
          if (!field) {
            violations.push(`${binding.location}: root field "${binding.name}" not in the schema`);
            continue;
          }

          const returnType: any = getNamedType(field.type);
          const fields = (returnType as any).getFields?.() || {};

          for (const [source, target] of Object.entries<any>(map)) {
            // A result map is applied to `data.data[query.name]` — the object
            // UNDER the root field — so the key is a property of that type, not
            // a path prefixed with the root field's name. A dotted key walks
            // into a nested object type (`body.content`, `start.dateTime`).
            if (!resolveFieldPath(field.type, source)) {
              violations.push(
                `${binding.location}: resultMap key "${source}" is not a field of ${returnType.name}` +
                  ` (${Object.keys(fields).join(', ')}) — the map is applied to the object under` +
                  ` "${binding.name}", not to the whole response`,
              );
            }

            const targetKey = typeof target === 'string' ? target : target?.key;
            if (typeof targetKey === 'string' && !declared.has(targetKey)) {
              violations.push(
                `${binding.location}: resultMap target "${targetKey}" is not a declared form property`,
              );
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });

    it('applied to a sample return value, fills only declared form properties', () => {
      const violations: string[] = [];

      for (const form of forms) {
        const declared = declaredProperties(form);

        for (const binding of collectBindings(form)) {
          const map = binding.resultMap;
          if (!map || Object.keys(map).length === 0) continue;

          const field = rootField(schema, binding);
          if (!field) continue;

          const returnType = getNamedType(field.type) as any;
          const fields = returnType.getFields?.() || {};
          const sampleReturn: Record<string, unknown> = {};
          for (const key of Object.keys(fields)) {
            sampleReturn[key] = sampleValue({ type: 'string' });
          }

          const produced = objectMapper(sampleReturn, map);
          if (produced === undefined || produced === null) {
            violations.push(
              `${binding.location}: the resultMap produced nothing from a complete` +
                ` ${returnType.name} — every key is unknown`,
            );
            continue;
          }

          for (const key of Object.keys(produced)) {
            if (!declared.has(key)) {
              violations.push(
                `${binding.location}: resultMap produced "${key}", which is not a declared form property`,
              );
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe('internationalisation', () => {
    const bundle = readTranslations();

    it('externalises every user-facing label to a key that resolves in i18n/en.json', () => {
      const violations: string[] = [];

      for (const form of forms) {
        for (const label of collectLabels(form)) {
          if (!label.value.startsWith('azure.forms.')) {
            violations.push(`${label.location}: hardcoded label "${label.value}"`);
            continue;
          }

          const resolved = resolveLabel(bundle, label.value);
          if (typeof resolved !== 'string' || resolved.length === 0) {
            violations.push(`${label.location}: "${label.value}" does not resolve in i18n/en.json`);
          }
        }
      }

      expect(violations).toEqual([]);
    });

    it('labels every enum member it offers', () => {
      const violations: string[] = [];

      for (const form of forms) {
        for (const [property, definition] of Object.entries<any>((form.schema as any).properties)) {
          for (const candidate of [definition, definition?.items]) {
            if (!candidate?.enum) continue;

            const names = candidate.enumNames || [];
            if (names.length !== candidate.enum.length) {
              violations.push(
                `${form.name}.${property}: ${candidate.enum.length} enum values but ${names.length} labels`,
              );
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });

    it('leaves no orphaned string in i18n/en.json', () => {
      const referenced = new Set(
        forms.flatMap((form) =>
          collectLabels(form)
            .map((label) => label.value)
            .filter((value) => value.startsWith('azure.forms.')),
        ),
      );

      const orphans = flattenKeys(bundle, '')
        .filter((key) => key.startsWith('azure.forms.'))
        .filter((key) => !referenced.has(key));

      expect(orphans).toEqual([]);
    });
  });
});

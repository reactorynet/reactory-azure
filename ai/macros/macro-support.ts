import type { Schema } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

/**
 * Shared plumbing for the Azure AI macros (AZ-13).
 *
 * This file is **not** a macro definition: it is deliberately named
 * `macro-support.ts` rather than `*.macros.ts`, so the AZ-01 barrel and the
 * module's contract test (which enumerates `ai/macros/*.macros.ts`) are
 * unaffected by it.
 *
 * Three rules it exists to enforce, once:
 *
 *  1. **Every parameter documents itself.** The authoring shape is a
 *     {@link MacroParameterSpec} array in which `description` and `required` are
 *     both mandatory. Emitting the JSON Schema from that array makes it
 *     impossible to add a parameter without a description or without deciding
 *     whether it is required; a required parameter always lands in
 *     `parameters.required`.
 *
 *  2. **Every result is JSON-serialisable.** The envelope builders return plain
 *     objects only - never a stream, a service instance or an `Error`. A failure
 *     is data the model can read and act on, not an exception it has to survive.
 *
 *  3. **"Not connected" is an answer, not a crash.** Graph services throw
 *     `ApiError { code: 'NotConnected' }` when the user has no vaulted Microsoft
 *     token. {@link macroFailure} turns that into a payload that says so and
 *     tells the assistant to ask the user to connect - the assistant cannot
 *     repair an exception, but it can relay a sentence.
 *
 * Nothing here imports a service: the macros resolve their own service from the
 * chat context (`getService('<fqn>')`), which is what makes them testable with a
 * fake context and with no Graph tenant.
 */

/** Namespace every Azure macro is registered under. */
export const AZURE_NS = 'azure';

/** The module-wide macro version. */
export const AZURE_VERSION = '1.0.0';

/** Roles a macro is exposed to. */
export const ROLE_SET = ['USER', 'ADMIN'];

export type MacroParameterType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

/**
 * One parameter, in authoring form.
 *
 * `description` and `required` are not optional: requirement 2 of AZ-13 says
 * every parameter has a description and a required flag, and a spec that omits
 * either cannot be compiled into one of these.
 */
export interface MacroParameterSpec {
  /** Property name, exactly as the model must supply it. */
  name: string;
  /** JSON Schema type. */
  type: MacroParameterType;
  /** What the parameter means and how to populate it. Never blank. */
  description: string;
  /** Whether the macro refuses to run without it. */
  required: boolean;
  /** Allowed values, when the parameter is an enum. */
  enum?: string[];
  /** Element schema, when the parameter is an array. */
  items?: Schema;
  /** Default the macro applies when the parameter is absent. */
  default?: unknown;
}

/**
 * Compile parameter specs into the `parameters` block of a tool definition.
 *
 * The emitted schema is ordinary OpenAPI/JSON Schema: `required` is a top-level
 * string array, never a per-property boolean. The boolean lives on the spec (so
 * the author has to make the decision) and is translated here, which is why the
 * result can be handed to a provider unmodified.
 */
export const buildParameters = (specs: MacroParameterSpec[]): Schema => {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];

  for (const spec of specs) {
    const property: Schema = {
      type: spec.type,
      description: spec.description,
    };

    if (spec.enum !== undefined) property.enum = [...spec.enum];
    if (spec.items !== undefined) property.items = spec.items;
    if (spec.default !== undefined) property.default = spec.default;

    properties[spec.name] = property;
    if (spec.required) required.push(spec.name);
  }

  return { type: 'object', properties, required };
};

/** A JSON-safe success envelope. */
export const ok = (tool: string, params: unknown, data: unknown, message?: string) => ({
  success: true,
  tool,
  params,
  data,
  ...(message ? { message } : {}),
});

/** A JSON-safe failure envelope. */
export const fail = (tool: string, params: unknown, error: string, instructions?: string) => ({
  success: false,
  tool,
  params,
  error,
  ...(instructions ? { instructions } : {}),
});

/**
 * The payload a connection-dependent macro returns when the user has no
 * Microsoft 365 connection (or the connector service is not registered).
 *
 * `connected: false` is the machine-readable bit; `instructions` is the sentence
 * the assistant should relay. Nothing is thrown, so the chat turn survives.
 */
export const notConnected = (tool: string, params: unknown, detail?: string) => ({
  success: false,
  connected: false,
  status: 'DISCONNECTED',
  tool,
  params,
  error: detail || 'Microsoft 365 is not connected for this user',
  instructions:
    'Microsoft 365 is not connected for this user. Tell the user to connect their '
    + 'Microsoft 365 account (the Azure sign-in) and then retry the request. Do not '
    + 'retry blindly - nothing will succeed until the account is connected.',
});

/** Read a message out of anything that was thrown. */
export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
};

const errorCode = (error: unknown): string | undefined => {
  const code = (error as any)?.code ?? (error as any)?.extensions?.code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * True when a service refused because there is no usable Microsoft token.
 *
 * The module's own marker is `ApiError.code === 'NotConnected'`
 * (`GraphErrorCode.NOT_CONNECTED`). The message fallback covers a mock or a
 * wrapping layer that dropped the code - the user-facing outcome is identical,
 * so treating it the same is safe.
 */
export const isNotConnected = (error: unknown): boolean => {
  const code = errorCode(error);
  if (code && code.toLowerCase() === 'notconnected') return true;
  if (code === 'InvalidAuthenticationToken' || code === 'LegacyTokenExpired') return true;

  return /not connected|no microsoft account|no azure token|reconnect/i.test(errorMessage(error));
};

/**
 * Turn a caught service error into the right envelope: a not-connected payload
 * when the cause is a missing connection, a plain failure otherwise.
 */
export const macroFailure = (tool: string, params: unknown, error: unknown) => (
  isNotConnected(error)
    ? notConnected(tool, params, errorMessage(error))
    : fail(tool, params, errorMessage(error))
);

/** The authenticated user id from the chat context, or `undefined`. */
export const userIdFrom = (context: any): string | undefined => {
  const id = context?.user?._id;
  if (id === undefined || id === null) return undefined;

  const value = String(id);
  return value.length > 0 && value !== 'undefined' && value !== 'null' ? value : undefined;
};

/** Drop `undefined` properties so the payload has no invisible holes. */
export const compactObject = <T extends Record<string, unknown>>(input: T): Partial<T> => {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }

  return output as Partial<T>;
};

/** A trimmed, non-empty string, or `undefined`. */
export const optionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** A finite number, or `undefined`. */
export const optionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
};

/** A boolean given as either a boolean or `"true"`/`"false"`, or `undefined`. */
export const optionalBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};

/**
 * Normalise a recipient/attendee list.
 *
 * Models routinely pass a single address, an array of addresses, or one
 * comma/semicolon-separated string. All three are accepted; the service is given
 * a clean `string[]`.
 */
export const asStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,;]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
};

/** An ISO 8601 rendering of a Date/string value, or `undefined`. */
export const toIsoString = (value: unknown): string | undefined => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
};

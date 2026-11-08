import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { encodePathSegment } from '../utils/odata';
import { isScopeVerificationDeferred } from '../utils/scopes';
import { GraphErrorCode, apiError, toGraphApiError } from '../utils/graph-error';
import type { IGraphProviderOptions } from './graph/AzureGraphClientProvider';
import type { IGraphBinaryResponse } from '../types/graph.types';
import type {
  IAzureContact,
  IAzureContactEmailAddress,
  IAzureContactFolder,
  IAzureContactGetOptions,
  IAzureContactInput,
  IAzureContactListOptions,
  IAzureContactPage,
  IAzureContactsService,
  IAzureDirectoryUser,
  IAzureDirectoryUserListOptions,
  IAzureDirectoryUserPage,
  IAzurePeopleOptions,
  IAzurePeoplePage,
  IAzurePerson,
  IAzureScoredEmailAddress,
} from '../types/contacts.types';
import {
  CONTACTS_INSUFFICIENT_SCOPE,
  DEFAULT_CONTACT_DETAIL_SELECT,
  DEFAULT_CONTACT_FOLDER_SELECT,
  DEFAULT_CONTACT_SELECT,
  DEFAULT_CONTACTS_PAGE_SIZE,
  DEFAULT_DIRECTORY_USER_SELECT,
  DEFAULT_PEOPLE_SELECT,
  DIRECTORY_BASIC_PERMISSION,
  DIRECTORY_FULL_PERMISSION,
  DIRECTORY_REQUIRED_SCOPES,
} from '../types/contacts.types';

/** The raw Graph collection envelope (only the parts this service reads). */
interface IGraphCollection<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.count'?: number;
}

/** The provider surface this service depends on - typed so generic calls are checked. */
interface IContactsGraphProvider {
  request<T>(userId: string, path: string, options?: IGraphProviderOptions): Promise<T>;
  requestAll<T>(userId: string, path: string, options?: IGraphProviderOptions): Promise<T[]>;
  requestRaw(
    userId: string,
    path: string,
    options?: IGraphProviderOptions,
  ): Promise<IGraphBinaryResponse>;
  getClient(userId: string): any;
}

/** The only auth-service method this service needs. */
interface IContactsAuthService {
  getGrantedScopes(userId: string): Promise<string[]>;
}

const CONTACTS_PATH = '/me/contacts';
const CONTACT_FOLDERS_PATH = '/me/contactFolders';
const PEOPLE_PATH = '/me/people';
const USERS_PATH = '/users';

/**
 * Contact properties accepted on create/update.
 *
 * Graph rejects an unknown member with `ErrorInvalidRequest`; filtering here gives
 * the caller a predictable payload and keeps a typo from reaching the tenant.
 */
const CONTACT_WRITE_PROPERTIES: Array<keyof IAzureContactInput> = [
  'displayName',
  'givenName',
  'surname',
  'emailAddresses',
  'businessPhones',
  'homePhones',
  'mobilePhone',
  'companyName',
  'jobTitle',
  'department',
  'officeLocation',
  'personalNotes',
  'categories',
];

/** Copy a non-empty string onto a target object. */
function assignString(target: any, key: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) target[key] = value;
}

/** A Graph string array, without the empty strings Graph sometimes emits. */
function normaliseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * Normalise one Graph address.
 *
 * Contacts and people use the flat `{ name, address }` shape; the mail-style
 * `{ emailAddress: { name, address } }` is accepted too so one normaliser can
 * serve every caller.
 */
function normaliseEmailAddress(value: any): IAzureContactEmailAddress | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const inner = value.emailAddress && typeof value.emailAddress === 'object'
    ? value.emailAddress
    : value;

  const address = typeof inner.address === 'string' && inner.address.length > 0
    ? inner.address
    : undefined;
  const name = typeof inner.name === 'string' && inner.name.length > 0 ? inner.name : undefined;

  if (address === undefined && name === undefined) return undefined;

  const result: IAzureContactEmailAddress = {};
  if (name !== undefined) result.name = name;
  if (address !== undefined) result.address = address;
  return result;
}

/** Normalise an address list; absent or malformed input reads as an empty list. */
function normaliseEmailAddressList(value: unknown): IAzureContactEmailAddress[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normaliseEmailAddress(entry))
    .filter((entry): entry is IAzureContactEmailAddress => entry !== undefined);
}

/** Normalise a `/me/people` scored address list. */
function normaliseScoredEmailAddressList(value: unknown): IAzureScoredEmailAddress[] {
  if (!Array.isArray(value)) return [];

  const result: IAzureScoredEmailAddress[] = [];

  for (const entry of value) {
    const address = normaliseEmailAddress(entry);
    if (!address) continue;

    const scored: IAzureScoredEmailAddress = { ...address };
    const score = (entry as any)?.relevanceScore;
    if (typeof score === 'number' && Number.isFinite(score)) scored.relevanceScore = score;
    result.push(scored);
  }

  return result;
}

/** Normalise one `/me/contacts` entry. */
function normaliseContact(raw: any): IAzureContact {
  const contact: IAzureContact = {
    id: String(raw?.id ?? ''),
    emailAddresses: normaliseEmailAddressList(raw?.emailAddresses),
    businessPhones: normaliseStringArray(raw?.businessPhones),
  };

  assignString(contact, 'displayName', raw?.displayName);
  assignString(contact, 'givenName', raw?.givenName);
  assignString(contact, 'surname', raw?.surname);
  assignString(contact, 'mobilePhone', raw?.mobilePhone);
  assignString(contact, 'companyName', raw?.companyName);
  assignString(contact, 'jobTitle', raw?.jobTitle);
  assignString(contact, 'department', raw?.department);
  assignString(contact, 'officeLocation', raw?.officeLocation);
  assignString(contact, 'parentFolderId', raw?.parentFolderId);

  return contact;
}

/** Normalise one `/me/contactFolders` entry. */
function normaliseContactFolder(raw: any): IAzureContactFolder {
  const folder: IAzureContactFolder = { id: String(raw?.id ?? '') };

  assignString(folder, 'displayName', raw?.displayName);
  assignString(folder, 'parentFolderId', raw?.parentFolderId);
  assignString(folder, 'wellKnownName', raw?.wellKnownName);

  return folder;
}

/**
 * Normalise one `/me/people` entry.
 *
 * Graph models `personType` as `{ class, subclass }`; the domain exposes the
 * subclass (`organizationUser`, `person`, `group`, `unknown`) with the class as
 * the fallback, because that is the value a UI switches on.
 */
function normalisePerson(raw: any): IAzurePerson {
  const person: IAzurePerson = {
    id: String(raw?.id ?? ''),
    displayName: String(raw?.displayName ?? ''),
    emailAddresses: normaliseEmailAddressList(raw?.emailAddresses),
    scoredEmailAddresses: normaliseScoredEmailAddressList(raw?.scoredEmailAddresses),
  };

  assignString(person, 'givenName', raw?.givenName);
  assignString(person, 'surname', raw?.surname);
  assignString(person, 'companyName', raw?.companyName);
  assignString(person, 'jobTitle', raw?.jobTitle);
  assignString(person, 'department', raw?.department);

  const personType = raw?.personType;
  if (typeof personType === 'string') {
    assignString(person, 'personType', personType);
  } else if (personType && typeof personType === 'object') {
    assignString(person, 'personType', personType.subclass ?? personType.class);
  }

  return person;
}

/** Normalise one `/users` entry. */
function normaliseDirectoryUser(raw: any): IAzureDirectoryUser {
  const user: IAzureDirectoryUser = {
    id: String(raw?.id ?? ''),
    businessPhones: normaliseStringArray(raw?.businessPhones),
  };

  assignString(user, 'displayName', raw?.displayName);
  assignString(user, 'givenName', raw?.givenName);
  assignString(user, 'surname', raw?.surname);
  assignString(user, 'mail', raw?.mail);
  assignString(user, 'userPrincipalName', raw?.userPrincipalName);
  assignString(user, 'jobTitle', raw?.jobTitle);
  assignString(user, 'department', raw?.department);
  assignString(user, 'officeLocation', raw?.officeLocation);
  assignString(user, 'mobilePhone', raw?.mobilePhone);
  if (typeof raw?.accountEnabled === 'boolean') user.accountEnabled = raw.accountEnabled;

  return user;
}

/** A deterministic `$top`, so no read is unbounded. */
function pageSize(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_CONTACTS_PAGE_SIZE;
}

/** True when the grant contains a `User.Read*` scope (OAuth scope names are case-insensitive). */
function hasUserReadScope(scope: unknown): boolean {
  return typeof scope === 'string' && /^user\.read/i.test(scope.trim());
}

/**
 * The directory scope gate.
 *
 * `listDirectoryUsers` needs `User.ReadBasic.All` or `User.Read.All`. The gate is
 * deliberately conservative about *when* it fires:
 *
 *   - `['legacy:unverified']` -> **attempt the call**. A legacy User-document token
 *     carries no scope string, so the grant is unverifiable; refusing locally
 *     would lock every pre-vault user out of the directory. This is
 *     `isScopeVerificationDeferred` from utils/scopes.ts.
 *   - `[]` -> **attempt the call**. No scopes are recorded (no row, or a revoked
 *     row); the provider will raise `NotConnected` / `InvalidAuthenticationToken`,
 *     which describes the real problem far better than a scope complaint.
 *   - a non-empty grant with no `User.Read*` entry -> **throw** an insufficient-scope
 *     `ApiError` before any request. This is the case where we *know* the grant is
 *     insufficient, and the live call would only fail with an opaque 403.
 *
 * @param userId - the user the directory read was requested for (error context)
 * @param granted - the scopes `AzureAuthService.getGrantedScopes` returned
 * @throws ApiError with `code = 'InsufficientScope'`
 */
export function assertDirectoryScopes(userId: string, granted: string[]): void {
  if (isScopeVerificationDeferred(granted)) return;

  const scopes = Array.isArray(granted) ? granted : [];
  if (scopes.length === 0) return;
  if (scopes.some(hasUserReadScope)) return;

  throw apiError(
    CONTACTS_INSUFFICIENT_SCOPE,
    `Microsoft Graph directory access requires ${DIRECTORY_BASIC_PERMISSION} or `
      + `${DIRECTORY_FULL_PERMISSION}; user [${userId}] has no User.Read* grant `
      + `(granted: ${scopes.join(', ')})`,
    {
      userId,
      grantedScopes: [...scopes],
      requiredScopes: [...DIRECTORY_REQUIRED_SCOPES],
      operation: 'listDirectoryUsers',
    },
  );
}

/**
 * AzureContactsService - Microsoft Graph contacts, contact folders, people search
 * and the organisation directory.
 *
 * The service is a thin, typed adapter over `AzureGraphClientProvider`:
 *
 *   - the provider owns the Graph `Client`, retries, `@odata.nextLink` pagination
 *     and error translation, so this service never re-implements transport policy;
 *   - every failure propagates as an `ApiError` carrying the Graph `code`
 *     (`itemNotFound`, `ErrorInvalidRequest`, `InvalidAuthenticationToken`, ...).
 *     No method returns `[]`, `null` or a placeholder on failure - the single
 *     exception is `getContactPhoto`, whose `null` is reserved for Graph's
 *     documented `ImageNotFound`;
 *   - every read is normalised so a Graph shape change stops at this boundary.
 *
 * ## People search vs. the directory
 *
 * `/me/people` is the relevance-ranked people list (`People.Read`); `/users` is
 * the tenant directory (`User.ReadBasic.All` / `User.Read.All`). They are
 * different resources with different permissions and are not interchangeable -
 * see {@link listDirectoryUsers} and `types/contacts.types.ts`.
 */
@service({
  id: 'azure.AzureContactsService@1.0.0',
  name: 'AzureContactsService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph contacts, contact folders, people search and organisation directory',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'azure.AzureAuthService@1.0.0', alias: 'authService' },
  ],
})
class AzureContactsService implements Reactory.Service.IReactoryService, IAzureContactsService {
  name: string = 'AzureContactsService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _graphClientProvider: IContactsGraphProvider;
  private _authService: IContactsAuthService;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `graphClientProvider` alias. */
  setGraphClientProvider(serviceInstance: any): void {
    this._graphClientProvider = serviceInstance;
  }

  /** Bound by the Reactory service container from the `authService` alias. */
  setAuthService(serviceInstance: any): void {
    this._authService = serviceInstance;
  }

  private get graphClientProvider(): IContactsGraphProvider {
    if (this._graphClientProvider) return this._graphClientProvider;
    return this.context.getService('azure.AzureGraphClientProvider@1.0.0') as unknown as IContactsGraphProvider;
  }

  /** `undefined` when the container cannot resolve it - the gate then stands aside. */
  private get authService(): IContactsAuthService | undefined {
    if (this._authService) return this._authService;

    try {
      return this.context.getService('azure.AzureAuthService@1.0.0') as unknown as IContactsAuthService;
    } catch {
      return undefined;
    }
  }

  /**
   * List the signed-in user's personal contacts.
   *
   * `GET /me/contacts` with `$select` / `$filter` / `$orderby` / `$top` / `$skip`.
   * Without `options.all` the first page is returned with the opaque
   * `@odata.nextLink`; with `options.all` every page is drained (bounded by
   * `maxPages`, and the provider throws rather than truncating).
   *
   * `$skip` **is** supported on `/me/contacts` - unlike `/me/people`, see
   * {@link searchPeople}.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listContacts(
    userId: string,
    options: IAzureContactListOptions = {},
  ): Promise<IAzureContactPage> {
    return this.readContactPage(userId, CONTACTS_PATH, options, 'listContacts');
  }

  /**
   * Read one contact.
   *
   * `GET /me/contacts/{id}` with the detail projection (the list projection plus
   * `givenName`, `surname`, `department`, `officeLocation`, `parentFolderId`).
   *
   * @throws ApiError carrying the Graph `code` (e.g. `itemNotFound`)
   */
  async getContact(
    userId: string,
    contactId: string,
    options: IAzureContactGetOptions = {},
  ): Promise<IAzureContact> {
    this.requireId(contactId, 'contactId');

    const contact = await this.graphClientProvider.request<any>(
      userId,
      `${CONTACTS_PATH}/${encodePathSegment(String(contactId))}`,
      {
        select: options.select ?? DEFAULT_CONTACT_DETAIL_SELECT,
        operation: 'getContact',
      },
    );

    return normaliseContact(contact);
  }

  /**
   * Create a contact.
   *
   * `POST /me/contacts` with the whitelisted {@link IAzureContactInput} members.
   * Requires `Contacts.ReadWrite`.
   *
   * @throws ApiError carrying the Graph `code`; also when Graph returns no contact
   * body (a write that cannot be confirmed is reported as a failure, never as a
   * synthetic `id: ''`)
   */
  async createContact(userId: string, input: IAzureContactInput): Promise<IAzureContact> {
    const body = this.buildContactPayload(input, true);
    const client = this.graphClientProvider.getClient(userId);

    let created: any;
    try {
      created = await client.api(CONTACTS_PATH).post(body);
    } catch (error: any) {
      throw toGraphApiError(error, { operation: 'createContact' });
    }

    return this.requireContactResult(created, 'createContact');
  }

  /**
   * Update a contact with a partial payload (`PATCH /me/contacts/{id}`).
   *
   * Only the supplied whitelisted properties are sent; Graph leaves the rest
   * untouched. Requires `Contacts.ReadWrite`.
   *
   * @throws ApiError carrying the Graph `code`; an empty patch is rejected locally
   */
  async updateContact(
    userId: string,
    contactId: string,
    input: IAzureContactInput,
  ): Promise<IAzureContact> {
    this.requireId(contactId, 'contactId');

    const body = this.buildContactPayload(input, false);
    const client = this.graphClientProvider.getClient(userId);

    let updated: any;
    try {
      updated = await client
        .api(`${CONTACTS_PATH}/${encodePathSegment(String(contactId))}`)
        .patch(body);
    } catch (error: any) {
      throw toGraphApiError(error, { operation: 'updateContact' });
    }

    return this.requireContactResult(updated, 'updateContact');
  }

  /**
   * Delete a contact (`DELETE /me/contacts/{id}`).
   *
   * Resolves to `void` - a successful delete has no body, and the contract must
   * not invent one. A 404 for an unknown id throws `itemNotFound`.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async deleteContact(userId: string, contactId: string): Promise<void> {
    this.requireId(contactId, 'contactId');

    const client = this.graphClientProvider.getClient(userId);

    try {
      await client.api(`${CONTACTS_PATH}/${encodePathSegment(String(contactId))}`).delete();
    } catch (error: any) {
      throw toGraphApiError(error, { operation: 'deleteContact' });
    }
  }

  /**
   * List the user's contact folders.
   *
   * `GET /me/contactFolders`. Contact folders are few and the endpoint has no
   * meaningful paging story for a UI, so every page is followed through the
   * provider's bounded `requestAll`.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listContactFolders(userId: string): Promise<IAzureContactFolder[]> {
    const folders = await this.graphClientProvider.requestAll<any>(
      userId,
      CONTACT_FOLDERS_PATH,
      {
        select: DEFAULT_CONTACT_FOLDER_SELECT,
        operation: 'listContactFolders',
      },
    );

    return (Array.isArray(folders) ? folders : []).map(normaliseContactFolder);
  }

  /**
   * List the contacts in one contact folder.
   *
   * `GET /me/contactFolders/{folderId}/contacts`; identical options and paging to
   * {@link listContacts}.
   *
   * @throws ApiError carrying the Graph `code`
   */
  async listContactsInFolder(
    userId: string,
    folderId: string,
    options: IAzureContactListOptions = {},
  ): Promise<IAzureContactPage> {
    this.requireId(folderId, 'folderId');

    const path = `${CONTACT_FOLDERS_PATH}/${encodePathSegment(String(folderId))}/contacts`;
    return this.readContactPage(userId, path, options, 'listContactsInFolder');
  }

  /**
   * Search the people the user interacts with (`GET /me/people?$search=`).
   *
   * ## Paging contract (the sharp edge)
   *
   * `/me/people` supports `$search` **or** `$skip`, never both: Graph rejects
   * `$search` + `$skip` with `ErrorInvalidRequest`. This method therefore:
   *
   *   - sends `$search` (never an OData `$filter` on `displayName` - that would
   *     miss the relevance ranking and, for `people`, is a different query);
   *   - never sends `$skip`; a `skip` supplied at runtime is dropped so a caller
   *     cannot accidentally produce an invalid query;
   *   - pages **only** through `@odata.nextLink`: pass the returned `nextLink`
   *     back as `options.nextLink` to read the next page, or set `options.all` to
   *     drain every page in one call (bounded by `maxPages`).
   *
   * `$search` needs `ConsistencyLevel: eventual` on every page; the provider adds
   * it for the first page and this method carries it explicitly so page 2+ keep it.
   *
   * `People.Read` is required. Use {@link listDirectoryUsers} for the tenant
   * directory instead.
   *
   * @param userId - the vault owner whose people list is searched
   * @param query - the `$search` term; ignored when `options.nextLink` is set
   * @throws ApiError carrying the Graph `code`
   */
  async searchPeople(
    userId: string,
    query: string,
    options: IAzurePeopleOptions = {},
  ): Promise<IAzurePeoplePage> {
    const nextLink = typeof options.nextLink === 'string' && options.nextLink.trim().length > 0
      ? options.nextLink.trim()
      : undefined;
    const term = typeof query === 'string' ? query.trim() : '';

    if (!nextLink && term.length === 0) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'A non-empty query is required to search people',
        { operation: 'searchPeople' },
      );
    }

    const select = options.select ?? DEFAULT_PEOPLE_SELECT;

    // `requestAll` rebuilds page 2+ options as `{ operation, apiVersion, headers }`,
    // so `ConsistencyLevel` has to travel as a header or a paged search loses it.
    const headers: Record<string, string> = { ConsistencyLevel: 'eventual' };

    if (options.all === true && !nextLink) {
      const all = await this.graphClientProvider.requestAll<any>(userId, PEOPLE_PATH, {
        select,
        search: term,
        top: pageSize(options.top),
        headers,
        operation: 'searchPeople',
        ...(typeof options.maxPages === 'number' ? { maxPages: options.maxPages } : {}),
      });

      return { items: (Array.isArray(all) ? all : []).map(normalisePerson) };
    }

    // A nextLink is an absolute URL that already carries `$search` and the cursor,
    // so no query option may be added to it (see IGraphProviderOptions.url) - but
    // `ConsistencyLevel: eventual` is a HEADER, and `$search` requires it on every
    // page, so it is carried here as well. Omitting it on this branch made page 2+
    // of a people search fail with ErrorInvalidRequest.
    const requestOptions: IGraphProviderOptions = nextLink
      ? { url: nextLink, headers, operation: 'searchPeople' }
      : {
        select,
        search: term,
        top: pageSize(options.top),
        headers,
        operation: 'searchPeople',
      };

    const page = await this.graphClientProvider.request<IGraphCollection<any>>(
      userId,
      nextLink || PEOPLE_PATH,
      requestOptions,
    );

    const result: IAzurePeoplePage = {
      items: Array.isArray(page?.value) ? page.value.map(normalisePerson) : [],
    };

    if (typeof page?.['@odata.nextLink'] === 'string') result.nextLink = page['@odata.nextLink'];

    return result;
  }

  /**
   * List users from the tenant directory (`GET /users`).
   *
   * ## Permission gate
   *
   * Requires `User.ReadBasic.All` (basic profile) or `User.Read.All` (full
   * profile). The difference matters - `User.ReadBasic.All` cannot return
   * `jobTitle`, `department`, `officeLocation`, `businessPhones` or `mobilePhone`;
   * `User.Read.All` can, and is a privileged permission normally needing admin
   * consent. The default projection is the basic one
   * (`DEFAULT_DIRECTORY_USER_SELECT` in types/contacts.types.ts); a caller with
   * `User.Read.All` passes `EXTENDED_DIRECTORY_USER_SELECT` as `options.select`.
   *
   * Before any request the gate reads `getGrantedScopes(userId)`:
   *
   *   - a non-empty grant with no `User.Read*` scope throws an insufficient-scope
   *     `ApiError` (`code = 'InsufficientScope'`) carrying `grantedScopes` and
   *     `requiredScopes` - the request is never made;
   *   - the exact `['legacy:unverified']` sentinel **attempts the call**: a legacy
   *     token has no scope string, so its grant is unverifiable, not insufficient;
   *   - an empty grant also attempts the call, letting the provider report
   *     `NotConnected` / `InvalidAuthenticationToken`.
   *
   * See {@link assertDirectoryScopes}.
   *
   * @throws ApiError `InsufficientScope`, or the Graph error from the attempt
   */
  async listDirectoryUsers(
    userId: string,
    options: IAzureDirectoryUserListOptions = {},
  ): Promise<IAzureDirectoryUserPage> {
    await this.assertDirectoryScope(userId);

    const requestOptions: IGraphProviderOptions = {
      select: options.select ?? DEFAULT_DIRECTORY_USER_SELECT,
      top: pageSize(options.top),
      operation: 'listDirectoryUsers',
    };

    if (options.filter) requestOptions.filter = options.filter;
    if (options.orderBy) requestOptions.orderBy = options.orderBy;
    // `skip` is an offset into a single page; an all-pages read starts at the top.
    if (options.all !== true && typeof options.skip === 'number'
      && Number.isFinite(options.skip) && options.skip > 0) {
      requestOptions.skip = Math.trunc(options.skip);
    }
    // `$count` is a total-for-the-first-page concern: an all-pages read returns
    // `{ items }` only, so it is genuinely not sent (see IAzureDirectoryUserListOptions).
    if (options.all !== true && options.count === true) requestOptions.count = true;

    if (options.all === true) {
      const all = await this.graphClientProvider.requestAll<any>(userId, USERS_PATH, {
        ...requestOptions,
        ...(typeof options.maxPages === 'number' ? { maxPages: options.maxPages } : {}),
      });

      return { items: (Array.isArray(all) ? all : []).map(normaliseDirectoryUser) };
    }

    const page = await this.graphClientProvider.request<IGraphCollection<any>>(
      userId,
      USERS_PATH,
      requestOptions,
    );

    const result: IAzureDirectoryUserPage = {
      items: Array.isArray(page?.value) ? page.value.map(normaliseDirectoryUser) : [],
    };

    if (typeof page?.['@odata.nextLink'] === 'string') result.nextLink = page['@odata.nextLink'];
    if (typeof page?.['@odata.count'] === 'number') result.count = page['@odata.count'];

    return result;
  }

  /**
   * Read a contact photo (`GET /me/contacts/{id}/photo/$value`) as a data URI.
   *
   * ## Why this is the only method that returns `null`
   *
   * Graph answers `404 ImageNotFound` when the contact simply has no photo. That
   * is a documented, expected absence, so it maps to `null`. **Everything else
   * throws** - a 401 (revoked/expired grant), throttling, a 404 `itemNotFound`
   * for a missing *contact*, a 5xx, an empty payload. The module this replaced
   * returned `null` for every failure, which made a revoked account
   * indistinguishable from "no avatar"; that defect is not repeated here.
   *
   * ## The resolved-response contract
   *
   * A RAW request does **not** reject on a non-2xx status: the SDK returns the raw
   * `Response` before checking `response.ok`. A 404/401/429/5xx therefore arrives
   * as a *resolved* `IGraphBinaryResponse` with the Graph error JSON in `buffer`.
   * The status is inspected explicitly (see the body) so a 401 becomes
   * `ApiError(code='InvalidAuthenticationToken', status=401)` and throttling/5xx
   * surfaces as an error rather than a bogus image. A genuine transport rejection
   * is still translated through `toGraphApiError`.
   *
   * The returned MIME type is the response's `Content-Type` (Graph sends
   * `image/jpeg`), stripped of any parameters.
   *
   * @throws ApiError for every failure except `ImageNotFound`
   */
  async getContactPhoto(userId: string, contactId: string): Promise<string | null> {
    this.requireId(contactId, 'contactId');

    const path = `${CONTACTS_PATH}/${encodePathSegment(String(contactId))}/photo/$value`;

    let response: IGraphBinaryResponse;

    try {
      response = await this.graphClientProvider.requestRaw(userId, path, {
        operation: 'getContactPhoto',
      });
    } catch (error: any) {
      if (isImageNotFound(error)) return null;
      throw toGraphApiError(error, { operation: 'getContactPhoto' });
    }

    // A RAW request resolves for EVERY status code: the SDK's
    // `GraphResponseHandler.getResponse` returns the raw `Response` for
    // `ResponseType.RAW` BEFORE it inspects `response.ok`. So a 404 ImageNotFound,
    // a 401 for a revoked grant and a 429/5xx all arrive here as a *resolved*
    // response whose Buffer is the Graph error JSON. The status has to be checked
    // explicitly, or the error body is handed back as a
    // `data:application/json;base64,...` URI - which is precisely how the module
    // this replaces made a revoked account look like "no avatar", and it also
    // means the provider's retry policy never sees the failure.
    const status = typeof response?.status === 'number' ? response.status : 200;

    if (status >= 400) {
      const failure = parseGraphErrorBody(response?.buffer);

      // The ONE documented absence: 404 + ImageNotFound. A 404 `itemNotFound`
      // (missing contact) is NOT an ImageNotFound and falls through to a throw.
      if (status === 404 && isImageNotFoundCode(failure.code)) return null;

      throw apiError(
        failure.code ?? GraphErrorCode.GRAPH_REQUEST_FAILED,
        failure.message ?? `Microsoft Graph returned ${status} for the contact photo`,
        {
          status,
          operation: 'getContactPhoto',
          graphCode: failure.code,
          contactId: String(contactId),
        },
      );
    }

    if (!response || !response.buffer || response.buffer.length === 0) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned an empty contact photo payload',
        { operation: 'getContactPhoto', contactId: String(contactId) },
      );
    }

    const rawContentType = response.contentType
      || response.headers?.['content-type']
      || 'image/jpeg';
    const contentType = String(rawContentType).split(';')[0].trim() || 'image/jpeg';

    return `data:${contentType};base64,${response.buffer.toString('base64')}`;
  }

  /** The shared contact-collection read: build the request, then page or drain. */
  private async readContactPage(
    userId: string,
    path: string,
    options: IAzureContactListOptions,
    operation: string,
  ): Promise<IAzureContactPage> {
    const requestOptions: IGraphProviderOptions = {
      select: options.select ?? DEFAULT_CONTACT_SELECT,
      top: pageSize(options.top),
      operation,
    };

    // Continue from a previous page's `@odata.nextLink`. The URL already carries
    // `$filter` / `$skip` / `$skiptoken`, so no query option may be re-applied to
    // it (see IGraphProviderOptions.url) - `select` and `top` are dropped here for
    // that reason. Paging by cursor is stable under concurrent edits, unlike $skip.
    const nextLink = typeof options.nextLink === 'string' && options.nextLink.trim().length > 0
      ? options.nextLink.trim()
      : undefined;

    if (nextLink) return this.readFollowUpPage(userId, nextLink, operation);

    if (options.filter) requestOptions.filter = options.filter;
    if (options.orderBy) requestOptions.orderBy = options.orderBy;
    // `skip` is an offset into a single page; an all-pages read starts at the top.
    if (options.all !== true && typeof options.skip === 'number'
      && Number.isFinite(options.skip) && options.skip > 0) {
      requestOptions.skip = Math.trunc(options.skip);
    }
    // `$count` is a total-for-the-first-page concern: an all-pages read returns
    // `{ items }` only, so it is genuinely not sent (see IAzureContactListOptions).
    if (options.all !== true && options.count === true) requestOptions.count = true;

    if (options.all === true) {
      const all = await this.graphClientProvider.requestAll<any>(userId, path, {
        ...requestOptions,
        ...(typeof options.maxPages === 'number' ? { maxPages: options.maxPages } : {}),
      });

      return { items: (Array.isArray(all) ? all : []).map(normaliseContact) };
    }

    const page = await this.graphClientProvider.request<IGraphCollection<any>>(
      userId,
      path,
      requestOptions,
    );

    const result: IAzureContactPage = {
      items: Array.isArray(page?.value) ? page.value.map(normaliseContact) : [],
    };

    if (typeof page?.['@odata.nextLink'] === 'string') result.nextLink = page['@odata.nextLink'];
    if (typeof page?.['@odata.count'] === 'number') result.count = page['@odata.count'];

    return result;
  }

  /**
   * Follow one `@odata.nextLink` cursor returned by a previous contact page.
   *
   * The URL is requested verbatim: it already carries `$filter`, `$skip` and the
   * `$skiptoken` cursor, so re-applying any option would reset it (see
   * `IGraphProviderOptions.url`). Cursor paging is stable under concurrent edits,
   * unlike a `$skip` offset.
   */
  private async readFollowUpPage(
    userId: string,
    nextLink: string,
    operation: string,
  ): Promise<IAzureContactPage> {
    const page = await this.graphClientProvider.request<IGraphCollection<any>>(
      userId,
      nextLink,
      { url: nextLink, operation },
    );

    const result: IAzureContactPage = {
      items: Array.isArray(page?.value) ? page.value.map(normaliseContact) : [],
    };

    if (typeof page?.['@odata.nextLink'] === 'string') result.nextLink = page['@odata.nextLink'];
    if (typeof page?.['@odata.count'] === 'number') result.count = page['@odata.count'];

    return result;
  }

  /** Run the directory gate; an unavailable auth service is not treated as a denial. */
  private async assertDirectoryScope(userId: string): Promise<void> {
    const auth = this.authService;
    if (!auth || typeof auth.getGrantedScopes !== 'function') return;

    let granted: string[];
    try {
      granted = await auth.getGrantedScopes(userId);
    } catch {
      // A grant lookup failure must not become a scope denial: the provider will
      // surface the real credential error when the request runs.
      return;
    }

    assertDirectoryScopes(String(userId), granted);
  }

  /**
   * Project a caller payload onto the properties Graph accepts.
   *
   * @param requireOne - reject an empty payload (create needs content; an empty
   * PATCH would be a no-op request and is rejected locally too)
   */
  private buildContactPayload(input: IAzureContactInput, requireOne: boolean): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `A contact ${requireOne ? 'create' : 'update'} payload is required`,
      );
    }

    const payload: Record<string, unknown> = {};

    for (const property of CONTACT_WRITE_PROPERTIES) {
      const value = (input as any)[property];
      if (value === undefined || value === null) continue;

      if (property === 'emailAddresses') {
        const addresses = normaliseEmailAddressList(value);
        if (addresses.length > 0) payload.emailAddresses = addresses;
        continue;
      }

      if (property === 'businessPhones' || property === 'homePhones' || property === 'categories') {
        const values = normaliseStringArray(value);
        if (values.length > 0) payload[property] = values;
        continue;
      }

      if (typeof value === 'string') {
        if (value.length > 0) payload[property] = value;
        continue;
      }

      // Every remaining property is a Graph scalar string. A non-string value is
      // dropped rather than forwarded: Graph answers a type error with an opaque
      // 400 that does not name the offending member.
    }
    if (Object.keys(payload).length === 0) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `A contact ${requireOne ? 'create' : 'update'} payload requires at least one supported property`,
        { supportedProperties: [...CONTACT_WRITE_PROPERTIES] },
      );
    }

    return payload;
  }

  /** A write must return a real contact, never a synthetic one. */
  private requireContactResult(value: any, operation: string): IAzureContact {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id === '') {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Microsoft Graph returned no contact body for ${operation}`,
        { operation },
      );
    }

    return normaliseContact(value);
  }

  /** A path segment must be a non-empty string before it reaches Graph. */
  private requireId(value: string, label: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `A ${label} is required`,
      );
    }
  }
}

/**
 * True when `code` is Graph's documented "this contact has no photo" answer.
 *
 * Only the `ImageNotFound` code qualifies. A 404 `itemNotFound` (the contact
 * itself is missing) is deliberately **not** an ImageNotFound and therefore
 * throws.
 */
function isImageNotFoundCode(code: unknown): boolean {
  return typeof code === 'string' && code.trim().toLowerCase() === 'imagenotfound';
}

/**
 * True when a *thrown* error is Graph's documented "no photo" answer.
 *
 * The provider preserves the Graph code as both `code` and `graphCode`; either is
 * accepted. This covers the transport-rejection path; the ordinary path is a
 * resolved non-2xx RAW response, see {@link parseGraphErrorBody}.
 */
function isImageNotFound(error: any): boolean {
  if (!error) return false;
  return isImageNotFoundCode(error.graphCode ?? error.code);
}

/**
 * Read `error.code` / `error.message` out of a Graph error body.
 *
 * A RAW Graph request resolves for every status code: the SDK's
 * `GraphResponseHandler.getResponse` returns the raw `Response` for
 * `ResponseType.RAW` *before* it inspects `response.ok`, so a failed call arrives
 * as a resolved response whose Buffer holds the standard Graph envelope:
 *
 *     { "error": { "code": "InvalidAuthenticationToken", "message": "..." } }
 *
 * A body that is not JSON, or that has no `error` member, yields `{}` and the
 * caller falls back to a generic `GraphRequestFailed`.
 */
function parseGraphErrorBody(buffer?: Buffer): { code?: string; message?: string } {
  if (!buffer || buffer.length === 0) return {};

  let parsed: any;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    return {};
  }

  const error = parsed?.error ?? parsed;
  const result: { code?: string; message?: string } = {};

  if (typeof error?.code === 'string' && error.code.length > 0) result.code = error.code;
  if (typeof error?.message === 'string' && error.message.length > 0) result.message = error.message;

  return result;
}

export const AzureContactsServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureContactsService> = {
  service: (props: any, context: any) => new AzureContactsService(props, context),
  id: 'azure.AzureContactsService@1.0.0',
  name: 'AzureContactsService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph contacts, contact folders, people search and organisation directory',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
    { id: 'azure.AzureAuthService@1.0.0', alias: 'authService' },
  ],
};

export { AzureContactsService };

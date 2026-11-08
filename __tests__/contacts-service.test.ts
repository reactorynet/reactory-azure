import fs from 'fs';
import path from 'path';
import { buildSchema, GraphQLInputObjectType, GraphQLObjectType } from 'graphql';
import ApiError, { InsufficientPermissions } from '@reactory/server-core/exceptions';

/**
 * Behavioural suite for AzureContactsService (AZ-11).
 *
 * No tenant and no network:
 *
 *   - the Graph provider is a fake, so the suite asserts the service's own
 *     contract - normalisation, path construction, paging and the error contract;
 *   - the directory scope gate is exercised against the REAL AzureAuthService
 *     with `models/AzureToken` mocked, so the granted scopes genuinely come from a
 *     fake AzureToken record (the same seam `auth-service.test.ts` uses). That is
 *     what proves the `['legacy:unverified']` sentinel is not mistaken for an
 *     insufficient grant.
 */
jest.mock('../models/AzureToken', () => {
  const AzureToken = {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };

  return { __esModule: true, AzureToken, default: AzureToken };
});

// eslint-disable-next-line import/first
import { AzureToken } from '../models/AzureToken';
// eslint-disable-next-line import/first
import { AzureAuthService } from '../services/AzureAuthService';
// eslint-disable-next-line import/first
import {
  AzureContactsService,
  AzureContactsServiceDefinition,
  assertDirectoryScopes,
} from '../services/AzureContactsService';
// eslint-disable-next-line import/first
import ContactsResolver from '../graphql/resolvers/ContactsResolver';
// eslint-disable-next-line import/first
import { apiError, GraphErrorCode } from '../utils/graph-error';
// eslint-disable-next-line import/first
import { LEGACY_SCOPE_UNVERIFIED } from '../types/azure.types';
// eslint-disable-next-line import/first
import {
  CONTACTS_INSUFFICIENT_SCOPE,
  DEFAULT_CONTACT_SELECT,
  DEFAULT_CONTACTS_PAGE_SIZE,
  DEFAULT_DIRECTORY_USER_SELECT,
  DEFAULT_PEOPLE_SELECT,
} from '../types/contacts.types';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const NEXT_LINK = 'https://graph.microsoft.com/v1.0/me/contacts?$skiptoken=page-2';

const model = AzureToken as unknown as {
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
};

/** A Graph-shaped contact. */
function contactRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contact-1',
    displayName: 'Ada Lovelace',
    givenName: 'Ada',
    surname: 'Lovelace',
    emailAddresses: [{ name: 'Ada', address: 'ada@example.test' }],
    businessPhones: ['+27 11 555 0100'],
    mobilePhone: '+27 82 555 0100',
    companyName: 'Analytical Engines',
    jobTitle: 'Mathematician',
    ...overrides,
  };
}

/** A Graph-shaped /me/people result. */
function personRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'person-1',
    displayName: 'Grace Hopper',
    givenName: 'Grace',
    surname: 'Hopper',
    companyName: 'US Navy',
    jobTitle: 'Rear Admiral',
    department: 'Computation',
    personType: { class: 'Person', subclass: 'organizationUser' },
    emailAddresses: [{ name: 'Grace', address: 'grace@example.test' }],
    scoredEmailAddresses: [
      { name: 'Grace', address: 'grace@example.test', relevanceScore: 12.5 },
    ],
    ...overrides,
  };
}

/** A Graph-shaped directory user. */
function directoryUserRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    displayName: 'Alan Turing',
    givenName: 'Alan',
    surname: 'Turing',
    mail: 'alan@example.test',
    userPrincipalName: 'alan@example.test',
    businessPhones: ['+44 20 7946 0000'],
    ...overrides,
  };
}

interface IFakes {
  service: AzureContactsService;
  provider: any;
  chain: any;
}

/** A fake provider plus the write chain returned by its `getClient`. */
function createFakes(): IFakes {
  const chain: any = {
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  };
  chain.api = jest.fn(() => chain);

  const provider: any = {
    request: jest.fn(),
    requestAll: jest.fn(),
    requestRaw: jest.fn(),
    getClient: jest.fn(() => chain),
  };

  const context: any = { getService: jest.fn(() => undefined) };
  const service = new AzureContactsService({} as any, context);
  service.setGraphClientProvider(provider);

  return { service, provider, chain };
}

/** The real auth service, with its Mongo model and legacy bridge faked. */
function createAuthService(legacyAccessToken?: string) {
  const context: any = { getService: jest.fn(() => undefined) };
  const auth = new AzureAuthService({} as any, context);

  auth.setRedisService({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  });
  auth.setUserService({
    findUserById: jest.fn().mockResolvedValue(
      legacyAccessToken
        ? {
          getAuthentication: (provider: string) => (
            provider === 'microsoft' ? { props: { accessToken: legacyAccessToken } } : null
          ),
        }
        : null,
    ),
  });

  return auth;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AzureContactsService — listContacts paging', () => {
  it('returns the first page with its nextLink and the mandated projection', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValue({
      value: [contactRecord()],
      '@odata.nextLink': NEXT_LINK,
      '@odata.count': 41,
    });

    const page = await service.listContacts(USER_ID, { top: 10, count: true });

    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      '/me/contacts',
      expect.objectContaining({ top: 10, select: DEFAULT_CONTACT_SELECT, count: true }),
    );

    // Requirement 1: the projection carries every mandated property.
    for (const property of [
      'displayName',
      'emailAddresses',
      'businessPhones',
      'mobilePhone',
      'companyName',
      'jobTitle',
    ]) {
      expect(DEFAULT_CONTACT_SELECT).toContain(property);
    }

    expect(page.items).toHaveLength(1);
    expect(page.nextLink).toBe(NEXT_LINK);
    expect(page.count).toBe(41);
    expect(page.items[0]).toMatchObject({
      id: 'contact-1',
      displayName: 'Ada Lovelace',
      emailAddresses: [{ name: 'Ada', address: 'ada@example.test' }],
      businessPhones: ['+27 11 555 0100'],
      mobilePhone: '+27 82 555 0100',
      companyName: 'Analytical Engines',
      jobTitle: 'Mathematician',
    });
  });

  it('drains every page when options.all is set, bounded by maxPages', async () => {
    const { service, provider } = createFakes();

    provider.requestAll.mockResolvedValue([
      contactRecord(),
      contactRecord({ id: 'contact-2', displayName: 'Charles Babbage' }),
    ]);

    const page = await service.listContacts(USER_ID, { all: true, maxPages: 3 });

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      '/me/contacts',
      expect.objectContaining({ maxPages: 3, select: DEFAULT_CONTACT_SELECT }),
    );
    expect(page.items.map((item) => item.id)).toEqual(['contact-1', 'contact-2']);
    expect(page.nextLink).toBeUndefined();
    expect(provider.request).not.toHaveBeenCalled();
  });

  it('defaults the page size, forwards $skip/$filter and tolerates sparse records', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValue({
      value: [{ id: 'contact-3', displayName: 'No details' }],
    });

    const page = await service.listContacts(USER_ID, {
      skip: 20,
      filter: "companyName eq 'Analytical Engines'",
    });

    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      '/me/contacts',
      expect.objectContaining({
        top: DEFAULT_CONTACTS_PAGE_SIZE,
        skip: 20,
        filter: "companyName eq 'Analytical Engines'",
      }),
    );

    // Missing collections are normalised to empty arrays, never left undefined.
    expect(page.items[0].emailAddresses).toEqual([]);
    expect(page.items[0].businessPhones).toEqual([]);
  });

  it('reads a single contact and a folder-scoped page from the right paths', async () => {
    const { service, provider } = createFakes();

    provider.request
      .mockResolvedValueOnce(contactRecord())
      .mockResolvedValueOnce({ value: [contactRecord()], '@odata.nextLink': NEXT_LINK });

    const contact = await service.getContact(USER_ID, 'contact-1');
    const page = await service.listContactsInFolder(USER_ID, 'folder-9', { top: 5 });

    expect(provider.request.mock.calls[0][1]).toBe('/me/contacts/contact-1');
    expect(provider.request.mock.calls[1][1]).toBe('/me/contactFolders/folder-9/contacts');
    expect(contact.id).toBe('contact-1');
    expect(page.nextLink).toBe(NEXT_LINK);
  });

  it('follows a contact nextLink cursor verbatim and ignores every other option', async () => {
    const { service, provider } = createFakes();
    const cursor = 'https://graph.microsoft.com/v1.0/me/contacts?$skiptoken=c2';

    provider.request.mockResolvedValue({
      value: [contactRecord({ id: 'contact-9' })],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/contacts?$skiptoken=c3',
      '@odata.count': 12,
    });

    const page = await service.listContacts(USER_ID, {
      nextLink: cursor,
      top: 10,
      filter: "displayName eq 'ignored'",
      count: true,
    });

    // The cursor URL carries $filter/$skip/$skiptoken already: it is requested
    // verbatim, with no option re-applied (which would reset the cursor).
    expect(provider.request).toHaveBeenCalledWith(USER_ID, cursor, {
      url: cursor,
      operation: 'listContacts',
    });

    expect(page.items[0].id).toBe('contact-9');
    expect(page.nextLink).toBe('https://graph.microsoft.com/v1.0/me/contacts?$skiptoken=c3');
    expect(page.count).toBe(12);
  });

  it('does not send $count or $skip on an all-pages read, matching the documented contract', async () => {
    const { service, provider } = createFakes();
    provider.requestAll.mockResolvedValue([contactRecord()]);

    await service.listContacts(USER_ID, { all: true, count: true, skip: 10 });

    const [, , options] = provider.requestAll.mock.calls[0];
    expect(options.count).toBeUndefined();
    expect(options.skip).toBeUndefined();
  });

  it('lists contact folders through the bounded requestAll', async () => {
    const { service, provider } = createFakes();

    provider.requestAll.mockResolvedValue([
      { id: 'folder-1', displayName: 'Contacts', parentFolderId: 'root' },
    ]);

    const folders = await service.listContactFolders(USER_ID);

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      '/me/contactFolders',
      expect.objectContaining({ operation: 'listContactFolders' }),
    );
    expect(folders).toEqual([
      { id: 'folder-1', displayName: 'Contacts', parentFolderId: 'root' },
    ]);
  });
});

describe('AzureContactsService — searchPeople', () => {
  it('uses $search, never an OData $filter on displayName, and sends no $skip', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValue({ value: [personRecord()], '@odata.nextLink': NEXT_LINK });

    // `skip` is supplied deliberately: the service must drop it, because Graph
    // rejects `$search` + `$skip` with ErrorInvalidRequest.
    const page = await service.searchPeople(USER_ID, 'grace hopper', { top: 5, skip: 40 } as any);

    expect(provider.request).toHaveBeenCalledTimes(1);
    const [requestedUserId, requestedPath, requestOptions] = provider.request.mock.calls[0];

    expect(requestedUserId).toBe(USER_ID);
    expect(requestedPath).toBe('/me/people');
    expect(requestOptions.search).toBe('grace hopper');
    expect(requestOptions.filter).toBeUndefined();
    expect(requestOptions.skip).toBeUndefined();
    expect(requestOptions.top).toBe(5);
    expect(requestOptions.select).toBe(DEFAULT_PEOPLE_SELECT);
    // $search needs ConsistencyLevel: eventual on the request.
    expect(requestOptions.headers).toEqual({ ConsistencyLevel: 'eventual' });

    expect(page.nextLink).toBe(NEXT_LINK);
    expect(page.items[0]).toMatchObject({
      id: 'person-1',
      displayName: 'Grace Hopper',
      personType: 'organizationUser',
      scoredEmailAddresses: [
        { name: 'Grace', address: 'grace@example.test', relevanceScore: 12.5 },
      ],
    });
  });

  it('pages only by passing a nextLink back, with no query options re-applied', async () => {
    const { service, provider } = createFakes();

    const peopleNextLink = 'https://graph.microsoft.com/v1.0/me/people?$search=%22grace%22&$skiptoken=p2';
    provider.request.mockResolvedValue({ value: [personRecord({ id: 'person-2' })] });

    const page = await service.searchPeople(USER_ID, 'grace', { nextLink: peopleNextLink });

    const [requestedUserId, requestedPath, requestOptions] = provider.request.mock.calls[0];
    expect(requestedUserId).toBe(USER_ID);
    expect(requestedPath).toBe(peopleNextLink);
    expect(requestOptions.url).toBe(peopleNextLink);
    // The URL already carries the search and cursor; adding $skip would break it.
    expect(requestOptions.skip).toBeUndefined();
    expect(requestOptions.search).toBeUndefined();
    // ...but ConsistencyLevel is a HEADER, and $search requires it on EVERY page.
    // Dropping it here made page 2+ of a people search fail with ErrorInvalidRequest.
    expect(requestOptions.headers).toEqual({ ConsistencyLevel: 'eventual' });
    expect(page.items[0].id).toBe('person-2');
    expect(page.nextLink).toBeUndefined();
  });

  it('drains all pages for an `all` search, keeping ConsistencyLevel on every page', async () => {
    const { service, provider } = createFakes();

    provider.requestAll.mockResolvedValue([personRecord(), personRecord({ id: 'person-2' })]);

    const page = await service.searchPeople(USER_ID, 'grace', { all: true, maxPages: 2 });

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      '/me/people',
      expect.objectContaining({
        search: 'grace',
        headers: { ConsistencyLevel: 'eventual' },
        maxPages: 2,
      }),
    );
    expect(page.items).toHaveLength(2);
  });

  it('rejects an empty query instead of issuing a meaningless $search', async () => {
    const { service, provider } = createFakes();

    await expect(service.searchPeople(USER_ID, '   ')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });
    expect(provider.request).not.toHaveBeenCalled();
  });

  it('normalises a plain-string personType and survives missing collections', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValue({
      value: [
        // `personType` as a bare string (not the usual { class, subclass } pair).
        {
          id: 'person-3',
          displayName: 'Katherine Johnson',
          personType: 'person',
          // emailAddresses / scoredEmailAddresses deliberately absent.
        },
      ],
    });

    const page = await service.searchPeople(USER_ID, 'katherine');

    expect(page.items[0].personType).toBe('person');
    // Absent collections normalise to empty arrays, never undefined.
    expect(page.items[0].emailAddresses).toEqual([]);
    expect(page.items[0].scoredEmailAddresses).toEqual([]);
  });

  it('keeps only the address entries that carry a name or an address', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValue({
      value: [{
        id: 'person-4',
        displayName: 'Mixed',
        emailAddresses: [{}, { name: 'Only Name' }, { address: 'only@example.test' }],
        // A scored entry with no address is dropped; one without a score keeps no
        // relevanceScore property at all.
        scoredEmailAddresses: [{}, { address: 'scored@example.test' }],
      }],
    });

    const page = await service.searchPeople(USER_ID, 'mixed');
    const [person] = page.items;

    expect(person.emailAddresses).toEqual([
      { name: 'Only Name' },
      { address: 'only@example.test' },
    ]);
    expect(person.scoredEmailAddresses).toEqual([{ address: 'scored@example.test' }]);
    expect(person.scoredEmailAddresses[0].relevanceScore).toBeUndefined();
  });
});

describe('AzureContactsService — getContactPhoto (real RAW contract)', () => {
  const PHOTO_PATH = '/me/contacts/contact-1/photo/$value';

  /**
   * The shape a RAW Graph request ACTUALLY resolves with on a failure.
   *
   * `GraphResponseHandler.getResponse` returns the raw `Response` for
   * `ResponseType.RAW` *before* it inspects `response.ok` (SDK 3.0.7, line 201),
   * so a 404/401/429/5xx RESOLVES with the Graph error JSON in `buffer` - it does
   * not reject. Mocking a rejection here would assert a provider contract that the
   * provider does not implement, which is why these fakes reproduce the resolved
   * shape instead.
   */
  function graphErrorResponse(status: number, code: string, message = 'Graph error') {
    return {
      status,
      ok: false,
      headers: { 'content-type': 'application/json' },
      contentType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ error: { code, message } })),
    };
  }

  it('returns a data URI carrying the response content type', async () => {
    const { service, provider } = createFakes();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    provider.requestRaw.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      contentType: 'image/jpeg',
      buffer: bytes,
    });

    const uri = await service.getContactPhoto(USER_ID, 'contact-1');

    expect(provider.requestRaw).toHaveBeenCalledWith(
      USER_ID,
      PHOTO_PATH,
      expect.objectContaining({ operation: 'getContactPhoto' }),
    );
    expect(uri).toBe(`data:image/jpeg;base64,${bytes.toString('base64')}`);
  });

  it('returns null for a RESOLVED 404 ImageNotFound - the documented absence', async () => {
    const { service, provider } = createFakes();

    provider.requestRaw.mockResolvedValue(
      graphErrorResponse(404, 'ImageNotFound', 'Image not found'),
    );

    await expect(service.getContactPhoto(USER_ID, 'contact-1')).resolves.toBeNull();
  });

  it('THROWS for a RESOLVED 401 instead of returning the error body as an image', async () => {
    const { service, provider } = createFakes();

    provider.requestRaw.mockResolvedValue(
      graphErrorResponse(401, 'InvalidAuthenticationToken', 'Access token has expired'),
    );

    let caught: any;
    try {
      const uri = await service.getContactPhoto(USER_ID, 'contact-1');
      // A data URI here is exactly the defect this test exists to catch: the
      // revoked-grant error body would be served to the client as an avatar.
      throw new Error(`expected a throw, but resolved with ${uri}`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe(GraphErrorCode.INVALID_AUTHENTICATION_TOKEN);
    expect(caught.code).toBe('InvalidAuthenticationToken');
    expect(caught.status).toBe(401);
    expect(caught.operation).toBe('getContactPhoto');
  });

  it('throws for a RESOLVED 500 and a RESOLVED 429, never returning a data URI', async () => {
    for (const status of [500, 429]) {
      jest.clearAllMocks();
      const { service, provider } = createFakes();

      provider.requestRaw.mockResolvedValue(
        graphErrorResponse(status, 'serviceNotAvailable', 'Try again later'),
      );

      let caught: any;
      try {
        const uri = await service.getContactPhoto(USER_ID, 'contact-1');
        throw new Error(`expected a throw for ${status}, but resolved with ${uri}`);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ApiError);
      expect(caught.code).toBe('serviceNotAvailable');
      expect(caught.status).toBe(status);
    }
  });

  it('throws for a RESOLVED 404 itemNotFound - the contact itself is missing', async () => {
    const { service, provider } = createFakes();

    provider.requestRaw.mockResolvedValue(
      graphErrorResponse(404, 'itemNotFound', 'Contact not found'),
    );

    await expect(service.getContactPhoto(USER_ID, 'contact-1')).rejects.toMatchObject({
      code: 'itemNotFound',
      status: 404,
    });
  });

  it('falls back to GraphRequestFailed for a non-JSON and for an empty error body', async () => {
    const { service, provider } = createFakes();

    provider.requestRaw.mockResolvedValueOnce({
      status: 502,
      headers: { 'content-type': 'text/html' },
      contentType: 'text/html',
      buffer: Buffer.from('<html>bad gateway</html>'),
    });

    await expect(service.getContactPhoto(USER_ID, 'contact-1')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
      status: 502,
    });

    provider.requestRaw.mockResolvedValueOnce({
      status: 401,
      headers: {},
      contentType: undefined,
      buffer: Buffer.alloc(0),
    });

    await expect(service.getContactPhoto(USER_ID, 'contact-1')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
      status: 401,
    });
  });

  it('still translates a genuine transport rejection (thrown, not resolved)', async () => {
    const { service, provider } = createFakes();

    provider.requestRaw.mockRejectedValueOnce(
      apiError('ImageNotFound', 'Image not found', { status: 404 }),
    );
    await expect(service.getContactPhoto(USER_ID, 'contact-1')).resolves.toBeNull();

    provider.requestRaw.mockRejectedValueOnce(
      apiError(GraphErrorCode.INVALID_AUTHENTICATION_TOKEN, 'expired', { status: 401 }),
    );
    await expect(service.getContactPhoto(USER_ID, 'contact-1')).rejects.toMatchObject({
      code: GraphErrorCode.INVALID_AUTHENTICATION_TOKEN,
    });
  });

  it('throws for a 2xx with no bytes, and defaults the content type to image/jpeg', async () => {
    const { service, provider } = createFakes();

    provider.requestRaw.mockResolvedValueOnce({
      status: 200,
      headers: {},
      contentType: undefined,
      buffer: Buffer.alloc(0),
    });

    await expect(service.getContactPhoto(USER_ID, 'contact-1')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });

    const bytes = Buffer.from([1, 2, 3]);
    provider.requestRaw.mockResolvedValueOnce({
      status: 200,
      headers: {},
      contentType: undefined,
      buffer: bytes,
    });

    await expect(service.getContactPhoto(USER_ID, 'contact-1'))
      .resolves.toBe(`data:image/jpeg;base64,${bytes.toString('base64')}`);
  });

  it('strips content-type parameters from the data URI', async () => {
    const { service, provider } = createFakes();
    const bytes = Buffer.from([9, 8, 7]);

    provider.requestRaw.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/png; charset=binary' },
      contentType: 'image/png; charset=binary',
      buffer: bytes,
    });

    await expect(service.getContactPhoto(USER_ID, 'contact-1'))
      .resolves.toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  });
});

describe('AzureContactsService — listDirectoryUsers scope gate', () => {
  it('throws an insufficient-scope ApiError when a recorded grant has no User.Read* scope', async () => {
    const { service, provider } = createFakes();
    const auth = createAuthService();
    service.setAuthService(auth);

    // A fake AzureToken record: no network, no tenant, just the stored grant.
    model.findOne.mockResolvedValue({
      userId: USER_ID,
      grantedScopes: ['Contacts.ReadWrite', 'People.Read'],
      revokedAt: undefined,
    });

    let caught: any;
    try {
      await service.listDirectoryUsers(USER_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe(CONTACTS_INSUFFICIENT_SCOPE);
    expect(caught.message).toContain('User.ReadBasic.All');
    expect(caught.message).toContain('User.Read.All');
    expect(caught.grantedScopes).toEqual(['Contacts.ReadWrite', 'People.Read']);
    expect(caught.requiredScopes).toEqual(['User.ReadBasic.All', 'User.Read.All']);

    // The decisive assertion: the gate refuses BEFORE any Graph request.
    expect(provider.request).not.toHaveBeenCalled();
    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it("does NOT gate on ['legacy:unverified'] — it attempts the call", async () => {
    const { service, provider } = createFakes();
    // No vault record + a legacy User-document token => getGrantedScopes returns
    // exactly ['legacy:unverified'].
    const auth = createAuthService('legacy-access-token');
    service.setAuthService(auth);

    model.findOne.mockResolvedValue(null);
    provider.request.mockResolvedValue({ value: [directoryUserRecord()] });

    await expect(auth.getGrantedScopes(USER_ID)).resolves.toEqual([LEGACY_SCOPE_UNVERIFIED]);

    const page = await service.listDirectoryUsers(USER_ID, { filter: "accountEnabled eq true" });

    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      '/users',
      expect.objectContaining({
        select: DEFAULT_DIRECTORY_USER_SELECT,
        filter: 'accountEnabled eq true',
        top: DEFAULT_CONTACTS_PAGE_SIZE,
      }),
    );
    expect(page.items[0]).toMatchObject({ id: 'user-1', displayName: 'Alan Turing' });
  });

  it('attempts the call when the grant contains User.ReadBasic.All or User.Read.All', async () => {
    for (const scope of ['User.ReadBasic.All', 'User.Read.All', 'User.Read']) {
      jest.clearAllMocks();
      const { service, provider } = createFakes();
      const auth = createAuthService();
      service.setAuthService(auth);

      model.findOne.mockResolvedValue({ grantedScopes: [scope], revokedAt: undefined });
      provider.request.mockResolvedValue({ value: [] });

      await expect(service.listDirectoryUsers(USER_ID)).resolves.toEqual({ items: [] });
      expect(provider.request).toHaveBeenCalledTimes(1);
    }
  });

  it('pages and normalises directory users, and never sends $skip with an all-pages read', async () => {
    const { service, provider } = createFakes();
    const auth = createAuthService();
    service.setAuthService(auth);
    model.findOne.mockResolvedValue({ grantedScopes: ['User.Read.All'], revokedAt: undefined });

    provider.requestAll.mockResolvedValue([directoryUserRecord({ jobTitle: 'Cryptanalyst' })]);

    const page = await service.listDirectoryUsers(USER_ID, {
      all: true,
      orderBy: 'displayName',
      skip: 10,
    });

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      '/users',
      expect.objectContaining({ orderBy: 'displayName', select: DEFAULT_DIRECTORY_USER_SELECT }),
    );
    // An all-pages read starts at the top: the per-page offset is dropped.
    expect(provider.requestAll.mock.calls[0][2].skip).toBeUndefined();
    expect(page.items[0].jobTitle).toBe('Cryptanalyst');
    expect(page.items[0].businessPhones).toEqual(['+44 20 7946 0000']);
  });

  it('forwards $filter/$skip on a single-page directory read and exposes the cursor', async () => {
    const { service, provider } = createFakes();
    const auth = createAuthService();
    service.setAuthService(auth);
    model.findOne.mockResolvedValue({ grantedScopes: ['User.ReadBasic.All'], revokedAt: undefined });

    provider.request.mockResolvedValue({
      value: [directoryUserRecord()],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=u2',
      '@odata.count': 7,
    });

    const page = await service.listDirectoryUsers(USER_ID, { skip: 5, top: 3, count: true });

    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      '/users',
      expect.objectContaining({ skip: 5, top: 3, count: true }),
    );
    expect(page.nextLink).toBe('https://graph.microsoft.com/v1.0/users?$skiptoken=u2');
    expect(page.count).toBe(7);
  });

  it('stands the gate aside when no auth service is registered', async () => {
    // createFakes() wires no auth service and its context returns undefined, so the
    // grant is unknown - the call is attempted rather than refused.
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ value: [directoryUserRecord()] });

    const page = await service.listDirectoryUsers(USER_ID);

    expect(provider.request).toHaveBeenCalledWith(USER_ID, '/users', expect.anything());
    expect(page.items).toHaveLength(1);
  });

  it('stands the gate aside when the auth service has no getGrantedScopes', async () => {
    const { service, provider } = createFakes();
    service.setAuthService({});
    provider.request.mockResolvedValue({ value: [] });

    await expect(service.listDirectoryUsers(USER_ID)).resolves.toEqual({ items: [] });
    expect(provider.request).toHaveBeenCalledTimes(1);
  });

  it('stands the gate aside when the grant lookup itself fails', async () => {
    const { service, provider } = createFakes();
    service.setAuthService({
      getGrantedScopes: jest.fn().mockRejectedValue(new Error('vault unavailable')),
    });
    provider.request.mockResolvedValue({ value: [] });

    // A lookup failure must not be reported as a scope denial: the provider gets
    // the chance to report the real credential error.
    await expect(service.listDirectoryUsers(USER_ID)).resolves.toEqual({ items: [] });
    expect(provider.request).toHaveBeenCalledTimes(1);
  });

  it('assertDirectoryScopes documents the empty-grant and sentinel cases', () => {
    // Empty grant: nothing recorded, so the provider decides (NotConnected/401).
    expect(() => assertDirectoryScopes(USER_ID, [])).not.toThrow();
    // Legacy sentinel: unverifiable, never insufficient.
    expect(() => assertDirectoryScopes(USER_ID, [LEGACY_SCOPE_UNVERIFIED])).not.toThrow();
    // A non-empty grant with no User.Read* scope is the one case that throws.
    expect(() => assertDirectoryScopes(USER_ID, ['Mail.Read'])).toThrow(ApiError);
  });
});

describe('AzureContactsService — writes', () => {
  it('creates, updates and deletes through the provider client', async () => {
    const { service, chain } = createFakes();

    chain.post.mockResolvedValue(contactRecord({ id: 'contact-new' }));
    chain.patch.mockResolvedValue(contactRecord({ displayName: 'Ada Byron' }));
    chain.delete.mockResolvedValue(undefined);

    const created = await service.createContact(USER_ID, {
      displayName: 'Ada Lovelace',
      emailAddresses: [{ name: 'Ada', address: 'ada@example.test' }],
    });
    const updated = await service.updateContact(USER_ID, 'contact-new', { displayName: 'Ada Byron' });
    await service.deleteContact(USER_ID, 'contact-new');

    expect(chain.api).toHaveBeenNthCalledWith(1, '/me/contacts');
    expect(chain.post).toHaveBeenCalledWith({
      displayName: 'Ada Lovelace',
      emailAddresses: [{ name: 'Ada', address: 'ada@example.test' }],
    });

    expect(chain.api).toHaveBeenNthCalledWith(2, '/me/contacts/contact-new');
    expect(chain.patch).toHaveBeenCalledWith({ displayName: 'Ada Byron' });

    expect(chain.api).toHaveBeenNthCalledWith(3, '/me/contacts/contact-new');
    expect(chain.delete).toHaveBeenCalledTimes(1);

    expect(created.id).toBe('contact-new');
    expect(updated.displayName).toBe('Ada Byron');
  });

  it('rejects an empty payload locally and never calls Graph', async () => {
    const { service, chain } = createFakes();

    await expect(service.createContact(USER_ID, {} as any)).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });
    await expect(service.updateContact(USER_ID, 'contact-1', {} as any)).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });

    expect(chain.post).not.toHaveBeenCalled();
    expect(chain.patch).not.toHaveBeenCalled();
  });

  it('translates createContact and deleteContact failures with the Graph code', async () => {
    const { service, chain } = createFakes();

    chain.post.mockRejectedValue(
      apiError('ErrorInvalidRequest', 'Invalid contact', { status: 400 }),
    );
    await expect(service.createContact(USER_ID, { displayName: 'Ada' })).rejects.toMatchObject({
      code: 'ErrorInvalidRequest',
      status: 400,
    });

    chain.delete.mockRejectedValue(
      apiError('itemNotFound', 'Contact not found', { status: 404 }),
    );
    await expect(service.deleteContact(USER_ID, 'contact-1')).rejects.toMatchObject({
      code: 'itemNotFound',
      status: 404,
    });
  });

  it('rejects a write that returns no contact body instead of inventing one', async () => {
    const { service, chain } = createFakes();

    chain.post.mockResolvedValue(undefined);
    await expect(service.createContact(USER_ID, { displayName: 'Ada' })).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });

    chain.patch.mockResolvedValue({ displayName: 'No id' });
    await expect(
      service.updateContact(USER_ID, 'contact-1', { displayName: 'Ada' }),
    ).rejects.toMatchObject({ code: GraphErrorCode.GRAPH_REQUEST_FAILED, operation: 'updateContact' });
  });

  it('rejects a non-object payload and normalises the array properties', async () => {
    const { service, chain } = createFakes();

    const badInputs: any[] = [[], null, undefined, 'Ada'];
    for (const bad of badInputs) {
      await expect(service.createContact(USER_ID, bad as any)).rejects.toMatchObject({
        code: GraphErrorCode.GRAPH_REQUEST_FAILED,
      });
    }
    expect(chain.post).not.toHaveBeenCalled();

    chain.post.mockResolvedValue(contactRecord());
    await service.createContact(USER_ID, {
      displayName: 'Ada',
      mobilePhone: '',
      personalNotes: 'note',
      // Empty arrays and blank entries are dropped, not sent as-is.
      emailAddresses: [],
      businessPhones: ['+27 11 555 0100', ''],
      homePhones: ['+27 11 555 0101'],
      categories: ['Friends'],
    });

    expect(chain.post).toHaveBeenCalledWith({
      displayName: 'Ada',
      personalNotes: 'note',
      businessPhones: ['+27 11 555 0100'],
      homePhones: ['+27 11 555 0101'],
      categories: ['Friends'],
    });
  });

  it('drops a non-string scalar and an empty payload is still rejected', async () => {
    const { service, chain } = createFakes();

    // A non-string for a scalar property is dropped rather than forwarded, so a
    // payload made only of such values has nothing supported and is rejected.
    await expect(
      service.createContact(USER_ID, { displayName: 42, jobTitle: true } as any),
    ).rejects.toMatchObject({ code: GraphErrorCode.GRAPH_REQUEST_FAILED });
    expect(chain.post).not.toHaveBeenCalled();

    // Non-array values for the collection properties are treated as empty.
    chain.post.mockResolvedValue(contactRecord());
    await service.createContact(USER_ID, {
      displayName: 'Ada',
      emailAddresses: 'not-an-array' as any,
      businessPhones: 'not-an-array' as any,
    });

    expect(chain.post).toHaveBeenCalledWith({ displayName: 'Ada' });
  });

  it('translates a Graph write failure into an ApiError carrying the Graph code', async () => {
    const { service, chain } = createFakes();

    chain.patch.mockRejectedValue(
      apiError('ErrorInvalidRequest', 'Invalid contact property', { status: 400 }),
    );

    await expect(
      service.updateContact(USER_ID, 'contact-1', { displayName: 'Ada' }),
    ).rejects.toMatchObject({ code: 'ErrorInvalidRequest', status: 400 });
  });
});

describe('AzureContactsService — definition and argument guards', () => {
  it('rejects a blank id before it reaches Graph', async () => {
    const { service, provider } = createFakes();

    await expect(service.getContact(USER_ID, '')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });
    await expect(service.deleteContact(USER_ID, '   ')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });
    await expect(service.listContactsInFolder(USER_ID, '')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });
    await expect(service.getContactPhoto(USER_ID, '')).rejects.toMatchObject({
      code: GraphErrorCode.GRAPH_REQUEST_FAILED,
    });

    expect(provider.request).not.toHaveBeenCalled();
    expect(provider.requestRaw).not.toHaveBeenCalled();
  });

  it('stands the gate aside when context.getService itself throws', async () => {
    const { provider } = createFakes();
    const context: any = {
      getService: jest.fn(() => {
        throw new Error('container not ready');
      }),
    };

    const service = new AzureContactsService({} as any, context);
    service.setGraphClientProvider(provider);
    provider.request.mockResolvedValue({ value: [] });

    // An unavailable auth service is not a denial: the call is attempted.
    await expect(service.listDirectoryUsers(USER_ID)).resolves.toEqual({ items: [] });
    expect(provider.request).toHaveBeenCalledTimes(1);
  });

  it('builds a working instance from the exported service definition', () => {
    const context: any = { getService: jest.fn(() => undefined) };

    const built = AzureContactsServiceDefinition.service({} as any, context);

    expect(built).toBeInstanceOf(AzureContactsService);
    expect(AzureContactsServiceDefinition.id).toBe('azure.AzureContactsService@1.0.0');
    expect(AzureContactsServiceDefinition.dependencies).toEqual([
      { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
      { id: 'azure.AzureAuthService@1.0.0', alias: 'authService' },
    ]);
  });
});

describe('AzureContactsService — lazy service resolution', () => {
  it('falls back to context.getService when the container never called the setters', async () => {
    const provider: any = {
      // Path-aware: /me/contacts yields a contact, /users an empty directory.
      request: jest.fn((_userId: string, path: string) => Promise.resolve(
        path === '/users' ? { value: [] } : { value: [contactRecord()] },
      )),
      requestAll: jest.fn().mockResolvedValue([]),
      requestRaw: jest.fn(),
      getClient: jest.fn(),
    };
    const auth: any = {
      getGrantedScopes: jest.fn().mockResolvedValue(['User.ReadBasic.All']),
    };

    const context: any = {
      getService: jest.fn((id: string) => {
        if (id === 'azure.AzureGraphClientProvider@1.0.0') return provider;
        if (id === 'azure.AzureAuthService@1.0.0') return auth;
        return undefined;
      }),
    };

    // Constructed WITHOUT setGraphClientProvider / setAuthService: the getters must
    // resolve lazily from the context, because the container binding order is not
    // guaranteed for a service resolved on demand.
    const service = new AzureContactsService({} as any, context);

    const page = await service.listContacts(USER_ID);
    expect(page.items[0].id).toBe('contact-1');
    expect(context.getService).toHaveBeenCalledWith('azure.AzureGraphClientProvider@1.0.0');

    await expect(service.listDirectoryUsers(USER_ID)).resolves.toEqual({ items: [] });
    expect(auth.getGrantedScopes).toHaveBeenCalledWith(USER_ID);
  });

  it('reports a missing Graph provider through context.getService', async () => {
    const context: any = { getService: jest.fn(() => undefined) };
    const service = new AzureContactsService({} as any, context);

    await expect(service.listContactFolders(USER_ID)).rejects.toThrow();
  });
});

describe('ContactsResolver — GraphQL wiring', () => {
  function fakeService() {
    return {
      listContacts: jest.fn().mockResolvedValue({ items: [] }),
      getContact: jest.fn().mockResolvedValue({ id: 'contact-1' }),
      listContactFolders: jest.fn().mockResolvedValue([]),
      listContactsInFolder: jest.fn().mockResolvedValue({ items: [] }),
      searchPeople: jest.fn().mockResolvedValue({ items: [] }),
      listDirectoryUsers: jest.fn().mockResolvedValue({ items: [] }),
      getContactPhoto: jest.fn().mockResolvedValue(null),
      createContact: jest.fn().mockResolvedValue({ id: 'contact-new' }),
      updateContact: jest.fn().mockResolvedValue({ id: 'contact-1' }),
      deleteContact: jest.fn().mockResolvedValue(undefined),
    };
  }

  function fakeContext(service: any, userId: string, roles: string[] = ['USER']) {
    return {
      user: { _id: userId, id: userId, roles },
      hasRole: (role: string) => roles.includes(role),
      getService: jest.fn((id: string) => (id === 'azure.AzureContactsService@1.0.0' ? service : undefined)),
    } as any;
  }

  it('delegates every field to the service with the calling user id', async () => {
    const service = fakeService();
    const context = fakeContext(service, 'caller-id');
    const resolver: any = new ContactsResolver();

    await resolver.listContacts({}, { options: { top: 5 } }, context);
    await resolver.getContact({}, { contactId: 'contact-1' }, context);
    await resolver.listContactFolders({}, {}, context);
    await resolver.listContactsInFolder({}, { folderId: 'folder-1' }, context);
    await resolver.searchPeople({}, { query: 'grace' }, context);
    await resolver.listDirectoryUsers({}, { options: { top: 2 } }, context);
    await resolver.getContactPhoto({}, { contactId: 'contact-1' }, context);
    await resolver.createContact({}, { input: { displayName: 'Ada' } }, context);
    await resolver.updateContact({}, { contactId: 'contact-1', input: { jobTitle: 'CTO' } }, context);
    const deleted = await resolver.deleteContact({}, { contactId: 'contact-1' }, context);

    expect(context.getService).toHaveBeenCalledWith('azure.AzureContactsService@1.0.0');
    expect(service.listContacts).toHaveBeenCalledWith('caller-id', { top: 5 });
    expect(service.getContact).toHaveBeenCalledWith('caller-id', 'contact-1');
    expect(service.listContactFolders).toHaveBeenCalledWith('caller-id');
    expect(service.listContactsInFolder).toHaveBeenCalledWith('caller-id', 'folder-1', {});
    expect(service.searchPeople).toHaveBeenCalledWith('caller-id', 'grace', {});
    expect(service.listDirectoryUsers).toHaveBeenCalledWith('caller-id', { top: 2 });
    expect(service.getContactPhoto).toHaveBeenCalledWith('caller-id', 'contact-1');
    expect(service.createContact).toHaveBeenCalledWith('caller-id', { displayName: 'Ada' });
    expect(service.updateContact).toHaveBeenCalledWith('caller-id', 'contact-1', { jobTitle: 'CTO' });
    expect(service.deleteContact).toHaveBeenCalledWith('caller-id', 'contact-1');
    expect(deleted).toBe(true);
  });

  it('rejects a foreign userId from a USER-only caller and never touches the service', async () => {
    const service = fakeService();
    const context = fakeContext(service, 'caller-id', ['USER']);
    const resolver: any = new ContactsResolver();

    const attempts: Array<() => Promise<unknown>> = [
      () => resolver.listContacts({}, { userId: 'target-id' }, context),
      () => resolver.getContact({}, { userId: 'target-id', contactId: 'c1' }, context),
      () => resolver.listContactFolders({}, { userId: 'target-id' }, context),
      () => resolver.listContactsInFolder({}, { userId: 'target-id', folderId: 'f1' }, context),
      () => resolver.searchPeople({}, { userId: 'target-id', query: 'x' }, context),
      () => resolver.listDirectoryUsers({}, { userId: 'target-id' }, context),
      () => resolver.getContactPhoto({}, { userId: 'target-id', contactId: 'c1' }, context),
      () => resolver.createContact({}, { userId: 'target-id', input: { displayName: 'X' } }, context),
      () => resolver.updateContact(
        {},
        { userId: 'target-id', contactId: 'c1', input: { displayName: 'X' } },
        context,
      ),
      () => resolver.deleteContact({}, { userId: 'target-id', contactId: 'c1' }, context),
    ];

    for (const attempt of attempts) {
      let caught: any;
      try {
        await attempt();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InsufficientPermissions);
      expect(caught.code).toBe('USER-401');
      expect(caught.message).toContain('target-id');
    }

    // No token was resolved and no contact was touched.
    expect(service.listContacts).not.toHaveBeenCalled();
    expect(service.deleteContact).not.toHaveBeenCalled();
    expect(service.listDirectoryUsers).not.toHaveBeenCalled();
  });

  it('fails loudly when the contacts service is not registered', async () => {
    const context: any = {
      user: { _id: 'caller-id', id: 'caller-id', roles: ['USER'] },
      hasRole: () => true,
      getService: jest.fn(() => undefined),
    };
    const resolver: any = new ContactsResolver();

    await expect(resolver.listContacts({}, {}, context))
      .rejects.toThrow('Azure Contacts Service not available');
  });

  it('lets an ADMIN name another user', async () => {
    const service = fakeService();
    const context = fakeContext(service, 'admin-id', ['USER', 'ADMIN']);
    const resolver: any = new ContactsResolver();

    await resolver.listContacts({}, { userId: 'target-id' }, context);

    expect(service.listContacts).toHaveBeenCalledWith('target-id', {});
  });
});

describe('Contacts.graphql — schema shape', () => {
  const sdl = fs.readFileSync(
    path.join(__dirname, '..', 'graphql', 'types', 'Contacts.graphql'),
    'utf8',
  );

  const schema = buildSchema(`
    type Query { _base: Boolean }
    type Mutation { _base: Boolean }
    ${sdl}
  `);

  it('exposes the five required queries and the three mutations', () => {
    const queries = (schema.getQueryType() as GraphQLObjectType).getFields();
    const mutations = (schema.getMutationType() as GraphQLObjectType).getFields();

    for (const field of [
      'azureContacts',
      'azureContact',
      'azureContactFolders',
      'azurePeople',
      'azureDirectoryUsers',
    ]) {
      expect(queries[field]).toBeDefined();
    }

    for (const field of ['azureCreateContact', 'azureUpdateContact', 'azureDeleteContact']) {
      expect(mutations[field]).toBeDefined();
    }

    // The photo field is intentionally nullable: null means ImageNotFound only.
    expect(queries.azureContactPhoto).toBeDefined();
  });

  it('has no skip on the people options input (paging is nextLink-only)', () => {
    const peopleOptions = schema.getType('AzurePeopleOptions') as GraphQLInputObjectType;

    expect(peopleOptions).toBeDefined();
    expect(peopleOptions.getFields().skip).toBeUndefined();
    expect(peopleOptions.getFields().nextLink).toBeDefined();

    // Contact and directory options do support skip.
    expect(
      (schema.getType('AzureContactListOptions') as GraphQLInputObjectType).getFields().skip,
    ).toBeDefined();
    expect(
      (schema.getType('AzureDirectoryUserListOptions') as GraphQLInputObjectType).getFields().skip,
    ).toBeDefined();
  });
});

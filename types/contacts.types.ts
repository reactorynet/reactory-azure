/**
 * Contacts, contact folders, people search and organisation-directory types (AZ-11).
 *
 * These describe the *domain* shape `AzureContactsService` returns. Graph's own
 * envelopes never leak past the service: `emailAddresses` is always present as an
 * array, phone arrays are always arrays, and a Graph value the service cannot
 * classify is dropped rather than surfaced as `null`.
 *
 * ## Permissions
 *
 * Graph splits contact and directory reads across several delegated permissions:
 *
 *   - `Contacts.Read` / `Contacts.ReadWrite` - the signed-in user's own contacts
 *     (`/me/contacts`, `/me/contactFolders`) and writes to them. Writes need the
 *     `ReadWrite` variant; `Contacts.Read` is read-only.
 *   - `People.Read` - `/me/people`, the relevance-ranked list of people the user
 *     interacts with. It is *not* the tenant directory.
 *   - `User.ReadBasic.All` - read the **basic** profile of every user in the
 *     tenant: `displayName`, `givenName`, `surname`, `mail`, `userPrincipalName`
 *     and the photo. This is what `listDirectoryUsers` needs at minimum.
 *   - `User.Read.All` - read the **full** profile of every user: adds `jobTitle`,
 *     `department`, `officeLocation`, `businessPhones`, `mobilePhone` and more.
 *     It is a privileged permission and normally requires admin consent.
 *
 * `listDirectoryUsers` therefore defaults to {@link DEFAULT_DIRECTORY_USER_SELECT},
 * which only contains properties `User.ReadBasic.All` can return. A caller that
 * holds `User.Read.All` can request the extended projection through
 * `options.select` (see {@link EXTENDED_DIRECTORY_USER_SELECT}); asking for those
 * properties with only the basic grant makes Graph reject the request, and that
 * `ApiError` is surfaced unchanged.
 */

/** One `emailAddresses` entry on a contact or person. */
export interface IAzureContactEmailAddress {
  /** Display name, when Graph has one. */
  name?: string;
  /** SMTP address. */
  address?: string;
}

/** A scored address on a `/me/people` result (Graph's `scoredEmailAddresses`). */
export interface IAzureScoredEmailAddress extends IAzureContactEmailAddress {
  /** Relevance score Graph assigned to this address. */
  relevanceScore?: number;
}

/** A personal contact from `/me/contacts`. */
export interface IAzureContact {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  emailAddresses: IAzureContactEmailAddress[];
  businessPhones: string[];
  mobilePhone?: string;
  companyName?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  parentFolderId?: string;
}

/** A contact folder from `/me/contactFolders`. */
export interface IAzureContactFolder {
  id: string;
  displayName?: string;
  parentFolderId?: string;
  /** Set for Graph's well-known folders (e.g. `contacts`). */
  wellKnownName?: string;
}

/**
 * A `/me/people` result.
 *
 * `personType` is Graph's `{ class, subclass }` pair flattened to the subclass
 * (`organizationUser`, `person`, `group`, `unknown`) with the class as fallback.
 */
export interface IAzurePerson {
  id: string;
  displayName: string;
  givenName?: string;
  surname?: string;
  companyName?: string;
  jobTitle?: string;
  department?: string;
  personType?: string;
  emailAddresses: IAzureContactEmailAddress[];
  scoredEmailAddresses: IAzureScoredEmailAddress[];
}

/** A tenant directory user from `/users`. */
export interface IAzureDirectoryUser {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  businessPhones: string[];
  mobilePhone?: string;
  accountEnabled?: boolean;
}

/** One page of contacts. */
export interface IAzureContactPage {
  items: IAzureContact[];
  /** Opaque `@odata.nextLink` cursor; absent on the last page. */
  nextLink?: string;
  /** Present only when `$count=true` was requested. */
  count?: number;
}

/** One page of people-search results. */
export interface IAzurePeoplePage {
  items: IAzurePerson[];
  /** Opaque `@odata.nextLink` cursor; the only supported paging mechanism. */
  nextLink?: string;
}

/** One page of directory users. */
export interface IAzureDirectoryUserPage {
  items: IAzureDirectoryUser[];
  nextLink?: string;
  count?: number;
}

/**
 * Options for `listContacts` and `listContactsInFolder`.
 *
 * `$skip` is supported on both contact resources; `all` drains every page instead
 * (bounded by `maxPages`, and it ignores `skip`).
 */
export interface IAzureContactListOptions {
  /** `$top` - page size. Defaults to {@link DEFAULT_CONTACTS_PAGE_SIZE}. */
  top?: number;
  /** `$skip` - offset. Not used when `all` or `nextLink` is set. */
  skip?: number;
  /**
   * Continue from a previous page's `@odata.nextLink`.
   *
   * The URL is requested verbatim because it already carries `$filter`, `$skip`
   * and the `$skiptoken` cursor; every other option is then ignored. Cursor paging
   * is stable under concurrent edits, unlike a `$skip` offset - so a UI should
   * page with this value rather than incrementing `skip`.
   */
  nextLink?: string;
  /** `$filter` - raw OData expression. */
  filter?: string;
  /** `$select` override; defaults to {@link DEFAULT_CONTACT_SELECT}. */
  select?: string;
  /** `$orderby` - raw OData ordering. */
  orderBy?: string;
  /**
   * `$count=true`. Not sent when `all` is set: an all-pages read returns
   * `{ items }` only, so the total would be discarded. Matches the behaviour.
   */
  count?: boolean;
  /** Follow every `@odata.nextLink` and return the complete list. */
  all?: boolean;
  /** Hard page bound for `all`; the provider throws when it is exceeded. */
  maxPages?: number;
}

/** Options for a single contact read. */
export interface IAzureContactGetOptions {
  /** `$select` override; defaults to {@link DEFAULT_CONTACT_DETAIL_SELECT}. */
  select?: string;
}

/**
 * A contact create/update payload.
 *
 * Only the properties listed here are forwarded - Graph rejects unknown members,
 * and silently dropping a caller's typo would be worse than omitting it, so the
 * service filters to this whitelist and requires at least one property.
 */
export interface IAzureContactInput {
  displayName?: string;
  givenName?: string;
  surname?: string;
  emailAddresses?: IAzureContactEmailAddress[];
  businessPhones?: string[];
  homePhones?: string[];
  mobilePhone?: string;
  companyName?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  personalNotes?: string;
  categories?: string[];
}

/**
 * Options for `searchPeople`.
 *
 * There is deliberately **no `skip`**: `/me/people` rejects `$skip` alongside
 * `$search`, so paging is done exclusively by passing the previous page's
 * `nextLink` back in {@link IAzurePeopleOptions.nextLink}.
 */
export interface IAzurePeopleOptions {
  /** `$top` - page size. Defaults to {@link DEFAULT_CONTACTS_PAGE_SIZE}. */
  top?: number;
  /**
   * Continue from a previous page's `@odata.nextLink`.
   *
   * When set, the URL is requested verbatim (it already carries `$search` and
   * `$skiptoken`); `query` is then only used for error context.
   */
  nextLink?: string;
  /** `$select` override; defaults to {@link DEFAULT_PEOPLE_SELECT}. */
  select?: string;
  /** Follow every `@odata.nextLink` and return the complete result. */
  all?: boolean;
  /** Hard page bound for `all`; the provider throws when it is exceeded. */
  maxPages?: number;
}

/** Options for `listDirectoryUsers`. */
export interface IAzureDirectoryUserListOptions {
  /** `$top` - page size. Defaults to {@link DEFAULT_CONTACTS_PAGE_SIZE}. */
  top?: number;
  /** `$skip` - offset. Supported by `/users`; do not use with `all`. */
  skip?: number;
  /** `$filter` - raw OData expression over directory user properties. */
  filter?: string;
  /**
   * `$select` override. Defaults to {@link DEFAULT_DIRECTORY_USER_SELECT}, the
   * projection `User.ReadBasic.All` can return.
   */
  select?: string;
  /** `$orderby` - raw OData ordering. */
  orderBy?: string;
  /**
   * `$count=true`. Not sent when `all` is set: an all-pages read returns
   * `{ items }` only, so the total would be discarded. Matches the behaviour.
   */
  count?: boolean;
  /** Follow every `@odata.nextLink` and return the complete list. */
  all?: boolean;
  /** Hard page bound for `all`; the provider throws when it is exceeded. */
  maxPages?: number;
}

/** The contacts service contract exposed over GraphQL and to other services. */
export interface IAzureContactsService {
  listContacts(userId: string, options?: IAzureContactListOptions): Promise<IAzureContactPage>;
  getContact(userId: string, contactId: string, options?: IAzureContactGetOptions): Promise<IAzureContact>;
  createContact(userId: string, input: IAzureContactInput): Promise<IAzureContact>;
  updateContact(userId: string, contactId: string, input: IAzureContactInput): Promise<IAzureContact>;
  deleteContact(userId: string, contactId: string): Promise<void>;
  listContactFolders(userId: string): Promise<IAzureContactFolder[]>;
  listContactsInFolder(
    userId: string,
    folderId: string,
    options?: IAzureContactListOptions,
  ): Promise<IAzureContactPage>;
  searchPeople(userId: string, query: string, options?: IAzurePeopleOptions): Promise<IAzurePeoplePage>;
  listDirectoryUsers(
    userId: string,
    options?: IAzureDirectoryUserListOptions,
  ): Promise<IAzureDirectoryUserPage>;
  /**
   * A contact photo as a `data:` URI.
   *
   * `null` means Graph answered `ImageNotFound` - the contact genuinely has no
   * photo. Every other failure (401, throttling, a 404 for a missing *contact*)
   * throws, so a revoked grant can never look like "no avatar".
   */
  getContactPhoto(userId: string, contactId: string): Promise<string | null>;
}

/** `$top` used when the caller does not supply one. */
export const DEFAULT_CONTACTS_PAGE_SIZE = 50;

/** Exactly the properties requirement 1 mandates, plus the id. */
export const DEFAULT_CONTACT_SELECT =
  'id,displayName,emailAddresses,businessPhones,mobilePhone,companyName,jobTitle';

/** Single-contact projection: the list fields plus the detail-only properties. */
export const DEFAULT_CONTACT_DETAIL_SELECT =
  `${DEFAULT_CONTACT_SELECT},givenName,surname,department,officeLocation,parentFolderId`;

/** Contact-folder projection. */
export const DEFAULT_CONTACT_FOLDER_SELECT = 'id,displayName,parentFolderId,wellKnownName';

/** `/me/people` projection. */
export const DEFAULT_PEOPLE_SELECT =
  'id,displayName,givenName,surname,emailAddresses,scoredEmailAddresses,companyName,jobTitle,department,personType';

/**
 * `/users` projection that `User.ReadBasic.All` is documented to support.
 *
 * Keep this list free of `jobTitle` / `department` / `officeLocation` /
 * `businessPhones` / `mobilePhone`: those are full-profile properties and need
 * `User.Read.All`.
 */
export const DEFAULT_DIRECTORY_USER_SELECT =
  'id,displayName,givenName,surname,mail,userPrincipalName';

/**
 * The extended projection for callers that hold `User.Read.All`.
 *
 * Pass it as `options.select` to `listDirectoryUsers`; with only
 * `User.ReadBasic.All` Graph rejects the request and the `ApiError` is surfaced.
 */
export const EXTENDED_DIRECTORY_USER_SELECT =
  `${DEFAULT_DIRECTORY_USER_SELECT},jobTitle,department,officeLocation,businessPhones,mobilePhone,accountEnabled`;

/** The least-privileged delegated permission the directory read needs. */
export const DIRECTORY_BASIC_PERMISSION = 'User.ReadBasic.All';

/** The privileged delegated permission that unlocks the full user profile. */
export const DIRECTORY_FULL_PERMISSION = 'User.Read.All';

/**
 * One of these is required before a `/users` request is attempted.
 *
 * Any `User.Read*` grant satisfies the check (see the service's gate), which
 * covers `User.Read`, `User.ReadBasic.All`, `User.Read.All` and
 * `User.ReadWrite.All`.
 */
export const DIRECTORY_REQUIRED_SCOPES: string[] = [
  DIRECTORY_BASIC_PERMISSION,
  DIRECTORY_FULL_PERMISSION,
];

/**
 * `ApiError.code` raised when the vault has a recorded grant that contains no
 * `User.Read*` scope.
 *
 * The legacy `['legacy:unverified']` sentinel never produces this: the grant is
 * unverifiable, so the call is attempted and Graph's real answer is surfaced.
 */
export const CONTACTS_INSUFFICIENT_SCOPE = 'InsufficientScope';

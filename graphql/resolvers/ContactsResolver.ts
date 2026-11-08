import Reactory from '@reactorynet/reactory-core';
import { InsufficientPermissions } from '@reactory/server-core/exceptions';
import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation } from '@reactory/server-core/models/graphql/decorators/resolver';
import type {
  IAzureContactInput,
  IAzureContactListOptions,
  IAzureDirectoryUserListOptions,
  IAzurePeopleOptions,
} from '../../types/contacts.types';

/**
 * GraphQL surface for contacts, people search and the organisation directory (AZ-11).
 *
 * Every field is a thin adapter over `azure.AzureContactsService@1.0.0`: the
 * resolver resolves the caller and forwards the options. It performs no request
 * shaping, no paging and no error translation - the service owns all of that, and
 * its `ApiError` (with the Graph `code`) is what a client receives. In particular
 * `azureContactPhoto` deliberately has a nullable return: `null` is the service's
 * signal for Graph's documented `ImageNotFound`, and a 401 is an error, not null.
 *
 * ## Ownership (security)
 *
 * `@roles(['USER'])` only proves the caller is *a* user; it does not bind the
 * request to that user. `AzureContactsService` authenticates with
 * `AzureAuthService.getToken(userId)`, i.e. it uses the vaulted Microsoft token of
 * whichever user id it is given - so an unguarded `userId` argument would let any
 * authenticated USER read or delete another user's contacts (an IDOR), or use
 * their directory grants.
 *
 * `userId` is therefore self-or-admin: it defaults to the caller, and a value
 * naming anyone else is rejected unless the caller holds ADMIN. This mirrors the
 * house precedent in `KYCResolver.getVerificationHistory` and `MailResolver`.
 */

/** The authenticated caller's id (`_id` is the vault key; `id` is its virtual). */
function callerId(context: Reactory.Server.IReactoryContext): string {
  return String(context?.user?._id ?? (context?.user as any)?.id ?? '');
}

/**
 * Resolve the credential owner: the caller by default, another user only for an
 * ADMIN.
 *
 * @throws InsufficientPermissions when `params.userId` names a different user and
 * the caller is not an ADMIN.
 */
function resolveUserId(
  params: { userId?: string } | undefined,
  context: Reactory.Server.IReactoryContext,
): string {
  const caller = callerId(context);
  const requested = params?.userId;

  if (requested === undefined || requested === null || String(requested).length === 0) {
    return caller;
  }

  const target = String(requested);
  if (target === caller) return caller;

  if (typeof context?.hasRole !== 'function' || context.hasRole('ADMIN') !== true) {
    throw new InsufficientPermissions(
      `User [${caller || 'anonymous'}] may not access the contacts or directory of [${target}]`,
      { allowedRoles: ['ADMIN'], contextKey: 'args.context', requestedUserId: target },
    );
  }

  return target;
}

/** Resolve the contacts service, failing loudly when the module is not registered. */
function contactsService(context: Reactory.Server.IReactoryContext): any {
  const service = context.getService('azure.AzureContactsService@1.0.0');
  if (!service) throw new Error('Azure Contacts Service not available');
  return service;
}

@resolver
class ContactsResolver {
  resolver: any;

  /** `GET /me/contacts` - one page, or every page when `options.all` is set. */
  @roles(['USER'], 'args.context')
  @query('azureContacts')
  async listContacts(
    _obj: any,
    params: { userId?: string; options?: IAzureContactListOptions },
    context: Reactory.Server.IReactoryContext,
  ) {
    return contactsService(context).listContacts(
      resolveUserId(params, context),
      params?.options || {},
    );
  }

  /** `GET /me/contacts/{id}`. */
  @roles(['USER'], 'args.context')
  @query('azureContact')
  async getContact(
    _obj: any,
    params: { userId?: string; contactId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return contactsService(context).getContact(
      resolveUserId(params, context),
      params?.contactId,
    );
  }

  /** `GET /me/contactFolders`. */
  @roles(['USER'], 'args.context')
  @query('azureContactFolders')
  async listContactFolders(
    _obj: any,
    params: { userId?: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return contactsService(context).listContactFolders(resolveUserId(params, context));
  }

  /** `GET /me/contactFolders/{folderId}/contacts`. */
  @roles(['USER'], 'args.context')
  @query('azureContactsInFolder')
  async listContactsInFolder(
    _obj: any,
    params: { userId?: string; folderId: string; options?: IAzureContactListOptions },
    context: Reactory.Server.IReactoryContext,
  ) {
    return contactsService(context).listContactsInFolder(
      resolveUserId(params, context),
      params?.folderId,
      params?.options || {},
    );
  }

  /**
   * `GET /me/people?$search=` - paging is nextLink-only.
   *
   * There is no `skip` argument on purpose: Graph rejects `$search` + `$skip`.
   */
  @roles(['USER'], 'args.context')
  @query('azurePeople')
  async searchPeople(
    _obj: any,
    params: { userId?: string; query: string; options?: IAzurePeopleOptions },
    context: Reactory.Server.IReactoryContext,
  ) {
    return contactsService(context).searchPeople(
      resolveUserId(params, context),
      params?.query,
      params?.options || {},
    );
  }

  /** `GET /users` - requires User.ReadBasic.All or User.Read.All. */
  @roles(['USER'], 'args.context')
  @query('azureDirectoryUsers')
  async listDirectoryUsers(
    _obj: any,
    params: { userId?: string; options?: IAzureDirectoryUserListOptions },
    context: Reactory.Server.IReactoryContext,
  ) {
    return contactsService(context).listDirectoryUsers(
      resolveUserId(params, context),
      params?.options || {},
    );
  }

  /** `GET /me/contacts/{id}/photo/$value`; `null` only for `ImageNotFound`. */
  @roles(['USER'], 'args.context')
  @query('azureContactPhoto')
  async getContactPhoto(
    _obj: any,
    params: { userId?: string; contactId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return contactsService(context).getContactPhoto(
      resolveUserId(params, context),
      params?.contactId,
    );
  }

  /** `POST /me/contacts`. */
  @roles(['USER'], 'args.context')
  @mutation('azureCreateContact')
  async createContact(
    _obj: any,
    params: { userId?: string; input: IAzureContactInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return contactsService(context).createContact(
      resolveUserId(params, context),
      params?.input,
    );
  }

  /** `PATCH /me/contacts/{id}`. */
  @roles(['USER'], 'args.context')
  @mutation('azureUpdateContact')
  async updateContact(
    _obj: any,
    params: { userId?: string; contactId: string; input: IAzureContactInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return contactsService(context).updateContact(
      resolveUserId(params, context),
      params?.contactId,
      params?.input,
    );
  }

  /** `DELETE /me/contacts/{id}`; resolves to `true` on success. */
  @roles(['USER'], 'args.context')
  @mutation('azureDeleteContact')
  async deleteContact(
    _obj: any,
    params: { userId?: string; contactId: string },
    context: Reactory.Server.IReactoryContext,
  ): Promise<boolean> {
    await contactsService(context).deleteContact(
      resolveUserId(params, context),
      params?.contactId,
    );

    return true;
  }
}

export default ContactsResolver;

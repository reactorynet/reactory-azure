import { InsufficientPermissions } from '@reactory/server-core/exceptions';
import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation } from '@reactory/server-core/models/graphql/decorators/resolver';
import type {
  IAzureSharePointItemInput,
  IAzureSharePointItemListOptions,
} from '../../types/sharepoint.types';

/**
 * The slice of the request context this resolver uses.
 *
 * Declared as a local interface rather than annotated
 * `Reactory.Server.IReactoryContext`: `emitDecoratorMetadata` would otherwise
 * rewrite every decorated method's `design:paramtypes` into a guard on the
 * ambient `Reactory` namespace that is false at runtime, and istanbul reports the
 * dead right-hand side as two unreachable branches per method. Neither `@roles`
 * nor `@query`/`@mutation` reads `design:paramtypes`, so the interface is inert.
 */
interface SharePointResolverContext {
  /** The authenticated user; `_id` is the id every service method takes. */
  user: { _id?: any; id?: any };
  /** Resolve a service by FQN, e.g. `azure.AzureSharePointService@1.0.0`. */
  getService(id: string): any;
  /** Role check used for the self-or-admin `userId` rule. */
  hasRole?(role: string): boolean;
}

/**
 * GraphQL surface for SharePoint sites, lists, list items, columns and drives
 * (AZ-15).
 *
 * Every field is a thin adapter over `azure.AzureSharePointService@1.0.0`: the
 * service owns paths, encoding, paging, the non-dollar `expand=fields` and error
 * translation, and this class owns argument mapping plus the credential-owner
 * rule. In particular the resolver never re-shapes `fields`: its keys are the
 * list's internal column names and must reach Graph unchanged.
 *
 * ## Ownership (security)
 *
 * `@roles(['USER'])` only proves the caller is *a* user. `AzureSharePointService`
 * authenticates with `AzureAuthService.getToken(userId)` - the vaulted Microsoft
 * token of whichever user id it is given - so an unguarded `userId` argument
 * would let any authenticated USER read or write another user's SharePoint data
 * (an IDOR). `userId` is therefore self-or-admin: it defaults to the caller, and
 * naming another user is rejected unless the caller holds ADMIN.
 */

/** The authenticated caller's id (`_id` is the vault key; `id` is its virtual). */
function callerId(context: SharePointResolverContext): string {
  return String(context?.user?._id ?? context?.user?.id ?? '');
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
  context: SharePointResolverContext,
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
      `User [${caller || 'anonymous'}] may not access SharePoint as [${target}]`,
      { allowedRoles: ['ADMIN'], contextKey: 'args.context', requestedUserId: target },
    );
  }

  return target;
}

/** Resolve the SharePoint service, failing loudly when the module is not registered. */
function sharePointService(context: SharePointResolverContext): any {
  const service = context.getService('azure.AzureSharePointService@1.0.0');
  if (!service) throw new Error('Azure SharePoint Service not available');
  return service;
}

@resolver
class SharePointResolver {
  resolver: any;

  /** `GET /sites?search={term}` - the sites search parameter has no dollar prefix. */
  @roles(['USER'], 'args.context')
  @query('azureSites')
  async listSites(
    _obj: any,
    params: { userId?: string; search?: string },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).listSites(
      resolveUserId(params, context),
      params?.search,
    );
  }

  /** `GET /sites/root`. */
  @roles(['USER'], 'args.context')
  @query('azureRootSite')
  async getRootSite(
    _obj: any,
    params: { userId?: string },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).getRootSite(resolveUserId(params, context));
  }

  /** `GET /sites/{hostname}:/{site-path}` - the path is encoded per segment. */
  @roles(['USER'], 'args.context')
  @query('azureSiteByPath')
  async getSiteByPath(
    _obj: any,
    params: { userId?: string; hostname: string; sitePath: string },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).getSiteByPath(
      resolveUserId(params, context),
      params?.hostname,
      params?.sitePath,
    );
  }

  /** `GET /sites/{siteId}/lists`. */
  @roles(['USER'], 'args.context')
  @query('azureSharePointLists')
  async listLists(
    _obj: any,
    params: { userId?: string; siteId: string },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).listLists(
      resolveUserId(params, context),
      params?.siteId,
    );
  }

  /**
   * `GET /sites/{siteId}/lists/{listId}/items?expand=fields`.
   *
   * The expand parameter is non-dollar; see the service JSDoc.
   */
  @roles(['USER'], 'args.context')
  @query('azureSharePointItems')
  async listItems(
    _obj: any,
    params: {
      userId?: string;
      siteId: string;
      listId: string;
      options?: IAzureSharePointItemListOptions;
    },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).listItems(
      resolveUserId(params, context),
      params?.siteId,
      params?.listId,
      params?.options || {},
    );
  }

  /** `GET /sites/{siteId}/lists/{listId}/items/{itemId}?expand=fields`. */
  @roles(['USER'], 'args.context')
  @query('azureSharePointItem')
  async getItem(
    _obj: any,
    params: { userId?: string; siteId: string; listId: string; itemId: string },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).getItem(
      resolveUserId(params, context),
      params?.siteId,
      params?.listId,
      params?.itemId,
    );
  }

  /** `GET /sites/{siteId}/lists/{listId}/columns` - display name to internal name. */
  @roles(['USER'], 'args.context')
  @query('azureSharePointColumns')
  async listColumns(
    _obj: any,
    params: { userId?: string; siteId: string; listId: string },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).getListColumns(
      resolveUserId(params, context),
      params?.siteId,
      params?.listId,
    );
  }

  /** `GET /sites/{siteId}/drive` - the document library drive id for AZ-08. */
  @roles(['USER'], 'args.context')
  @query('azureSharePointDrive')
  async getSiteDrive(
    _obj: any,
    params: { userId?: string; siteId: string },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).getSiteDrive(
      resolveUserId(params, context),
      params?.siteId,
    );
  }

  /** `POST /sites/{siteId}/lists/{listId}/items` with `{ fields }`. */
  @roles(['USER'], 'args.context')
  @mutation('azureCreateSharePointItem')
  async createItem(
    _obj: any,
    params: { userId?: string; siteId: string; listId: string; input: IAzureSharePointItemInput },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).createItem(
      resolveUserId(params, context),
      params?.siteId,
      params?.listId,
      params?.input,
    );
  }

  /** `PATCH /sites/{siteId}/lists/{listId}/items/{itemId}` with `{ fields }`. */
  @roles(['USER'], 'args.context')
  @mutation('azureUpdateSharePointItem')
  async updateItem(
    _obj: any,
    params: {
      userId?: string;
      siteId: string;
      listId: string;
      itemId: string;
      input: IAzureSharePointItemInput;
    },
    context: SharePointResolverContext,
  ) {
    return sharePointService(context).updateItem(
      resolveUserId(params, context),
      params?.siteId,
      params?.listId,
      params?.itemId,
      params?.input,
    );
  }

  /** `DELETE /sites/{siteId}/lists/{listId}/items/{itemId}`; resolves to `true`. */
  @roles(['USER'], 'args.context')
  @mutation('azureDeleteSharePointItem')
  async deleteItem(
    _obj: any,
    params: { userId?: string; siteId: string; listId: string; itemId: string },
    context: SharePointResolverContext,
  ): Promise<boolean> {
    await sharePointService(context).deleteItem(
      resolveUserId(params, context),
      params?.siteId,
      params?.listId,
      params?.itemId,
    );

    return true;
  }
}

export default SharePointResolver;

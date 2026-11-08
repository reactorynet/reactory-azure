import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation, property } from '@reactory/server-core/models/graphql/decorators/resolver';
import type { IDriveItem } from '../../types/drive.types';
import { GraphErrorCode, apiError } from '../../utils/graph-error';

/**
 * The slice of the request context this resolver actually uses.
 *
 * Declared as a local **interface** rather than annotated
 * `Reactory.Server.IReactoryContext`, for two reasons that happen to coincide:
 * it documents the exact surface a resolver is allowed to touch, and
 * `emitDecoratorMetadata` would otherwise rewrite every decorated method's
 * `design:paramtypes` into `typeof Reactory !== "undefined" && Reactory.Server`.
 * `Reactory` is an ambient *type* namespace (`export as namespace`), so that
 * guard is false at runtime and its right-hand side is never evaluated: dead
 * compiler output that istanbul then reports as two unreachable branches on each
 * of the seventeen decorated methods. An interface emits `Object`, and neither
 * `@roles` nor `@query`/`@mutation` reads `design:paramtypes`, so the metadata
 * change is inert.
 */
interface DriveResolverContext {
  /** The authenticated user; `_id` is the id every service method takes. */
  user: { _id: any };
  /** Resolve a service by FQN, e.g. `azure.AzureDriveService@1.0.0`. */
  getService(id: string): any;
}

/**
 * GraphQL surface for OneDrive.
 *
 * Every field is a two-line adapter over `azure.AzureDriveService@1.0.0`: the
 * service owns encoding, paging, the redirect contract and error translation, and
 * this class owns argument mapping plus the derived fields a Graph payload makes
 * awkward in SDL (`kind`, `isFolder`, `mimeType`, identity unwrapping).
 *
 * The mutations accept `contentBase64` rather than bytes because GraphQL has no
 * binary scalar; the proxy route in `routes/proxy.ts` is the streaming path.
 */
@resolver
class DriveResolver {
  resolver: any;

  private getService(context: DriveResolverContext): any {
    const driveService = context.getService('azure.AzureDriveService@1.0.0') as any;

    if (!driveService) throw new Error('Azure Drive Service not available');

    return driveService;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  @roles(['USER'], 'args.context')
  @query('azureDrive')
  async getDefaultDrive(
    _obj: any,
    _params: unknown,
    context: DriveResolverContext,
  ) {
    return this.getService(context).getDefaultDrive(String(context.user._id));
  }

  @roles(['USER'], 'args.context')
  @query('azureDrives')
  async listDrives(
    _obj: any,
    _params: unknown,
    context: DriveResolverContext,
  ) {
    return this.getService(context).listDrives(String(context.user._id));
  }

  @roles(['USER'], 'args.context')
  @query('azureDriveItems')
  async listChildren(
    _obj: any,
    params: {
      driveId?: string;
      itemId?: string;
      nextLink?: string;
      top?: number;
      orderBy?: string;
      select?: string[];
    },
    context: DriveResolverContext,
  ) {
    return this.getService(context).listChildren(
      String(context.user._id),
      params.itemId || null,
      {
        driveId: params.driveId,
        nextLink: params.nextLink,
        top: params.top,
        orderBy: params.orderBy,
        select: params.select,
      },
    );
  }

  @roles(['USER'], 'args.context')
  @query('azureDriveItem')
  async getItem(
    _obj: any,
    params: { driveId?: string; itemId?: string; path?: string },
    context: DriveResolverContext,
  ) {
    const driveService = this.getService(context);
    const userId = String(context.user._id);

    if (params.itemId) {
      return driveService.getItem(userId, params.itemId, { driveId: params.driveId });
    }

    if (params.path) {
      return driveService.getItemByPath(userId, params.path, { driveId: params.driveId });
    }

    throw apiError(
      GraphErrorCode.GRAPH_REQUEST_FAILED,
      'azureDriveItem requires either itemId or path',
      { operation: 'resolver.azureDriveItem' },
    );
  }

  @roles(['USER'], 'args.context')
  @query('azureDriveSearch')
  async search(
    _obj: any,
    params: { driveId?: string; query: string; top?: number; nextLink?: string },
    context: DriveResolverContext,
  ) {
    return this.getService(context).search(String(context.user._id), params.query, {
      driveId: params.driveId,
      top: params.top,
      nextLink: params.nextLink,
    });
  }

  @roles(['USER'], 'args.context')
  @query('azureDrivePermissions')
  async listPermissions(
    _obj: any,
    params: { driveId?: string; itemId: string },
    context: DriveResolverContext,
  ) {
    return this.getService(context).listPermissions(
      String(context.user._id),
      params.itemId,
      { driveId: params.driveId },
    );
  }

  @roles(['USER'], 'args.context')
  @query('azureDriveVersions')
  async listVersions(
    _obj: any,
    params: { driveId?: string; itemId: string },
    context: DriveResolverContext,
  ) {
    return this.getService(context).listVersions(
      String(context.user._id),
      params.itemId,
      { driveId: params.driveId },
    );
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  @roles(['USER'], 'args.context')
  @mutation('azureCreateDriveFolder')
  async createFolder(
    _obj: any,
    params: {
      driveId?: string;
      name: string;
      parentId?: string;
      conflictBehavior?: 'rename' | 'replace' | 'fail';
    },
    context: DriveResolverContext,
  ) {
    return this.getService(context).createFolder(
      String(context.user._id),
      params.name,
      params.parentId || null,
      { driveId: params.driveId, conflictBehavior: params.conflictBehavior },
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureUploadDriveItem')
  async uploadItem(
    _obj: any,
    params: {
      driveId?: string;
      parentId?: string;
      name: string;
      contentBase64: string;
      contentType?: string;
      conflictBehavior?: 'rename' | 'replace' | 'fail';
    },
    context: DriveResolverContext,
  ) {
    const content = Buffer.from(String(params.contentBase64 || ''), 'base64');

    return this.getService(context).uploadItem(
      String(context.user._id),
      params.parentId || null,
      params.name,
      content,
      {
        driveId: params.driveId,
        contentType: params.contentType,
        conflictBehavior: params.conflictBehavior,
      },
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureMoveDriveItem')
  async moveItem(
    _obj: any,
    params: { driveId?: string; itemId: string; parentId: string; name?: string },
    context: DriveResolverContext,
  ) {
    return this.getService(context).moveItem(
      String(context.user._id),
      params.itemId,
      params.parentId,
      { driveId: params.driveId, name: params.name },
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureCopyDriveItem')
  async copyItem(
    _obj: any,
    params: { driveId?: string; itemId: string; parentId: string; name?: string; wait?: boolean },
    context: DriveResolverContext,
  ) {
    return this.getService(context).copyItem(
      String(context.user._id),
      params.itemId,
      params.parentId,
      { driveId: params.driveId, name: params.name, wait: params.wait },
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureDeleteDriveItem')
  async deleteItem(
    _obj: any,
    params: { driveId?: string; itemId: string },
    context: DriveResolverContext,
  ) {
    await this.getService(context).deleteItem(
      String(context.user._id),
      params.itemId,
      { driveId: params.driveId },
    );

    return true;
  }

  @roles(['USER'], 'args.context')
  @mutation('azureRestoreDriveItem')
  async restoreItem(
    _obj: any,
    params: { driveId?: string; itemId: string },
    context: DriveResolverContext,
  ) {
    return this.getService(context).restoreItem(
      String(context.user._id),
      params.itemId,
      { driveId: params.driveId },
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureShareDriveItem')
  async createShareLink(
    _obj: any,
    params: {
      driveId?: string;
      itemId: string;
      type?: 'view' | 'edit' | 'embed';
      scope?: 'anonymous' | 'organization';
      expirationDateTime?: string;
      password?: string;
    },
    context: DriveResolverContext,
  ) {
    return this.getService(context).createShareLink(
      String(context.user._id),
      params.itemId,
      {
        driveId: params.driveId,
        type: params.type,
        scope: params.scope,
        expirationDateTime: params.expirationDateTime,
        password: params.password,
      },
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureInviteDriveCollaborators')
  async inviteCollaborators(
    _obj: any,
    params: {
      driveId?: string;
      itemId: string;
      recipients: string[];
      role?: 'read' | 'write';
      message?: string;
      sendInvitation?: boolean;
    },
    context: DriveResolverContext,
  ) {
    return this.getService(context).inviteCollaborators(
      String(context.user._id),
      params.itemId,
      params.recipients || [],
      {
        driveId: params.driveId,
        role: params.role,
        message: params.message,
        sendInvitation: params.sendInvitation,
      },
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureDeleteDrivePermission')
  async deletePermission(
    _obj: any,
    params: { driveId?: string; itemId: string; permissionId: string },
    context: DriveResolverContext,
  ) {
    await this.getService(context).deletePermission(
      String(context.user._id),
      params.itemId,
      params.permissionId,
      { driveId: params.driveId },
    );

    return true;
  }

  @roles(['USER'], 'args.context')
  @mutation('azureRestoreDriveVersion')
  async restoreVersion(
    _obj: any,
    params: { driveId?: string; itemId: string; versionId: string },
    context: DriveResolverContext,
  ) {
    await this.getService(context).restoreVersion(
      String(context.user._id),
      params.itemId,
      params.versionId,
      { driveId: params.driveId },
    );

    return true;
  }

  // ---------------------------------------------------------------------------
  // Derived fields
  // ---------------------------------------------------------------------------

  @property('AzureDriveItem', 'kind')
  resolveKind(item: IDriveItem): string {
    if (item?.folder) return 'FOLDER';
    if (item?.package) return 'PACKAGE';
    if (item?.file) return 'FILE';

    return 'UNKNOWN';
  }

  @property('AzureDriveItem', 'mimeType')
  resolveMimeType(item: IDriveItem): string | null {
    return item?.file?.mimeType ?? null;
  }

  @property('AzureDriveItem', 'isFolder')
  resolveIsFolder(item: IDriveItem): boolean {
    return Boolean(item?.folder);
  }

  @property('AzureDriveItem', 'childCount')
  resolveChildCount(item: IDriveItem): number | null {
    return item?.folder?.childCount ?? null;
  }

  @property('AzureDriveItem', 'createdBy')
  resolveCreatedBy(item: IDriveItem): any {
    return item?.createdBy?.user ?? null;
  }

  @property('AzureDriveItem', 'lastModifiedBy')
  resolveLastModifiedBy(item: IDriveItem): any {
    return item?.lastModifiedBy?.user ?? null;
  }

  /**
   * Graph sends `owner` as an **identitySet** (`{ user: {...} }`), not a flat
   * identity. Without this resolver the default field resolver reads
   * `parent.owner.id`, finds nothing, and every subfield of `AzureDriveIdentity`
   * silently resolves to null - a query that succeeds and returns nothing useful.
   *
   * The same unwrapping applies to `AzureDriveItem.createdBy/lastModifiedBy`,
   * `AzureDriveSharedFacet.owner`, `AzureDriveVersion.lastModifiedBy` and
   * `AzureDrivePermission.grantedTo`; all five arrive as identitySets.
   */
  @property('AzureDrive', 'owner')
  resolveDriveOwner(drive: any): any {
    return drive?.owner?.user ?? null;
  }

  /** `shared` is a facet whose `owner` is an identitySet as well. */
  @property('AzureDriveSharedFacet', 'owner')
  resolveSharedOwner(shared: any): any {
    return shared?.owner?.user ?? null;
  }

  /** A version's `lastModifiedBy` is an identitySet as well. */
  @property('AzureDriveVersion', 'lastModifiedBy')
  resolveVersionLastModifiedBy(version: any): any {
    return version?.lastModifiedBy?.user ?? null;
  }

  /** Collapse Graph's `grantedToV2` bag onto one principal. */
  @property('AzureDrivePermission', 'grantedTo')
  resolveGrantedTo(permission: any): any {
    const set = permission?.grantedToV2;
    if (!set) return null;

    return set.user || set.group || set.siteGroup || set.siteUser || set.application || null;
  }

  @property('AzureDriveInvitation', 'invitedBy')
  resolveInvitedBy(invitation: any): any {
    return invitation?.invitedBy?.user ?? null;
  }

  @property('AzureDriveVersion', 'publicationLevel')
  resolvePublicationLevel(version: any): string | null {
    return version?.publication?.level ?? null;
  }
}

export default DriveResolver;

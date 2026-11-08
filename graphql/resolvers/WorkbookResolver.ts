import Reactory from '@reactorynet/reactory-core';
import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation } from '@reactory/server-core/models/graphql/decorators/resolver';
import type { IWorkbookRangeUpdate, WorkbookValues } from '../../types/workbook.types';

/**
 * GraphQL surface for Excel workbooks (AZ-10).
 *
 * A thin adapter: every field resolves `azure.AzureWorkbookService@1.0.0` and
 * passes the calling user's id, so all Graph access, session handling and error
 * translation stays in one service. Nothing here builds a Graph path.
 *
 * The one place this file makes a decision is `azureWorkbookRange`: with an
 * `address` it reads that range, without one it reads the used range (honouring
 * `valuesOnly`, which only applies to `usedRange`). Both shapes are the same
 * `AzureWorkbookRange`, so a client can ask for either and get identical cells.
 *
 * Values are typed `Any` end to end (see `Workbook.graphql`): `null` is an empty
 * cell and `'#DIV/0!'` is an error cell, and neither is coerced here.
 */
@resolver
class WorkbookResolver {
  resolver: any;

  /** Resolve the service or fail with a message that names it. */
  private workbook(context: Reactory.Server.IReactoryContext): any {
    const workbookService = context.getService('azure.AzureWorkbookService@1.0.0') as any;
    if (!workbookService) throw new Error('Azure Workbook Service not available');
    return workbookService;
  }

  /* ---------------------------------------------------------------- queries */

  @roles(['USER'], 'args.context')
  @query('azureWorkbookWorksheets')
  async listWorksheets(
    _obj: any,
    params: { itemId: string; driveId?: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.workbook(context).listWorksheets(String(context.user._id), String(params.itemId), {
      driveId: params.driveId,
    });
  }

  @roles(['USER'], 'args.context')
  @query('azureWorkbookRange')
  async getRange(
    _obj: any,
    params: {
      itemId: string;
      worksheet: string;
      address?: string;
      valuesOnly?: boolean;
      driveId?: string;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    const service = this.workbook(context);
    const userId = String(context.user._id);
    const itemId = String(params.itemId);
    const worksheet = String(params.worksheet);

    if (params.address !== undefined && params.address !== null && String(params.address).trim() !== '') {
      return service.getRange(userId, itemId, worksheet, String(params.address), {
        driveId: params.driveId,
      });
    }

    return service.getUsedRange(userId, itemId, worksheet, {
      driveId: params.driveId,
      valuesOnly: params.valuesOnly,
    });
  }

  @roles(['USER'], 'args.context')
  @query('azureWorkbookTables')
  async listTables(
    _obj: any,
    params: { itemId: string; worksheet?: string; driveId?: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.workbook(context).listTables(String(context.user._id), String(params.itemId), {
      worksheet: params.worksheet,
      driveId: params.driveId,
    });
  }

  /* -------------------------------------------------------------- mutations */

  @roles(['USER'], 'args.context')
  @mutation('azureUpdateWorkbookRange')
  async updateRange(
    _obj: any,
    params: {
      itemId: string;
      worksheet: string;
      address: string;
      input: IWorkbookRangeUpdate;
      useSession?: boolean;
      driveId?: string;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.workbook(context).updateRange(
      String(context.user._id),
      String(params.itemId),
      String(params.worksheet),
      String(params.address),
      params.input,
      { useSession: params.useSession === true, driveId: params.driveId },
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureAppendWorkbookRows')
  async appendRows(
    _obj: any,
    params: {
      itemId: string;
      worksheet: string;
      values: WorkbookValues;
      useSession?: boolean;
      driveId?: string;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.workbook(context).appendRows(
      String(context.user._id),
      String(params.itemId),
      String(params.worksheet),
      params.values,
      { useSession: params.useSession === true, driveId: params.driveId },
    );
  }
}

export default WorkbookResolver;

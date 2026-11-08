import Reactory from '@reactorynet/reactory-core';
import { resolver, query } from '@reactory/server-core/models/graphql/decorators/resolver';
import { GraphErrorCode, apiError } from '../../utils/graph-error';

/**
 * SharePointResolver - STUB created by AZ-01.
 *
 * TODO(AZ-15): expose sites, SharePoint lists, items and columns.
 *
 * The resolver class exists (and is wired into graphql/resolvers/index.ts) so
 * AZ-15 adds fields to this file instead of editing a shared barrel. Until
 * then every field it exposes throws, so a client sees a real error rather than
 * an empty payload.
 */
@resolver
class SharePointResolver {
  resolver: any;

  @query('_azureSharePointPlaceholder')
  async placeholder(
    _obj: any,
    _params: Record<string, unknown>,
    _context: Reactory.Server.IReactoryContext,
  ): Promise<boolean> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-15' });
  }
}

export default SharePointResolver;

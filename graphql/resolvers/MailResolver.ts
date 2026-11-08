import Reactory from '@reactorynet/reactory-core';
import { resolver, query } from '@reactory/server-core/models/graphql/decorators/resolver';
import { GraphErrorCode, apiError } from '../../utils/graph-error';

/**
 * MailResolver - STUB created by AZ-01.
 *
 * TODO(AZ-04): expose azureMailMessages, azureMailMessage, azureMailFolders, azureMailCategories, azureMailConversation.
 *
 * The resolver class exists (and is wired into graphql/resolvers/index.ts) so
 * AZ-04 adds fields to this file instead of editing a shared barrel. Until
 * then every field it exposes throws, so a client sees a real error rather than
 * an empty payload.
 */
@resolver
class MailResolver {
  resolver: any;

  @query('_azureMailPlaceholder')
  async placeholder(
    _obj: any,
    _params: Record<string, unknown>,
    _context: Reactory.Server.IReactoryContext,
  ): Promise<boolean> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-04' });
  }
}

export default MailResolver;

import Reactory from '@reactorynet/reactory-core';
import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation, property } from '@reactory/server-core/models/graphql/decorators/resolver';

/**
 * GraphQL surface for the Microsoft Graph connection.
 *
 * Three operations only: read the connection state, ask for an authorization
 * URL, and disconnect. All of them resolve `azure.AzureAuthService@1.0.0`, so the
 * resolver stays a thin adapter.
 */
@resolver
class AuthResolver {
  resolver: any;

  @roles(['USER'], 'args.context')
  @query('azureConnectionStatus')
  async getConnectionStatus(
    _obj: any,
    _params: Record<string, unknown>,
    context: Reactory.Server.IReactoryContext,
  ) {
    const authService = context.getService('azure.AzureAuthService@1.0.0') as any;
    if (!authService) throw new Error('Azure Auth Service not available');

    return authService.getConnectionStatus(String(context.user._id));
  }

  @roles(['USER'], 'args.context')
  @mutation('azureAuthUrl')
  async getAuthUrl(
    _obj: any,
    params: { services?: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    const authService = context.getService('azure.AzureAuthService@1.0.0') as any;
    if (!authService) throw new Error('Azure Auth Service not available');

    const url = await authService.getAuthorizationUrl(
      String(context.user._id),
      params.services || [],
    );

    return { url };
  }

  @roles(['USER'], 'args.context')
  @mutation('azureDisconnect')
  async disconnect(
    _obj: any,
    _params: Record<string, unknown>,
    context: Reactory.Server.IReactoryContext,
  ) {
    const authService = context.getService('azure.AzureAuthService@1.0.0') as any;
    if (!authService) throw new Error('Azure Auth Service not available');

    await authService.revokeAccess(String(context.user._id));
    return true;
  }

  /** Field resolver: the service returns `upn`, the schema also exposes `email`. */
  @property('AzureConnection', 'email')
  resolveEmail(obj: any): string | null {
    return obj?.email ?? obj?.upn ?? null;
  }
}

export default AuthResolver;

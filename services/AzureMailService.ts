import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureMailService - STUB, created by AZ-01.
 *
 * TODO(AZ-04): implement mail read: /me/messages, folders, categories, conversation reads and $search.
 *
 * This file exists so that AZ-04 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureMailService@1.0.0',
  name: 'AzureMailService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureMailService (stub - delivered by AZ-04)',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureMailService implements Reactory.Service.IReactoryService {
  name: string = 'AzureMailService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-04 replaces this with the real contract. */
  async listMessages(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-04' });
  }
}

export const AzureMailServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureMailService> = {
  service: (props: any, context: any) => new AzureMailService(props, context),
  id: 'azure.AzureMailService@1.0.0',
  name: 'AzureMailService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureMailService (stub - delivered by AZ-04)',
  serviceType: 'data',
  dependencies: [],
};

export { AzureMailService };

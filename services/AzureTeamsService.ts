import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureTeamsService - STUB, created by AZ-01.
 *
 * TODO(AZ-14): implement Teams: chats, channel messages, presence.
 *
 * This file exists so that AZ-14 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureTeamsService@1.0.0',
  name: 'AzureTeamsService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureTeamsService (stub - delivered by AZ-14)',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureTeamsService implements Reactory.Service.IReactoryService {
  name: string = 'AzureTeamsService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-14 replaces this with the real contract. */
  async listChats(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-14' });
  }
}

export const AzureTeamsServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureTeamsService> = {
  service: (props: any, context: any) => new AzureTeamsService(props, context),
  id: 'azure.AzureTeamsService@1.0.0',
  name: 'AzureTeamsService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureTeamsService (stub - delivered by AZ-14)',
  serviceType: 'data',
  dependencies: [],
};

export { AzureTeamsService };

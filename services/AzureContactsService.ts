import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureContactsService - STUB, created by AZ-01.
 *
 * TODO(AZ-11): implement contacts, contact folders, people search and the org directory.
 *
 * This file exists so that AZ-11 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureContactsService@1.0.0',
  name: 'AzureContactsService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureContactsService (stub - delivered by AZ-11)',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureContactsService implements Reactory.Service.IReactoryService {
  name: string = 'AzureContactsService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-11 replaces this with the real contract. */
  async listContacts(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-11' });
  }
}

export const AzureContactsServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureContactsService> = {
  service: (props: any, context: any) => new AzureContactsService(props, context),
  id: 'azure.AzureContactsService@1.0.0',
  name: 'AzureContactsService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureContactsService (stub - delivered by AZ-11)',
  serviceType: 'data',
  dependencies: [],
};

export { AzureContactsService };

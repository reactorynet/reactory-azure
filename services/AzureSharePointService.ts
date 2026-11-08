import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureSharePointService - STUB, created by AZ-01.
 *
 * TODO(AZ-15): implement SharePoint: sites, lists, list items (expand=fields) and columns.
 *
 * This file exists so that AZ-15 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureSharePointService@1.0.0',
  name: 'AzureSharePointService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureSharePointService (stub - delivered by AZ-15)',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureSharePointService implements Reactory.Service.IReactoryService {
  name: string = 'AzureSharePointService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-15 replaces this with the real contract. */
  async listSites(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-15' });
  }
}

export const AzureSharePointServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureSharePointService> = {
  service: (props: any, context: any) => new AzureSharePointService(props, context),
  id: 'azure.AzureSharePointService@1.0.0',
  name: 'AzureSharePointService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureSharePointService (stub - delivered by AZ-15)',
  serviceType: 'data',
  dependencies: [],
};

export { AzureSharePointService };

import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureSubscriptionService - STUB, created by AZ-01.
 *
 * TODO(AZ-12): implement Graph change-notification subscriptions with clientState and 80%-of-granted renewal.
 *
 * This file exists so that AZ-12 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureSubscriptionService@1.0.0',
  name: 'AzureSubscriptionService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureSubscriptionService (stub - delivered by AZ-12)',
  serviceType: 'integration',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureSubscriptionService implements Reactory.Service.IReactoryService {
  name: string = 'AzureSubscriptionService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-12 replaces this with the real contract. */
  async listSubscriptions(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-12' });
  }
}

export const AzureSubscriptionServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureSubscriptionService> = {
  service: (props: any, context: any) => new AzureSubscriptionService(props, context),
  id: 'azure.AzureSubscriptionService@1.0.0',
  name: 'AzureSubscriptionService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureSubscriptionService (stub - delivered by AZ-12)',
  serviceType: 'integration',
  dependencies: [],
};

export { AzureSubscriptionService };

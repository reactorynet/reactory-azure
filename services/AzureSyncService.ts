import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureSyncService - STUB, created by AZ-01.
 *
 * TODO(AZ-12): implement delta loops for messages/events/drive, persisting the deltaLink and handling 410 with a full resync.
 *
 * This file exists so that AZ-12 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureSyncService@1.0.0',
  name: 'AzureSyncService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureSyncService (stub - delivered by AZ-12)',
  serviceType: 'integration',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureSyncService implements Reactory.Service.IReactoryService {
  name: string = 'AzureSyncService';
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
  async syncMessages(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-12' });
  }
}

export const AzureSyncServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureSyncService> = {
  service: (props: any, context: any) => new AzureSyncService(props, context),
  id: 'azure.AzureSyncService@1.0.0',
  name: 'AzureSyncService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureSyncService (stub - delivered by AZ-12)',
  serviceType: 'integration',
  dependencies: [],
};

export { AzureSyncService };

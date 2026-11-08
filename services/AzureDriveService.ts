import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureDriveService - STUB, created by AZ-01.
 *
 * TODO(AZ-08): implement OneDrive: drives, children, item by path, download, upload sessions, sharing.
 *
 * This file exists so that AZ-08 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureDriveService@1.0.0',
  name: 'AzureDriveService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureDriveService (stub - delivered by AZ-08)',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureDriveService implements Reactory.Service.IReactoryService {
  name: string = 'AzureDriveService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-08 replaces this with the real contract. */
  async listChildren(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-08' });
  }
}

export const AzureDriveServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureDriveService> = {
  service: (props: any, context: any) => new AzureDriveService(props, context),
  id: 'azure.AzureDriveService@1.0.0',
  name: 'AzureDriveService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureDriveService (stub - delivered by AZ-08)',
  serviceType: 'data',
  dependencies: [],
};

export { AzureDriveService };

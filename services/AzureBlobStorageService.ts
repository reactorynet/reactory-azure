import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureBlobStorageService - STUB, created by AZ-01.
 *
 * TODO(AZ-16): implement Azure Blob Storage v12 data-plane access (no Aborter/StorageURL).
 *
 * This file exists so that AZ-16 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureBlobStorageService@1.0.0',
  name: 'AzureBlobStorageService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureBlobStorageService (stub - delivered by AZ-16)',
  serviceType: 'integration',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureBlobStorageService implements Reactory.Service.IReactoryService {
  name: string = 'AzureBlobStorageService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-16 replaces this with the real contract. */
  async listContainers(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-16' });
  }
}

export const AzureBlobStorageServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureBlobStorageService> = {
  service: (props: any, context: any) => new AzureBlobStorageService(props, context),
  id: 'azure.AzureBlobStorageService@1.0.0',
  name: 'AzureBlobStorageService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureBlobStorageService (stub - delivered by AZ-16)',
  serviceType: 'integration',
  dependencies: [],
};

export { AzureBlobStorageService };

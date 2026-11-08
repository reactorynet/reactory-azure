import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureWorkbookService - STUB, created by AZ-01.
 *
 * TODO(AZ-10): implement Excel: worksheets, ranges, tables, sessions closed in a finally.
 *
 * This file exists so that AZ-10 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureWorkbookService@1.0.0',
  name: 'AzureWorkbookService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureWorkbookService (stub - delivered by AZ-10)',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureWorkbookService implements Reactory.Service.IReactoryService {
  name: string = 'AzureWorkbookService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-10 replaces this with the real contract. */
  async listWorksheets(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-10' });
  }
}

export const AzureWorkbookServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureWorkbookService> = {
  service: (props: any, context: any) => new AzureWorkbookService(props, context),
  id: 'azure.AzureWorkbookService@1.0.0',
  name: 'AzureWorkbookService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureWorkbookService (stub - delivered by AZ-10)',
  serviceType: 'data',
  dependencies: [],
};

export { AzureWorkbookService };

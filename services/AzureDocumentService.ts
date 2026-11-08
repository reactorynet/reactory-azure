import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureDocumentService - STUB, created by AZ-01.
 *
 * TODO(AZ-09): implement Word: template copy, text extraction, PDF conversion (2 MB cap), replace.
 *
 * This file exists so that AZ-09 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureDocumentService@1.0.0',
  name: 'AzureDocumentService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureDocumentService (stub - delivered by AZ-09)',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureDocumentService implements Reactory.Service.IReactoryService {
  name: string = 'AzureDocumentService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-09 replaces this with the real contract. */
  async getDocumentText(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-09' });
  }
}

export const AzureDocumentServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureDocumentService> = {
  service: (props: any, context: any) => new AzureDocumentService(props, context),
  id: 'azure.AzureDocumentService@1.0.0',
  name: 'AzureDocumentService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureDocumentService (stub - delivered by AZ-09)',
  serviceType: 'data',
  dependencies: [],
};

export { AzureDocumentService };

import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureTodoService - STUB, created by AZ-01.
 *
 * TODO(AZ-06): implement Microsoft To Do: task lists, tasks, checklist items. No assignedTo - assignment is Planner.
 *
 * This file exists so that AZ-06 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureTodoService@1.0.0',
  name: 'AzureTodoService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureTodoService (stub - delivered by AZ-06)',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureTodoService implements Reactory.Service.IReactoryService {
  name: string = 'AzureTodoService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-06 replaces this with the real contract. */
  async listTaskLists(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-06' });
  }
}

export const AzureTodoServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureTodoService> = {
  service: (props: any, context: any) => new AzureTodoService(props, context),
  id: 'azure.AzureTodoService@1.0.0',
  name: 'AzureTodoService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureTodoService (stub - delivered by AZ-06)',
  serviceType: 'data',
  dependencies: [],
};

export { AzureTodoService };

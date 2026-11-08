import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { GraphErrorCode, apiError } from '../utils/graph-error';

/**
 * AzureCalendarService - STUB, created by AZ-01.
 *
 * TODO(AZ-07): implement calendars, calendarView ranges, event CRUD, getSchedule and findMeetingTimes.
 *
 * This file exists so that AZ-07 fills in an implementation without editing a
 * shared barrel (services/index.ts is owned by AZ-01 and must not be touched), and
 * so the module registers the final FQN from day one. Every method until then
 * throws `ApiError('not implemented', { ticket })` - never an empty result.
 */
@service({
  id: 'azure.AzureCalendarService@1.0.0',
  name: 'AzureCalendarService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureCalendarService (stub - delivered by AZ-07)',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [],
})
class AzureCalendarService implements Reactory.Service.IReactoryService {
  name: string = 'AzureCalendarService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Placeholder entry point; AZ-07 replaces this with the real contract. */
  async listCalendars(..._args: unknown[]): Promise<never> {
    throw apiError(GraphErrorCode.NOT_IMPLEMENTED, 'not implemented', { ticket: 'AZ-07' });
  }
}

export const AzureCalendarServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureCalendarService> = {
  service: (props: any, context: any) => new AzureCalendarService(props, context),
  id: 'azure.AzureCalendarService@1.0.0',
  name: 'AzureCalendarService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'AzureCalendarService (stub - delivered by AZ-07)',
  serviceType: 'data',
  dependencies: [],
};

export { AzureCalendarService };

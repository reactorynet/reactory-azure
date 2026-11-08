import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import type { IAzureConnection } from '../types/azure.types';

/**
 * Facade over every service the module contributes.
 *
 * A resolver or macro that needs several capabilities resolves one service - this
 * one - and asks it for the others, instead of hard-coding a dozen FQNs. The
 * getters return whatever the container has: a stub service throws
 * `not implemented` from its own methods, which keeps the failure local and
 * attributable to a ticket.
 *
 * Dependency injection: `ServiceManager` binds each `dependencies` entry by
 * calling `set<Alias>(instance)` when the service defines that setter, and
 * otherwise assigning the instance to the property named `alias`. This facade
 * defines no per-alias setters, so `this.authService`, `this.mailService`, ... are
 * the bound instances; `resolve()` reads them first and falls back to
 * `context.getService(id)` only when the facade is constructed outside the
 * container.
 */const OTHER_SERVICES = [
  { id: 'azure.AzureAuditService@1.0.0', alias: 'auditService' },
  { id: 'azure.AzureAuthService@1.0.0', alias: 'authService' },
  { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphClientProvider' },
  { id: 'azure.AzureMailService@1.0.0', alias: 'mailService' },
  { id: 'azure.AzureTodoService@1.0.0', alias: 'todoService' },
  { id: 'azure.AzureCalendarService@1.0.0', alias: 'calendarService' },
  { id: 'azure.AzureDriveService@1.0.0', alias: 'driveService' },
  { id: 'azure.AzureDocumentService@1.0.0', alias: 'documentService' },
  { id: 'azure.AzureWorkbookService@1.0.0', alias: 'workbookService' },
  { id: 'azure.AzureContactsService@1.0.0', alias: 'contactsService' },
  { id: 'azure.AzureSyncService@1.0.0', alias: 'syncService' },
  { id: 'azure.AzureSubscriptionService@1.0.0', alias: 'subscriptionService' },
  { id: 'azure.AzureTeamsService@1.0.0', alias: 'teamsService' },
  { id: 'azure.AzureSharePointService@1.0.0', alias: 'sharePointService' },
  { id: 'azure.AzureBlobStorageService@1.0.0', alias: 'blobStorageService' },
];

@service({
  id: 'azure.AzureService@1.0.0',
  name: 'AzureService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph orchestration facade over every Azure service',
  serviceType: 'integration',
  lifeCycle: 'singleton',
  dependencies: OTHER_SERVICES,
})
class AzureService implements Reactory.Service.IReactoryService {
  name: string = 'AzureService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /**
   * Resolve a dependency by its id, preferring the instance the container bound.
   *
   * `ServiceManager` binds each `dependencies` entry by calling `set<Alias>(...)`
   * when the service defines that setter, and otherwise assigning the instance to
   * the property named `alias` - so for this facade `this.authService`,
   * `this.mailService`, ... are the bound instances. It never calls a generic
   * `setService(alias, instance)`.
   *
   * The `context.getService(id)` fallback covers a facade constructed outside the
   * container (a unit test, or a macro that resolves the facade lazily).
   */
  private resolve(id: string, alias: string): any {
    const bound = (this as any)[alias];
    if (bound) return bound;

    try {
      return this.context.getService(id);
    } catch {
      return undefined;
    }
  }

  getAuditService(): any {
    return this.resolve('azure.AzureAuditService@1.0.0', 'auditService');
  }

  getAuthService(): any {
    return this.resolve('azure.AzureAuthService@1.0.0', 'authService');
  }

  getGraphClientProvider(): any {
    return this.resolve('azure.AzureGraphClientProvider@1.0.0', 'graphClientProvider');
  }

  getMailService(): any {
    return this.resolve('azure.AzureMailService@1.0.0', 'mailService');
  }

  getTodoService(): any {
    return this.resolve('azure.AzureTodoService@1.0.0', 'todoService');
  }

  getCalendarService(): any {
    return this.resolve('azure.AzureCalendarService@1.0.0', 'calendarService');
  }

  getDriveService(): any {
    return this.resolve('azure.AzureDriveService@1.0.0', 'driveService');
  }

  getDocumentService(): any {
    return this.resolve('azure.AzureDocumentService@1.0.0', 'documentService');
  }

  getWorkbookService(): any {
    return this.resolve('azure.AzureWorkbookService@1.0.0', 'workbookService');
  }

  getContactsService(): any {
    return this.resolve('azure.AzureContactsService@1.0.0', 'contactsService');
  }

  getSyncService(): any {
    return this.resolve('azure.AzureSyncService@1.0.0', 'syncService');
  }

  getSubscriptionService(): any {
    return this.resolve('azure.AzureSubscriptionService@1.0.0', 'subscriptionService');
  }

  getTeamsService(): any {
    return this.resolve('azure.AzureTeamsService@1.0.0', 'teamsService');
  }

  getSharePointService(): any {
    return this.resolve('azure.AzureSharePointService@1.0.0', 'sharePointService');
  }

  getBlobStorageService(): any {
    return this.resolve('azure.AzureBlobStorageService@1.0.0', 'blobStorageService');
  }

  /** Connection state for the calling user (or the supplied user id). */
  async getConnectionStatus(userId?: string): Promise<IAzureConnection> {
    const uid = userId || String(this.context?.user?._id || '');
    const authService = this.getAuthService();

    if (!authService) {
      return {
        userId: uid,
        status: 'DISCONNECTED' as IAzureConnection['status'],
        grantedScopes: [],
      };
    }

    return authService.getConnectionStatus(uid);
  }

  /** Disconnect the calling user's Microsoft account. */
  async disconnectAccount(userId?: string): Promise<void> {
    const uid = userId || String(this.context?.user?._id || '');
    const authService = this.getAuthService();

    if (!authService) return;

    return authService.revokeAccess(uid);
  }
}

export const AzureServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureService> = {
  service: (props: any, context: any) => new AzureService(props, context),
  id: 'azure.AzureService@1.0.0',
  name: 'AzureService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph orchestration facade over every Azure service',
  serviceType: 'integration',
  dependencies: OTHER_SERVICES,
};

export { AzureService };

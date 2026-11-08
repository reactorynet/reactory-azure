/**
 * AzureService facade contract (plan requirement 7): "exposes one getter per
 * service, including the stubs, plus getConnectionStatus and disconnectAccount".
 *
 * The getters are enumerated below so that dropping or renaming one fails this
 * suite, and both resolution paths are exercised: the property `ServiceManager`
 * assigns for each dependency alias, and the `context.getService(id)` fallback used
 * when the facade is built outside the container.
 */
import { AzureService } from '../services/AzureService';

const GETTERS: Array<{ getter: string; alias: string; fqn: string }> = [
  { getter: 'getAuditService', alias: 'auditService', fqn: 'azure.AzureAuditService@1.0.0' },
  { getter: 'getAuthService', alias: 'authService', fqn: 'azure.AzureAuthService@1.0.0' },
  { getter: 'getGraphClientProvider', alias: 'graphClientProvider', fqn: 'azure.AzureGraphClientProvider@1.0.0' },
  { getter: 'getMailService', alias: 'mailService', fqn: 'azure.AzureMailService@1.0.0' },
  { getter: 'getTodoService', alias: 'todoService', fqn: 'azure.AzureTodoService@1.0.0' },
  { getter: 'getCalendarService', alias: 'calendarService', fqn: 'azure.AzureCalendarService@1.0.0' },
  { getter: 'getDriveService', alias: 'driveService', fqn: 'azure.AzureDriveService@1.0.0' },
  { getter: 'getDocumentService', alias: 'documentService', fqn: 'azure.AzureDocumentService@1.0.0' },
  { getter: 'getWorkbookService', alias: 'workbookService', fqn: 'azure.AzureWorkbookService@1.0.0' },
  { getter: 'getContactsService', alias: 'contactsService', fqn: 'azure.AzureContactsService@1.0.0' },
  { getter: 'getSyncService', alias: 'syncService', fqn: 'azure.AzureSyncService@1.0.0' },
  { getter: 'getSubscriptionService', alias: 'subscriptionService', fqn: 'azure.AzureSubscriptionService@1.0.0' },
  { getter: 'getTeamsService', alias: 'teamsService', fqn: 'azure.AzureTeamsService@1.0.0' },
  { getter: 'getSharePointService', alias: 'sharePointService', fqn: 'azure.AzureSharePointService@1.0.0' },
  { getter: 'getBlobStorageService', alias: 'blobStorageService', fqn: 'azure.AzureBlobStorageService@1.0.0' },
];

function createFacade(getService: jest.Mock = jest.fn(() => undefined), user?: any) {
  const context: any = { getService, user, error: jest.fn() };
  return { facade: new AzureService({} as any, context), context, getService };
}

describe('AzureService — getters', () => {
  it('exposes exactly the 15 documented getters', () => {
    const { facade } = createFacade();

    for (const { getter } of GETTERS) {
      expect(typeof (facade as any)[getter]).toBe('function');
    }

    expect(GETTERS).toHaveLength(15);
  });

  it.each(GETTERS)('$getter returns the instance the container bound as $alias', ({ getter, alias }) => {
    const { facade } = createFacade();
    const instance = { boundAs: alias };

    // ServiceManager assigns svc[alias] directly when there is no set<Alias> setter.
    (facade as any)[alias] = instance;

    expect((facade as any)[getter]()).toBe(instance);
  });

  it.each(GETTERS)('$getter falls back to context.getService($fqn)', ({ getter, fqn }) => {
    const instance = { resolvedFrom: fqn };
    const getService = jest.fn((id: string) => (id === fqn ? instance : undefined));
    const { facade } = createFacade(getService);

    expect((facade as any)[getter]()).toBe(instance);
    expect(getService).toHaveBeenCalledWith(fqn);
  });

  it.each(GETTERS)('$getter returns undefined when the container throws', ({ getter }) => {
    const getService = jest.fn(() => { throw new Error('not registered'); });
    const { facade } = createFacade(getService);

    expect((facade as any)[getter]()).toBeUndefined();
  });

  it('prefers the bound property over the context lookup', () => {
    const bound = { source: 'bound' };
    const getService = jest.fn(() => ({ source: 'context' }));
    const { facade } = createFacade(getService);
    (facade as any).authService = bound;

    expect(facade.getAuthService()).toBe(bound);
    expect(getService).not.toHaveBeenCalled();
  });
});

describe('AzureService — getConnectionStatus', () => {
  it('delegates to the auth service for the calling user', async () => {
    const status = { userId: 'u1', status: 'CONNECTED', grantedScopes: ['User.Read'] };
    const authService = { getConnectionStatus: jest.fn().mockResolvedValue(status) };
    const { facade } = createFacade(jest.fn(() => undefined), { _id: 'u1' });
    (facade as any).authService = authService;

    await expect(facade.getConnectionStatus()).resolves.toBe(status);
    expect(authService.getConnectionStatus).toHaveBeenCalledWith('u1');
  });

  it('accepts an explicit userId', async () => {
    const authService = { getConnectionStatus: jest.fn().mockResolvedValue({ userId: 'u2' }) };
    const { facade } = createFacade();
    (facade as any).authService = authService;

    await facade.getConnectionStatus('u2');
    expect(authService.getConnectionStatus).toHaveBeenCalledWith('u2');
  });

  it('reports DISCONNECTED when the auth service is unavailable', async () => {
    const getService = jest.fn(() => { throw new Error('container down'); });
    const { facade } = createFacade(getService, { _id: 'u3' });

    await expect(facade.getConnectionStatus()).resolves.toEqual({
      userId: 'u3',
      status: 'DISCONNECTED',
      grantedScopes: [],
    });
  });

  it('falls back to an empty user id when there is no context user', async () => {
    const { facade } = createFacade();

    await expect(facade.getConnectionStatus()).resolves.toMatchObject({ userId: '', status: 'DISCONNECTED' });
  });
});

describe('AzureService — disconnectAccount', () => {
  it('delegates revocation to the auth service', async () => {
    const authService = { revokeAccess: jest.fn().mockResolvedValue(undefined) };
    const { facade } = createFacade(jest.fn(() => undefined), { _id: 'u1' });
    (facade as any).authService = authService;

    await facade.disconnectAccount();

    expect(authService.revokeAccess).toHaveBeenCalledWith('u1');
  });

  it('accepts an explicit userId', async () => {
    const authService = { revokeAccess: jest.fn().mockResolvedValue(undefined) };
    const { facade } = createFacade();
    (facade as any).authService = authService;

    await facade.disconnectAccount('u9');
    expect(authService.revokeAccess).toHaveBeenCalledWith('u9');
  });

  it('is a no-op when the auth service is unavailable', async () => {
    const { facade } = createFacade(jest.fn(() => { throw new Error('container down'); }));

    await expect(facade.disconnectAccount()).resolves.toBeUndefined();
  });
});

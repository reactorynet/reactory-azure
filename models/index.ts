import Reactory from '@reactorynet/reactory-core';
import AzureToken from './AzureToken';
import AzureAuditLog from './AzureAuditLog';
import AzureSyncState from './AzureSyncState';
import AzureSubscription from './AzureSubscription';

export { AzureToken, AzureAuditLog, AzureSyncState, AzureSubscription };

export type { IAzureToken, IAzureTokenDocument } from './AzureToken';
export type { IAzureAuditLog, IAzureAuditLogDocument } from './AzureAuditLog';
export type {
  IAzureSyncState,
  IAzureSyncStateDocument,
  AzureSyncResource,
  AzureSyncStatus,
} from './AzureSyncState';
export type {
  IAzureSubscription,
  IAzureSubscriptionDocument,
  AzureSubscriptionResource,
} from './AzureSubscription';

/**
 * Model definitions contributed to the Reactory model registry.
 *
 * AZ-01 owns this barrel. AZ-12 is the ONLY later ticket permitted to append to it
 * (AzureSyncState and AzureSubscription); every other ticket stops and raises.
 */
export const ModelDefinitions: Reactory.IReactoryComponentDefinition<any>[] = [
  {
    nameSpace: 'azure',
    name: 'AzureToken',
    version: '1.0.0',
    description: 'Microsoft Graph OAuth token vault',
    stem: 'azure-token',
    tags: ['azure', 'oauth', 'token'],
    component: AzureToken,
    domain: Reactory.ComponentDomain.model,
    overwrite: false,
    roles: [],
  },
  {
    nameSpace: 'azure',
    name: 'AzureAuditLog',
    version: '1.0.0',
    description: 'Microsoft Graph API audit log',
    stem: 'azure-audit-log',
    tags: ['azure', 'audit', 'log'],
    component: AzureAuditLog,
    domain: Reactory.ComponentDomain.model,
    overwrite: false,
    roles: [],
  },
  {
    nameSpace: 'azure',
    name: 'AzureSyncState',
    version: '1.0.0',
    description: 'Microsoft Graph delta cursor per user and resource',
    stem: 'azure-sync-state',
    tags: ['azure', 'sync', 'delta'],
    component: AzureSyncState,
    domain: Reactory.ComponentDomain.model,
    overwrite: false,
    roles: [],
  },
  {
    nameSpace: 'azure',
    name: 'AzureSubscription',
    version: '1.0.0',
    description: 'Microsoft Graph change-notification subscription with encrypted clientState',
    stem: 'azure-subscription',
    tags: ['azure', 'subscription', 'webhook'],
    component: AzureSubscription,
    domain: Reactory.ComponentDomain.model,
    overwrite: false,
    roles: [],
  },
];

export default ModelDefinitions;

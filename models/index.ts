import Reactory from '@reactorynet/reactory-core';
import AzureToken from './AzureToken';
import AzureAuditLog from './AzureAuditLog';

export { AzureToken, AzureAuditLog };

export type { IAzureToken, IAzureTokenDocument } from './AzureToken';
export type { IAzureAuditLog, IAzureAuditLogDocument } from './AzureAuditLog';

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
];

export default ModelDefinitions;

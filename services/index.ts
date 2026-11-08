import Reactory from '@reactorynet/reactory-core';
import { AzureAuditServiceDefinition } from './AzureAuditService';
import { AzureAuthServiceDefinition } from './AzureAuthService';
import { AzureGraphClientProviderDefinition } from './graph/AzureGraphClientProvider';
import { AzureServiceDefinition } from './AzureService';
import { AzureMailServiceDefinition } from './AzureMailService';
import { AzureTodoServiceDefinition } from './AzureTodoService';
import { AzureCalendarServiceDefinition } from './AzureCalendarService';
import { AzureDriveServiceDefinition } from './AzureDriveService';
import { AzureDocumentServiceDefinition } from './AzureDocumentService';
import { AzureWorkbookServiceDefinition } from './AzureWorkbookService';
import { AzureContactsServiceDefinition } from './AzureContactsService';
import { AzureSyncServiceDefinition } from './AzureSyncService';
import { AzureSubscriptionServiceDefinition } from './AzureSubscriptionService';
import { AzureTeamsServiceDefinition } from './AzureTeamsService';
import { AzureSharePointServiceDefinition } from './AzureSharePointService';
import { AzureBlobStorageServiceDefinition } from './AzureBlobStorageService';

/**
 * The 16 services this module contributes - all `azure.*@1.0.0`.
 *
 * THIS LIST IS FROZEN. AZ-01 creates every entry; a later ticket implements its
 * service inside the existing file and must not add or reorder anything here.
 *
 *   1.  azure.AzureAuditService@1.0.0          (AZ-01)
 *   2.  azure.AzureAuthService@1.0.0           (AZ-01)
 *   3.  azure.AzureGraphClientProvider@1.0.0   (AZ-01)
 *   4.  azure.AzureService@1.0.0               (AZ-01)
 *   5.  azure.AzureMailService@1.0.0           (AZ-04)
 *   6.  azure.AzureTodoService@1.0.0           (AZ-06)
 *   7.  azure.AzureCalendarService@1.0.0       (AZ-07)
 *   8.  azure.AzureDriveService@1.0.0          (AZ-08)
 *   9.  azure.AzureDocumentService@1.0.0       (AZ-09)
 *   10. azure.AzureWorkbookService@1.0.0       (AZ-10)
 *   11. azure.AzureContactsService@1.0.0       (AZ-11)
 *   12. azure.AzureSyncService@1.0.0           (AZ-12)
 *   13. azure.AzureSubscriptionService@1.0.0   (AZ-12)
 *   14. azure.AzureTeamsService@1.0.0          (AZ-14)
 *   15. azure.AzureSharePointService@1.0.0     (AZ-15)
 *   16. azure.AzureBlobStorageService@1.0.0    (AZ-16)
 */
const services: Reactory.Service.IReactoryServiceDefinition<any>[] = [
  AzureAuditServiceDefinition,
  AzureAuthServiceDefinition,
  AzureGraphClientProviderDefinition,
  AzureServiceDefinition,
  AzureMailServiceDefinition,
  AzureTodoServiceDefinition,
  AzureCalendarServiceDefinition,
  AzureDriveServiceDefinition,
  AzureDocumentServiceDefinition,
  AzureWorkbookServiceDefinition,
  AzureContactsServiceDefinition,
  AzureSyncServiceDefinition,
  AzureSubscriptionServiceDefinition,
  AzureTeamsServiceDefinition,
  AzureSharePointServiceDefinition,
  AzureBlobStorageServiceDefinition,
];

export default services;

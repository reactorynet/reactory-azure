import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import { AzureAuditLog } from '../models/AzureAuditLog';
import type { IAzureAuditLog } from '../models/AzureAuditLog';
import type { AzureAuditOutcome } from '../types/azure.types';

/**
 * Keys whose values are credentials and must never reach a log document.
 *
 * `token` and `bearer` are here in addition to the OAuth spellings because the
 * legacy bridge hands a caller a bare `token`, and a Graph request carries a
 * `Bearer` scheme - either could end up in a metadata bag.
 */
export const REDACTED_KEYS: string[] = [
  'authorization',
  'access_token',
  'refresh_token',
  'token',
  'bearer',
];

/** Normalise a key so `accessToken`, `Access-Token` and `access_token` all match. */
function normaliseKey(key: string): string {
  return String(key).replace(/[_\-\s]/g, '').toLowerCase();
}

const REDACTED_KEY_SET = new Set<string>([
  'authorization',
  'accesstoken',
  'refreshtoken',
  'token',
  'bearer',
  'bearertoken',
  'idtoken',
]);

const REDACTED_PLACEHOLDER = '[REDACTED]';
const MAX_REDACTION_DEPTH = 8;

/**
 * Deep-copy `value`, replacing every credential value with `[REDACTED]`.
 *
 * Arrays are walked, cycles are cut (an audit payload must never throw), and
 * depth is capped. Exported so a reviewer can unit test the redaction without
 * touching Mongo.
 */
export function redact(value: unknown, depth: number = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_REDACTION_DEPTH) return '[TRUNCATED]';

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1, seen));
  }

  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return `[BUFFER:${value.length}]`;

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[CIRCULAR]';
    seen.add(value as object);

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEY_SET.has(normaliseKey(key))) {
        output[key] = REDACTED_PLACEHOLDER;
      } else {
        output[key] = redact(entry, depth + 1, seen);
      }
    }
    return output;
  }

  return value;
}

/** Input accepted by {@link AzureAuditService.logOperation}. */
export interface IAzureAuditEntry {
  userId: string;
  operation: string;
  resource?: string;
  outcome: AzureAuditOutcome;
  durationMs?: number;
  graphCode?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Microsoft Graph audit logging.
 *
 * Two hard rules:
 *   1. `logOperation` never throws. A failing audit write must not fail the
 *      operation it is recording - it is logged and swallowed.
 *   2. Every metadata bag is redacted before it is persisted, so a caller that
 *      passes `{ headers: { Authorization: ... } }` cannot leak a credential.
 */
@service({
  id: 'azure.AzureAuditService@1.0.0',
  name: 'AzureAuditService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph audit logging with credential redaction',
  serviceType: 'logging',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'core.ReactoryAuditService@1.0.0', alias: 'auditService' },
  ],
})
class AzureAuditService implements Reactory.Service.IReactoryService {
  name: string = 'AzureAuditService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _auditService: any;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `auditService` dependency alias. */
  setAuditService(serviceInstance: any): void {
    this._auditService = serviceInstance;
  }

  private get coreAuditService(): any {
    if (this._auditService) return this._auditService;
    try {
      return this.context.getService('core.ReactoryAuditService@1.0.0');
    } catch {
      return undefined;
    }
  }

  /**
   * Record one Graph operation.
   *
   * Never throws; credentials in `metadata` are redacted before the write.
   */
  async logOperation(entry: IAzureAuditEntry): Promise<void> {
    try {
      const document = {
        userId: entry.userId,
        operation: entry.operation,
        resource: entry.resource || '',
        outcome: entry.outcome,
        durationMs: Number.isFinite(entry.durationMs) ? Number(entry.durationMs) : 0,
        graphCode: entry.graphCode,
        correlationId: entry.correlationId,
        metadata: redact(entry.metadata) as Record<string, unknown>,
        timestamp: new Date(),
      };

      await new AzureAuditLog(document).save();

      const coreAudit = this.coreAuditService;
      if (coreAudit && typeof coreAudit.logAuditEvent === 'function') {
        await coreAudit.logAuditEvent({
          actorType: 'user',
          actorId: entry.userId,
          action: `azure.${entry.operation}`,
          resourceType: 'microsoft_graph',
          resourceId: entry.resource,
          eventType: entry.outcome === 'success' ? 'read' : 'error',
          outcome: entry.outcome,
          details: { graphCode: entry.graphCode, durationMs: entry.durationMs },
          moduleName: 'reactory-azure',
          moduleVersion: '1.0.0',
        });
      }
    } catch (error: any) {
      logger.warn(`AzureAuditService.logOperation failed for ${entry?.operation}: ${error?.message}`);
    }
  }

  /** Convenience wrapper for auth events (`connect`, `refresh`, `revoke`). */
  async logAuthEvent(userId: string, action: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.logOperation({
      userId,
      operation: `auth.${action}`,
      resource: 'azure_token',
      outcome: 'success',
      durationMs: 0,
      metadata,
    });
  }

  /**
   * Recent audit entries for a user. Read-only and safe when the collection is
   * empty; a query failure propagates so a caller can tell "no data" from "no
   * database".
   */
  async getAuditTrail(userId: string, limit: number = 100): Promise<IAzureAuditLog[]> {
    return AzureAuditLog.find({ userId })
      .sort({ timestamp: -1 })
      .limit(Math.max(1, Math.min(1000, limit)))
      .lean();
  }
}

export const AzureAuditServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureAuditService> = {
  service: (props: any, context: any) => new AzureAuditService(props, context),
  id: 'azure.AzureAuditService@1.0.0',
  name: 'AzureAuditService',
  nameSpace: 'azure',
  version: '1.0.0',
  description: 'Microsoft Graph audit logging with credential redaction',
  serviceType: 'logging',
  dependencies: [
    { id: 'core.ReactoryAuditService@1.0.0', alias: 'auditService' },
  ],
};

export { AzureAuditService };

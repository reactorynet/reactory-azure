import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Audit trail for Microsoft Graph operations.
 *
 * `metadata` is written through AzureAuditService, which redacts every credential
 * key (`authorization`, `access_token`, `refresh_token`, `token`, `bearer`) before
 * the document is saved. Nothing here is trusted to be safe on its own.
 */
export interface IAzureAuditLog {
  userId: mongoose.Types.ObjectId;
  /** Logical operation, e.g. `mail.listMessages` or `auth.refresh`. */
  operation: string;
  /** Graph resource or path the operation touched, e.g. `/me/messages`. */
  resource: string;
  outcome: 'success' | 'failure';
  durationMs: number;
  /** Graph error code when the outcome is `failure`. */
  graphCode?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface IAzureAuditLogDocument extends IAzureAuditLog, Document {}

const AzureAuditLogSchema = new Schema<IAzureAuditLogDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    operation: {
      type: String,
      required: true,
    },
    resource: {
      type: String,
      required: true,
      default: '',
    },
    outcome: {
      type: String,
      required: true,
      enum: ['success', 'failure'],
    },
    durationMs: {
      type: Number,
      required: true,
      default: 0,
    },
    graphCode: {
      type: String,
    },
    correlationId: {
      type: String,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: false,
    collection: 'azure_audit_logs',
  },
);

AzureAuditLogSchema.index({ timestamp: -1 });
AzureAuditLogSchema.index({ userId: 1, operation: 1 });

const AzureAuditLog: Model<IAzureAuditLogDocument> =
  mongoose.models['AzureAuditLog']
  || mongoose.model<IAzureAuditLogDocument>('AzureAuditLog', AzureAuditLogSchema);

export { AzureAuditLog };
export default AzureAuditLog;

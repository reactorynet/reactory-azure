import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Per-user, per-resource delta cursor for Microsoft Graph change tracking.
 *
 * One row per `{ userId, resource }`. `deltaLink` is the opaque
 * `@odata.deltaLink` Graph handed back on the final page of the previous delta
 * query: requesting it returns only what changed since. When Graph rejects a
 * token (HTTP 410 `resyncRequired`) the link is cleared and the next read is a
 * full resync - which is why the row also records *that* a resync happened
 * (`fullResyncCount`, `lastFullResyncAt`, `lastSyncWasFullResync`). A caller can
 * therefore tell "we have never synced" from "our token expired and we rebuilt".
 *
 * `cursor` is a diagnostics field, not a second delta token: it holds the id of
 * the last item the loop processed, so a stalled or bounded sync can be
 * explained without re-running the query.
 */

/** The three Graph collections this module tracks deltas for. */
export type AzureSyncResource = 'messages' | 'events' | 'drive';

/**
 * `idle`      - row created, never synced.
 * `syncing`   - a delta loop is running.
 * `synced`    - the last loop completed and persisted a deltaLink.
 * `resync`    - the last loop completed after a 410 forced a full resync.
 * `error`     - the last loop failed; `lastError` carries the reason.
 */
export type AzureSyncStatus = 'idle' | 'syncing' | 'synced' | 'resync' | 'error';

export interface IAzureSyncState {
  userId: mongoose.Types.ObjectId;
  resource: AzureSyncResource;
  /** Opaque `@odata.deltaLink` from the last completed delta query. */
  deltaLink?: string | null;
  /** When the last delta loop completed successfully. */
  lastSyncedAt?: Date | null;
  /** Diagnostics: id of the last item the loop processed. */
  cursor?: string | null;
  status: AzureSyncStatus;
  /** Graph code / message from the last failed loop, for operators. */
  lastError?: string | null;
  /** Number of 410-triggered full resyncs performed for this row. */
  fullResyncCount: number;
  /** When the most recent full resync completed. */
  lastFullResyncAt?: Date | null;
  /** True when the most recent completed sync was a full resync. */
  lastSyncWasFullResync: boolean;
}

export interface IAzureSyncStateDocument extends IAzureSyncState, Document {}

const AzureSyncStateSchema = new Schema<IAzureSyncStateDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    resource: {
      type: String,
      required: true,
      enum: ['messages', 'events', 'drive'],
    },
    deltaLink: {
      type: String,
      default: null,
    },
    lastSyncedAt: {
      type: Date,
      default: null,
    },
    cursor: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      required: true,
      enum: ['idle', 'syncing', 'synced', 'resync', 'error'],
      default: 'idle',
    },
    lastError: {
      type: String,
      default: null,
    },
    fullResyncCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    lastFullResyncAt: {
      type: Date,
      default: null,
    },
    lastSyncWasFullResync: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  {
    timestamps: true,
    collection: 'azure_sync_states',
  },
);

// Exactly one cursor per user per resource: syncs upsert on this key.
AzureSyncStateSchema.index({ userId: 1, resource: 1 }, { unique: true });

const AzureSyncState: Model<IAzureSyncStateDocument> =
  mongoose.models['AzureSyncState']
  || mongoose.model<IAzureSyncStateDocument>('AzureSyncState', AzureSyncStateSchema);

export { AzureSyncState };
export default AzureSyncState;

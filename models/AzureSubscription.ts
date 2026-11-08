import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * A Microsoft Graph change-notification subscription owned by one user.
 *
 * `clientState` is the shared secret Graph echoes on every notification. It is
 * generated per subscription and stored **encrypted** (AES-256-GCM, see
 * `utils/token-encryption`) with a per-subscription `clientStateSalt`, exactly
 * like a refresh token: a leaked database row must not let anyone forge a
 * notification. Verification decrypts and compares in constant time.
 *
 * `expirationDateTime` is always the lifetime Graph actually **granted**, never
 * the one we asked for - Graph clamps resource-specifically (minutes to days).
 * `nextRenewAt` is derived from that grant (80% of the granted lifetime), so a
 * scheduler never has to guess a resource's maximum.
 */

/** Logical resources this module subscribes to. */
export type AzureSubscriptionResource = 'messages' | 'events' | 'drive';

export interface IAzureSubscription {
  userId: mongoose.Types.ObjectId;
  /** Graph's subscription id (`POST /subscriptions` response `id`). */
  subscriptionId: string;
  /** Logical resource (`messages` | `events` | `drive`). */
  resource: AzureSubscriptionResource;
  /** The Graph resource path the subscription was created against. */
  graphResource: string;
  /** `created`, `updated`, `deleted` - the change types Graph notifies on. */
  changeType: string[];
  notificationUrl: string;
  /** The expiry Graph granted on create/renew (not the one requested). */
  expirationDateTime: Date;
  /** Encrypted per-subscription client state (`iv:authTag:ciphertext`). */
  clientState: string;
  /** Per-subscription salt for `clientState` decryption. */
  clientStateSalt: string;
  /** When the subscription was created or last renewed. */
  renewedAt: Date;
  /** 80% of the granted lifetime: when renewal should run. */
  nextRenewAt?: Date | null;
  active: boolean;
}

export interface IAzureSubscriptionDocument extends IAzureSubscription, Document {}

const AzureSubscriptionSchema = new Schema<IAzureSubscriptionDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    subscriptionId: {
      type: String,
      required: true,
      index: true,
    },
    resource: {
      type: String,
      required: true,
      enum: ['messages', 'events', 'drive'],
    },
    graphResource: {
      type: String,
      required: true,
      default: '',
    },
    changeType: {
      type: [String],
      required: true,
      default: ['created', 'updated'],
    },
    notificationUrl: {
      type: String,
      required: true,
    },
    expirationDateTime: {
      type: Date,
      required: true,
    },
    clientState: {
      type: String,
      required: true,
    },
    clientStateSalt: {
      type: String,
      required: true,
    },
    renewedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    nextRenewAt: {
      type: Date,
      default: null,
    },
    active: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'azure_subscriptions',
  },
);

// One row per Graph subscription; a re-subscribe replaces the Graph id in place.
AzureSubscriptionSchema.index({ userId: 1, subscriptionId: 1 }, { unique: true });

const AzureSubscription: Model<IAzureSubscriptionDocument> =
  mongoose.models['AzureSubscription']
  || mongoose.model<IAzureSubscriptionDocument>('AzureSubscription', AzureSubscriptionSchema);

export { AzureSubscription };
export default AzureSubscription;

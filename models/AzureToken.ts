import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Vaulted Microsoft Graph credentials, one row per user.
 *
 * The collection is the *only* source of refreshable credentials in this module.
 * Tokens are AES-256-GCM encrypted with a per-user salt (see utils/token-encryption).
 *
 * Deliberate omissions: no scope string on a legacy token, no plaintext token,
 * no refresh token on the user document. Users who predate this collection are
 * served from the User document's `microsoft` authentication by the legacy bridge
 * in AzureAuthService - and that path never writes here.
 */
export interface IAzureToken {
  userId: mongoose.Types.ObjectId;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  accessTokenExpiry: Date;
  grantedScopes: string[];
  /** Entra object id (`oid`) of the connected account. */
  azureUserId: string;
  /** Entra tenant id (`tid`). */
  tenantId: string;
  /** User principal name (`upn` / `preferred_username`). */
  upn: string;
  encryptionSalt: string;
  connectedAt: Date;
  lastRefreshedAt?: Date;
  revokedAt?: Date;
}

export interface IAzureTokenDocument extends IAzureToken, Document {}

const AzureTokenSchema = new Schema<IAzureTokenDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    accessTokenEncrypted: {
      type: String,
      required: true,
    },
    refreshTokenEncrypted: {
      type: String,
      required: true,
    },
    accessTokenExpiry: {
      type: Date,
      required: true,
    },
    grantedScopes: {
      type: [String],
      required: true,
      default: [],
    },
    azureUserId: {
      type: String,
      required: true,
      default: '',
    },
    tenantId: {
      type: String,
      required: true,
      default: '',
    },
    upn: {
      type: String,
      required: true,
      default: '',
    },
    encryptionSalt: {
      type: String,
      required: true,
    },
    connectedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    lastRefreshedAt: {
      type: Date,
    },
    revokedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    collection: 'azure_tokens',
  },
);

// One credential set per user: the OAuth callback upserts on this key.
AzureTokenSchema.index({ userId: 1 }, { unique: true });

const AzureToken: Model<IAzureTokenDocument> =
  mongoose.models['AzureToken']
  || mongoose.model<IAzureTokenDocument>('AzureToken', AzureTokenSchema);

export { AzureToken };
export default AzureToken;

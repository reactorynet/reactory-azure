import crypto from 'crypto';

/**
 * AES-256-GCM token encryption.
 *
 * Graph access and refresh tokens are bearer credentials: they are encrypted at
 * rest with a key derived from `AZURE_TOKEN_ENCRYPTION_KEY` and a per-user salt
 * (stored beside the ciphertext, never derived from the user id). The ciphertext
 * format is `iv:authTag:ciphertext`, all base64.
 *
 * GCM gives us authenticated encryption, so a tampered ciphertext fails `final()`
 * instead of silently decrypting to garbage - `decryptToken` therefore throws.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** Raised when a ciphertext cannot be decrypted (tampered, wrong key or wrong salt). */
export class TokenEncryptionError extends Error {
  readonly code: string = 'TokenEncryptionError';

  constructor(message: string) {
    super(message);
    this.name = 'TokenEncryptionError';
  }
}

/** Derive a 32-byte key from the master key and the per-user salt (scrypt). */
function deriveKey(masterKey: string, salt: string): Buffer {
  if (!masterKey) {
    throw new TokenEncryptionError('Token encryption key is not configured');
  }
  if (!salt) {
    throw new TokenEncryptionError('Per-user encryption salt is required');
  }
  return crypto.scryptSync(masterKey, salt, KEY_LENGTH);
}

/**
 * Encrypt a plaintext token.
 *
 * @param plaintext - the token value
 * @param masterKey - `AZURE_TOKEN_ENCRYPTION_KEY`
 * @param salt - the user's `encryptionSalt`
 * @returns `iv:authTag:ciphertext`, base64 segments
 */
export function encryptToken(plaintext: string, masterKey: string, salt: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TokenEncryptionError('Cannot encrypt an empty token');
  }

  const key = deriveKey(masterKey, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8') as unknown as Uint8Array,
    cipher.final() as unknown as Uint8Array,
  ]);

  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a ciphertext produced by {@link encryptToken}.
 *
 * @throws TokenEncryptionError when the payload is malformed or fails authentication
 *         (which is what a tampered ciphertext does).
 */
export function decryptToken(ciphertext: string, masterKey: string, salt: string): string {
  if (typeof ciphertext !== 'string') {
    throw new TokenEncryptionError('Invalid encrypted token format');
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new TokenEncryptionError('Invalid encrypted token format');
  }

  const [ivB64, authTagB64, encryptedB64] = parts;

  try {
    const key = deriveKey(masterKey, salt);
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');

    if (iv.length !== IV_LENGTH || authTag.length !== 16) {
      throw new TokenEncryptionError('Invalid encrypted token format');
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedB64, 'base64')) as unknown as Uint8Array,
      decipher.final() as unknown as Uint8Array,
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    if (error instanceof TokenEncryptionError) throw error;
    throw new TokenEncryptionError('Could not decrypt token: authentication tag mismatch');
  }
}

/** Generate a random per-user salt for token encryption. */
export function generateEncryptionSalt(): string {
  return crypto.randomBytes(SALT_LENGTH).toString('base64');
}

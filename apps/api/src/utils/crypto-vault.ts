import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

/**
 * Derives the 32-byte key buffer from the hex env var.
 * Falls back to 64 zero-hex chars (all-zero key) when VAULT_MASTER_KEY is not set.
 * In production, VAULT_MASTER_KEY must be set to a cryptographically random 64-char hex string.
 */
function getMasterKey(): Buffer {
  const keyHex = process.env.VAULT_MASTER_KEY || '0'.repeat(64);
  if (keyHex.length !== 64) {
    throw new Error('VAULT_MASTER_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

export interface VaultEncrypted {
  ciphertext: string; // hex
  iv: string;         // hex, 12 bytes
  authTag: string;    // hex, 16 bytes
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns ciphertext, iv, and authTag for storage.
 */
export function encrypt(plaintext: string): VaultEncrypted {
  const key = getMasterKey();
  const iv = randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypts a VaultEncrypted payload back to plaintext.
 * Throws if the authTag verification fails (tampered data).
 */
export function decrypt(payload: VaultEncrypted): string {
  const key = getMasterKey();
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');
  const ciphertext = Buffer.from(payload.ciphertext, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Convenience: serialize VaultEncrypted to a single storable string.
 * Format: `{iv}.{authTag}.{ciphertext}` (all hex segments)
 */
export function encryptToString(plaintext: string): string {
  const { iv, authTag, ciphertext } = encrypt(plaintext);
  return `${iv}.${authTag}.${ciphertext}`;
}

/**
 * Convenience: deserialize and decrypt a stored vault string.
 * Expects the format produced by encryptToString: `{iv}.{authTag}.{ciphertext}`
 */
export function decryptFromString(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid vault string format: expected "{iv}.{authTag}.{ciphertext}"');
  }
  const [iv, authTag, ciphertext] = parts;
  return decrypt({ iv, authTag, ciphertext });
}

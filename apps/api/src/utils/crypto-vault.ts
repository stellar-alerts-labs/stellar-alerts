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

export interface KeyRotationOptions {
  newKey: string;
  newVersion: string;
  batchSize?: number;
  dryRun?: boolean;
}

export interface KeyRotationResult {
  success: boolean;
  rotatedCount: number;
  failedCount: number;
  errors: string[];
  newVersion: string;
}

export class MasterKeyRotationManager {
  private static readonly DEFAULT_BATCH_SIZE = 100;
  private static readonly GRACE_PERIOD_MS = 48 * 60 * 60 * 1000; // 48 hours

  async rotateMasterKey(options: KeyRotationOptions): Promise<KeyRotationResult> {
    const { newKey, newVersion, batchSize = MasterKeyRotationManager.DEFAULT_BATCH_SIZE, dryRun = false } = options;
    const result: KeyRotationResult = {
      success: true,
      rotatedCount: 0,
      failedCount: 0,
      errors: [],
      newVersion,
    };

    try {
      // Add new key to CryptoVault
      cryptoVault.addKey(newVersion, newKey);

      // Re-encrypt all sensitive data
      const webhookRotationResult = await this.rotateWebhookSecrets(newVersion, batchSize, dryRun);
      result.rotatedCount += webhookRotationResult.rotatedCount;
      result.failedCount += webhookRotationResult.failedCount;
      result.errors.push(...webhookRotationResult.errors);

      const walletRotationResult = await this.rotateWalletCredentials(newVersion, batchSize, dryRun);
      result.rotatedCount += walletRotationResult.rotatedCount;
      result.failedCount += walletRotationResult.failedCount;
      result.errors.push(...walletRotationResult.errors);

      const botTokenRotationResult = await this.rotateBotTokens(newVersion, batchSize, dryRun);
      result.rotatedCount += botTokenRotationResult.rotatedCount;
      result.failedCount += botTokenRotationResult.failedCount;
      result.errors.push(...botTokenRotationResult.errors);

      if (result.failedCount > 0) {
        result.success = false;
      }

      return result;
    } catch (error: any) {
      result.success = false;
      result.errors.push(error.message);
      return result;
    }
  }

  private async rotateWebhookSecrets(
    newVersion: string,
    batchSize: number,
    dryRun: boolean
  ): Promise<{ rotatedCount: number; failedCount: number; errors: string[] }> {
    const { prisma } = await import('../lib/prisma');
    let rotatedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    const webhooks = await prisma.webhook.findMany({
      where: {
        keyVersion: { lt: parseInt(newVersion, 10) },
      },
      take: batchSize,
    });

    for (const webhook of webhooks) {
      try {
        const encrypted = [
          String(webhook.keyVersion),
          webhook.secretIv,
          webhook.secretAuthTag,
          webhook.secretCiphertext,
        ].join(':');

        const decrypted = cryptoVault.decrypt(encrypted);
        const reEncrypted = cryptoVault.encrypt(decrypted);
        const [ver, iv, authTag, ciphertext] = reEncrypted.split(':');

        if (!dryRun) {
          await prisma.webhook.update({
            where: { id: webhook.id },
            data: {
              secretCiphertext: ciphertext,
              secretIv: iv,
              secretAuthTag: authTag,
              keyVersion: parseInt(newVersion, 10),
            },
          });
        }

        rotatedCount++;
      } catch (error: any) {
        failedCount++;
        errors.push(`Failed to rotate webhook ${webhook.id}: ${error.message}`);
      }
    }

    return { rotatedCount, failedCount, errors };
  }

  private async rotateWalletCredentials(
    newVersion: string,
    batchSize: number,
    dryRun: boolean
  ): Promise<{ rotatedCount: number; failedCount: number; errors: string[] }> {
    const { prisma } = await import('../lib/prisma');
    let rotatedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    // Note: Implement wallet credential rotation if wallet credentials are encrypted
    // This is a placeholder for future implementation
    return { rotatedCount, failedCount, errors };
  }

  private async rotateBotTokens(
    newVersion: string,
    batchSize: number,
    dryRun: boolean
  ): Promise<{ rotatedCount: number; failedCount: number; errors: string[] }> {
    const { prisma } = await import('../lib/prisma');
    let rotatedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    // Note: Implement bot token rotation if bot tokens are encrypted
    // This is a placeholder for future implementation
    return { rotatedCount, failedCount, errors };
  }

  private deriveKey(key: string): Buffer {
    const safeKey = key || 'default_master_encryption_key_32bytes_long!';
    return crypto.createHash('sha256').update(safeKey).digest();
  }

  generateNewKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  getGracePeriodMs(): number {
    return MasterKeyRotationManager.GRACE_PERIOD_MS;
  }
}

export const masterKeyRotationManager = new MasterKeyRotationManager();

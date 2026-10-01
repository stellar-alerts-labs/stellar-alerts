import crypto from 'crypto';

const SEPARATOR = ':';

export interface EncryptedSecretParts {
  version: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class CryptoVault {
  private currentKey: Buffer;
  private currentVersion: string;
  private keys: Map<string, Buffer>;

  constructor(
    currentKey: string,
    currentVersion: string = '1',
    oldKeys: Record<string, string> = {}
  ) {
    this.currentVersion = currentVersion;
    this.currentKey = this.deriveKey(currentKey);
    this.keys = new Map([[currentVersion, this.currentKey]]);

    for (const [version, key] of Object.entries(oldKeys)) {
      this.keys.set(version, this.deriveKey(key));
    }
  }

  private deriveKey(key: string): Buffer {
    // Ensure consistent 32-byte key for AES-256-GCM
    const safeKey = key || 'default_master_encryption_key_32bytes_long!';
    return crypto.createHash('sha256').update(safeKey).digest();
  }

  /**
   * Registers a derived key under a version label.
   *
   * Used by `MasterKeyRotationManager` to make a new master key decryptable
   * alongside the retired ones before any re-encryption happens. Exposed
   * rather than written to the private map directly so the key-derivation
   * contract stays owned by the vault.
   */
  addKeyVersion(version: string, key: string): void {
    this.keys.set(version, this.deriveKey(key));
  }

  /** The version new ciphertext is written under. */
  get activeVersion(): string {
    return this.currentVersion;
  }

  /** Version labels the vault can currently decrypt. */
  get knownVersions(): string[] {
    return [...this.keys.keys()];
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.currentKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      this.currentVersion,
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(SEPARATOR);
  }

  decrypt(encrypted: string): string {
    const parts = encrypted.split(SEPARATOR);
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted secret format');
    }

    const [version, iv, authTag, ciphertext] = parts;
    const key = this.keys.get(version);

    if (!key) {
      throw new Error(`Unknown encryption key version: ${version}`);
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }
}

const oldKeys = process.env.MASTER_ENCRYPTION_OLD_KEYS
  ? JSON.parse(process.env.MASTER_ENCRYPTION_OLD_KEYS)
  : {};

export const cryptoVault = new CryptoVault(
  process.env.MASTER_ENCRYPTION_KEY!,
  process.env.MASTER_ENCRYPTION_KEY_VERSION ?? '1',
  oldKeys
);

export interface WebhookSecretParts {
  secretCiphertext: string;
  secretIv: string;
  secretAuthTag: string;
  keyVersion: number;
}

/** Combines split DB secret fields into the `version:iv:authTag:ciphertext` format CryptoVault expects. */
export function joinEncryptedSecretParts(parts: WebhookSecretParts): string {
  return [String(parts.keyVersion), parts.secretIv, parts.secretAuthTag, parts.secretCiphertext].join(SEPARATOR);
}

/** Splits a CryptoVault-encrypted string into the DB's separate secret fields. */
export function splitEncryptedSecret(encrypted: string): WebhookSecretParts {
  const [version, iv, authTag, ciphertext] = encrypted.split(SEPARATOR);
  return { secretCiphertext: ciphertext, secretIv: iv, secretAuthTag: authTag, keyVersion: Number(version) };
}

/** Decrypts a webhook secret from its combined encrypted string form. */
export function decryptSecret(encrypted: string): string {
  return cryptoVault.decrypt(encrypted);
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
      // Make the new key decryptable before anything is re-encrypted, so a
      // mid-rotation failure leaves old ciphertext readable.
      cryptoVault.addKeyVersion(newVersion, newKey);

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

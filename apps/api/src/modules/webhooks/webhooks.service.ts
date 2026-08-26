import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { generateWebhookSignature } from '../../utils/webhook-signer';
import { encryptToString, decryptFromString } from '../../utils/crypto-vault';

export interface WebhookTestResult {
  success: boolean;
  status: number | null;
  message: string;
}

const WEBHOOK_TEST_TIMEOUT_MS = 10_000;

export class WebhooksService {
  async addWebhook(userId: string, url: string) {
    console.log(`[WebhooksService] Registering webhook ${url} for user ${userId}`);
    const rawSecret = crypto.randomBytes(32).toString('hex');
    // Encrypt the secret before persisting — only the vault-encrypted form is stored
    const secret = encryptToString(rawSecret);

    return prisma.webhook.create({
      data: {
        userId,
        url,
        secret,
      },
      select: {
        id: true,
        url: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async getWebhooks(userId: string) {
    return prisma.webhook.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        url: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async removeWebhook(id: string, userId: string) {
    const deleted = await prisma.webhook.deleteMany({
      where: { id, userId },
    });

    if (deleted.count === 0) {
      throw new Error('Webhook not found');
    }

    return { success: true };
  }

  async sendTestWebhook(id: string, userId: string): Promise<WebhookTestResult> {
    const webhook = await prisma.webhook.findUnique({ where: { id } });

    if (!webhook || webhook.userId !== userId) {
      throw new Error('Webhook not found');
    }

    const payload = JSON.stringify({
      event: 'webhook.ping',
      timestamp: new Date().toISOString(),
      data: {
        webhookId: webhook.id,
        message: 'Test ping dispatched from Stellar Alerts',
      },
    });

    // Decrypt the stored vault secret before signing
    const rawSecret = decryptFromString(webhook.secret);
    const signature = generateWebhookSignature(payload, rawSecret);

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stellar-Signature': signature.headerValue,
          'X-Stellar-Alerts-Nonce': signature.nonce,
        },
        body: payload,
        signal: AbortSignal.timeout(WEBHOOK_TEST_TIMEOUT_MS),
      });

      return {
        success: response.ok,
        status: response.status,
        message: response.ok
          ? 'Ping payload delivered successfully.'
          : `Endpoint responded with status ${response.status}.`,
      };
    } catch (error: any) {
      console.error(`[WebhooksService] Failed to deliver test ping to ${webhook.url}:`, error.message);
      return {
        success: false,
        status: null,
        message: `Failed to reach endpoint: ${error.message}`,
      };
    }
  }
}

export const webhooksService = new WebhooksService();

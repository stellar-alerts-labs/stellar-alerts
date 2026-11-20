/**
 * Discord Notification Dispatcher Integration Tests
 *
 * Validates the end-to-end integration of Discord webhook notifications
 * with the dispatcher worker, including:
 * - Alert payload transformation
 * - Rich embed formatting
 * - Rate limit handling and retries
 * - Severity-to-color mapping
 * - Explorer link generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discordNotificationProvider } from '../discord.dispatcher';
import type { DiscordAlertInput } from '../discord.dispatcher';

describe('Discord Dispatcher Worker Integration', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('Alert payload transformation', () => {
    it('transforms payment alert into Discord embed with all required fields', () => {
      const paymentAlert: DiscordAlertInput = {
        paymentId: 'pay-123',
        txHash: 'abcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234',
        amount: '1000.50',
        asset: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        fromAddress: 'GABC123SENDER',
        recipientAddress: 'GDEF456RECEIVER',
        receivedAt: '2026-10-20T10:00:00Z',
        severity: 'info',
        network: 'public',
      };

      const payload = discordNotificationProvider.buildWebhookPayload(paymentAlert);
      const embed = payload.embeds[0];

      expect(embed).toBeDefined();
      expect(embed.title).toContain('Payment');
      expect(embed.color).toBe(0x5865f2); // info color
      expect(embed.fields.length).toBeGreaterThan(0);

      const fieldNames = embed.fields.map((f) => f.name);
      expect(fieldNames).toContain('Amount');
      expect(fieldNames).toContain('Asset');
      expect(fieldNames).toContain('From');
      expect(fieldNames).toContain('To');
      expect(fieldNames).toContain('Hash');

      expect(embed.url).toContain('stellar.expert');
      expect(embed.url).toContain(paymentAlert.txHash);
      expect(embed.timestamp).toBe('2026-10-20T10:00:00.000Z');
    });

    it('transforms contract alert into Discord embed with contract-specific fields', () => {
      const contractAlert: DiscordAlertInput = {
        alertId: 'alert-contract-456',
        type: 'contract',
        txHash: 'contract0000000000000000000000000000000000000000000000000000000',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        eventType: 'transfer',
        severity: 'warning',
        receivedAt: new Date('2026-10-20T12:00:00Z'),
        network: 'testnet',
      };

      const payload = discordNotificationProvider.buildWebhookPayload(contractAlert);
      const embed = payload.embeds[0];

      expect(embed.title).toContain('Contract Alert');
      expect(embed.color).toBe(0xfee75c); // warning color

      const fieldNames = embed.fields.map((f) => f.name);
      expect(fieldNames).toContain('Contract');
      expect(fieldNames).toContain('Event');
      expect(fieldNames).toContain('Hash');

      expect(embed.url).toContain('testnet');
      expect(embed.footer?.text).toContain('Testnet');
    });
  });

  describe('Severity color mapping', () => {
    it.each([
      ['critical', 0xed4245],
      ['error', 0xe74c3c],
      ['warning', 0xfee75c],
      ['info', 0x5865f2],
      ['success', 0x57f287],
    ])('maps %s severity to color 0x%s', (severity, expectedColor) => {
      const alert: DiscordAlertInput = {
        txHash: 'test123',
        severity,
        receivedAt: new Date(),
      };

      const payload = discordNotificationProvider.buildWebhookPayload(alert);
      expect(payload.embeds[0].color).toBe(expectedColor);
    });
  });

  describe('Rate limit handling', () => {
    it('handles HTTP 429 with X-RateLimit-Reset header and retries', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 2;

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'rate limited' }), {
            status: 429,
            headers: {
              'x-ratelimit-reset': String(resetAt),
              'content-type': 'application/json',
            },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const alert: DiscordAlertInput = {
        txHash: 'test789',
        amount: '100',
        asset: 'XLM',
        receivedAt: new Date(),
      };

      const result = await discordNotificationProvider.dispatch(
        { webhookUrl: 'https://discord.com/api/webhooks/123/token' },
        alert,
        {
          maxRetries: 1,
          baseRetryDelayMs: 0,
        },
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('handles HTTP 429 with Retry-After header', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '5' },
        }),
      );

      const alert: DiscordAlertInput = {
        txHash: 'test456',
        receivedAt: new Date(),
      };

      const result = await discordNotificationProvider.dispatch(
        { webhookUrl: 'https://discord.com/api/webhooks/123/token' },
        alert,
        { maxRetries: 0 },
      );

      expect(result.success).toBe(false);
      expect(result.rateLimited).toBe(true);
      expect(result.retryAfterSeconds).toBe(5);
    });

    it('handles HTTP 429 with retry_after in response body', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ retry_after: 3.5 }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const alert: DiscordAlertInput = {
        txHash: 'test999',
        receivedAt: new Date(),
      };

      const result = await discordNotificationProvider.dispatch(
        { webhookUrl: 'https://discord.com/api/webhooks/123/token' },
        alert,
        { maxRetries: 0 },
      );

      expect(result.rateLimited).toBe(true);
      expect(result.retryAfterSeconds).toBe(3.5);
    });
  });

  describe('Explorer link generation', () => {
    it('generates correct Stellar Expert link for public network', () => {
      const alert: DiscordAlertInput = {
        txHash: 'publichash123',
        receivedAt: new Date(),
        network: 'public',
      };

      const payload = discordNotificationProvider.buildWebhookPayload(alert);
      const embed = payload.embeds[0];

      expect(embed.url).toBe(
        'https://stellar.expert/explorer/public/tx/publichash123',
      );
    });

    it('generates correct Stellar Expert link for testnet', () => {
      const alert: DiscordAlertInput = {
        txHash: 'testnethash456',
        receivedAt: new Date(),
        network: 'testnet',
      };

      const payload = discordNotificationProvider.buildWebhookPayload(alert);
      const embed = payload.embeds[0];

      expect(embed.url).toBe(
        'https://stellar.expert/explorer/testnet/tx/testnethash456',
      );
    });

    it('includes contract explorer link in embed fields', () => {
      const alert: DiscordAlertInput = {
        txHash: 'contracttx123',
        contractId: 'CCONTRACT123',
        type: 'contract',
        receivedAt: new Date(),
        network: 'public',
      };

      const payload = discordNotificationProvider.buildWebhookPayload(alert);
      const contractField = payload.embeds[0].fields.find((f) => f.name === 'Contract');

      expect(contractField).toBeDefined();
      expect(contractField?.value).toContain('stellar.expert');
      expect(contractField?.value).toContain('/contract/');
      expect(contractField?.value).toContain('CCONTRACT123');
    });
  });

  describe('Asset icon resolution', () => {
    it('includes thumbnail for known assets (XLM, USDC, EURC)', () => {
      const xlmAlert: DiscordAlertInput = {
        txHash: 'xlmtx',
        asset: 'XLM',
        receivedAt: new Date(),
      };

      const usdcAlert: DiscordAlertInput = {
        txHash: 'usdctx',
        asset: 'USDC',
        receivedAt: new Date(),
      };

      const xlmPayload = discordNotificationProvider.buildWebhookPayload(xlmAlert);
      const usdcPayload = discordNotificationProvider.buildWebhookPayload(usdcAlert);

      expect(xlmPayload.embeds[0].thumbnail?.url).toContain('stellar-xlm-logo');
      expect(usdcPayload.embeds[0].thumbnail?.url).toContain('usd-coin-usdc-logo');
    });

    it('omits thumbnail for unknown assets', () => {
      const alert: DiscordAlertInput = {
        txHash: 'unknowntx',
        asset: 'CUSTOM_TOKEN',
        receivedAt: new Date(),
      };

      const payload = discordNotificationProvider.buildWebhookPayload(alert);
      expect(payload.embeds[0].thumbnail).toBeUndefined();
    });
  });

  describe('Webhook URL validation', () => {
    it('rejects invalid webhook URLs without making network requests', async () => {
      global.fetch = vi.fn();

      const alert: DiscordAlertInput = {
        txHash: 'test',
        receivedAt: new Date(),
      };

      const invalidUrls = [
        'https://example.com/webhook',
        'http://discord.com/api/webhooks/123/token',
        'https://discord.com/not-a-webhook',
        'not-a-url',
      ];

      for (const url of invalidUrls) {
        const result = await discordNotificationProvider.dispatch(
          { webhookUrl: url },
          alert,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('webhook URL');
        expect(global.fetch).not.toHaveBeenCalled();
      }
    });

    it('accepts valid Discord webhook URLs', () => {
      const validUrls = [
        'https://discord.com/api/webhooks/123456/abcdef',
        'https://discordapp.com/api/webhooks/123456/token',
      ];

      for (const url of validUrls) {
        expect(discordNotificationProvider.isValidWebhookUrl(url)).toBe(true);
      }
    });
  });

  describe('HTTP error handling', () => {
    it('returns error for non-retryable 4xx responses', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response('Bad Request', { status: 400 }));

      const alert: DiscordAlertInput = {
        txHash: 'test',
        receivedAt: new Date(),
      };

      const result = await discordNotificationProvider.dispatch(
        { webhookUrl: 'https://discord.com/api/webhooks/123/token' },
        alert,
      );

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toContain('HTTP 400');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries 5xx server errors with exponential backoff', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('Internal Server Error', { status: 500 }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const alert: DiscordAlertInput = {
        txHash: 'test',
        receivedAt: new Date(),
      };

      const result = await discordNotificationProvider.dispatch(
        { webhookUrl: 'https://discord.com/api/webhooks/123/token' },
        alert,
        {
          maxRetries: 1,
          baseRetryDelayMs: 0,
        },
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});

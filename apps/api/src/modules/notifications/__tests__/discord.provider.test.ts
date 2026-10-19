import { describe, expect, it, vi } from 'vitest';
import {
  DiscordNotificationProvider,
  DEFAULT_ASSET_ICON_URLS,
  DISCORD_SEVERITY_COLORS,
} from '../providers/discord.provider';

describe('Multi-Tenant Discord Webhook Rich Embed Formatter (#636)', () => {
  const sampleTxHash =
    '8f9e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e';
  const sampleFrom =
    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  const sampleTo =
    'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

  it('formats incoming payment and contract alerts into rich Discord embed payloads with dynamic asset icons', () => {
    const provider = new DiscordNotificationProvider({
      nowFn: () => Date.parse('2026-10-20T12:00:00.000Z'),
    });

    // 1. USDC payment alert with multi-tenant branding
    const usdcPayload = provider.buildRichEmbedPayload({
      eventType: 'payment.received',
      severity: 'success',
      amount: 12500.5,
      asset: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      fromAddress: sampleFrom,
      toAddress: sampleTo,
      txHash: sampleTxHash,
      memo: 'DAO-TREASURY-Q4',
      tenant: {
        tenantId: 'tenant_dao_1',
        tenantName: 'Aquarius DAO Treasury',
        username: 'Aquarius Alert Bot',
        avatarUrl: 'https://example.com/dao-avatar.png',
        network: 'public',
      },
    });

    expect(usdcPayload.username).toBe('Aquarius Alert Bot');
    expect(usdcPayload.avatar_url).toBe('https://example.com/dao-avatar.png');
    expect(usdcPayload.embeds).toHaveLength(1);

    const embed = usdcPayload.embeds[0];
    expect(embed.title).toContain('12,500.5 USDC');
    expect(embed.color).toBe(DISCORD_SEVERITY_COLORS.success);
    expect(embed.thumbnail.url).toBe(DEFAULT_ASSET_ICON_URLS.USDC);
    expect(embed.url).toBe(
      `https://stellar.expert/explorer/public/tx/${sampleTxHash}`
    );

    const fieldMap = new Map(embed.fields.map((f) => [f.name, f.value]));
    expect(fieldMap.get('Amount')).toBe('**12,500.5 USDC**');
    expect(fieldMap.get('Asset')).toContain('USDC');
    expect(fieldMap.get('From')).toContain(
      `https://stellar.expert/explorer/public/account/${sampleFrom}`
    );
    expect(fieldMap.get('To')).toContain(
      `https://stellar.expert/explorer/public/account/${sampleTo}`
    );
    expect(fieldMap.get('Hash')).toContain(
      `https://stellar.expert/explorer/public/tx/${sampleTxHash}`
    );
    expect(fieldMap.get('Memo')).toBe('`DAO-TREASURY-Q4`');

    // 2. Resolves XLM, EURC, custom tenant icons, and fallback generic icon
    expect(provider.resolveAssetIconUrl('xlm')).toBe(DEFAULT_ASSET_ICON_URLS.XLM);
    expect(provider.resolveAssetIconUrl('EURC')).toBe(DEFAULT_ASSET_ICON_URLS.EURC);
    expect(
      provider.resolveAssetIconUrl('MYTOKEN', {
        MYTOKEN: 'https://cdn.example.com/mytoken.png',
      })
    ).toBe('https://cdn.example.com/mytoken.png');
    expect(provider.resolveAssetIconUrl('UNKNOWN_ASSET')).toBe(
      DEFAULT_ASSET_ICON_URLS.DEFAULT
    );
  });

  it('handles Discord 429 rate-limit responses using X-RateLimit-Reset / Retry-After headers and succeeds on retry', async () => {
    const sleepCalls: number[] = [];
    const baseNowMs = 1_760_000_000_000;

    const mockFetch = vi
      .fn()
      // 1st attempt: 429 with X-RateLimit-Reset (1.5 seconds in the future)
      .mockResolvedValueOnce({
        status: 429,
        headers: new Headers({
          'X-RateLimit-Reset': String((baseNowMs + 1500) / 1000),
        }),
        json: async () => ({ message: 'You are being rate limited.', retry_after: 1.5 }),
      })
      // 2nd attempt: 502 Bad Gateway transient failure
      .mockResolvedValueOnce({
        status: 502,
        headers: new Headers(),
        json: async () => ({}),
      })
      // 3rd attempt: 204 No Content (Discord webhook success)
      .mockResolvedValueOnce({
        status: 204,
        headers: new Headers(),
        json: async () => ({}),
      });

    const provider = new DiscordNotificationProvider({
      maxRetries: 3,
      baseBackoffMs: 200,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleepImpl: async (ms: number) => {
        sleepCalls.push(ms);
      },
      nowFn: () => baseNowMs,
    });

    const result = await provider.sendAlert(
      'https://discord.com/api/webhooks/123456789/abcdefg',
      {
        eventType: 'whale.detected',
        amount: 500_000,
        asset: 'XLM',
        fromAddress: sampleFrom,
        toAddress: sampleTo,
        txHash: sampleTxHash,
      }
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(204);
    expect(result.attempts).toBe(3);
    expect(result.rateLimitedCount).toBe(1);
    expect(sleepCalls[0]).toBe(1500);
    expect(sleepCalls[1]).toBe(400); // 200 * 2^1 exponential backoff on 2nd attempt (index 1)
  });

  it('returns failure after exhausting maxRetries on persistent 429 rate limiting', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 429,
      headers: new Headers({ 'Retry-After': '1' }),
      json: async () => ({ retry_after: 1 }),
    });

    const provider = new DiscordNotificationProvider({
      maxRetries: 2,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    const result = await provider.sendAlert(
      'https://discord.com/api/webhooks/123456789/abcdefg',
      {
        amount: 100,
        asset: 'EURC',
        fromAddress: sampleFrom,
        toAddress: sampleTo,
        txHash: sampleTxHash,
      }
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.attempts).toBe(3);
    expect(result.rateLimitedCount).toBe(3);
    expect(result.error).toMatch(/rate limit/i);
  });
});

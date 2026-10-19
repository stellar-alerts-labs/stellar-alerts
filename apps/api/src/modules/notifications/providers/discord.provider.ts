export function isValidDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') &&
      parsed.pathname.startsWith('/api/webhooks/')
    );
  } catch {
    return false;
  }
}

export type DiscordAlertSeverity = 'info' | 'success' | 'warning' | 'critical';
export type StellarNetworkName = 'public' | 'testnet';

export const DISCORD_SEVERITY_COLORS: Record<DiscordAlertSeverity, number> = {
  info: 0x3498db,
  success: 0x2ecc71,
  warning: 0xf39c12,
  critical: 0xe74c3c,
};

export const DEFAULT_ASSET_ICON_URLS: Record<string, string> = {
  XLM: 'https://assets.stellar.org/icons/xlm.png',
  USDC: 'https://assets.stellar.org/icons/usdc.png',
  EURC: 'https://assets.stellar.org/icons/eurc.png',
  AQUA: 'https://assets.stellar.org/icons/aqua.png',
  YXLM: 'https://assets.stellar.org/icons/yxlm.png',
  DEFAULT: 'https://assets.stellar.org/icons/generic-token.png',
};

export interface DiscordTenantBranding {
  tenantId?: string;
  tenantName?: string;
  username?: string;
  avatarUrl?: string;
  footerText?: string;
  network?: StellarNetworkName;
  customAssetIcons?: Record<string, string>;
}

export interface DiscordAlertEventInput {
  eventType?: 'payment.received' | 'contract.invoked' | 'whale.detected' | string;
  severity?: DiscordAlertSeverity;
  amount: string | number;
  asset: string;
  assetIssuer?: string | null;
  fromAddress: string;
  toAddress: string;
  txHash: string;
  memo?: string | null;
  contractId?: string | null;
  timestamp?: string | Date;
  tenant?: DiscordTenantBranding;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordRichEmbed {
  title: string;
  description: string;
  url: string;
  color: number;
  timestamp: string;
  thumbnail: {
    url: string;
  };
  author?: {
    name: string;
    icon_url?: string;
  };
  fields: DiscordEmbedField[];
  footer: {
    text: string;
    icon_url?: string;
  };
}

export interface DiscordWebhookPayload {
  username: string;
  avatar_url?: string;
  embeds: DiscordRichEmbed[];
}

export interface DiscordDeliveryOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  maxWaitMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

export interface DiscordDeliveryResult {
  success: boolean;
  statusCode?: number;
  attempts: number;
  rateLimitedCount: number;
  totalRetryWaitMs: number;
  error?: string;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DiscordNotificationProvider {
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxWaitMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;

  constructor(options: DiscordDeliveryOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 250;
    this.maxWaitMs = options.maxWaitMs ?? 15_000;
    this.fetchFn = options.fetchImpl ?? fetch;
    this.sleepFn = options.sleepImpl ?? defaultSleep;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  /**
   * Resolves the canonical icon URL for common Stellar assets (`XLM`, `USDC`, `EURC`, etc.)
   * with support for per-tenant custom icon overrides.
   */
  public resolveAssetIconUrl(
    assetCode: string,
    customIcons?: Record<string, string>
  ): string {
    const normalized = (assetCode || 'XLM').trim().toUpperCase();
    if (customIcons && customIcons[normalized]) {
      return customIcons[normalized];
    }
    return DEFAULT_ASSET_ICON_URLS[normalized] ?? DEFAULT_ASSET_ICON_URLS.DEFAULT;
  }

  /**
   * Builds a clickable Stellar Expert explorer link for a transaction or account.
   */
  public static buildStellarExpertUrl(
    type: 'tx' | 'account' | 'contract',
    identifier: string,
    network: StellarNetworkName = 'public'
  ): string {
    return `https://stellar.expert/explorer/${network}/${type}/${identifier}`;
  }

  /**
   * Formats a numeric or string amount with thousands separators while preserving decimals.
   */
  public static formatDisplayAmount(amount: string | number): string {
    const numeric = typeof amount === 'number' ? amount : Number(amount);
    if (!Number.isFinite(numeric)) {
      return String(amount);
    }
    const [intPart, decPart] = numeric.toFixed(7).replace(/\.?0+$/, '').split('.');
    const formattedInt = Number(intPart).toLocaleString('en-US');
    return decPart ? `${formattedInt}.${decPart}` : formattedInt;
  }

  /**
   * Constructs a Discord-compliant webhook payload with a rich embed card,
   * dynamic asset thumbnail, color-coded severity, and clickable Stellar Expert links.
   */
  public buildRichEmbedPayload(
    event: DiscordAlertEventInput
  ): DiscordWebhookPayload {
    const network: StellarNetworkName = event.tenant?.network ?? 'public';
    const assetCode = (event.asset || 'XLM').trim().toUpperCase();
    const formattedAmount = DiscordNotificationProvider.formatDisplayAmount(
      event.amount
    );
    const assetIconUrl = this.resolveAssetIconUrl(
      assetCode,
      event.tenant?.customAssetIcons
    );

    const severity: DiscordAlertSeverity =
      event.severity ??
      (event.eventType === 'whale.detected'
        ? 'critical'
        : event.eventType === 'contract.invoked'
          ? 'warning'
          : 'success');

    const color = DISCORD_SEVERITY_COLORS[severity] ?? DISCORD_SEVERITY_COLORS.info;
    const txUrl = DiscordNotificationProvider.buildStellarExpertUrl(
      'tx',
      event.txHash,
      network
    );
    const fromUrl = DiscordNotificationProvider.buildStellarExpertUrl(
      'account',
      event.fromAddress,
      network
    );
    const toUrl = DiscordNotificationProvider.buildStellarExpertUrl(
      'account',
      event.toAddress,
      network
    );

    const shorten = (addr: string) =>
      addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-6)}` : addr;

    const titlePrefix =
      event.eventType === 'whale.detected'
        ? '🐋 Whale Transaction Detected'
        : event.eventType === 'contract.invoked'
          ? '📜 Soroban Contract Alert'
          : '💸 Stellar Payment Alert';

    const fields: DiscordEmbedField[] = [
      {
        name: 'Amount',
        value: `**${formattedAmount} ${assetCode}**`,
        inline: true,
      },
      {
        name: 'Asset',
        value: event.assetIssuer
          ? `${assetCode} (\`${shorten(event.assetIssuer)}\`)`
          : `${assetCode} (Native)`,
        inline: true,
      },
      {
        name: 'From',
        value: `[\`${shorten(event.fromAddress)}\`](${fromUrl})`,
        inline: true,
      },
      {
        name: 'To',
        value: `[\`${shorten(event.toAddress)}\`](${toUrl})`,
        inline: true,
      },
      {
        name: 'Hash',
        value: `[\`${shorten(event.txHash)}\`](${txUrl})`,
        inline: false,
      },
    ];

    if (event.contractId) {
      const contractUrl = DiscordNotificationProvider.buildStellarExpertUrl(
        'contract',
        event.contractId,
        network
      );
      fields.push({
        name: 'Contract',
        value: `[\`${shorten(event.contractId)}\`](${contractUrl})`,
        inline: true,
      });
    }

    if (event.memo) {
      fields.push({
        name: 'Memo',
        value: `\`${event.memo}\``,
        inline: true,
      });
    }

    const timestampIso =
      event.timestamp instanceof Date
        ? event.timestamp.toISOString()
        : typeof event.timestamp === 'string'
          ? new Date(event.timestamp).toISOString()
          : new Date(this.nowFn()).toISOString();

    const tenantName = event.tenant?.tenantName || 'Stellar Alerts';
    const footerText =
      event.tenant?.footerText ||
      `${tenantName} • Stellar ${network === 'public' ? 'Mainnet' : 'Testnet'}`;

    const embed: DiscordRichEmbed = {
      title: `${titlePrefix}: ${formattedAmount} ${assetCode}`,
      description: `View transaction details on [Stellar Expert](${txUrl}).`,
      url: txUrl,
      color,
      timestamp: timestampIso,
      thumbnail: {
        url: assetIconUrl,
      },
      author: {
        name: tenantName,
        icon_url: event.tenant?.avatarUrl ?? assetIconUrl,
      },
      fields,
      footer: {
        text: footerText,
        icon_url: assetIconUrl,
      },
    };

    return {
      username: event.tenant?.username || tenantName,
      avatar_url: event.tenant?.avatarUrl,
      embeds: [embed],
    };
  }

  /**
   * Computes wait duration in milliseconds from Discord's rate-limit headers
   * (`X-RateLimit-Reset-After`, `Retry-After`, or `X-RateLimit-Reset`) or exponential backoff.
   */
  public computeRetryDelayMs(
    attemptIndex: number,
    headers?: Headers | Record<string, string | undefined>,
    bodyRetryAfterSeconds?: number
  ): number {
    const getHeader = (name: string): string | null => {
      if (!headers) return null;
      if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name);
      }
      const record = headers as Record<string, string | undefined>;
      const foundKey = Object.keys(record).find(
        (k) => k.toLowerCase() === name.toLowerCase()
      );
      return foundKey ? (record[foundKey] ?? null) : null;
    };

    const resetAfterRaw =
      getHeader('x-ratelimit-reset-after') ?? getHeader('retry-after');
    if (resetAfterRaw !== null) {
      const parsedSec = Number(resetAfterRaw);
      if (Number.isFinite(parsedSec) && parsedSec >= 0) {
        return Math.min(this.maxWaitMs, Math.ceil(parsedSec * 1000));
      }
    }

    const resetEpochRaw = getHeader('x-ratelimit-reset');
    if (resetEpochRaw !== null) {
      const resetEpochSec = Number(resetEpochRaw);
      if (Number.isFinite(resetEpochSec) && resetEpochSec > 0) {
        const deltaMs = Math.max(0, Math.ceil(resetEpochSec * 1000 - this.nowFn()));
        return Math.min(this.maxWaitMs, deltaMs);
      }
    }

    if (
      typeof bodyRetryAfterSeconds === 'number' &&
      Number.isFinite(bodyRetryAfterSeconds) &&
      bodyRetryAfterSeconds > 0
    ) {
      return Math.min(this.maxWaitMs, Math.ceil(bodyRetryAfterSeconds * 1000));
    }

    const expBackoff = this.baseBackoffMs * Math.pow(2, attemptIndex);
    return Math.min(this.maxWaitMs, expBackoff);
  }

  /**
   * Dispatches a formatted rich embed alert to a Discord webhook URL with
   * rate-limit (`429`) and transient error (`5xx`) retry handling.
   */
  public async sendAlert(
    webhookUrl: string,
    event: DiscordAlertEventInput
  ): Promise<DiscordDeliveryResult> {
    if (!isValidDiscordWebhookUrl(webhookUrl)) {
      throw new Error(
        'Invalid Discord webhook URL. Must be an https://discord.com/api/webhooks/... URL.'
      );
    }

    const payload = this.buildRichEmbedPayload(event);
    let attempts = 0;
    let rateLimitedCount = 0;
    let totalRetryWaitMs = 0;
    let lastStatus: number | undefined;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      attempts += 1;
      try {
        const response = await this.fetchFn(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        lastStatus = response.status;

        if (response.status >= 200 && response.status < 300) {
          return {
            success: true,
            statusCode: response.status,
            attempts,
            rateLimitedCount,
            totalRetryWaitMs,
          };
        }

        if (response.status === 429) {
          rateLimitedCount += 1;
          let bodyRetryAfter: number | undefined;
          try {
            const json = (await response.json()) as { retry_after?: number };
            bodyRetryAfter = json?.retry_after;
          } catch {
            // ignore non-json 429 body
          }

          if (attempt < this.maxRetries) {
            const waitMs = this.computeRetryDelayMs(
              attempt,
              response.headers,
              bodyRetryAfter
            );
            totalRetryWaitMs += waitMs;
            await this.sleepFn(waitMs);
            continue;
          }

          lastError = 'Discord webhook rate limit exceeded (HTTP 429)';
          break;
        }

        if (response.status >= 500 && attempt < this.maxRetries) {
          const waitMs = this.computeRetryDelayMs(attempt, response.headers);
          totalRetryWaitMs += waitMs;
          await this.sleepFn(waitMs);
          continue;
        }

        lastError = `Discord webhook responded with HTTP ${response.status}`;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < this.maxRetries) {
          const waitMs = this.computeRetryDelayMs(attempt);
          totalRetryWaitMs += waitMs;
          await this.sleepFn(waitMs);
          continue;
        }
      }
    }

    return {
      success: false,
      statusCode: lastStatus,
      attempts,
      rateLimitedCount,
      totalRetryWaitMs,
      error: lastError ?? 'Discord webhook delivery failed',
    };
  }
}

export const discordNotificationProvider = new DiscordNotificationProvider();
export default discordNotificationProvider;

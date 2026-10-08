import * as StellarSdk from 'stellar-sdk';
import { prisma } from '../../lib/prisma';
import { stellar } from '../../lib/stellar';
import { SlackCommandPayload } from './slack.schema';

export interface SlackEphemeralResponse {
  response_type: 'ephemeral';
  text: string;
}

interface HorizonBalanceLike {
  balance: string;
  asset_type: string;
  asset_code?: string;
}

interface AlertRuleSummary {
  name?: string | null;
  assets: string[];
  // Prisma models this as Decimal; structural typing keeps the formatter
  // usable with plain fixtures in tests.
  minAmount?: { toString(): string } | null;
  isActive: boolean;
}

function ephemeral(text: string): SlackEphemeralResponse {
  return { response_type: 'ephemeral', text };
}

export function isValidStellarAddress(address: string): boolean {
  try {
    return StellarSdk.StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

function shortenAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function formatBalanceLine(balance: HorizonBalanceLike): string {
  if (balance.asset_type === 'native') {
    return `• ${balance.balance} XLM`;
  }
  if (balance.asset_type === 'liquidity_pool_shares') {
    return `• ${balance.balance} liquidity pool shares`;
  }
  return `• ${balance.balance} ${balance.asset_code ?? 'Unknown'}`;
}

function formatAlertRuleLine(rule: AlertRuleSummary): string {
  const label = rule.name?.trim() || 'Untitled rule';
  const assets = rule.assets.length > 0 ? rule.assets.join(', ') : 'any asset';
  const minAmount = rule.minAmount != null ? `min ${rule.minAmount.toString()}` : 'any amount';
  const status = rule.isActive ? 'active' : 'paused';
  return `• *${label}* — ${assets}, ${minAmount}, ${status}`;
}

export class SlackCommandService {
  buildHelpResponse(): SlackEphemeralResponse {
    return ephemeral(
      [
        '*Stellar Alerts* slash command reference:',
        '• `/stellar balance <address>` — current XLM and asset balances for a tracked wallet',
        '• `/stellar alerts <address>` — alert rules configured for a tracked wallet',
        '',
        'Wallets must be registered in Stellar Alerts before they can be queried here.',
      ].join('\n'),
    );
  }

  async handleBalance(args: string[]): Promise<SlackEphemeralResponse> {
    const address = args[0];
    if (!address) {
      return ephemeral('Usage: `/stellar balance <wallet address>` — e.g. `/stellar balance GABC…`');
    }

    if (!isValidStellarAddress(address)) {
      return ephemeral(
        `\`${address.slice(0, 20)}\` is not a valid Stellar account address — accounts start with \`G\`.`,
      );
    }

    const wallet = await prisma.wallet.findUnique({ where: { publicKey: address } });
    if (!wallet) {
      return ephemeral(
        `Wallet \`${shortenAddress(address)}\` is not tracked by Stellar Alerts. Register it via the web app first, then query it here.`,
      );
    }

    let account: { balances: HorizonBalanceLike[] };
    try {
      account = await stellar.server.loadAccount(address);
    } catch (error: any) {
      console.warn(
        `[SlackCommandService] Failed to load account ${shortenAddress(address)}: ${error?.message ?? error}`,
      );
      return ephemeral(
        `Could not load balances for \`${shortenAddress(address)}\` from the network. The account may not exist yet, or Horizon is temporarily unreachable.`,
      );
    }

    const lines = (account.balances ?? []).map(formatBalanceLine);
    if (lines.length === 0) {
      return ephemeral(`Wallet \`${shortenAddress(address)}\` has no balances reported yet.`);
    }

    return ephemeral(`💰 *Balance for* \`${shortenAddress(address)}\`\n${lines.join('\n')}`);
  }

  async handleAlerts(args: string[]): Promise<SlackEphemeralResponse> {
    const address = args[0];
    if (!address) {
      return ephemeral('Usage: `/stellar alerts <wallet address>` — e.g. `/stellar alerts GABC…`');
    }

    if (!isValidStellarAddress(address)) {
      return ephemeral(
        `\`${address.slice(0, 20)}\` is not a valid Stellar account address — accounts start with \`G\`.`,
      );
    }

    const wallet = await prisma.wallet.findUnique({ where: { publicKey: address } });
    if (!wallet) {
      return ephemeral(
        `Wallet \`${shortenAddress(address)}\` is not tracked by Stellar Alerts. Register it via the web app first, then query it here.`,
      );
    }

    // Include rules scoped to this wallet plus user-wide rules (walletId null)
    // owned by the same user, mirroring how the alert evaluator matches rules.
    const rules = await prisma.alertRule.findMany({
      where: {
        OR: [{ walletId: wallet.id }, { walletId: null, userId: wallet.userId }],
      },
      orderBy: { createdAt: 'desc' },
    });

    if (rules.length === 0) {
      return ephemeral(
        `No alert rules are configured for \`${shortenAddress(address)}\` yet. Create one via the Stellar Alerts web app.`,
      );
    }

    const lines = rules.map(formatAlertRuleLine);
    return ephemeral(
      `🔔 *Alert rules for* \`${shortenAddress(address)}\` (${rules.length})\n${lines.join('\n')}`,
    );
  }

  async handleCommand(payload: SlackCommandPayload): Promise<SlackEphemeralResponse> {
    const tokens = payload.text.trim().split(/\s+/).filter(Boolean);
    const [subcommand, ...args] = tokens;

    switch ((subcommand ?? 'help').toLowerCase()) {
      case 'balance':
        return this.handleBalance(args);
      case 'alerts':
        return this.handleAlerts(args);
      case 'help':
        return this.buildHelpResponse();
      default:
        return ephemeral(
          `Unknown subcommand \`${subcommand}\`.\n\n${this.buildHelpResponse().text}`,
        );
    }
  }
}

export const slackCommandService = new SlackCommandService();

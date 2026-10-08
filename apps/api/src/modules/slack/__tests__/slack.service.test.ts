import { describe, it, expect, vi, beforeEach } from 'vitest';
import StellarSdk from 'stellar-sdk';
import { SlackCommandService } from '../slack.service';
import { prisma } from '../../../lib/prisma';
import { stellar } from '../../../lib/stellar';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    wallet: {
      findUnique: vi.fn(),
    },
    alertRule: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../lib/stellar', () => ({
  stellar: {
    server: {
      loadAccount: vi.fn(),
    },
  },
}));

const address = () => StellarSdk.Keypair.random().publicKey();

const commandPayload = (text: string) => ({
  command: '/stellar',
  text,
  user_id: 'U123',
  user_name: 'tester',
});

describe('SlackCommandService', () => {
  let service: SlackCommandService;

  beforeEach(() => {
    service = new SlackCommandService();
    vi.clearAllMocks();
  });

  describe('handleCommand routing', () => {
    it('returns help text for an empty command', async () => {
      const response = await service.handleCommand(commandPayload(''));

      expect(response.response_type).toBe('ephemeral');
      expect(response.text).toContain('/stellar balance');
      expect(response.text).toContain('/stellar alerts');
    });

    it('returns help text for the explicit help subcommand', async () => {
      const response = await service.handleCommand(commandPayload('help'));

      expect(response.text).toContain('slash command reference');
    });

    it('reports unknown subcommands and includes help', async () => {
      const response = await service.handleCommand(commandPayload('frobnicate'));

      expect(response.text).toContain('Unknown subcommand `frobnicate`');
      expect(response.text).toContain('/stellar balance');
    });
  });

  describe('balance', () => {
    it('returns usage hint when no address is provided', async () => {
      const response = await service.handleCommand(commandPayload('balance'));

      expect(response.text).toContain('Usage: `/stellar balance');
    });

    it('rejects an address that fails strkey validation', async () => {
      const response = await service.handleCommand(commandPayload('balance not-a-real-address'));

      expect(response.text).toContain('not a valid Stellar account address');
      expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
      expect(stellar.server.loadAccount).not.toHaveBeenCalled();
    });

    it('reports wallets that are not tracked by Stellar Alerts', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue(null as any);

      const response = await service.handleCommand(commandPayload(`balance ${address()}`));

      expect(response.text).toContain('not tracked by Stellar Alerts');
    });

    it('returns an ephemeral balance summary for a tracked wallet', async () => {
      const publicKey = address();
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        publicKey,
      } as any);
      vi.mocked(stellar.server.loadAccount).mockResolvedValue({
        balances: [
          { balance: '100.0000000', asset_type: 'native' },
          { balance: '25.5000000', asset_type: 'credit_alphanum4', asset_code: 'USDC' },
        ],
      } as any);

      const response = await service.handleCommand(commandPayload(`balance ${publicKey}`));

      expect(response.response_type).toBe('ephemeral');
      expect(response.text).toContain('Balance for');
      expect(response.text).toContain('100.0000000 XLM');
      expect(response.text).toContain('25.5000000 USDC');
      expect(prisma.wallet.findUnique).toHaveBeenCalledWith({ where: { publicKey } });
      expect(stellar.server.loadAccount).toHaveBeenCalledWith(publicKey);
    });

    it('falls back to a friendly message when Horizon cannot load the account', async () => {
      const publicKey = address();
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        publicKey,
      } as any);
      vi.mocked(stellar.server.loadAccount).mockRejectedValue(new Error('timeout'));

      const response = await service.handleCommand(commandPayload(`balance ${publicKey}`));

      expect(response.text).toContain('Could not load balances');
    });

    it('handles wallets with no reported balances', async () => {
      const publicKey = address();
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        publicKey,
      } as any);
      vi.mocked(stellar.server.loadAccount).mockResolvedValue({ balances: [] } as any);

      const response = await service.handleCommand(commandPayload(`balance ${publicKey}`));

      expect(response.text).toContain('no balances reported yet');
    });
  });

  describe('alerts', () => {
    it('returns usage hint when no address is provided', async () => {
      const response = await service.handleCommand(commandPayload('alerts'));

      expect(response.text).toContain('Usage: `/stellar alerts');
    });

    it('rejects an address that fails strkey validation', async () => {
      const response = await service.handleCommand(commandPayload('alerts 1234'));

      expect(response.text).toContain('not a valid Stellar account address');
    });

    it('reports wallets that are not tracked by Stellar Alerts', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue(null as any);

      const response = await service.handleCommand(commandPayload(`alerts ${address()}`));

      expect(response.text).toContain('not tracked by Stellar Alerts');
    });

    it('lists wallet-scoped and user-wide alert rules for a tracked wallet', async () => {
      const publicKey = address();
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        publicKey,
      } as any);
      vi.mocked(prisma.alertRule.findMany).mockResolvedValue([
        { id: 'r-1', name: 'Big payments', assets: ['XLM'], minAmount: '100', isActive: true },
        { id: 'r-2', name: null, assets: [], minAmount: null, isActive: false },
      ] as any);

      const response = await service.handleCommand(commandPayload(`alerts ${publicKey}`));

      expect(response.response_type).toBe('ephemeral');
      expect(response.text).toContain('Alert rules for');
      expect(response.text).toContain('(2)');
      expect(response.text).toContain('*Big payments* — XLM, min 100, active');
      expect(response.text).toContain('*Untitled rule* — any asset, any amount, paused');
      expect(prisma.alertRule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ walletId: 'w-1' }, { walletId: null, userId: 'u-1' }],
          },
        }),
      );
    });

    it('reports wallets with no alert rules configured', async () => {
      const publicKey = address();
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        publicKey,
      } as any);
      vi.mocked(prisma.alertRule.findMany).mockResolvedValue([] as any);

      const response = await service.handleCommand(commandPayload(`alerts ${publicKey}`));

      expect(response.text).toContain('No alert rules are configured');
    });
  });
});

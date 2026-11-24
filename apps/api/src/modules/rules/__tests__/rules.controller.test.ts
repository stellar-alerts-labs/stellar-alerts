import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rulesController } from '../rules.controller';
import { alertRuleRepository } from '../../../repositories/alert-rule.repository';
import { AuthenticationError, NotFoundError, ValidationError } from '../../../lib/errors';

describe('RulesController', () => {
  const mockUser = {
    id: 'user-123',
    email: 'dev@stellar-alerts.com',
  };

  const createMockRequest = (body: any = {}, params: any = {}, query: any = {}, user: any = mockUser) => ({
    body,
    params,
    query,
    user,
  });

  const createMockReply = () => {
    const reply: any = {};
    reply.status = vi.fn().mockReturnValue(reply);
    reply.send = vi.fn().mockReturnValue(reply);
    return reply;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPresets', () => {
    it('returns all AMM presets when no filter is provided', async () => {
      const req = createMockRequest({}, {}, {});
      const reply = createMockReply();

      await rulesController.getPresets(req as any, reply as any);

      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          presets: expect.any(Array),
        }),
      );
    });

    it('filters presets by protocol and network', async () => {
      const req = createMockRequest({}, {}, { protocol: 'soroswap', network: 'mainnet' });
      const reply = createMockReply();

      await rulesController.getPresets(req as any, reply as any);

      const response = reply.send.mock.calls[0][0];
      expect(response.success).toBe(true);
      for (const preset of response.presets) {
        expect(preset.protocol).toBe('soroswap');
        expect(preset.network).toBe('mainnet');
      }
    });

    it('throws ValidationError on invalid protocol filter', async () => {
      const req = createMockRequest({}, {}, { protocol: 'invalid_proto' });
      const reply = createMockReply();

      await expect(rulesController.getPresets(req as any, reply as any)).rejects.toThrow(ValidationError);
    });
  });

  describe('backtest', () => {
    it('throws AuthenticationError if request.user is missing', async () => {
      const req = createMockRequest({ rule: { minAmount: 10 } }, {}, {}, null);
      const reply = createMockReply();

      await expect(rulesController.backtest(req as any, reply as any)).rejects.toThrow(AuthenticationError);
    });

    it('throws ValidationError if both rule and ruleId are omitted', async () => {
      const req = createMockRequest({ startLedger: 100, endLedger: 200 });
      const reply = createMockReply();

      await expect(rulesController.backtest(req as any, reply as any)).rejects.toThrow(ValidationError);
    });

    it('executes backtest with valid draft rule payload', async () => {
      const req = createMockRequest({
        rule: {
          name: 'Draft Alert Rule',
          minAmount: '500',
          assets: ['USDC'],
        },
        seededEvents: [
          {
            id: 'e1',
            txHash: '0x1',
            ledgerSeq: 100,
            amount: '600',
            asset: 'USDC',
            fromAddress: 'GA1',
            timestamp: '2026-11-20T10:00:00Z',
          },
        ],
      });
      const reply = createMockReply();

      await rulesController.backtest(req as any, reply as any);

      expect(reply.status).toHaveBeenCalledWith(200);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          report: expect.objectContaining({
            metrics: expect.objectContaining({
              totalEvaluations: 1,
              totalMatches: 1,
            }),
            dryRunVerified: true,
          }),
        }),
      );
    });

    it('fetches persisted rule by ruleId from alertRuleRepository', async () => {
      const persistedRule = {
        id: 'rule-999',
        userId: 'user-123',
        walletId: null,
        name: 'Persisted Rule',
        assets: ['XLM'],
        minAmount: 1000,
        maxAmount: null,
        memo: null,
        channels: ['webhook'],
        conditions: null,
        version: 1,
        isActive: true,
      };

      vi.spyOn(alertRuleRepository, 'findRuleById').mockResolvedValue(persistedRule as any);

      const req = createMockRequest({
        ruleId: 'rule-999',
        seededEvents: [
          {
            id: 'e1',
            txHash: '0x1',
            ledgerSeq: 100,
            amount: '2000',
            asset: 'XLM',
            fromAddress: 'GA1',
            timestamp: '2026-11-20T10:00:00Z',
          },
        ],
      });
      const reply = createMockReply();

      await rulesController.backtest(req as any, reply as any);

      expect(alertRuleRepository.findRuleById).toHaveBeenCalledWith('rule-999', 'user-123');
      expect(reply.status).toHaveBeenCalledWith(200);
      const response = reply.send.mock.calls[0][0];
      expect(response.report.ruleSummary.name).toBe('Persisted Rule');
      expect(response.report.metrics.totalMatches).toBe(1);
    });

    it('throws NotFoundError if ruleId does not exist for the authenticated user', async () => {
      vi.spyOn(alertRuleRepository, 'findRuleById').mockResolvedValue(null);

      const req = createMockRequest({
        ruleId: 'non-existent-rule',
        startLedger: 100,
        endLedger: 200,
      });
      const reply = createMockReply();

      await expect(rulesController.backtest(req as any, reply as any)).rejects.toThrow(NotFoundError);
    });

    it('runs backtestWithRuleId convenience handler', async () => {
      const persistedRule = {
        id: 'rule-abc',
        userId: 'user-123',
        walletId: null,
        name: 'Rule ABC',
        assets: ['USDC'],
        minAmount: 50,
        maxAmount: null,
        memo: null,
        channels: [],
        conditions: null,
        version: 1,
        isActive: true,
      };

      vi.spyOn(alertRuleRepository, 'findRuleById').mockResolvedValue(persistedRule as any);

      const req = createMockRequest(
        {
          seededEvents: [
            {
              id: 'e1',
              txHash: '0x1',
              ledgerSeq: 100,
              amount: '100',
              asset: 'USDC',
              fromAddress: 'GA1',
              timestamp: '2026-11-20T10:00:00Z',
            },
          ],
        },
        { id: 'rule-abc' },
      );
      const reply = createMockReply();

      await rulesController.backtestWithRuleId(req as any, reply as any);

      expect(alertRuleRepository.findRuleById).toHaveBeenCalledWith('rule-abc', 'user-123');
      expect(reply.status).toHaveBeenCalledWith(200);
      const res = reply.send.mock.calls[0][0];
      expect(res.report.metrics.totalMatches).toBe(1);
    });
  });
});

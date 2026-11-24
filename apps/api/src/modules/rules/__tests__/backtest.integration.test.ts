import Fastify, { FastifyInstance } from 'fastify';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  backtestReplayEngine,
  type HistoricalLedgerEvent,
  type DraftAlertRule,
} from '../backtest-engine';
import { alertRuleRepository } from '../../../repositories/alert-rule.repository';

// Mock auth middleware for fast route testing
vi.mock('../../../middleware/rbac.middleware', () => ({
  authenticate: async (request: any, reply: any) => {
    const userHeader = request.headers['x-test-user'];
    if (!userHeader) {
      return reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHENTICATED' });
    }
    request.user = { id: userHeader, email: `${userHeader}@stellar-alerts.test` };
  },
  requireScopes: () => async (_request: any, _reply: any) => {
    // Permit in test
  },
}));

import { alertRulesRoutes } from '../../alert-rules/alert-rules.routes';

describe('Historical Ledger Time-Travel Replay & Alert Backtesting Engine (Integration)', () => {
  let app: FastifyInstance;

  // Realistic seeded ledger dataset across a 20-ledger sequence span
  const seededLedgerHistory: HistoricalLedgerEvent[] = [
    // Ledger 50000001 - Hour 1
    {
      id: 'tx-50000001-1',
      txHash: '0x1001',
      ledgerSeq: 50000001,
      walletId: 'wallet-primary',
      amount: '25.5000000',
      asset: 'XLM',
      fromAddress: 'G_SENDER_A',
      toAddress: 'G_WALLET_PRIMARY',
      memo: 'coffee-payment',
      timestamp: '2026-11-20T10:00:05.000Z',
      type: 'payment',
    },
    {
      id: 'tx-50000001-2',
      txHash: '0x1002',
      ledgerSeq: 50000001,
      walletId: 'wallet-primary',
      amount: '500.0000000',
      asset: 'USDC',
      fromAddress: 'G_SENDER_B',
      toAddress: 'G_WALLET_PRIMARY',
      memo: 'invoice-301',
      timestamp: '2026-11-20T10:00:05.000Z',
      type: 'payment',
    },
    // Ledger 50000005 - Hour 1
    {
      id: 'tx-50000005-1',
      txHash: '0x1005',
      ledgerSeq: 50000005,
      walletId: 'wallet-secondary',
      amount: '0.0000001',
      asset: 'XLM',
      fromAddress: 'G_SPAMMER',
      toAddress: 'G_WALLET_SECONDARY',
      memo: 'click here for free xlm',
      timestamp: '2026-11-20T10:00:25.000Z',
      type: 'payment',
    },
    // Ledger 50000010 - Hour 1
    {
      id: 'tx-50000010-1',
      txHash: '0x1010',
      ledgerSeq: 50000010,
      walletId: 'wallet-primary',
      amount: '125000.0000000',
      asset: 'USDC',
      fromAddress: 'G_WHALE_OTC',
      toAddress: 'G_WALLET_PRIMARY',
      memo: 'urgent treasury rebalance',
      timestamp: '2026-11-20T10:00:50.000Z',
      type: 'payment',
    },
    // Ledger 50000015 - Hour 2
    {
      id: 'tx-50000015-1',
      txHash: '0x1015',
      ledgerSeq: 50000015,
      walletId: 'wallet-primary',
      amount: '1500.0000000',
      asset: 'USDC',
      fromAddress: 'G_CUSTOMER_C',
      toAddress: 'G_WALLET_PRIMARY',
      memo: 'invoice-302',
      timestamp: '2026-11-20T11:15:15.000Z',
      type: 'payment',
    },
    {
      id: 'tx-50000015-2',
      txHash: '0x1016',
      ledgerSeq: 50000015,
      walletId: 'wallet-primary',
      amount: '8500.0000000',
      asset: 'XLM',
      fromAddress: 'G_SUPPLIER_D',
      toAddress: 'G_WALLET_PRIMARY',
      memo: 'vendor payment',
      timestamp: '2026-11-20T11:15:15.000Z',
      type: 'payment',
    },
    // Ledger 50000020 - Hour 3
    {
      id: 'tx-50000020-1',
      txHash: '0x1020',
      ledgerSeq: 50000020,
      walletId: 'wallet-primary',
      amount: '50000.0000000',
      asset: 'AQUA',
      fromAddress: 'G_AMM_POOL',
      toAddress: 'G_WALLET_PRIMARY',
      memo: 'liquidity withdrawal',
      timestamp: '2026-11-20T12:30:00.000Z',
      type: 'payment',
    },
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(alertRulesRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Seeded Historical Ledger Replay & Exact Match Report Assertion', () => {
    it('replays ledger sequence range [50000001..50000020] and asserts exact deterministic match report', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'USDC Invoice Tracker',
        assets: ['USDC'],
        minAmount: '100',
        memo: 'invoice',
      };

      const report = await backtestReplayEngine.runBacktest(candidateRule, {
        startLedger: 50000001,
        endLedger: 50000020,
        seededEvents: seededLedgerHistory,
      });

      // Assert Range
      expect(report.range.startLedger).toBe(50000001);
      expect(report.range.endLedger).toBe(50000020);
      expect(report.range.totalLedgers).toBe(20);

      // Total evaluations should match all 7 seeded events
      expect(report.metrics.totalEvaluations).toBe(7);

      // Expected matches:
      // - tx-50000001-2: 500 USDC, memo "invoice-301" -> MATCH
      // - tx-50000015-1: 1500 USDC, memo "invoice-302" -> MATCH
      // Non-matches:
      // - tx-50000001-1 (XLM, coffee)
      // - tx-50000005-1 (XLM dust)
      // - tx-50000010-1 (125000 USDC, memo "urgent treasury rebalance" does not contain "invoice")
      // - tx-50000015-2 (XLM, vendor payment)
      // - tx-50000020-1 (AQUA)
      expect(report.metrics.totalMatches).toBe(2);
      expect(report.metrics.matchRate).toBeCloseTo(2 / 7, 4);

      // Verify sample transactions
      expect(report.sampleMatches.length).toBe(2);
      expect(report.sampleMatches[0].id).toBe('tx-50000001-2');
      expect(report.sampleMatches[0].txHash).toBe('0x1002');
      expect(report.sampleMatches[0].ledgerSeq).toBe(50000001);
      expect(report.sampleMatches[1].id).toBe('tx-50000015-1');
      expect(report.sampleMatches[1].txHash).toBe('0x1015');
      expect(report.sampleMatches[1].ledgerSeq).toBe(50000015);

      // Verify hourly histogram breakdown
      expect(report.hourlyHistogram.length).toBe(3); // 10:00, 11:00, 12:00
      const hour10 = report.hourlyHistogram.find((h) => h.hour.includes('T10:00:00'));
      const hour11 = report.hourlyHistogram.find((h) => h.hour.includes('T11:00:00'));
      const hour12 = report.hourlyHistogram.find((h) => h.hour.includes('T12:00:00'));

      expect(hour10?.totalEvaluations).toBe(4);
      expect(hour10?.matches).toBe(1);
      expect(hour11?.totalEvaluations).toBe(2);
      expect(hour11?.matches).toBe(1);
      expect(hour12?.totalEvaluations).toBe(1);
      expect(hour12?.matches).toBe(0);

      // Verify dry-run certification
      expect(report.dryRunVerified).toBe(true);
      expect(report.status).toBe('completed');
    });

    it('evaluates rule conditions AST with high-value threshold and memo keywords', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'Urgent Treasury or Large Settlement',
        conditions: {
          operator: 'OR',
          rules: [
            { field: 'amount', operator: 'gte', value: 100000 },
            { field: 'memo', operator: 'contains', value: 'urgent' },
          ],
        },
      };

      const report = await backtestReplayEngine.runBacktest(candidateRule, {
        startLedger: 50000001,
        endLedger: 50000020,
        seededEvents: seededLedgerHistory,
      });

      // Matches tx-50000010-1 (amount 125000 USDC, memo 'urgent treasury rebalance')
      expect(report.metrics.totalMatches).toBe(1);
      expect(report.sampleMatches[0].id).toBe('tx-50000010-1');
      expect(report.sampleMatches[0].amount).toBe('125000.0000000');
    });

    it('asserts false-positive simulation against a baseline rule', async () => {
      // Baseline rule alerts on any transaction > 10,000
      const baselineRule: DraftAlertRule = {
        name: 'Whale Baseline',
        minAmount: 10000,
      };

      // Candidate rule alerts on all transactions > 100
      const candidateRule: DraftAlertRule = {
        name: 'Expanded Payment Alert',
        minAmount: 100,
      };

      const report = await backtestReplayEngine.runBacktest(candidateRule, {
        baselineRule,
        seededEvents: seededLedgerHistory,
      });

      // Candidate matches (> 100):
      // tx-50000001-2 (500), tx-50000010-1 (125000), tx-50000015-1 (1500), tx-50000015-2 (8500), tx-50000020-1 (50000)
      // Total candidate matches = 5
      // Baseline matches (> 10000):
      // tx-50000010-1 (125000), tx-50000020-1 (50000)
      // Total baseline matches = 2
      // Overlap = 2
      // Non-overlapping triggers = 3
      // Simulated false-positive rate = 3 / 5 = 0.6000
      expect(report.metrics.totalMatches).toBe(5);
      expect(report.baselineSummary?.matches).toBe(2);
      expect(report.baselineSummary?.overlapMatches).toBe(2);
      expect(report.metrics.simulatedFalsePositiveRate).toBeCloseTo(0.6, 2);
    });
  });

  describe('HTTP REST API Integration via Fastify Inject', () => {
    it('POST /rules/backtest returns 200 with full deterministic report', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/rules/backtest',
        headers: {
          'x-test-user': 'user-enterprise-99',
        },
        payload: {
          rule: {
            name: 'Whale Alert',
            minAmount: 10000,
            assets: ['USDC'],
          },
          startLedger: 50000001,
          endLedger: 50000020,
          seededEvents: seededLedgerHistory,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.success).toBe(true);
      expect(json.report).toBeDefined();
      expect(json.report.backtestId).toBeDefined();
      expect(json.report.metrics.totalEvaluations).toBe(7);
      expect(json.report.metrics.totalMatches).toBe(1); // 125000 USDC
      expect(json.report.dryRunVerified).toBe(true);
    });

    it('POST /alert-rules/backtest is aliased and produces identical results', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/alert-rules/backtest',
        headers: {
          'x-test-user': 'user-enterprise-99',
        },
        payload: {
          rule: {
            name: 'Whale Alert',
            minAmount: 10000,
            assets: ['USDC'],
          },
          startLedger: 50000001,
          endLedger: 50000020,
          seededEvents: seededLedgerHistory,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.success).toBe(true);
      expect(json.report.metrics.totalMatches).toBe(1);
    });

    it('POST /alert-rules/:id/backtest loads persisted rule and executes replay', async () => {
      const persistedRule = {
        id: 'persisted-rule-42',
        userId: 'user-enterprise-99',
        walletId: null,
        name: 'AQUA Liquidity Alert',
        assets: ['AQUA'],
        minAmount: 1000,
        maxAmount: null,
        memo: null,
        channels: ['webhook'],
        conditions: null,
        version: 1,
        isActive: true,
      };

      vi.spyOn(alertRuleRepository, 'findRuleById').mockResolvedValue(persistedRule as any);

      const response = await app.inject({
        method: 'POST',
        url: '/alert-rules/persisted-rule-42/backtest',
        headers: {
          'x-test-user': 'user-enterprise-99',
        },
        payload: {
          startLedger: 50000001,
          endLedger: 50000020,
          seededEvents: seededLedgerHistory,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.success).toBe(true);
      expect(json.report.ruleSummary.name).toBe('AQUA Liquidity Alert');
      expect(json.report.metrics.totalMatches).toBe(1); // tx-50000020-1 (50000 AQUA)
    });

    it('returns 401 when request is unauthenticated', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/rules/backtest',
        payload: {
          rule: { name: 'Test' },
          startLedger: 100,
          endLedger: 200,
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });
});

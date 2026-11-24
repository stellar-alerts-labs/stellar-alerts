import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BacktestReplayEngine,
  FixtureHistoricalProvider,
  SandboxedRuleEvaluator,
  type HistoricalLedgerEvent,
  type DraftAlertRule,
} from '../backtest-engine';
import { ValidationError } from '../../../lib/errors';
import { alertQueue } from '../../../lib/queue';

describe('BacktestReplayEngine (Deterministic Historical Ledger Time-Travel Replay)', () => {
  let engine: BacktestReplayEngine;

  const mockHistoricalEvents: HistoricalLedgerEvent[] = [
    {
      id: 'evt-1',
      txHash: '0xaaa1',
      ledgerSeq: 50000001,
      walletId: 'w-alpha',
      walletAddress: 'GA_ALPHA',
      amount: '50',
      asset: 'XLM',
      fromAddress: 'GA_SENDER_1',
      toAddress: 'GA_ALPHA',
      memo: 'invoice-101',
      timestamp: '2026-11-20T10:15:00.000Z',
      type: 'payment',
    },
    {
      id: 'evt-2',
      txHash: '0xaaa2',
      ledgerSeq: 50000010,
      walletId: 'w-alpha',
      walletAddress: 'GA_ALPHA',
      amount: '500',
      asset: 'USDC',
      fromAddress: 'GA_SENDER_2',
      toAddress: 'GA_ALPHA',
      memo: 'payroll-nov',
      timestamp: '2026-11-20T10:30:00.000Z',
      type: 'payment',
    },
    {
      id: 'evt-3',
      txHash: '0xaaa3',
      ledgerSeq: 50000050,
      walletId: 'w-beta',
      walletAddress: 'GA_BETA',
      amount: '0.00001',
      asset: 'XLM',
      fromAddress: 'GA_SPAMMER',
      toAddress: 'GA_BETA',
      memo: 'claim your free reward at scam.xyz',
      timestamp: '2026-11-20T11:05:00.000Z',
      type: 'payment',
    },
    {
      id: 'evt-4',
      txHash: '0xaaa4',
      ledgerSeq: 50000100,
      walletId: 'w-alpha',
      walletAddress: 'GA_ALPHA',
      amount: '25000',
      asset: 'USDC',
      fromAddress: 'GA_WHALE',
      toAddress: 'GA_ALPHA',
      memo: 'treasury transfer',
      timestamp: '2026-11-20T12:00:00.000Z',
      type: 'payment',
    },
    {
      id: 'evt-5',
      txHash: '0xaaa5',
      ledgerSeq: 50000150,
      walletId: 'w-alpha',
      walletAddress: 'GA_ALPHA',
      amount: '12000',
      asset: 'XLM',
      fromAddress: 'GA_SENDER_3',
      toAddress: 'GA_ALPHA',
      memo: 'invoice-102',
      timestamp: '2026-11-21T09:00:00.000Z',
      type: 'payment',
    },
  ];

  beforeEach(() => {
    engine = new BacktestReplayEngine();
    vi.clearAllMocks();
  });

  describe('Range & Boundary Validations', () => {
    it('throws ValidationError if startLedger > endLedger', async () => {
      const candidateRule: DraftAlertRule = { name: 'Test', minAmount: 100 };
      await expect(
        engine.runBacktest(candidateRule, {
          startLedger: 50000100,
          endLedger: 50000000,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError if startLedger is negative or zero', async () => {
      const candidateRule: DraftAlertRule = { name: 'Test', minAmount: 100 };
      await expect(
        engine.runBacktest(candidateRule, {
          startLedger: 0,
          endLedger: 100,
        }),
      ).rejects.toThrow('startLedger must be a positive integer');
    });

    it('throws ValidationError if requested ledger range exceeds maxLedgersLimit', async () => {
      const candidateRule: DraftAlertRule = { name: 'Test' };
      await expect(
        engine.runBacktest(candidateRule, {
          startLedger: 1,
          endLedger: 10000,
          maxLedgersLimit: 500,
        }),
      ).rejects.toThrow('exceeds maximum allowed ledger limit');
    });

    it('throws ValidationError if neither ledger range nor date range nor seededEvents provided', async () => {
      const candidateRule: DraftAlertRule = { name: 'Test' };
      await expect(engine.runBacktest(candidateRule, {})).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError if startDate is after endDate', async () => {
      const candidateRule: DraftAlertRule = { name: 'Test' };
      await expect(
        engine.runBacktest(candidateRule, {
          startDate: '2026-11-25T00:00:00Z',
          endDate: '2026-11-20T00:00:00Z',
        }),
      ).rejects.toThrow('startDate must be earlier than or equal to endDate');
    });

    it('throws ValidationError if date range exceeds 90 days', async () => {
      const candidateRule: DraftAlertRule = { name: 'Test' };
      await expect(
        engine.runBacktest(candidateRule, {
          startDate: '2026-01-01T00:00:00Z',
          endDate: '2026-06-01T00:00:00Z',
        }),
      ).rejects.toThrow('Date range cannot exceed 90 days');
    });

    it('handles single ledger sequence boundary [startLedger === endLedger]', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'Single Ledger Rule',
        minAmount: 10,
      };

      const report = await engine.runBacktest(candidateRule, {
        startLedger: 50000001,
        endLedger: 50000001,
        seededEvents: mockHistoricalEvents,
      });

      expect(report.range.startLedger).toBe(50000001);
      expect(report.range.endLedger).toBe(50000001);
      expect(report.range.totalLedgers).toBe(1);
      expect(report.metrics.totalEvaluations).toBe(1);
      expect(report.metrics.totalMatches).toBe(1);
    });
  });

  describe('Rule Condition Matching', () => {
    it('matches rules by minimum and maximum amount thresholds', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'Mid-Tier Payments',
        minAmount: '100',
        maxAmount: '1000',
      };

      const report = await engine.runBacktest(candidateRule, {
        seededEvents: mockHistoricalEvents,
      });

      expect(report.metrics.totalEvaluations).toBe(5);
      expect(report.metrics.totalMatches).toBe(1); // evt-2 (500 USDC)
      expect(report.sampleMatches[0].id).toBe('evt-2');
      expect(report.sampleMatches[0].amount).toBe('500');
    });

    it('filters strictly by asset code allow-list', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'USDC Only Watcher',
        assets: ['USDC'],
      };

      const report = await engine.runBacktest(candidateRule, {
        seededEvents: mockHistoricalEvents,
      });

      expect(report.metrics.totalEvaluations).toBe(5);
      expect(report.metrics.totalMatches).toBe(2); // evt-2 (500), evt-4 (25000)
      const matchedIds = report.sampleMatches.map((s) => s.id);
      expect(matchedIds).toEqual(['evt-2', 'evt-4']);
    });

    it('filters by memo substring in a case-insensitive manner', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'Invoice Detector',
        memo: 'INVOICE',
      };

      const report = await engine.runBacktest(candidateRule, {
        seededEvents: mockHistoricalEvents,
      });

      expect(report.metrics.totalMatches).toBe(2); // evt-1 (invoice-101), evt-5 (invoice-102)
      expect(report.sampleMatches.map((m) => m.id)).toEqual(['evt-1', 'evt-5']);
    });

    it('evaluates complex AST conditions with nested AND / OR groups', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'High Value USDC or Urgent Invoice',
        conditions: {
          operator: 'OR',
          rules: [
            {
              operator: 'AND',
              rules: [
                { field: 'asset', operator: 'eq', value: 'USDC' },
                { field: 'amount', operator: 'gte', value: 1000 },
              ],
            },
            {
              field: 'memo',
              operator: 'contains',
              value: 'treasury',
            },
          ],
        },
      };

      const report = await engine.runBacktest(candidateRule, {
        seededEvents: mockHistoricalEvents,
      });

      // evt-4 matches (asset=USDC and amount=25000, plus memo contains treasury)
      expect(report.metrics.totalMatches).toBe(1);
      expect(report.sampleMatches[0].id).toBe('evt-4');
      expect(report.sampleMatches[0].txHash).toBe('0xaaa4');
    });

    it('scopes evaluations to walletId when specified', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'Beta Wallet Watcher',
        walletId: 'w-beta',
      };

      const report = await engine.runBacktest(candidateRule, {
        seededEvents: mockHistoricalEvents,
      });

      expect(report.metrics.totalMatches).toBe(1);
      expect(report.sampleMatches[0].id).toBe('evt-3');
      expect(report.sampleMatches[0].fromAddress).toBe('GA_SPAMMER');
    });
  });

  describe('Zero Side-Effects (Dry-Run Sandbox Guarantee)', () => {
    it('never emits external notifications or interacts with BullMQ queue during replay', async () => {
      const addSpy = vi.spyOn(alertQueue, 'add');

      const candidateRule: DraftAlertRule = {
        name: 'All Events Alert',
        minAmount: 0,
      };

      const report = await engine.runBacktest(candidateRule, {
        seededEvents: mockHistoricalEvents,
      });

      expect(report.metrics.totalMatches).toBe(5);
      expect(report.dryRunVerified).toBe(true);

      // Verify that no queue job was scheduled
      expect(addSpy).not.toHaveBeenCalled();
    });
  });

  describe('Deterministic Metrics & False-Positive Rate', () => {
    it('computes exact match rate and trigger frequencies', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'High Volume Rule',
        minAmount: 100,
      };

      const report = await engine.runBacktest(candidateRule, {
        seededEvents: mockHistoricalEvents,
      });

      expect(report.metrics.totalEvaluations).toBe(5);
      expect(report.metrics.totalMatches).toBe(3); // 500 USDC, 25000 USDC, 12000 XLM
      expect(report.metrics.matchRate).toBeCloseTo(3 / 5, 4);
      expect(report.metrics.triggerFrequencyPerHour).toBeGreaterThan(0);
      expect(report.metrics.triggerFrequencyPerDay).toBeGreaterThan(0);
      expect(report.metrics.estimatedMonthlyVolume).toBeGreaterThan(0);
    });

    it('computes relative false-positive rate when a baseline rule is provided', async () => {
      // Baseline matches high value (> 10,000)
      const baselineRule: DraftAlertRule = {
        name: 'Strict Whale Baseline',
        minAmount: 10000,
      };

      // Candidate is looser (> 100) -> will have false positives relative to baseline
      const candidateRule: DraftAlertRule = {
        name: 'Looser Candidate Rule',
        minAmount: 100,
      };

      const report = await engine.runBacktest(candidateRule, {
        baselineRule,
        seededEvents: mockHistoricalEvents,
      });

      // Total candidate matches: 3 (evt-2, evt-4, evt-5)
      // Baseline matches: 2 (evt-4, evt-5)
      // Overlap: 2
      // Non-overlapping triggers: 1 (evt-2: 500 USDC)
      // False-positive rate: 1 / 3 = 0.3333
      expect(report.baselineSummary?.matches).toBe(2);
      expect(report.baselineSummary?.overlapMatches).toBe(2);
      expect(report.metrics.simulatedFalsePositiveRate).toBeCloseTo(0.3333, 2);
    });

    it('simulates noise quotient false-positive rate when baseline is omitted', async () => {
      const spamRule: DraftAlertRule = {
        name: 'Catch All Including Dust',
        minAmount: 0,
      };

      const report = await engine.runBacktest(spamRule, {
        seededEvents: mockHistoricalEvents,
      });

      // Includes dust transaction evt-3 (amount 0.00001)
      expect(report.metrics.simulatedFalsePositiveRate).toBeGreaterThan(0);
    });
  });

  describe('Hourly and Daily Histograms (Timeline Breakdown)', () => {
    it('aggregates events into chronological hourly and daily buckets', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'Any Activity',
      };

      const report = await engine.runBacktest(candidateRule, {
        seededEvents: mockHistoricalEvents,
      });

      // Events span 2 days: Nov 20 and Nov 21
      expect(report.dailyHistogram.length).toBe(2);
      expect(report.dailyHistogram[0].date).toBe('2026-11-20');
      expect(report.dailyHistogram[0].totalEvaluations).toBe(4);
      expect(report.dailyHistogram[1].date).toBe('2026-11-21');
      expect(report.dailyHistogram[1].totalEvaluations).toBe(1);

      // Hourly breakdown
      expect(report.hourlyHistogram.length).toBeGreaterThan(0);
      for (const bucket of report.hourlyHistogram) {
        expect(bucket.hour).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
        expect(bucket.ledgerStart).toBeLessThanOrEqual(bucket.ledgerEnd);
        expect(bucket.totalEvaluations).toBeGreaterThanOrEqual(bucket.matches);
      }
    });
  });

  describe('Pagination & Resource Limits', () => {
    it('safely truncates execution when maxEventsLimit is reached', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'All Events',
      };

      // Set maxEventsLimit = 2 while 5 events exist
      const report = await engine.runBacktest(candidateRule, {
        maxEventsLimit: 2,
        pageSize: 1,
        seededEvents: mockHistoricalEvents,
      });

      expect(report.status).toBe('truncated');
      expect(report.resourceLimits.reachedLimit).toBe(true);
      expect(report.metrics.totalEvaluations).toBe(2);
      expect(report.sampleMatches.length).toBeLessThanOrEqual(2);
    });

    it('completes normally when event count is within limits', async () => {
      const candidateRule: DraftAlertRule = {
        name: 'All Events',
      };

      const report = await engine.runBacktest(candidateRule, {
        maxEventsLimit: 100,
        pageSize: 2,
        seededEvents: mockHistoricalEvents,
      });

      expect(report.status).toBe('completed');
      expect(report.resourceLimits.reachedLimit).toBe(false);
      expect(report.metrics.totalEvaluations).toBe(5);
    });
  });
});

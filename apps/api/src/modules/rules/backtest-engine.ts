import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { prisma } from '../../lib/prisma';
import {
  type FilterRuleGroup,
  type PaymentContext,
  evaluateRuleGroup,
} from '../../lib/rules-engine';
import {
  compileAlertRule,
  type AlertRuleRecord,
  type CompiledAlertRule,
} from '../../lib/alert-rule-evaluator';
import { ruleCompiler } from '../../lib/rules-engine/compiler';
import { ValidationError } from '../../lib/errors';

/**
 * Normalized historical ledger event for time-travel replay and backtesting.
 */
export interface HistoricalLedgerEvent {
  id: string;
  txHash: string;
  ledgerSeq: number;
  walletId?: string | null;
  walletAddress?: string | null;
  userId?: string | null;
  amount: number | string;
  asset: string;
  assetIssuer?: string | null;
  fromAddress: string;
  toAddress?: string;
  memo?: string | null;
  timestamp: string | Date;
  type?: string;
  topics?: unknown[];
  metadata?: Record<string, unknown>;
}

/**
 * Draft alert rule configuration evaluated in sandbox backtesting.
 */
export interface DraftAlertRule {
  id?: string;
  userId?: string;
  name?: string;
  walletId?: string | null;
  assets?: string[];
  minAmount?: number | string | null;
  maxAmount?: number | string | null;
  memo?: string | null;
  channels?: string[];
  conditions?: FilterRuleGroup | null;
}

/**
 * Parameters for the historical backtest execution.
 */
export interface BacktestReplayOptions {
  startLedger?: number;
  endLedger?: number;
  startDate?: string | Date;
  endDate?: string | Date;
  walletId?: string | null;
  maxEventsLimit?: number;
  maxLedgersLimit?: number;
  sampleSizeLimit?: number;
  pageSize?: number;
  baselineRule?: DraftAlertRule | null;
  seededEvents?: HistoricalLedgerEvent[];
}

export interface HourlyHistogramBucket {
  hour: string; // ISO 8601 rounded to the hour e.g. "2026-11-22T13:00:00.000Z"
  ledgerStart: number;
  ledgerEnd: number;
  totalEvaluations: number;
  matches: number;
}

export interface DailyHistogramBucket {
  date: string; // YYYY-MM-DD
  totalEvaluations: number;
  matches: number;
}

export interface SampleMatchedEvent {
  id: string;
  txHash: string;
  ledgerSeq: number;
  timestamp: string;
  amount: string;
  asset: string;
  fromAddress: string;
  toAddress?: string;
  memo?: string | null;
}

/**
 * Complete deterministic backtesting report returned to the caller.
 */
export interface BacktestReport {
  backtestId: string;
  executedAt: string;
  ruleSummary: {
    id?: string;
    name?: string;
    walletId?: string | null;
    assets: string[];
    minAmount?: number | string | null;
    maxAmount?: number | string | null;
    memo?: string | null;
    hasConditions: boolean;
  };
  baselineSummary?: {
    name?: string;
    matches: number;
    overlapMatches: number;
  };
  range: {
    startLedger: number;
    endLedger: number;
    totalLedgers: number;
    startDate?: string;
    endDate?: string;
    estimatedDurationSeconds: number;
  };
  metrics: {
    totalEvaluations: number;
    totalMatches: number;
    matchRate: number;
    triggerFrequencyPerHour: number;
    triggerFrequencyPerDay: number;
    simulatedFalsePositiveRate: number;
    estimatedMonthlyVolume: number;
    executionTimeMs: number;
  };
  hourlyHistogram: HourlyHistogramBucket[];
  dailyHistogram: DailyHistogramBucket[];
  sampleMatches: SampleMatchedEvent[];
  status: 'completed' | 'truncated';
  resourceLimits: {
    maxEventsLimit: number;
    maxLedgersLimit: number;
    reachedLimit: boolean;
  };
  dryRunVerified: true;
}

/**
 * Contract for streaming historical ledger events across providers.
 */
export interface HistoricalDataProvider {
  streamEvents(
    options: {
      startLedger: number;
      endLedger: number;
      startDate?: Date;
      endDate?: Date;
      walletId?: string | null;
      maxEventsLimit: number;
      pageSize: number;
    },
    onBatch: (events: HistoricalLedgerEvent[]) => Promise<boolean | void> | boolean | void,
  ): Promise<{ totalEventsStreamed: number; reachedLimit: boolean }>;
}

/**
 * Fixture-based provider for seeded testing and offline replay.
 */
export class FixtureHistoricalProvider implements HistoricalDataProvider {
  constructor(private readonly events: HistoricalLedgerEvent[]) {}

  async streamEvents(
    options: {
      startLedger: number;
      endLedger: number;
      startDate?: Date;
      endDate?: Date;
      walletId?: string | null;
      maxEventsLimit: number;
      pageSize: number;
    },
    onBatch: (events: HistoricalLedgerEvent[]) => Promise<boolean | void> | boolean | void,
  ): Promise<{ totalEventsStreamed: number; reachedLimit: boolean }> {
    const filtered = this.events.filter((event) => {
      if (options.startLedger && event.ledgerSeq < options.startLedger) return false;
      if (options.endLedger && event.ledgerSeq > options.endLedger) return false;

      const eventTime = new Date(event.timestamp).getTime();
      if (options.startDate && eventTime < options.startDate.getTime()) return false;
      if (options.endDate && eventTime > options.endDate.getTime()) return false;

      if (options.walletId) {
        const matchesWallet =
          event.walletId === options.walletId ||
          event.walletAddress === options.walletId ||
          event.fromAddress === options.walletId ||
          event.toAddress === options.walletId;
        if (!matchesWallet) return false;
      }

      return true;
    });

    // Deterministic sort by ledgerSeq ascending, then timestamp, then ID
    filtered.sort((a, b) => {
      if (a.ledgerSeq !== b.ledgerSeq) return a.ledgerSeq - b.ledgerSeq;
      const tA = new Date(a.timestamp).getTime();
      const tB = new Date(b.timestamp).getTime();
      if (tA !== tB) return tA - tB;
      return a.id.localeCompare(b.id);
    });

    let totalStreamed = 0;
    let reachedLimit = false;

    for (let i = 0; i < filtered.length; i += options.pageSize) {
      if (totalStreamed >= options.maxEventsLimit) {
        reachedLimit = true;
        break;
      }

      const remainingAllowed = options.maxEventsLimit - totalStreamed;
      const chunk = filtered.slice(i, i + Math.min(options.pageSize, remainingAllowed));
      totalStreamed += chunk.length;

      const shouldContinue = await onBatch(chunk);
      if (shouldContinue === false || totalStreamed >= options.maxEventsLimit) {
        if (totalStreamed >= options.maxEventsLimit && i + chunk.length < filtered.length) {
          reachedLimit = true;
        }
        break;
      }
    }

    return { totalEventsStreamed: totalStreamed, reachedLimit };
  }
}

export interface PaymentDbRecord {
  id: string;
  txHash: string;
  walletId: string;
  amount: { toString: () => string } | string | number;
  asset: string;
  assetIssuer?: string | null;
  fromAddress: string;
  memo?: string | null;
  receivedAt: Date | string;
}

export interface PaymentDatabaseClient {
  payment: {
    findMany: (args: {
      where?: {
        walletId?: string;
        receivedAt?: { gte?: Date; lte?: Date };
      };
      orderBy?: Array<{ receivedAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }>;
      take?: number;
      skip?: number;
    }) => Promise<PaymentDbRecord[]>;
  };
}

/**
 * Database historical provider that streams from PostgreSQL Payment & PaymentArchive.
 */
export class DatabaseHistoricalProvider implements HistoricalDataProvider {
  constructor(private readonly db: PaymentDatabaseClient = prisma as unknown as PaymentDatabaseClient) {}

  async streamEvents(
    options: {
      startLedger: number;
      endLedger: number;
      startDate?: Date;
      endDate?: Date;
      walletId?: string | null;
      maxEventsLimit: number;
      pageSize: number;
    },
    onBatch: (events: HistoricalLedgerEvent[]) => Promise<boolean | void> | boolean | void,
  ): Promise<{ totalEventsStreamed: number; reachedLimit: boolean }> {
    const where: {
      walletId?: string;
      receivedAt?: { gte?: Date; lte?: Date };
    } = {};
    if (options.walletId) {
      where.walletId = options.walletId;
    }

    if (options.startDate || options.endDate) {
      where.receivedAt = {};
      if (options.startDate) where.receivedAt.gte = options.startDate;
      if (options.endDate) where.receivedAt.lte = options.endDate;
    }

    let totalStreamed = 0;
    let reachedLimit = false;
    let skip = 0;

    while (totalStreamed < options.maxEventsLimit) {
      const take = Math.min(options.pageSize, options.maxEventsLimit - totalStreamed);
      const records = await this.db.payment.findMany({
        where,
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        take,
        skip,
      });

      if (!records || records.length === 0) {
        break;
      }

      const events: HistoricalLedgerEvent[] = records.map((record) => {
        const receivedAt = new Date(record.receivedAt);
        // Estimate ledger sequence if not stored natively on Payment row:
        // Stellar ledger closes ~5s. If startLedger and startDate are provided, interpolate.
        let ledgerSeq = options.startLedger;
        if (options.startDate) {
          const deltaSec = Math.max(0, (receivedAt.getTime() - options.startDate.getTime()) / 1000);
          ledgerSeq = options.startLedger + Math.floor(deltaSec / 5);
        } else {
          ledgerSeq = options.startLedger + Math.floor(skip / 10);
        }

        return {
          id: record.id,
          txHash: record.txHash,
          ledgerSeq,
          walletId: record.walletId,
          amount: record.amount?.toString() || '0',
          asset: record.asset,
          assetIssuer: record.assetIssuer ?? null,
          fromAddress: record.fromAddress,
          memo: record.memo ?? null,
          timestamp: receivedAt.toISOString(),
          type: 'payment',
        };
      });

      totalStreamed += events.length;
      skip += records.length;

      const shouldContinue = await onBatch(events);
      if (shouldContinue === false || totalStreamed >= options.maxEventsLimit) {
        if (totalStreamed >= options.maxEventsLimit && records.length === take) {
          reachedLimit = true;
        }
        break;
      }
    }

    return { totalEventsStreamed: totalStreamed, reachedLimit };
  }
}

/**
 * Sandboxed Rule Evaluator that matches candidate rules against events without side effects.
 */
export class SandboxedRuleEvaluator {
  private compiledCandidate: CompiledAlertRule;
  private compiledBaseline: CompiledAlertRule | null = null;

  constructor(candidateRule: DraftAlertRule, baselineRule?: DraftAlertRule | null) {
    const candidateRecord: AlertRuleRecord = {
      id: candidateRule.id || 'draft-rule',
      userId: candidateRule.userId || 'system',
      walletId: candidateRule.walletId ?? null,
      name: candidateRule.name || 'Draft Rule',
      assets: candidateRule.assets || [],
      minAmount: candidateRule.minAmount ?? null,
      maxAmount: candidateRule.maxAmount ?? null,
      memo: candidateRule.memo ?? null,
      channels: candidateRule.channels || [],
      conditions: candidateRule.conditions ?? null,
      isActive: true, // Always active for backtesting
    };

    this.compiledCandidate = compileAlertRule(candidateRecord);

    if (baselineRule) {
      const baselineRecord: AlertRuleRecord = {
        id: baselineRule.id || 'baseline-rule',
        userId: baselineRule.userId || 'system',
        walletId: baselineRule.walletId ?? null,
        name: baselineRule.name || 'Baseline Rule',
        assets: baselineRule.assets || [],
        minAmount: baselineRule.minAmount ?? null,
        maxAmount: baselineRule.maxAmount ?? null,
        memo: baselineRule.memo ?? null,
        channels: baselineRule.channels || [],
        conditions: baselineRule.conditions ?? null,
        isActive: true,
      };
      this.compiledBaseline = compileAlertRule(baselineRecord);
    }
  }

  evaluateCandidate(event: HistoricalLedgerEvent): boolean {
    return this.evaluateRuleAgainstEvent(this.compiledCandidate, event);
  }

  evaluateBaseline(event: HistoricalLedgerEvent): boolean {
    if (!this.compiledBaseline) return false;
    return this.evaluateRuleAgainstEvent(this.compiledBaseline, event);
  }

  private evaluateRuleAgainstEvent(rule: CompiledAlertRule, event: HistoricalLedgerEvent): boolean {
    // 1. Wallet scope check
    if (rule.walletId) {
      const matchesWalletId = event.walletId === rule.walletId;
      const matchesAddress =
        event.walletAddress === rule.walletId ||
        event.fromAddress === rule.walletId ||
        event.toAddress === rule.walletId;
      if (!matchesWalletId && !matchesAddress) return false;
    }

    // 2. Asset code check (empty or omitted means all assets match)
    if (rule.assets && rule.assets.length > 0) {
      if (!rule.assets.includes(event.asset)) return false;
    }

    // 3. Amount checks
    const numAmount = Number(event.amount);
    if (rule.minAmount !== null && rule.minAmount !== undefined) {
      if (numAmount < Number(rule.minAmount)) return false;
    }
    if (rule.maxAmount !== null && rule.maxAmount !== undefined) {
      if (numAmount > Number(rule.maxAmount)) return false;
    }

    // 4. Memo check (case-insensitive substring)
    if (rule.memo && rule.memo.trim() !== '') {
      if (!event.memo || !event.memo.toLowerCase().includes(rule.memo.toLowerCase())) {
        return false;
      }
    }

    // 5. AST Conditions evaluation
    if (rule.conditions) {
      const context: PaymentContext = {
        amount: event.amount,
        asset: event.asset,
        fromAddress: event.fromAddress,
        toAddress: event.toAddress,
        memo: event.memo ?? null,
        ledgerSeq: event.ledgerSeq,
        txHash: event.txHash,
        type: event.type,
        ...(event.metadata || {}),
      };

      if (rule.compiledCondition) {
        if (!ruleCompiler.evaluate(rule.compiledCondition, context)) return false;
      } else {
        if (!evaluateRuleGroup(rule.conditions, context)) return false;
      }
    }

    return true;
  }
}

/**
 * Deterministic Historical Ledger Time-Travel Replay & Alert Backtesting Engine.
 */
export class BacktestReplayEngine {
  private readonly defaultMaxEvents = 25000;
  private readonly defaultMaxLedgers = 50000;
  private readonly defaultSampleSize = 50;
  private readonly defaultPageSize = 1000;

  /**
   * Executes candidate alert rule AST against historical ledger sequences in a sandbox.
   */
  async runBacktest(
    candidateRule: DraftAlertRule,
    options: BacktestReplayOptions = {},
  ): Promise<BacktestReport> {
    const startTime = performance.now();
    const backtestId = randomUUID();

    // 1. Boundary and Range Validations
    const validatedRange = this.validateAndNormalizeRange(options);
    const maxEventsLimit = options.maxEventsLimit ?? this.defaultMaxEvents;
    const sampleSizeLimit = options.sampleSizeLimit ?? this.defaultSampleSize;
    const pageSize = options.pageSize ?? this.defaultPageSize;

    // 2. Select historical data provider
    let provider: HistoricalDataProvider;
    if (options.seededEvents && Array.isArray(options.seededEvents)) {
      provider = new FixtureHistoricalProvider(options.seededEvents);
    } else {
      provider = new DatabaseHistoricalProvider(prisma);
    }

    // 3. Initialize Sandboxed Rule Evaluator (Zero external side effects)
    const evaluator = new SandboxedRuleEvaluator(candidateRule, options.baselineRule);

    // 4. Metric accumulators
    let totalEvaluations = 0;
    let totalMatches = 0;
    let baselineMatches = 0;
    let overlapMatches = 0;
    let microMatchesCount = 0;

    const hourlyMap = new Map<string, HourlyHistogramBucket>();
    const dailyMap = new Map<string, DailyHistogramBucket>();
    const sampleMatches: SampleMatchedEvent[] = [];

    let minTimestamp: number | null = null;
    let maxTimestamp: number | null = null;

    // 5. Stream historical events through sandboxed evaluator
    const streamResult = await provider.streamEvents(
      {
        startLedger: validatedRange.startLedger,
        endLedger: validatedRange.endLedger,
        startDate: validatedRange.startDate ? new Date(validatedRange.startDate) : undefined,
        endDate: validatedRange.endDate ? new Date(validatedRange.endDate) : undefined,
        walletId: options.walletId || candidateRule.walletId,
        maxEventsLimit,
        pageSize,
      },
      (batch: HistoricalLedgerEvent[]) => {
        for (const event of batch) {
          totalEvaluations++;

          // Track time bounds for duration calculation
          const eventTime = new Date(event.timestamp).getTime();
          if (minTimestamp === null || eventTime < minTimestamp) minTimestamp = eventTime;
          if (maxTimestamp === null || eventTime > maxTimestamp) maxTimestamp = eventTime;

          // Histogram date keys
          const hourKey = new Date(eventTime);
          hourKey.setUTCMinutes(0, 0, 0);
          const hourKeyStr = hourKey.toISOString();
          const dateKeyStr = hourKeyStr.slice(0, 10);

          // Hourly bucket init
          let hourlyBucket = hourlyMap.get(hourKeyStr);
          if (!hourlyBucket) {
            hourlyBucket = {
              hour: hourKeyStr,
              ledgerStart: event.ledgerSeq,
              ledgerEnd: event.ledgerSeq,
              totalEvaluations: 0,
              matches: 0,
            };
            hourlyMap.set(hourKeyStr, hourlyBucket);
          }
          hourlyBucket.totalEvaluations++;
          hourlyBucket.ledgerStart = Math.min(hourlyBucket.ledgerStart, event.ledgerSeq);
          hourlyBucket.ledgerEnd = Math.max(hourlyBucket.ledgerEnd, event.ledgerSeq);

          // Daily bucket init
          let dailyBucket = dailyMap.get(dateKeyStr);
          if (!dailyBucket) {
            dailyBucket = {
              date: dateKeyStr,
              totalEvaluations: 0,
              matches: 0,
            };
            dailyMap.set(dateKeyStr, dailyBucket);
          }
          dailyBucket.totalEvaluations++;

          // Rule evaluations
          const candidateMatched = evaluator.evaluateCandidate(event);
          const baselineMatched = evaluator.evaluateBaseline(event);

          if (baselineMatched) {
            baselineMatches++;
          }

          if (candidateMatched) {
            totalMatches++;
            hourlyBucket.matches++;
            dailyBucket.matches++;

            if (baselineMatched) {
              overlapMatches++;
            }

            if (Number(event.amount) < 1.0) {
              microMatchesCount++;
            }

            if (sampleMatches.length < sampleSizeLimit) {
              sampleMatches.push({
                id: event.id,
                txHash: event.txHash,
                ledgerSeq: event.ledgerSeq,
                timestamp: new Date(event.timestamp).toISOString(),
                amount: String(event.amount),
                asset: event.asset,
                fromAddress: event.fromAddress,
                toAddress: event.toAddress,
                memo: event.memo ?? null,
              });
            }
          }
        }

        if (totalEvaluations >= maxEventsLimit) {
          return false; // Stop streaming
        }
      },
    );

    // 6. Compute deterministic metrics
    const executionTimeMs = Number((performance.now() - startTime).toFixed(2));
    const totalLedgers = validatedRange.endLedger - validatedRange.startLedger + 1;

    let estimatedDurationSeconds: number;
    if (minTimestamp !== null && maxTimestamp !== null && maxTimestamp > minTimestamp) {
      estimatedDurationSeconds = Math.max(5, Math.round((maxTimestamp - minTimestamp) / 1000));
    } else {
      // 5 seconds per Stellar ledger sequence
      estimatedDurationSeconds = Math.max(5, totalLedgers * 5);
    }

    const durationHours = Math.max(0.001, estimatedDurationSeconds / 3600);
    const triggerFrequencyPerHour = Number((totalMatches / durationHours).toFixed(4));
    const triggerFrequencyPerDay = Number((triggerFrequencyPerHour * 24).toFixed(4));
    const estimatedMonthlyVolume = Math.round(triggerFrequencyPerDay * 30);
    const matchRate = totalEvaluations > 0 ? Number((totalMatches / totalEvaluations).toFixed(6)) : 0;

    // Deterministic simulated false-positive rate
    let simulatedFalsePositiveRate = 0;
    if (options.baselineRule) {
      const nonOverlapping = totalMatches - overlapMatches;
      simulatedFalsePositiveRate = totalMatches > 0 ? Number((nonOverlapping / totalMatches).toFixed(4)) : 0;
    } else {
      const microRatio = totalMatches > 0 ? microMatchesCount / totalMatches : 0;
      simulatedFalsePositiveRate = Number(
        Math.min(1.0, Math.max(0, microRatio * 0.65 + Math.min(1.0, matchRate * 5) * 0.35)).toFixed(4),
      );
    }

    // Sort histograms chronologically
    const hourlyHistogram = Array.from(hourlyMap.values()).sort((a, b) => a.hour.localeCompare(b.hour));
    const dailyHistogram = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    const reachedLimit = streamResult.reachedLimit || totalEvaluations >= maxEventsLimit;

    return {
      backtestId,
      executedAt: new Date().toISOString(),
      ruleSummary: {
        id: candidateRule.id,
        name: candidateRule.name,
        walletId: candidateRule.walletId ?? null,
        assets: candidateRule.assets || [],
        minAmount: candidateRule.minAmount ?? null,
        maxAmount: candidateRule.maxAmount ?? null,
        memo: candidateRule.memo ?? null,
        hasConditions: Boolean(candidateRule.conditions && (candidateRule.conditions.rules?.length ?? 0) > 0),
      },
      baselineSummary: options.baselineRule
        ? {
            name: options.baselineRule.name,
            matches: baselineMatches,
            overlapMatches,
          }
        : undefined,
      range: {
        startLedger: validatedRange.startLedger,
        endLedger: validatedRange.endLedger,
        totalLedgers,
        startDate: validatedRange.startDate,
        endDate: validatedRange.endDate,
        estimatedDurationSeconds,
      },
      metrics: {
        totalEvaluations,
        totalMatches,
        matchRate,
        triggerFrequencyPerHour,
        triggerFrequencyPerDay,
        simulatedFalsePositiveRate,
        estimatedMonthlyVolume,
        executionTimeMs,
      },
      hourlyHistogram,
      dailyHistogram,
      sampleMatches,
      status: reachedLimit ? 'truncated' : 'completed',
      resourceLimits: {
        maxEventsLimit,
        maxLedgersLimit: options.maxLedgersLimit ?? this.defaultMaxLedgers,
        reachedLimit,
      },
      dryRunVerified: true,
    };
  }

  private validateAndNormalizeRange(options: BacktestReplayOptions): {
    startLedger: number;
    endLedger: number;
    startDate?: string;
    endDate?: string;
  } {
    const maxLedgersLimit = options.maxLedgersLimit ?? this.defaultMaxLedgers;

    const hasLedgerRange = options.startLedger !== undefined || options.endLedger !== undefined;
    const hasDateRange = options.startDate !== undefined || options.endDate !== undefined;
    const hasSeededEvents = options.seededEvents && options.seededEvents.length > 0;

    if (!hasLedgerRange && !hasDateRange && !hasSeededEvents) {
      throw new ValidationError(
        'Must specify either ledger sequence range [startLedger, endLedger], date range [startDate, endDate], or seededEvents',
      );
    }

    let startLedger = options.startLedger;
    let endLedger = options.endLedger;
    let startDateStr = typeof options.startDate === 'string' ? options.startDate : options.startDate?.toISOString();
    let endDateStr = typeof options.endDate === 'string' ? options.endDate : options.endDate?.toISOString();

    if (hasDateRange) {
      if (!startDateStr || !endDateStr) {
        throw new ValidationError('Both startDate and endDate must be provided when querying by date range');
      }
      const sDate = new Date(startDateStr);
      const eDate = new Date(endDateStr);
      if (isNaN(sDate.getTime()) || isNaN(eDate.getTime())) {
        throw new ValidationError('Invalid date format for startDate or endDate');
      }
      if (sDate.getTime() > eDate.getTime()) {
        throw new ValidationError('startDate must be earlier than or equal to endDate');
      }

      const diffDays = (eDate.getTime() - sDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > 90) {
        throw new ValidationError('Date range cannot exceed 90 days');
      }

      // If ledger sequences are omitted, extrapolate approximate ledger numbers (Stellar closes every ~5s)
      if (startLedger === undefined) {
        const referenceLedger = 50000000;
        const referenceTime = new Date('2026-01-01T00:00:00Z').getTime();
        startLedger = Math.max(1, referenceLedger + Math.floor((sDate.getTime() - referenceTime) / 5000));
      }
      if (endLedger === undefined) {
        const deltaSec = Math.max(0, (eDate.getTime() - sDate.getTime()) / 1000);
        endLedger = startLedger + Math.max(1, Math.floor(deltaSec / 5));
      }
    }

    if (hasSeededEvents && (startLedger === undefined || endLedger === undefined)) {
      const seqs = options.seededEvents!.map((e) => e.ledgerSeq);
      if (seqs.length > 0) {
        if (startLedger === undefined) startLedger = Math.min(...seqs);
        if (endLedger === undefined) endLedger = Math.max(...seqs);
      } else {
        if (startLedger === undefined) startLedger = 1;
        if (endLedger === undefined) endLedger = 1;
      }
    }

    if (startLedger === undefined || endLedger === undefined) {
      throw new ValidationError('startLedger and endLedger must both be defined or inferred');
    }

    if (!Number.isInteger(startLedger) || startLedger <= 0) {
      throw new ValidationError('startLedger must be a positive integer');
    }

    if (!Number.isInteger(endLedger) || endLedger <= 0) {
      throw new ValidationError('endLedger must be a positive integer');
    }

    if (startLedger > endLedger) {
      throw new ValidationError('startLedger must be less than or equal to endLedger');
    }

    const requestedLedgerCount = endLedger - startLedger + 1;
    if (requestedLedgerCount > maxLedgersLimit) {
      throw new ValidationError(
        `Requested ledger sequence range (${requestedLedgerCount}) exceeds maximum allowed ledger limit (${maxLedgersLimit})`,
      );
    }

    return {
      startLedger,
      endLedger,
      startDate: startDateStr,
      endDate: endDateStr,
    };
  }
}

export const backtestReplayEngine = new BacktestReplayEngine();

import { describe, expect, it } from 'vitest';
import {
  assertScoreReconciliation,
  dedupeIndicators,
  scoreRisk,
  scoreToBand,
  SEVERITY_ORDERING,
  SEVERITY_WEIGHTS,
} from '../risk-scorer';
import type { RiskIndicator } from '../types';

const baseIndicator = (overrides: Partial<RiskIndicator>): RiskIndicator => ({
  code: 'TEST_IND',
  category: 'drain',
  severity: 'medium',
  weight: 12,
  title: 'Test',
  detail: 'Test detail',
  remediation: 'Fix it',
  evidence: {},
  ...overrides,
});

describe('risk-scorer', () => {
  it('dedupes indicators by code', () => {
    const indicators = [baseIndicator({ code: 'A' }), baseIndicator({ code: 'A' }), baseIndicator({ code: 'B' })];
    const deduped = dedupeIndicators(indicators);
    expect(deduped.length).toBe(2);
  });

  it('maps scores to bands correctly', () => {
    expect(scoreToBand(0)).toBe('SAFE');
    expect(scoreToBand(20)).toBe('LOW');
    expect(scoreToBand(40)).toBe('MODERATE');
    expect(scoreToBand(60)).toBe('HIGH');
    expect(scoreToBand(80)).toBe('CRITICAL');
    expect(scoreToBand(100)).toBe('CRITICAL');
  });

  it('scores indicators with correct weights', () => {
    const result = scoreRisk([
      baseIndicator({ severity: 'critical', weight: 40 }),
      baseIndicator({ severity: 'high', weight: 25, code: 'HIGH' }),
    ]);
    expect(result.score).toBe(65);
    expect(result.band).toBe('HIGH');
    expect(result.blockExecution).toBe(false);
  });

  it('caps score at 100', () => {
    const result = scoreRisk([
      baseIndicator({ weight: 60, code: 'A' }),
      baseIndicator({ weight: 60, code: 'B' }),
    ]);
    expect(result.score).toBe(100);
    expect(result.band).toBe('CRITICAL');
    expect(result.blockExecution).toBe(true);
  });

  it('blocks execution when score meets threshold', () => {
    const result = scoreRisk([baseIndicator({ weight: 80 })], { blockThreshold: 80 });
    expect(result.blockExecution).toBe(true);
    expect(result.blockThreshold).toBe(80);
  });

  it('builds reconciliation and actions', () => {
    const result = scoreRisk([
      baseIndicator({ severity: 'critical', weight: 40, category: 'contract', code: 'C1', remediation: 'Fix contract' }),
      baseIndicator({ severity: 'high', weight: 25, category: 'drain', code: 'D1', remediation: 'Fix drain' }),
      baseIndicator({ severity: 'high', weight: 25, category: 'drain', code: 'D2', remediation: 'Fix drain' }),
    ]);
    expect(assertScoreReconciliation(result)).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.breakdown.length).toBeGreaterThan(0);
  });

  it('has stable severity ordering and weights', () => {
    expect(SEVERITY_ORDERING).toBeDefined();
    expect(SEVERITY_WEIGHTS.critical).toBe(40);
    expect(SEVERITY_WEIGHTS.high).toBe(25);
  });
});

import { describe, expect, it } from 'vitest';
import {
  SignerInactivityWatcher,
  buildSignerActivities,
  type TreasurySignerSnapshot,
} from '../signerInactivityWatcher';
import type { MultisigThresholds } from '../../lib/stellar';

// #1008: multi-sig signer inactivity & key weight-decay watcher.
const NOW = Date.parse('2026-09-30T00:00:00Z');
const THRESHOLDS: MultisigThresholds = { low: 1, medium: 2, high: 3 };

function daysAgo(days: number): Date {
  return new Date(NOW - days * 24 * 60 * 60 * 1000);
}

function watcher() {
  return new SignerInactivityWatcher({
    staleAfterDays: 30,
    inactiveAfterDays: 90,
    abandonedAfterDays: 180,
  });
}

describe('SignerInactivityWatcher status & decay (#1008)', () => {
  const w = watcher();

  it('classifies signers by inactivity window', () => {
    expect(w.classify(w.inactiveDays(daysAgo(1), NOW))).toBe('ACTIVE');
    expect(w.classify(w.inactiveDays(daysAgo(45), NOW))).toBe('STALE');
    expect(w.classify(w.inactiveDays(daysAgo(120), NOW))).toBe('INACTIVE');
    expect(w.classify(w.inactiveDays(daysAgo(200), NOW))).toBe('ABANDONED');
    expect(w.classify(w.inactiveDays(null, NOW))).toBe('ABANDONED');
  });

  it('decays weight linearly between the stale and abandonment boundaries', () => {
    expect(w.decayFactor(w.inactiveDays(daysAgo(10), NOW))).toBe(1);
    expect(w.decayFactor(w.inactiveDays(daysAgo(30), NOW))).toBe(1);
    // Halfway (105 days): stale=30, abandoned=180, midpoint=105 -> 0.5
    expect(w.decayFactor(w.inactiveDays(daysAgo(105), NOW))).toBeCloseTo(0.5, 6);
    expect(w.decayFactor(w.inactiveDays(daysAgo(180), NOW))).toBe(0);
    expect(w.decayFactor(null)).toBe(0);
  });

  it('applies decay to the signer weight', () => {
    const a = w.assessSigner({ key: 'GA', weight: 10, lastActiveAt: daysAgo(105) }, NOW);
    expect(a.status).toBe('INACTIVE');
    expect(a.decayedWeight).toBeCloseTo(5, 2);
  });
});

describe('SignerInactivityWatcher.assessTreasury (#1008)', () => {
  const w = watcher();

  function snapshot(signers: TreasurySignerSnapshot['signers']): TreasurySignerSnapshot {
    return {
      treasuryId: 't1',
      publicKey: 'GTREASURYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      label: 'Ops Treasury',
      thresholds: THRESHOLDS,
      thresholdLevel: 'medium',
      signers,
    };
  }

  it('reports OK when active weight comfortably clears the threshold', () => {
    const result = w.assessTreasury(
      snapshot([
        { key: 'GA', weight: 1, lastActiveAt: daysAgo(1) },
        { key: 'GB', weight: 1, lastActiveAt: daysAgo(2) },
        { key: 'GC', weight: 1, lastActiveAt: daysAgo(3) },
      ]),
      NOW,
    );
    expect(result.requiredThreshold).toBe(2);
    expect(result.activeWeight).toBe(3);
    expect(result.risk).toBe('OK');
  });

  it('flags CRITICAL when abandonment drops reachable weight below quorum', () => {
    const result = w.assessTreasury(
      snapshot([
        { key: 'GA', weight: 1, lastActiveAt: daysAgo(1) },
        { key: 'GB', weight: 1, lastActiveAt: daysAgo(200) }, // abandoned
        { key: 'GC', weight: 1, lastActiveAt: null }, // never signed -> abandoned
      ]),
      NOW,
    );
    expect(result.reachableWeight).toBe(1); // only GA is not abandoned
    expect(result.risk).toBe('CRITICAL');
    expect(result.message).toContain('can no longer reach');
    expect(result.atRiskSigners).toHaveLength(2);
  });

  it('warns when quorum depends on stale signers returning', () => {
    const result = w.assessTreasury(
      snapshot([
        { key: 'GA', weight: 1, lastActiveAt: daysAgo(1) }, // active
        { key: 'GB', weight: 1, lastActiveAt: daysAgo(45) }, // stale (reachable)
        { key: 'GC', weight: 1, lastActiveAt: daysAgo(50) }, // stale (reachable)
      ]),
      NOW,
    );
    // active weight (1) < threshold (2), but reachable (3) >= threshold.
    expect(result.activeWeight).toBe(1);
    expect(result.reachableWeight).toBe(3);
    expect(result.risk).toBe('WARNING');
    expect(result.message).toContain('stale/inactive');
  });

  it('warns on single-signer concentration risk', () => {
    const result = w.assessTreasury(
      {
        treasuryId: 't2',
        publicKey: 'GHIGH',
        label: 'Whale Treasury',
        thresholds: { low: 1, medium: 3, high: 5 },
        thresholdLevel: 'medium',
        signers: [
          { key: 'GBIG', weight: 3, lastActiveAt: daysAgo(1) },
          { key: 'GSMALL', weight: 1, lastActiveAt: daysAgo(1) },
        ],
      },
      NOW,
    );
    // active weight 4 >= 3, but losing the weight-3 signer leaves 1 < 3.
    expect(result.risk).toBe('WARNING');
    expect(result.message).toContain('single signer');
  });

  it('getTreasuriesAtRisk returns only non-OK treasuries', () => {
    const atRisk = w.getTreasuriesAtRisk(
      [
        snapshot([
          { key: 'GA', weight: 1, lastActiveAt: daysAgo(1) },
          { key: 'GB', weight: 1, lastActiveAt: daysAgo(1) },
          { key: 'GC', weight: 1, lastActiveAt: daysAgo(1) },
        ]),
        snapshot([
          { key: 'GA', weight: 1, lastActiveAt: daysAgo(1) },
          { key: 'GB', weight: 1, lastActiveAt: daysAgo(200) },
          { key: 'GC', weight: 1, lastActiveAt: null },
        ]),
      ],
      NOW,
    );
    expect(atRisk).toHaveLength(1);
    expect(atRisk[0]!.risk).toBe('CRITICAL');
  });
});

describe('buildSignerActivities (#1008)', () => {
  it('joins on-chain signers with a last-activity lookup', () => {
    const activities = buildSignerActivities(
      [
        { key: 'GA', weight: 2 },
        { key: 'GB', weight: 1 },
      ],
      new Map([['GA', daysAgo(5)]]),
    );
    expect(activities[0]).toEqual({ key: 'GA', weight: 2, lastActiveAt: daysAgo(5) });
    expect(activities[1]!.lastActiveAt).toBeNull();
  });
});

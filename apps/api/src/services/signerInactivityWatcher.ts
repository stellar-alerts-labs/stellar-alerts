/**
 * Multi-Sig Key Weight Decay & Signer Inactivity Watcher (#1008)
 *
 * Analyses longitudinal signing behaviour across multi-sig treasury accounts,
 * flags signer keypairs that have gone quiet over configurable lookback windows,
 * and warns administrators when a treasury's quorum threshold is at risk of
 * being unreachable because signers are drifting toward abandonment.
 *
 * Two complementary signals are produced:
 *   1. **Discrete status** per signer (ACTIVE → STALE → INACTIVE → ABANDONED)
 *      based on days since last observed signing activity.
 *   2. **Weight decay** — an inactive signer's contribution linearly decays from
 *      full weight (at the stale boundary) to zero (at the abandonment boundary),
 *      giving an early, continuous read on eroding quorum headroom before any
 *      signer is written off entirely.
 *
 * Pure logic: the caller supplies each signer's last-activity timestamp and the
 * account's thresholds; the engine does no I/O.
 */

import type {
  MultisigSigner,
  MultisigThresholds,
  MultisigThresholdLevel,
} from '../lib/stellar';

export type SignerStatus = 'ACTIVE' | 'STALE' | 'INACTIVE' | 'ABANDONED';

export type QuorumRisk = 'OK' | 'WARNING' | 'CRITICAL';

export interface SignerActivity {
  key: string;
  weight: number;
  /** Last time this signer contributed a signature. null = never observed. */
  lastActiveAt: Date | null;
}

export interface TreasurySignerSnapshot {
  treasuryId: string;
  publicKey: string;
  label?: string | null;
  thresholds: MultisigThresholds;
  thresholdLevel: MultisigThresholdLevel;
  signers: SignerActivity[];
}

export interface SignerAssessment {
  key: string;
  weight: number;
  inactiveDays: number | null;
  status: SignerStatus;
  /** weight scaled by the decay factor (0..1); rounded to 2 dp. */
  decayedWeight: number;
}

export interface TreasuryInactivityAssessment {
  treasuryId: string;
  publicKey: string;
  label: string | null;
  requiredThreshold: number;
  thresholdLevel: MultisigThresholdLevel;
  totalWeight: number;
  /** Weight of signers still recently active (ACTIVE only). */
  activeWeight: number;
  /** Weight of signers not yet abandoned (could still realistically sign). */
  reachableWeight: number;
  /** Decay-weighted total across all signers. */
  decayedWeight: number;
  signers: SignerAssessment[];
  /** Signers that are STALE / INACTIVE / ABANDONED. */
  atRiskSigners: SignerAssessment[];
  risk: QuorumRisk;
  message: string;
}

export interface SignerInactivityOptions {
  /** Days of inactivity after which a signer is STALE (decay begins). Default 30. */
  staleAfterDays?: number;
  /** Days of inactivity after which a signer is INACTIVE. Default 90. */
  inactiveAfterDays?: number;
  /** Days of inactivity after which a signer is ABANDONED (decay = 0). Default 180. */
  abandonedAfterDays?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class SignerInactivityWatcher {
  private readonly staleAfterDays: number;
  private readonly inactiveAfterDays: number;
  private readonly abandonedAfterDays: number;

  constructor(options: SignerInactivityOptions = {}) {
    this.staleAfterDays = options.staleAfterDays ?? 30;
    this.inactiveAfterDays = options.inactiveAfterDays ?? 90;
    this.abandonedAfterDays = options.abandonedAfterDays ?? 180;
  }

  /** Whole days between `lastActiveAt` and now; null when never active. */
  public inactiveDays(lastActiveAt: Date | null, now: number): number | null {
    if (!lastActiveAt) return null;
    return Math.max(0, Math.floor((now - lastActiveAt.getTime()) / MS_PER_DAY));
  }

  /**
   * Continuous weight-decay factor in [0, 1]. Full weight until the stale
   * boundary, then linearly decays to 0 at the abandonment boundary. A signer
   * that has never been observed is treated as fully decayed.
   */
  public decayFactor(inactiveDays: number | null): number {
    if (inactiveDays === null) return 0;
    if (inactiveDays <= this.staleAfterDays) return 1;
    if (inactiveDays >= this.abandonedAfterDays) return 0;
    const span = this.abandonedAfterDays - this.staleAfterDays;
    const elapsed = inactiveDays - this.staleAfterDays;
    return Math.max(0, Math.min(1, 1 - elapsed / span));
  }

  public classify(inactiveDays: number | null): SignerStatus {
    // A signer with no observed activity is treated as abandoned.
    if (inactiveDays === null || inactiveDays >= this.abandonedAfterDays) return 'ABANDONED';
    if (inactiveDays >= this.inactiveAfterDays) return 'INACTIVE';
    if (inactiveDays >= this.staleAfterDays) return 'STALE';
    return 'ACTIVE';
  }

  public assessSigner(signer: SignerActivity, now: number): SignerAssessment {
    const inactiveDays = this.inactiveDays(signer.lastActiveAt, now);
    const status = this.classify(inactiveDays);
    const decayedWeight = round2(signer.weight * this.decayFactor(inactiveDays));
    return {
      key: signer.key,
      weight: signer.weight,
      inactiveDays,
      status,
      decayedWeight,
    };
  }

  private requiredThreshold(
    thresholds: MultisigThresholds,
    level: MultisigThresholdLevel,
  ): number {
    return level === 'low' ? thresholds.low : level === 'high' ? thresholds.high : thresholds.medium;
  }

  /**
   * Assesses a treasury's quorum resilience against signer inactivity.
   *
   * Risk levels:
   *   - CRITICAL: even every non-abandoned signer combined can no longer reach
   *     the threshold (`reachableWeight < requiredThreshold`).
   *   - WARNING: recently-active signers alone can't reach the threshold, OR
   *     losing the single highest-weight active signer would drop below it
   *     (concentration / abandonment risk).
   *   - OK: comfortable active headroom above the threshold.
   */
  public assessTreasury(
    snapshot: TreasurySignerSnapshot,
    now: number = Date.now(),
  ): TreasuryInactivityAssessment {
    const requiredThreshold = this.requiredThreshold(snapshot.thresholds, snapshot.thresholdLevel);
    const assessments = snapshot.signers.map((s) => this.assessSigner(s, now));

    let totalWeight = 0;
    let activeWeight = 0;
    let reachableWeight = 0;
    let decayedWeight = 0;
    let maxActiveWeight = 0;

    for (const a of assessments) {
      totalWeight += a.weight;
      decayedWeight += a.decayedWeight;
      if (a.status === 'ACTIVE') {
        activeWeight += a.weight;
        if (a.weight > maxActiveWeight) maxActiveWeight = a.weight;
      }
      if (a.status !== 'ABANDONED') {
        reachableWeight += a.weight;
      }
    }

    const atRiskSigners = assessments.filter((a) => a.status !== 'ACTIVE');

    let risk: QuorumRisk = 'OK';
    let message: string;
    const name = snapshot.label ?? snapshot.publicKey.slice(0, 8) + '…';

    if (reachableWeight < requiredThreshold) {
      risk = 'CRITICAL';
      message =
        `CRITICAL: Treasury "${name}" can no longer reach its ${snapshot.thresholdLevel} ` +
        `quorum (${requiredThreshold}). Reachable signer weight has decayed to ${reachableWeight} ` +
        `after signer abandonment.`;
    } else if (activeWeight < requiredThreshold) {
      risk = 'WARNING';
      message =
        `WARNING: Treasury "${name}" relies on stale/inactive signers to meet its ` +
        `${snapshot.thresholdLevel} quorum (${requiredThreshold}); active weight is only ${activeWeight}.`;
    } else if (activeWeight - maxActiveWeight < requiredThreshold) {
      risk = 'WARNING';
      message =
        `WARNING: Treasury "${name}" quorum depends on a single signer — losing its ` +
        `highest-weight active signer (${maxActiveWeight}) would drop below the ` +
        `${snapshot.thresholdLevel} threshold (${requiredThreshold}).`;
    } else {
      message =
        `Treasury "${name}" quorum is healthy (active weight ${activeWeight} / threshold ${requiredThreshold}).`;
    }

    return {
      treasuryId: snapshot.treasuryId,
      publicKey: snapshot.publicKey,
      label: snapshot.label ?? null,
      requiredThreshold,
      thresholdLevel: snapshot.thresholdLevel,
      totalWeight,
      activeWeight,
      reachableWeight,
      decayedWeight: round2(decayedWeight),
      signers: assessments,
      atRiskSigners,
      risk,
      message,
    };
  }

  /** Batch helper: returns only treasuries whose quorum is at WARNING/CRITICAL. */
  public getTreasuriesAtRisk(
    snapshots: TreasurySignerSnapshot[],
    now: number = Date.now(),
  ): TreasuryInactivityAssessment[] {
    return snapshots
      .map((s) => this.assessTreasury(s, now))
      .filter((a) => a.risk !== 'OK');
  }
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export const signerInactivityWatcher = new SignerInactivityWatcher();

/** Convenience: builds SignerActivity entries by joining on-chain signers with a
 *  last-activity lookup (e.g. from stored signing history). Signers with no
 *  recorded activity get `lastActiveAt: null` (treated as abandoned). */
export function buildSignerActivities(
  signers: MultisigSigner[],
  lastActiveByKey: Map<string, Date>,
): SignerActivity[] {
  return signers.map((s) => ({
    key: s.key,
    weight: s.weight,
    lastActiveAt: lastActiveByKey.get(s.key) ?? null,
  }));
}

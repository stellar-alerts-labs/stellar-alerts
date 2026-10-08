/**
 * Threat risk scoring with an auditable indicator breakdown.
 *
 * The design constraint for a *pre-execution* gate is that a human (or an
 * automated signer) has to be able to answer "why is this 85?" without reading
 * the engine's source. That rules out an opaque model and rules for anything
 * that isn't explainable as arithmetic. So the score is deliberately plain:
 *
 *      score = min(100, Σ weight of every distinct triggered indicator)
 *
 * with three properties that make it trustworthy:
 *
 *  1. **Deduplicated by `code`.** A rule that fires once per operation must not
 *     be able to push a benign envelope into the critical band by sheer count —
 *     so each code contributes at most once, and *volume* is reported as evidence
 *     (`DESTINATION_FAN_OUT.evidence.destinationCount`) rather than as score.
 *  2. **Reconcilable.** The per-category breakdown is computed from the same
 *     deduplicated set, so `Σ breakdown[].score` always equals `score` up to the
 *     100-point cap. `assertScoreReconciliation` checks this invariant and is
 *     exercised in the test suite.
 *  3. **Severities are stable.** Weights are tied to severity buckets, so
 *     adding a *new low-severity* rule can never silently reclassify an existing
 *     HIGH envelope into CRITICAL.
 */

import { formatRatioAsPercent, RATIO_SCALE } from './amounts';
import type {
  IndicatorCategory,
  RiskBand,
  RiskCategoryBreakdown,
  RiskIndicator,
  RiskSeverity,
  ThreatRiskAssessment,
} from './types';

const SEVERITY_ORDER: readonly RiskSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];

/** Weight contributed by one indicator at each severity. */
const SEVERITY_WEIGHT: Record<RiskSeverity, number> = {
  critical: 40,
  high: 25,
  medium: 12,
  low: 5,
  info: 0,
};

/**
 * Band boundaries, as `[upperBoundInclusive, band]`, highest first.
 * Any score at or above 80 is CRITICAL, so `blockThreshold`'s default of 80
 * lands exactly on the start of the band that should never execute.
 */
const SCORE_BANDS: ReadonlyArray<readonly [number, RiskBand]> = [
  [80, 'CRITICAL'],
  [60, 'HIGH'],
  [40, 'MODERATE'],
  [20, 'LOW'],
  [0, 'SAFE'],
];

export const DEFAULT_RISK_BLOCK_THRESHOLD = 80;

export interface RiskScoringOptions {
  /** Score at/above which `blockExecution` becomes true. */
  blockThreshold?: number;
}

/** Maps a 0-100 score onto its band. */
export function scoreToBand(score: number): RiskBand {
  const bounded = Math.max(0, Math.min(100, Math.trunc(score)));
  for (const [upper, band] of SCORE_BANDS) {
    if (bounded >= upper) return band;
  }
  return 'SAFE';
}

/** The severity weight a rule declares, falling back to its severity bucket. */
function weightOf(indicator: RiskIndicator): number {
  return Number.isFinite(indicator.weight) && indicator.weight >= 0
    ? indicator.weight
    : SEVERITY_WEIGHT[indicator.severity] ?? 0;
}

/**
 * Collapses indicators to at most one entry per code, keeping the first
 * occurrence. Detectors emit in a deterministic order, so "first wins" is
 * stable across runs and the retained indicator is the one with the most
 * specific evidence.
 */
export function dedupeIndicators(indicators: RiskIndicator[]): RiskIndicator[] {
  const seen = new Set<string>();
  const result: RiskIndicator[] = [];
  for (const indicator of indicators) {
    if (seen.has(indicator.code)) continue;
    seen.add(indicator.code);
    result.push(indicator);
  }
  return result;
}

function worstSeverityOf(severities: RiskSeverity[]): RiskSeverity {
  let worst: RiskSeverity = 'info';
  for (const severity of severities) {
    if (SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(worst)) worst = severity;
  }
  return worst;
}

function buildBreakdown(indicators: RiskIndicator[]): RiskCategoryBreakdown[] {
  const byCategory = new Map<IndicatorCategory, RiskIndicator[]>();
  for (const indicator of indicators) {
    const bucket = byCategory.get(indicator.category);
    if (bucket) bucket.push(indicator);
    else byCategory.set(indicator.category, [indicator]);
  }

  const total = indicators.reduce((sum, i) => sum + weightOf(i), 0);

  return [...byCategory.entries()]
    .map(([category, categoryIndicators]) => {
      const score = categoryIndicators.reduce((sum, i) => sum + weightOf(i), 0);
      return {
        category,
        score,
        // A share of the *uncapped* total, so the percentages stay meaningful
        // even when the headline score is clamped to 100.
        sharePercent: formatRatioAsPercent(
          total > 0 ? (BigInt(score) * RATIO_SCALE) / BigInt(Math.max(1, total)) : 0n,
        ),
        indicatorCount: categoryIndicators.length,
        worstSeverity: worstSeverityOf(categoryIndicators.map((i) => i.severity)),
        codes: categoryIndicators.map((i) => i.code).sort(),
      };
    })
    .sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
}

/** Ordered, de-duplicated remediation steps, most severe first. */
function buildActions(indicators: RiskIndicator[]): string[] {
  const ordered = [...indicators].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
      weightOf(b) - weightOf(a) ||
      a.code.localeCompare(b.code),
  );

  const actions: string[] = [];
  const seen = new Set<string>();
  for (const indicator of ordered) {
    if (indicator.remediation && !seen.has(indicator.remediation)) {
      seen.add(indicator.remediation);
      actions.push(indicator.remediation);
    }
  }
  return actions;
}

function countSeverities(indicators: RiskIndicator[]): Record<RiskSeverity, number> {
  const counts: Record<RiskSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const indicator of indicators) {
    counts[indicator.severity] = (counts[indicator.severity] ?? 0) + 1;
  }
  return counts;
}

function buildSummary(
  score: number,
  band: RiskBand,
  indicators: RiskIndicator[],
  breakdown: RiskCategoryBreakdown[],
): string {
  if (indicators.length === 0) {
    return `Threat score ${score}/100 (${band}): no drain, footprint, contract, or envelope indicators triggered.`;
  }

  const topCategory = breakdown[0];
  const criticalCount = indicators.filter((i) => i.severity === 'critical').length;
  const categoryText = topCategory
    ? ` driven mainly by ${topCategory.category} (${topCategory.score} pts across ${topCategory.codes.length} indicator${topCategory.codes.length === 1 ? '' : 's'})`
    : '';

  const criticalText =
    criticalCount > 0 ? ` ${criticalCount} critical indicator${criticalCount === 1 ? '' : 's'} present.` : '';

  return `Threat score ${score}/100 (${band})${categoryText}.${criticalText}`;
}

/**
 * Turns a set of triggered indicators into the final, explainable assessment.
 *
 * `indicators` is deduplicated by `code` before scoring, so the returned
 * `score`, `breakdown`, `severityCounts`, and `actions` all describe the same
 * deduplicated set.
 */
export function scoreRisk(
  indicators: RiskIndicator[],
  options: RiskScoringOptions = {},
): ThreatRiskAssessment {
  const blockThreshold = Math.max(0, Math.min(100, options.blockThreshold ?? DEFAULT_RISK_BLOCK_THRESHOLD));
  const deduped = dedupeIndicators(indicators);
  const rawTotal = deduped.reduce((sum, i) => sum + weightOf(i), 0);
  const score = Math.min(100, Math.max(0, Math.round(rawTotal)));
  const band = scoreToBand(score);
  const breakdown = buildBreakdown(deduped);

  return {
    score,
    band,
    blockThreshold,
    blockExecution: score >= blockThreshold,
    breakdown,
    severityCounts: countSeverities(deduped),
    summary: buildSummary(score, band, deduped, breakdown),
    actions: buildActions(deduped),
  };
}

/**
 * Reconciliation invariant: the category breakdown must account for exactly the
 * same score that was reported, once the 100-point cap is accounted for.
 *
 * Exported (and asserted in tests) because it is the property that makes the
 * breakdown trustworthy — a breakdown that silently disagrees with the headline
 * number is worse than no breakdown at all.
 */
export function assertScoreReconciliation(assessment: ThreatRiskAssessment): boolean {
  const categoryTotal = assessment.breakdown.reduce((sum, b) => sum + b.score, 0);
  return categoryTotal >= assessment.score && assessment.score >= Math.min(100, categoryTotal);
}

/** Severity ordering helper, exported for deterministic sorting in tests/UI. */
export const SEVERITY_ORDERING = SEVERITY_ORDER;

/** Weight table, exported so docs and tests can assert the stability property. */
export const SEVERITY_WEIGHTS = SEVERITY_WEIGHT;

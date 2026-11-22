import {
  HostSaturationProfilerService,
  hostSaturationProfilerService,
  type SaturationProfileResult,
  type ResourceDimensionKey,
} from '../../soroban/host-saturation-profiler.service';
import { type SorobanSaturationAlert, type SorobanResourceLimits } from '@stellar-alerts/shared';
import { createLogger } from '../../../lib/logger';

const log = createLogger({ module: 'HostSaturationRule' });

export interface AlertRuleLike {
  id: string;
  userId: string;
  walletId?: string | null;
  name?: string | null;
  isActive: boolean;
  conditions?: unknown;
}

export interface HostSaturationRuleConfig {
  threshold?: number;
  criticalThreshold?: number;
  contractIds?: string[];
  dimensions?: ResourceDimensionKey[];
  customLimits?: Partial<SorobanResourceLimits>;
}

export interface HostSaturationRuleMatchResult {
  matched: boolean;
  ruleId?: string;
  deliveryPayload?: {
    event: 'soroban.host_saturation_alert';
    ruleId: string;
    userId: string;
    walletId?: string | null;
    contractId: string;
    txHash?: string;
    profile: SaturationProfileResult;
    alert: SorobanSaturationAlert;
    metadata: Record<string, unknown>;
  };
}

/**
 * Alert rule evaluator that detects when Soroban invocations approach or exceed
 * host CPU instruction and ledger footprint limits (#972).
 */
export class HostSaturationRuleEvaluator {
  private readonly profiler: HostSaturationProfilerService;

  constructor(profiler: HostSaturationProfilerService = hostSaturationProfilerService) {
    this.profiler = profiler;
  }

  public evaluate(
    source: unknown,
    rule: AlertRuleLike,
    context: { txHash?: string; contractId?: string; ledgerSeq?: number } = {},
  ): HostSaturationRuleMatchResult {
    if (!rule.isActive) {
      return { matched: false };
    }

    const config = this.extractRuleConfig(rule);
    const contractId = context.contractId ?? this.extractContractId(source);

    if (config?.contractIds && config.contractIds.length > 0) {
      if (!contractId || !config.contractIds.some((c) => c.toLowerCase() === contractId.toLowerCase())) {
        return { matched: false };
      }
    }

    const profile = this.profiler.profile(source, {
      warningThreshold: config?.threshold,
      criticalThreshold: config?.criticalThreshold,
      customLimits: config?.customLimits,
      txHash: context.txHash,
      ledgerSeq: context.ledgerSeq,
    });

    if (profile.status === 'HEALTHY' || !profile.alertPayload) {
      return { matched: false };
    }

    if (config?.dimensions && config.dimensions.length > 0) {
      const targetDims = new Set(config.dimensions);
      const hasTargetSaturation = profile.saturatedDimensions.some((d) => targetDims.has(d));
      if (!hasTargetSaturation) {
        return { matched: false };
      }
    }

    log.warn(
      {
        ruleId: rule.id,
        txHash: context.txHash,
        contractId: profile.contractId,
        overallSaturationPercent: profile.overallSaturationPercent,
        saturatedDimensions: profile.saturatedDimensions,
        severity: profile.status,
      },
      'Soroban host saturation alert rule fired',
    );

    return {
      matched: true,
      ruleId: rule.id,
      deliveryPayload: {
        event: 'soroban.host_saturation_alert',
        ruleId: rule.id,
        userId: rule.userId,
        walletId: rule.walletId,
        contractId: profile.contractId,
        txHash: profile.txHash,
        profile,
        alert: profile.alertPayload,
        metadata: {
          ruleName: rule.name,
          overallSaturationPercent: profile.overallSaturationPercent,
          saturatedDimensions: profile.saturatedDimensions,
          recommendations: profile.telemetry.recommendations,
          status: profile.status,
        },
      },
    };
  }

  private extractRuleConfig(rule: AlertRuleLike): HostSaturationRuleConfig | undefined {
    if (!rule.conditions || typeof rule.conditions !== 'object') {
      return undefined;
    }
    const cond = rule.conditions as Record<string, unknown>;
    const cfg = cond.hostSaturation ?? cond.resourceSaturation ?? cond.resourceUsage;
    if (!cfg || typeof cfg !== 'object') {
      return undefined;
    }
    return cfg as HostSaturationRuleConfig;
  }

  private extractContractId(source: unknown): string | undefined {
    if (!source || typeof source !== 'object') return undefined;
    const s = source as Record<string, unknown>;
    if (typeof s.contractId === 'string') return s.contractId;
    if (Array.isArray(s.invocations) && s.invocations.length > 0) {
      const first = s.invocations[0] as Record<string, unknown>;
      if (typeof first?.contractId === 'string') return first.contractId;
    }
    return undefined;
  }
}

export const hostSaturationRuleEvaluator = new HostSaturationRuleEvaluator();

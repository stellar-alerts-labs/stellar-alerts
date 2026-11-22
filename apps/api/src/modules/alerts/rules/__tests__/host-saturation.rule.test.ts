import { describe, it, expect, beforeEach } from 'vitest';
import {
  HostSaturationRuleEvaluator,
  type AlertRuleLike,
} from '../host-saturation.rule';
import { HostSaturationProfilerService } from '../../../soroban/host-saturation-profiler.service';

describe('HostSaturationRuleEvaluator (#972)', () => {
  let evaluator: HostSaturationRuleEvaluator;

  beforeEach(() => {
    evaluator = new HostSaturationRuleEvaluator(new HostSaturationProfilerService());
  });

  const baseRule: AlertRuleLike = {
    id: 'rule-sat-1',
    userId: 'user-sat-1',
    walletId: 'wallet-sat-1',
    name: 'Soroban Resource Saturation Guard',
    isActive: true,
    conditions: {
      hostSaturation: {
        threshold: 0.80,
        criticalThreshold: 0.95,
      },
    },
  };

  it('does not fire if rule is inactive', () => {
    const inactiveRule: AlertRuleLike = {
      ...baseRule,
      isActive: false,
    };

    const source = {
      contractId: 'C_HIGH_CPU',
      cpuInstructions: 90_000_000,
    };

    const result = evaluator.evaluate(source, inactiveRule);
    expect(result.matched).toBe(false);
  });

  it('fires warning alert when CPU saturation reaches 85%', () => {
    const source = {
      contractId: 'C_HEAVY_CONTRACT',
      functionName: 'complex_calc',
      cpuInstructions: 85_000_000,
      ramBytes: 15_000_000,
    };

    const result = evaluator.evaluate(source, baseRule, {
      txHash: '0xhash123',
      contractId: 'C_HEAVY_CONTRACT',
    });

    expect(result.matched).toBe(true);
    expect(result.ruleId).toBe('rule-sat-1');
    expect(result.deliveryPayload?.event).toBe('soroban.host_saturation_alert');
    expect(result.deliveryPayload?.alert.severity).toBe('WARNING');
    expect(result.deliveryPayload?.alert.overallSaturationPercent).toBe(85);
    expect(result.deliveryPayload?.alert.saturatedDimensions).toContain('cpu');
    expect(result.deliveryPayload?.metadata.recommendations).toBeInstanceOf(Array);
  });

  it('fires critical alert when ledger write bytes reach 96%', () => {
    const source = {
      contractId: 'C_STATE_BLOAT',
      functionName: 'persist_blob',
      cpuInstructions: 20_000_000,
      ramBytes: 10_000_000,
      writeLedgerBytes: 126_000, // 126,000 / 131,072 = 96.13%
    };

    const result = evaluator.evaluate(source, baseRule, {
      txHash: '0xcritical_write',
    });

    expect(result.matched).toBe(true);
    expect(result.deliveryPayload?.alert.severity).toBe('CRITICAL');
    expect(result.deliveryPayload?.alert.saturatedDimensions).toContain('writeBytes');
  });

  it('suppresses alert when resource usage is beneath warning threshold', () => {
    const source = {
      contractId: 'C_NORMAL_CONTRACT',
      cpuInstructions: 50_000_000, // 50%
      ramBytes: 10_000_000,        // ~23.8%
    };

    const result = evaluator.evaluate(source, baseRule);
    expect(result.matched).toBe(false);
  });

  it('filters by specified contractIds in rule condition', () => {
    const targetedRule: AlertRuleLike = {
      ...baseRule,
      conditions: {
        hostSaturation: {
          threshold: 0.80,
          contractIds: ['C_TARGET_CONTRACT'],
        },
      },
    };

    const nonTargetSource = {
      contractId: 'C_OTHER_CONTRACT',
      cpuInstructions: 90_000_000,
    };

    const targetSource = {
      contractId: 'C_TARGET_CONTRACT',
      cpuInstructions: 90_000_000,
    };

    expect(evaluator.evaluate(nonTargetSource, targetedRule).matched).toBe(false);
    expect(evaluator.evaluate(targetSource, targetedRule).matched).toBe(true);
  });

  it('filters by specific monitored dimensions', () => {
    const ramOnlyRule: AlertRuleLike = {
      ...baseRule,
      conditions: {
        hostSaturation: {
          threshold: 0.80,
          dimensions: ['ram'],
        },
      },
    };

    // CPU is 90%, but RAM is low
    const cpuHighRamLow = {
      contractId: 'C_CPU_ONLY',
      cpuInstructions: 90_000_000,
      ramBytes: 5_000_000,
    };

    // RAM is 85%
    const ramHigh = {
      contractId: 'C_RAM_HIGH',
      cpuInstructions: 10_000_000,
      ramBytes: 36_000_000, // 36MB / 40MB = ~85.8%
    };

    expect(evaluator.evaluate(cpuHighRamLow, ramOnlyRule).matched).toBe(false);
    expect(evaluator.evaluate(ramHigh, ramOnlyRule).matched).toBe(true);
  });
});

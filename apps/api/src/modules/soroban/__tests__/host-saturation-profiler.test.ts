import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HostSaturationProfilerService,
  hostSaturationProfilerService,
  DEFAULT_SOROBAN_PROTOCOL_LIMITS,
  DEFAULT_SATURATION_WARNING_THRESHOLD,
  DEFAULT_SATURATION_CRITICAL_THRESHOLD,
  toSafeNumber,
  type SorobanHostInvocationNode,
} from '../host-saturation-profiler.service';

vi.mock('../../../lib/queue', () => ({
  paymentAlertQueue: { add: vi.fn(), on: vi.fn() },
  alertQueue: { add: vi.fn(), on: vi.fn() },
  dlqQueue: { add: vi.fn(), on: vi.fn() },
  registerQueueMetrics: vi.fn(),
}));

import { inspectInvocationHostSaturation } from '../../../workers/watcher.worker';

describe('Soroban Host Function CPU Instruction & Ledger Byte Limit Saturation Profiler (#972)', () => {
  let profiler: HostSaturationProfilerService;

  beforeEach(() => {
    profiler = new HostSaturationProfilerService();
  });

  describe('Numeric & Input Sanitization', () => {
    it('safely parses null, undefined, bigints, and numeric strings', () => {
      expect(toSafeNumber(null)).toBe(0);
      expect(toSafeNumber(undefined, 42)).toBe(42);
      expect(toSafeNumber('1500000')).toBe(1500000);
      expect(toSafeNumber('  999  ')).toBe(999);
      expect(toSafeNumber(10000000n)).toBe(10000000);
      expect(toSafeNumber(-500)).toBe(0);
      expect(toSafeNumber('invalid-string', 10)).toBe(10);
    });
  });

  describe('Protocol Limit Resolution', () => {
    it('uses standard Soroban network protocol default limits when no overrides are given', () => {
      const limits = profiler.resolveLimits();
      expect(limits.cpuInstructions).toBe(DEFAULT_SOROBAN_PROTOCOL_LIMITS.cpuInstructions);
      expect(limits.ramBytes).toBe(DEFAULT_SOROBAN_PROTOCOL_LIMITS.ramBytes);
      expect(limits.readLedgerEntries).toBe(DEFAULT_SOROBAN_PROTOCOL_LIMITS.readLedgerEntries);
      expect(limits.writeLedgerEntries).toBe(DEFAULT_SOROBAN_PROTOCOL_LIMITS.writeLedgerEntries);
      expect(limits.readLedgerBytes).toBe(DEFAULT_SOROBAN_PROTOCOL_LIMITS.readLedgerBytes);
      expect(limits.writeLedgerBytes).toBe(DEFAULT_SOROBAN_PROTOCOL_LIMITS.writeLedgerBytes);
    });

    it('allows custom network protocol limit overrides', () => {
      const customLimits = profiler.resolveLimits({
        cpuInstructions: 50_000_000,
        ramBytes: 20_000_000,
        readLedgerEntries: 20,
      });

      expect(customLimits.cpuInstructions).toBe(50_000_000);
      expect(customLimits.ramBytes).toBe(20_000_000);
      expect(customLimits.readLedgerEntries).toBe(20);
      // Non-overridden fallback to defaults
      expect(customLimits.writeLedgerEntries).toBe(DEFAULT_SOROBAN_PROTOCOL_LIMITS.writeLedgerEntries);
    });
  });

  describe('Accurate Saturation Ratios Calculation', () => {
    it('computes exact saturation ratios across all 6 resource dimensions', () => {
      const node: SorobanHostInvocationNode = {
        contractId: 'C_DEFI_ROUTER',
        functionName: 'swap_exact_tokens',
        cpuInstructions: 85_000_000, // 85% of 100M
        ramBytes: 33_554_432,        // 80% of 40MB (41,943,040)
        readLedgerEntries: 32,       // 80% of 40
        writeLedgerEntries: 20,      // 80% of 25
        readLedgerBytes: 160_000,    // 80% of 200,000
        writeLedgerBytes: 104_858,   // 80% of 131,072
      };

      const result = profiler.profile(node);

      expect(result.hasData).toBe(true);
      expect(result.contractId).toBe('C_DEFI_ROUTER');
      expect(result.status).toBe('WARNING');
      expect(result.overallSaturationPercent).toBe(85);
      expect(result.bottleneckDimension).toBe('cpu');

      expect(result.dimensions.cpu.saturationPercent).toBe(85);
      expect(result.dimensions.cpu.isExceeded).toBe(true);
      expect(result.dimensions.cpu.isCritical).toBe(false);

      expect(result.dimensions.ram.saturationPercent).toBe(80);
      expect(result.dimensions.ram.isExceeded).toBe(true);

      expect(result.dimensions.readEntries.saturationPercent).toBe(80);
      expect(result.dimensions.readEntries.isExceeded).toBe(true);

      expect(result.dimensions.writeEntries.saturationPercent).toBe(80);
      expect(result.dimensions.writeEntries.isExceeded).toBe(true);

      expect(result.dimensions.readBytes.saturationPercent).toBe(80);
      expect(result.dimensions.readBytes.isExceeded).toBe(true);

      expect(result.dimensions.writeBytes.saturationPercent).toBe(80);
      expect(result.dimensions.writeBytes.isExceeded).toBe(true);
    });

    it('returns HEALTHY status when invocation is within safety limits', () => {
      const node: SorobanHostInvocationNode = {
        contractId: 'C_TOKEN',
        functionName: 'transfer',
        cpuInstructions: 15_000_000, // 15%
        ramBytes: 2_000_000,        // ~4.7%
        readLedgerEntries: 2,       // 5%
        writeLedgerEntries: 2,      // 8%
        readLedgerBytes: 1_000,
        writeLedgerBytes: 500,
      };

      const result = profiler.profile(node);

      expect(result.hasData).toBe(true);
      expect(result.status).toBe('HEALTHY');
      expect(result.overallSaturationPercent).toBe(15);
      expect(result.saturatedDimensions).toHaveLength(0);
      expect(result.alertPayload).toBeNull();
    });

    it('triggers CRITICAL severity alert when any metric exceeds 95% saturation threshold', () => {
      const node: SorobanHostInvocationNode = {
        contractId: 'C_LIQUIDATION_ENGINE',
        functionName: 'liquidate_collateral',
        cpuInstructions: 97_500_000, // 97.5% CPU saturation
        ramBytes: 10_000_000,
        readLedgerEntries: 10,
        writeLedgerEntries: 5,
        readLedgerBytes: 20_000,
        writeLedgerBytes: 10_000,
      };

      const result = profiler.profile(node);

      expect(result.status).toBe('CRITICAL');
      expect(result.overallSaturationPercent).toBe(97.5);
      expect(result.bottleneckDimension).toBe('cpu');
      expect(result.dimensions.cpu.isCritical).toBe(true);
      expect(result.alertPayload).not.toBeNull();
      expect(result.alertPayload?.severity).toBe('CRITICAL');
    });

    it('detects ledger write byte saturation bottleneck', () => {
      const node: SorobanHostInvocationNode = {
        contractId: 'C_ORACLE_STORE',
        functionName: 'commit_feed_snapshots',
        cpuInstructions: 20_000_000,
        ramBytes: 5_000_000,
        readLedgerEntries: 5,
        writeLedgerEntries: 22,    // 88%
        readLedgerBytes: 20_000,
        writeLedgerBytes: 125_000, // 95.37% of 131,072
      };

      const result = profiler.profile(node);

      expect(result.status).toBe('CRITICAL');
      expect(result.bottleneckDimension).toBe('writeBytes');
      expect(result.dimensions.writeBytes.saturationPercent).toBeCloseTo(95.37, 1);
      expect(result.saturatedDimensions).toContain('writeBytes');
      expect(result.saturatedDimensions).toContain('writeEntries');
    });
  });

  describe('Hierarchical Call Tree Aggregation & Hotspot Analysis', () => {
    it('recursively accumulates parent and child sub-invocations', () => {
      const invocationTree: SorobanHostInvocationNode = {
        contractId: 'C_ROUTER',
        functionName: 'execute_multi_hop',
        cpuInstructions: 20_000_000,
        ramBytes: 10_000_000,
        readLedgerEntries: 5,
        writeLedgerEntries: 2,
        readLedgerBytes: 20_000,
        writeLedgerBytes: 5_000,
        subInvocations: [
          {
            contractId: 'C_POOL_A',
            functionName: 'swap_step_1',
            cpuInstructions: 35_000_000,
            ramBytes: 12_000_000,
            readLedgerEntries: 10,
            writeLedgerEntries: 8,
            readLedgerBytes: 50_000,
            writeLedgerBytes: 30_000,
            subInvocations: [
              {
                contractId: 'C_SAC_USDC',
                functionName: 'transfer',
                cpuInstructions: 15_000_000,
                ramBytes: 5_000_000,
                readLedgerEntries: 5,
                writeLedgerEntries: 4,
                readLedgerBytes: 20_000,
                writeLedgerBytes: 15_000,
              },
            ],
          },
          {
            contractId: 'C_POOL_B',
            functionName: 'swap_step_2',
            cpuInstructions: 25_000_000,
            ramBytes: 8_000_000,
            readLedgerEntries: 12,
            writeLedgerEntries: 8,
            readLedgerBytes: 60_000,
            writeLedgerBytes: 40_000,
          },
        ],
      };

      const result = profiler.profile(invocationTree, {
        txHash: '0xabc123trace',
        ledgerSeq: 12345,
      });

      // Total CPU = 20M + 35M + 15M + 25M = 95M (95% of 100M -> CRITICAL)
      expect(result.consumption.totalCpuInstructions).toBe(95_000_000);
      expect(result.dimensions.cpu.saturationPercent).toBe(95);

      // Total RAM = 10M + 12M + 5M + 8M = 35MB
      expect(result.consumption.totalRamBytes).toBe(35_000_000);

      // Total Read Entries = 5 + 10 + 5 + 12 = 32 entries (80% of 40)
      expect(result.consumption.totalReadLedgerEntries).toBe(32);

      // Total Write Entries = 2 + 8 + 4 + 8 = 22 entries (88% of 25)
      expect(result.consumption.totalWriteLedgerEntries).toBe(22);

      // Total Invocations = 4
      expect(result.consumption.totalInvocations).toBe(4);
      expect(result.consumption.maxCallDepth).toBe(3);

      // Hotspot identification: C_POOL_A is top CPU consumer with 35M
      expect(result.consumption.hotspots[0].contractId).toBe('C_POOL_A');
      expect(result.consumption.hotspots[0].cpuInstructions).toBe(35_000_000);
      expect(result.consumption.hotspots[0].cpuPercentOfTotal).toBeCloseTo(36.84, 1);
    });

    it('generates high call depth warning telemetry when call depth exceeds threshold', () => {
      // Build a 12-frame deep recursion
      let current: SorobanHostInvocationNode = {
        contractId: 'C_CHAIN_12',
        functionName: 'leaf_call',
        cpuInstructions: 1_000_000,
        ramBytes: 500_000,
      };

      for (let i = 11; i >= 1; i--) {
        current = {
          contractId: `C_CHAIN_${i}`,
          functionName: `hop_${i}`,
          cpuInstructions: 7_500_000,
          ramBytes: 3_000_000,
          subInvocations: [current],
        };
      }

      const result = profiler.profile(current);
      expect(result.consumption.maxCallDepth).toBe(12);
      expect(result.telemetry.recommendations.some((r) => r.includes('High cross-contract call depth'))).toBe(true);
    });
  });

  describe('Safe Parsing of Invocation Trace Metadata', () => {
    it('parses from Soroban RPC simulation response structure', () => {
      const mockSimulationResponse = {
        transactionData: {
          resources: {
            instructions: 100_000_000,
            readBytes: 200_000,
            writeBytes: 131_072,
          },
          footprint: {
            readOnly: [{ toXDR: () => 'ro_1' }, { toXDR: () => 'ro_2' }],
            readWrite: [{ toXDR: () => 'rw_1' }],
          },
        },
        cpuInstructions: 82_000_000,
        ramBytes: 35_000_000,
        readBytes: 170_000,
        writeBytes: 110_000,
        contractId: 'C_SIMULATED_CONTRACT',
        txHash: '0xsimulation_hash',
      };

      const result = profiler.profile(mockSimulationResponse);

      expect(result.hasData).toBe(true);
      expect(result.contractId).toBe('C_SIMULATED_CONTRACT');
      expect(result.dimensions.cpu.saturationPercent).toBe(82);
      expect(result.status).toBe('WARNING');
      expect(result.dimensions.readEntries.used).toBe(2);
      expect(result.dimensions.writeEntries.used).toBe(1);
    });

    it('parses from diagnostic events array', () => {
      const diagnosticEvents = [
        {
          contractId: 'C_DIAGNOSTIC_TOKEN',
          topic: ['transfer', 'G_FROM', 'G_TO'],
          coreMetrics: {
            cpuInstructions: 83_000_000,
            ramBytes: 25_000_000,
          },
        },
      ];

      const result = profiler.profile({ diagnosticEvents, contractId: 'C_DIAGNOSTIC_TOKEN' });

      expect(result.hasData).toBe(true);
      expect(result.contractId).toBe('C_DIAGNOSTIC_TOKEN');
      expect(result.dimensions.cpu.saturationPercent).toBe(83);
      expect(result.status).toBe('WARNING');
    });

    it('handles empty, null, or completely malformed inputs gracefully without throwing', () => {
      const emptyResult = profiler.profile({});
      expect(emptyResult.hasData).toBe(false);
      expect(emptyResult.status).toBe('HEALTHY');
      expect(emptyResult.alertPayload).toBeNull();

      const nullResult = profiler.profile(null);
      expect(nullResult.hasData).toBe(false);
      expect(nullResult.status).toBe('HEALTHY');

      const undefinedResult = profiler.profile(undefined);
      expect(undefinedResult.hasData).toBe(false);

      const invalidTypeResult = profiler.profile('some-random-string-not-json');
      expect(invalidTypeResult.hasData).toBe(false);
    });
  });

  describe('Watcher Worker Integration', () => {
    it('executes watcher worker helper inspectInvocationHostSaturation seamlessly', async () => {
      const payload = {
        contractId: 'C_WORKER_PROFILED_CONTRACT',
        functionName: 'batch_settle',
        cpuInstructions: 88_000_000,
        ramBytes: 20_000_000,
        readLedgerEntries: 20,
        writeLedgerEntries: 15,
        readLedgerBytes: 100_000,
        writeLedgerBytes: 50_000,
      };

      const assessment = await inspectInvocationHostSaturation(payload, {
        txHash: '0xworker_tx_999',
        ledgerSeq: 77777,
      });

      expect(assessment.status).toBe('WARNING');
      expect(assessment.contractId).toBe('C_WORKER_PROFILED_CONTRACT');
      expect(assessment.dimensions.cpu.saturationPercent).toBe(88);
      expect(assessment.txHash).toBe('0xworker_tx_999');
      expect(assessment.ledgerSeq).toBe(77777);
      expect(assessment.alertPayload).not.toBeNull();
      expect(assessment.alertPayload?.type).toBe('SOROBAN_RESOURCE_SATURATION');
    });
  });
});

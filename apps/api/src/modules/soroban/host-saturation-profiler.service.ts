import { createLogger } from '../../lib/logger';
import {
  type SorobanResourceLimits,
  type ResourceDimensionSaturation,
  type SorobanSaturationAlert,
  type SorobanInvocationMetrics,
} from '@stellar-alerts/shared';

const logger = createLogger({ module: 'HostSaturationProfilerService' });

/**
 * Standard default Soroban network protocol limits (Protocol 20/21/22).
 */
export const DEFAULT_SOROBAN_PROTOCOL_LIMITS: Readonly<SorobanResourceLimits> = Object.freeze({
  cpuInstructions: 100_000_000, // 100M instructions per transaction
  ramBytes: 41_943_040,         // 40 MB memory limit
  readLedgerEntries: 40,        // Max read ledger entries
  writeLedgerEntries: 25,       // Max write ledger entries
  readLedgerBytes: 200_000,     // 200 KB max read ledger bytes
  writeLedgerBytes: 131_072,    // 128 KB max write ledger bytes
});

export const DEFAULT_SATURATION_WARNING_THRESHOLD = 0.80; // 80% saturation warning
export const DEFAULT_SATURATION_CRITICAL_THRESHOLD = 0.95; // 95% saturation critical

export type ResourceDimensionKey =
  | 'cpu'
  | 'ram'
  | 'readEntries'
  | 'writeEntries'
  | 'readBytes'
  | 'writeBytes';

export interface DimensionSaturationDetail extends ResourceDimensionSaturation {
  key: ResourceDimensionKey;
  label: string;
  unit: string;
  isCritical: boolean;
}

export interface InvocationHotspot {
  contractId: string;
  functionName: string;
  depth: number;
  cpuInstructions: number;
  ramBytes: number;
  readLedgerEntries: number;
  writeLedgerEntries: number;
  readLedgerBytes: number;
  writeLedgerBytes: number;
  cpuPercentOfTotal: number;
  ramPercentOfTotal: number;
}

export interface SorobanHostInvocationNode {
  invocationId?: string;
  contractId: string;
  functionName: string;
  args?: unknown[];
  cpuInstructions?: number | bigint | string;
  ramBytes?: number | bigint | string;
  readLedgerEntries?: number | bigint | string;
  writeLedgerEntries?: number | bigint | string;
  readLedgerBytes?: number | bigint | string;
  writeLedgerBytes?: number | bigint | string;
  subInvocations?: SorobanHostInvocationNode[];
  depth?: number;
}

export interface SaturationProfilerOptions {
  warningThreshold?: number;
  criticalThreshold?: number;
  customLimits?: Partial<SorobanResourceLimits>;
  txHash?: string;
  ledgerSeq?: number;
}

export interface AggregatedInvocationConsumption {
  totalCpuInstructions: number;
  totalRamBytes: number;
  totalReadLedgerEntries: number;
  totalWriteLedgerEntries: number;
  totalReadLedgerBytes: number;
  totalWriteLedgerBytes: number;
  maxCallDepth: number;
  totalInvocations: number;
  hotspots: InvocationHotspot[];
}

export interface SaturationProfileResult {
  hasData: boolean;
  contractId: string;
  functionName?: string;
  txHash?: string;
  ledgerSeq?: number;
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  warningThreshold: number;
  criticalThreshold: number;
  overallSaturationPercent: number;
  bottleneckDimension: ResourceDimensionKey | null;
  saturatedDimensions: ResourceDimensionKey[];
  limits: SorobanResourceLimits;
  dimensions: Record<ResourceDimensionKey, DimensionSaturationDetail>;
  consumption: AggregatedInvocationConsumption;
  telemetry: {
    recommendations: string[];
    traceDepth: number;
    totalInvocations: number;
  };
  alertPayload: SorobanSaturationAlert | null;
}

/**
 * Safely parses any number, bigint, or numeric string into a non-negative finite number.
 */
export function toSafeNumber(val: unknown, fallback = 0): number {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? Math.max(0, val) : fallback;
  }
  if (typeof val === 'bigint') {
    const num = Number(val);
    return Number.isFinite(num) ? Math.max(0, num) : fallback;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return fallback;
    const num = Number(trimmed);
    return Number.isFinite(num) ? Math.max(0, num) : fallback;
  }
  return fallback;
}

/**
 * Principal Soroban Host Function CPU Instruction & Ledger Byte Limit Saturation Profiler (#972).
 *
 * Tracks per-invocation Soroban CPU instructions, RAM bytes, read/write ledger entries,
 * and ledger footprint bytes against protocol limits. Computes saturation percentages,
 * generates early-warning telemetry, and produces alerting payloads.
 */
export class HostSaturationProfilerService {
  private readonly defaultLimits: SorobanResourceLimits;

  constructor(customDefaultLimits?: Partial<SorobanResourceLimits>) {
    this.defaultLimits = {
      ...DEFAULT_SOROBAN_PROTOCOL_LIMITS,
      ...(customDefaultLimits || {}),
    };
  }

  /**
   * Return the active protocol limits, combining system defaults with any per-call overrides.
   */
  public resolveLimits(overrides?: Partial<SorobanResourceLimits>): SorobanResourceLimits {
    return {
      cpuInstructions: Math.max(1, toSafeNumber(overrides?.cpuInstructions, this.defaultLimits.cpuInstructions)),
      ramBytes: Math.max(1, toSafeNumber(overrides?.ramBytes, this.defaultLimits.ramBytes)),
      readLedgerEntries: Math.max(1, toSafeNumber(overrides?.readLedgerEntries, this.defaultLimits.readLedgerEntries)),
      writeLedgerEntries: Math.max(1, toSafeNumber(overrides?.writeLedgerEntries, this.defaultLimits.writeLedgerEntries)),
      readLedgerBytes: Math.max(1, toSafeNumber(overrides?.readLedgerBytes, this.defaultLimits.readLedgerBytes)),
      writeLedgerBytes: Math.max(1, toSafeNumber(overrides?.writeLedgerBytes, this.defaultLimits.writeLedgerBytes)),
    };
  }

  /**
   * Aggregate total resources consumed across an invocation tree and identify hotspot nodes.
   */
  public aggregateInvocations(
    rootNodes: SorobanHostInvocationNode | SorobanHostInvocationNode[],
  ): AggregatedInvocationConsumption {
    const nodes = Array.isArray(rootNodes) ? rootNodes : [rootNodes];

    let totalCpuInstructions = 0;
    let totalRamBytes = 0;
    let totalReadLedgerEntries = 0;
    let totalWriteLedgerEntries = 0;
    let totalReadLedgerBytes = 0;
    let totalWriteLedgerBytes = 0;
    let maxCallDepth = 0;
    let totalInvocations = 0;

    const flattenedInvocations: Array<{
      contractId: string;
      functionName: string;
      depth: number;
      cpuInstructions: number;
      ramBytes: number;
      readLedgerEntries: number;
      writeLedgerEntries: number;
      readLedgerBytes: number;
      writeLedgerBytes: number;
    }> = [];

    const traverse = (node: SorobanHostInvocationNode, currentDepth: number) => {
      if (!node) return;
      totalInvocations++;
      if (currentDepth > maxCallDepth) {
        maxCallDepth = currentDepth;
      }

      const cpu = toSafeNumber(node.cpuInstructions);
      const ram = toSafeNumber(node.ramBytes);
      const readEntries = toSafeNumber(node.readLedgerEntries);
      const writeEntries = toSafeNumber(node.writeLedgerEntries);
      const readBytes = toSafeNumber(node.readLedgerBytes);
      const writeBytes = toSafeNumber(node.writeLedgerBytes);

      totalCpuInstructions += cpu;
      totalRamBytes += ram;
      totalReadLedgerEntries += readEntries;
      totalWriteLedgerEntries += writeEntries;
      totalReadLedgerBytes += readBytes;
      totalWriteLedgerBytes += writeBytes;

      flattenedInvocations.push({
        contractId: node.contractId || 'UNKNOWN_CONTRACT',
        functionName: node.functionName || 'unknown_fn',
        depth: currentDepth,
        cpuInstructions: cpu,
        ramBytes: ram,
        readLedgerEntries: readEntries,
        writeLedgerEntries: writeEntries,
        readLedgerBytes: readBytes,
        writeLedgerBytes: writeBytes,
      });

      if (Array.isArray(node.subInvocations) && node.subInvocations.length > 0) {
        for (const sub of node.subInvocations) {
          traverse(sub, currentDepth + 1);
        }
      }
    };

    for (const root of nodes) {
      traverse(root, 1);
    }

    const hotspots: InvocationHotspot[] = flattenedInvocations
      .map((item) => ({
        ...item,
        cpuPercentOfTotal: totalCpuInstructions > 0 ? (item.cpuInstructions / totalCpuInstructions) * 100 : 0,
        ramPercentOfTotal: totalRamBytes > 0 ? (item.ramBytes / totalRamBytes) * 100 : 0,
      }))
      .sort((a, b) => b.cpuInstructions - a.cpuInstructions)
      .slice(0, 5);

    return {
      totalCpuInstructions,
      totalRamBytes,
      totalReadLedgerEntries,
      totalWriteLedgerEntries,
      totalReadLedgerBytes,
      totalWriteLedgerBytes,
      maxCallDepth,
      totalInvocations,
      hotspots,
    };
  }

  /**
   * Evaluates consumption numbers against resolved limits and calculates multi-dimensional saturation.
   */
  public computeSaturation(
    consumption: AggregatedInvocationConsumption,
    limits: SorobanResourceLimits,
    warningThreshold = DEFAULT_SATURATION_WARNING_THRESHOLD,
    criticalThreshold = DEFAULT_SATURATION_CRITICAL_THRESHOLD,
  ): {
    dimensions: Record<ResourceDimensionKey, DimensionSaturationDetail>;
    overallSaturationPercent: number;
    bottleneckDimension: ResourceDimensionKey | null;
    saturatedDimensions: ResourceDimensionKey[];
    status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  } {
    const calcDim = (
      key: ResourceDimensionKey,
      label: string,
      unit: string,
      used: number,
      limit: number,
    ): DimensionSaturationDetail => {
      const safeLimit = Math.max(1, limit);
      const saturationPercent = (used / safeLimit) * 100;
      const isExceeded = saturationPercent >= warningThreshold * 100;
      const isCritical = saturationPercent >= criticalThreshold * 100;

      return {
        key,
        label,
        unit,
        used,
        limit: safeLimit,
        saturationPercent: parseFloat(saturationPercent.toFixed(2)),
        isExceeded,
        isCritical,
      };
    };

    const dimensions: Record<ResourceDimensionKey, DimensionSaturationDetail> = {
      cpu: calcDim('cpu', 'CPU Instructions', 'instructions', consumption.totalCpuInstructions, limits.cpuInstructions),
      ram: calcDim('ram', 'RAM Memory', 'bytes', consumption.totalRamBytes, limits.ramBytes),
      readEntries: calcDim('readEntries', 'Ledger Read Entries', 'entries', consumption.totalReadLedgerEntries, limits.readLedgerEntries),
      writeEntries: calcDim('writeEntries', 'Ledger Write Entries', 'entries', consumption.totalWriteLedgerEntries, limits.writeLedgerEntries),
      readBytes: calcDim('readBytes', 'Ledger Read Bytes', 'bytes', consumption.totalReadLedgerBytes, limits.readLedgerBytes),
      writeBytes: calcDim('writeBytes', 'Ledger Write Bytes', 'bytes', consumption.totalWriteLedgerBytes, limits.writeLedgerBytes),
    };

    const dimList = Object.values(dimensions);
    let highestSat = 0;
    let bottleneck: ResourceDimensionKey | null = null;
    const saturated: ResourceDimensionKey[] = [];

    for (const d of dimList) {
      if (d.saturationPercent > highestSat) {
        highestSat = d.saturationPercent;
        bottleneck = d.key;
      }
      if (d.isExceeded) {
        saturated.push(d.key);
      }
    }

    let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
    if (highestSat >= criticalThreshold * 100) {
      status = 'CRITICAL';
    } else if (highestSat >= warningThreshold * 100) {
      status = 'WARNING';
    }

    return {
      dimensions,
      overallSaturationPercent: parseFloat(highestSat.toFixed(2)),
      bottleneckDimension: bottleneck,
      saturatedDimensions: saturated,
      status,
    };
  }

  /**
   * Generates actionable optimization recommendations for saturated dimensions.
   */
  public generateRecommendations(
    saturatedDimensions: ResourceDimensionKey[],
    dimensions: Record<ResourceDimensionKey, DimensionSaturationDetail>,
    maxCallDepth: number,
  ): string[] {
    const recommendations: string[] = [];

    for (const dimKey of saturatedDimensions) {
      const dim = dimensions[dimKey];
      switch (dimKey) {
        case 'cpu':
          recommendations.push(
            `CPU instruction saturation reached ${dim.saturationPercent}% (${dim.used.toLocaleString()} / ${dim.limit.toLocaleString()} insns). Optimize repetitive loops, reduce sorting complexity, and simplify smart contract authorization trees.`,
          );
          break;
        case 'ram':
          recommendations.push(
            `RAM memory saturation reached ${dim.saturationPercent}% (${dim.used.toLocaleString()} / ${dim.limit.toLocaleString()} bytes). Reduce large byte buffer allocations, prune vector growth, and avoid high-footprint deserialization.`,
          );
          break;
        case 'readEntries':
          recommendations.push(
            `Ledger read entries saturation reached ${dim.saturationPercent}% (${dim.used} / ${dim.limit} entries). Group disjoint ledger keys into consolidated instance data or multi-value storage maps.`,
          );
          break;
        case 'writeEntries':
          recommendations.push(
            `Ledger write entries saturation reached ${dim.saturationPercent}% (${dim.used} / ${dim.limit} entries). Batch storage updates and omit temporary state updates from permanent ledger commits.`,
          );
          break;
        case 'readBytes':
          recommendations.push(
            `Ledger read bytes saturation reached ${dim.saturationPercent}% (${dim.used.toLocaleString()} / ${dim.limit.toLocaleString()} bytes). Minimize struct schema field footprints and truncate historical state retained in storage.`,
          );
          break;
        case 'writeBytes':
          recommendations.push(
            `Ledger write bytes saturation reached ${dim.saturationPercent}% (${dim.used.toLocaleString()} / ${dim.limit.toLocaleString()} bytes). Compress serialized data values and avoid writing oversized string buffers into ledger keys.`,
          );
          break;
      }
    }

    if (maxCallDepth > 10) {
      recommendations.push(
        `High cross-contract call depth detected (${maxCallDepth} frames). Deep invocation chains amplify host metering overhead and heighten stack limit exhaustion risks.`,
      );
    }

    return recommendations;
  }

  /**
   * Primary entry point: Profiles Soroban invocations or raw execution metadata.
   */
  public profile(
    source: unknown,
    options: SaturationProfilerOptions = {},
  ): SaturationProfileResult {
    const warningThreshold = options.warningThreshold ?? DEFAULT_SATURATION_WARNING_THRESHOLD;
    const criticalThreshold = options.criticalThreshold ?? DEFAULT_SATURATION_CRITICAL_THRESHOLD;

    const parsed = this.parseTrace(source);
    const resolvedLimits = this.resolveLimits({
      ...options.customLimits,
      ...(parsed.limits || {}),
    });

    const consumption = this.aggregateInvocations(parsed.invocations);
    const hasData =
      consumption.totalInvocations > 0 &&
      (consumption.totalCpuInstructions > 0 ||
        consumption.totalRamBytes > 0 ||
        consumption.totalReadLedgerEntries > 0 ||
        consumption.totalWriteLedgerEntries > 0 ||
        consumption.totalReadLedgerBytes > 0 ||
        consumption.totalWriteLedgerBytes > 0);

    const sat = this.computeSaturation(consumption, resolvedLimits, warningThreshold, criticalThreshold);
    const recommendations = this.generateRecommendations(
      sat.saturatedDimensions,
      sat.dimensions,
      consumption.maxCallDepth,
    );

    const contractId = parsed.contractId || parsed.invocations[0]?.contractId || 'UNKNOWN_CONTRACT';
    const functionName = parsed.invocations[0]?.functionName;
    const txHash = options.txHash || parsed.txHash;
    const ledgerSeq = options.ledgerSeq;

    let alertPayload: SorobanSaturationAlert | null = null;
    if (sat.status !== 'HEALTHY') {
      alertPayload = {
        type: 'SOROBAN_RESOURCE_SATURATION',
        severity: sat.status,
        txHash,
        ledgerSeq,
        contractId,
        functionName,
        threshold: warningThreshold,
        overallSaturationPercent: sat.overallSaturationPercent,
        saturatedDimensions: sat.saturatedDimensions,
        dimensions: {
          cpu: {
            used: sat.dimensions.cpu.used,
            limit: sat.dimensions.cpu.limit,
            saturationPercent: sat.dimensions.cpu.saturationPercent,
            isExceeded: sat.dimensions.cpu.isExceeded,
          },
          ram: {
            used: sat.dimensions.ram.used,
            limit: sat.dimensions.ram.limit,
            saturationPercent: sat.dimensions.ram.saturationPercent,
            isExceeded: sat.dimensions.ram.isExceeded,
          },
          readEntries: {
            used: sat.dimensions.readEntries.used,
            limit: sat.dimensions.readEntries.limit,
            saturationPercent: sat.dimensions.readEntries.saturationPercent,
            isExceeded: sat.dimensions.readEntries.isExceeded,
          },
          writeEntries: {
            used: sat.dimensions.writeEntries.used,
            limit: sat.dimensions.writeEntries.limit,
            saturationPercent: sat.dimensions.writeEntries.saturationPercent,
            isExceeded: sat.dimensions.writeEntries.isExceeded,
          },
          readBytes: {
            used: sat.dimensions.readBytes.used,
            limit: sat.dimensions.readBytes.limit,
            saturationPercent: sat.dimensions.readBytes.saturationPercent,
            isExceeded: sat.dimensions.readBytes.isExceeded,
          },
          writeBytes: {
            used: sat.dimensions.writeBytes.used,
            limit: sat.dimensions.writeBytes.limit,
            saturationPercent: sat.dimensions.writeBytes.saturationPercent,
            isExceeded: sat.dimensions.writeBytes.isExceeded,
          },
        },
        telemetry: {
          recommendations,
          traceDepth: consumption.maxCallDepth,
          totalInvocations: consumption.totalInvocations,
        },
        timestamp: new Date().toISOString(),
      };

      logger.warn(
        {
          contractId,
          functionName,
          txHash,
          severity: sat.status,
          overallSaturationPercent: sat.overallSaturationPercent,
          saturatedDimensions: sat.saturatedDimensions,
        },
        'Soroban host resource saturation exceeded warning threshold',
      );
    }

    return {
      hasData,
      contractId,
      functionName,
      txHash,
      ledgerSeq,
      status: sat.status,
      warningThreshold,
      criticalThreshold,
      overallSaturationPercent: sat.overallSaturationPercent,
      bottleneckDimension: sat.bottleneckDimension,
      saturatedDimensions: sat.saturatedDimensions,
      limits: resolvedLimits,
      dimensions: sat.dimensions,
      consumption,
      telemetry: {
        recommendations,
        traceDepth: consumption.maxCallDepth,
        totalInvocations: consumption.totalInvocations,
      },
      alertPayload,
    };
  }

  /**
   * Defensively parses trace metadata from multiple formats:
   * - Invocations array / node
   * - RPC Simulation response
   * - Diagnostic events list
   * - Flat resource metrics payload
   */
  public parseTrace(source: unknown): {
    invocations: SorobanHostInvocationNode[];
    limits?: Partial<SorobanResourceLimits>;
    txHash?: string;
    contractId?: string;
  } {
    if (!source || typeof source !== 'object') {
      return { invocations: [] };
    }

    const obj = source as Record<string, unknown>;
    const limits: Partial<SorobanResourceLimits> = {};
    let txHash: string | undefined = typeof obj.txHash === 'string' ? obj.txHash : undefined;
    let contractId: string | undefined = typeof obj.contractId === 'string' ? obj.contractId : undefined;

    // 1. Direct invocation array or single node
    if (Array.isArray(obj.invocations) && obj.invocations.length > 0) {
      const invocations = (obj.invocations as unknown[]).map((i) => this.normalizeInvocationNode(i));
      return { invocations, limits, txHash, contractId };
    }

    if (typeof obj.functionName === 'string' && (typeof obj.contractId === 'string' || obj.cpuInstructions !== undefined)) {
      return {
        invocations: [this.normalizeInvocationNode(obj)],
        limits,
        txHash,
        contractId,
      };
    }

    // 2. RPC simulation result shape (SimulateTransactionResponse)
    const transactionData =
      (obj.transactionData as Record<string, unknown>) ||
      (obj.sorobanData as Record<string, unknown>) ||
      (obj.result as Record<string, unknown>)?.sorobanData;

    if (transactionData) {
      const res = (transactionData.resources || transactionData) as Record<string, unknown>;
      if (res.instructions !== undefined || res.cpuLimit !== undefined) {
        limits.cpuInstructions = toSafeNumber(res.instructions ?? res.cpuLimit);
      }
      if (res.readBytes !== undefined) {
        limits.readLedgerBytes = toSafeNumber(res.readBytes);
      }
      if (res.writeBytes !== undefined) {
        limits.writeLedgerBytes = toSafeNumber(res.writeBytes);
      }

      const footprint = (transactionData.footprint || (transactionData.value as () => Record<string, unknown>)?.()?.footprint) as Record<string, unknown> | undefined;
      if (footprint) {
        const readOnly = Array.isArray(footprint.readOnly) ? footprint.readOnly : [];
        const readWrite = Array.isArray(footprint.readWrite) ? footprint.readWrite : [];
        const readCount = readOnly.length;
        const writeCount = readWrite.length;

        // Build synthetic invocation from simulation metrics
        const simCpu = toSafeNumber(obj.cpuInstructions ?? (obj.events ? this.extractCpuFromEvents(obj.events) : 0));
        const simRam = toSafeNumber(obj.ramBytes ?? obj.memoryBytes);
        const simReadBytes = toSafeNumber(obj.readBytes ?? res.readBytes);
        const simWriteBytes = toSafeNumber(obj.writeBytes ?? res.writeBytes);

        return {
          invocations: [
            {
              contractId: contractId || 'SIMULATED_CONTRACT',
              functionName: (obj.functionName as string) || 'invoke',
              cpuInstructions: simCpu,
              ramBytes: simRam,
              readLedgerEntries: readCount,
              writeLedgerEntries: writeCount,
              readLedgerBytes: simReadBytes,
              writeLedgerBytes: simWriteBytes,
            },
          ],
          limits,
          txHash,
          contractId,
        };
      }
    }

    // 3. Diagnostic events array
    const diagEvents = (obj.diagnosticEvents || obj.diagnostic_events || obj.events) as unknown[];
    if (Array.isArray(diagEvents) && diagEvents.length > 0) {
      const nodes = this.parseDiagnosticEvents(diagEvents);
      if (nodes.length > 0) {
        return { invocations: nodes, limits, txHash, contractId };
      }
    }

    // 4. Flat metrics object
    if (
      obj.cpuInstructions !== undefined ||
      obj.cpuInsns !== undefined ||
      obj.ramBytes !== undefined ||
      obj.memoryBytes !== undefined ||
      obj.readLedgerEntries !== undefined ||
      obj.writeLedgerEntries !== undefined
    ) {
      return {
        invocations: [
          {
            contractId: contractId || 'TARGET_CONTRACT',
            functionName: (obj.functionName as string) || 'invoke',
            cpuInstructions: toSafeNumber(obj.cpuInstructions ?? obj.cpuInsns),
            ramBytes: toSafeNumber(obj.ramBytes ?? obj.memoryBytes),
            readLedgerEntries: toSafeNumber(obj.readLedgerEntries ?? obj.readCount),
            writeLedgerEntries: toSafeNumber(obj.writeLedgerEntries ?? obj.writeCount),
            readLedgerBytes: toSafeNumber(obj.readLedgerBytes ?? obj.readBytes),
            writeLedgerBytes: toSafeNumber(obj.writeLedgerBytes ?? obj.writeBytes),
          },
        ],
        limits,
        txHash,
        contractId,
      };
    }

    return { invocations: [] };
  }

  private normalizeInvocationNode(raw: unknown): SorobanHostInvocationNode {
    if (!raw || typeof raw !== 'object') {
      return { contractId: 'UNKNOWN', functionName: 'unknown' };
    }
    const r = raw as Record<string, unknown>;

    const subInvocations: SorobanHostInvocationNode[] = [];
    if (Array.isArray(r.subInvocations)) {
      for (const sub of r.subInvocations) {
        subInvocations.push(this.normalizeInvocationNode(sub));
      }
    }

    return {
      invocationId: typeof r.invocationId === 'string' ? r.invocationId : undefined,
      contractId: String(r.contractId || 'UNKNOWN_CONTRACT'),
      functionName: String(r.functionName || 'unknown_fn'),
      args: Array.isArray(r.args) ? r.args : undefined,
      cpuInstructions: toSafeNumber(r.cpuInstructions ?? r.cpuInsns ?? r.instructions),
      ramBytes: toSafeNumber(r.ramBytes ?? r.memoryBytes ?? r.memory),
      readLedgerEntries: toSafeNumber(r.readLedgerEntries ?? r.readEntries ?? r.readCount),
      writeLedgerEntries: toSafeNumber(r.writeLedgerEntries ?? r.writeEntries ?? r.writeCount),
      readLedgerBytes: toSafeNumber(r.readLedgerBytes ?? r.readBytes),
      writeLedgerBytes: toSafeNumber(r.writeLedgerBytes ?? r.writeBytes),
      subInvocations: subInvocations.length > 0 ? subInvocations : undefined,
      depth: typeof r.depth === 'number' ? r.depth : undefined,
    };
  }

  private parseDiagnosticEvents(events: unknown[]): SorobanHostInvocationNode[] {
    const nodes: SorobanHostInvocationNode[] = [];
    let currentCpu = 0;
    let currentRam = 0;
    let currentContract = 'CONTRACT_EVENT';
    let currentFn = 'invoke';

    for (const raw of events) {
      if (!raw || typeof raw !== 'object') continue;
      const ev = raw as Record<string, unknown>;

      const metrics = (ev.coreMetrics || ev.core_metrics || ev.metrics || ev) as Record<string, unknown>;
      const cpu = toSafeNumber(metrics.cpuInstructions ?? metrics.cpuInsns ?? metrics.instructions);
      const ram = toSafeNumber(metrics.ramBytes ?? metrics.memoryBytes ?? metrics.memory);

      if (cpu > 0) currentCpu += cpu;
      if (ram > 0) currentRam += ram;

      if (typeof ev.contractId === 'string') currentContract = ev.contractId;
      if (Array.isArray(ev.topic) && typeof ev.topic[0] === 'string') {
        currentFn = ev.topic[0];
      }
    }

    if (currentCpu > 0 || currentRam > 0) {
      nodes.push({
        contractId: currentContract,
        functionName: currentFn,
        cpuInstructions: currentCpu,
        ramBytes: currentRam,
      });
    }

    return nodes;
  }

  private extractCpuFromEvents(events: unknown): number {
    if (!Array.isArray(events)) return 0;
    let total = 0;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const e = ev as Record<string, unknown>;
      const cpu = toSafeNumber(e.cpuInstructions ?? e.cpuInsns ?? (e.coreMetrics as Record<string, unknown>)?.cpuInstructions);
      total += cpu;
    }
    return total;
  }
}

export const hostSaturationProfilerService = new HostSaturationProfilerService();

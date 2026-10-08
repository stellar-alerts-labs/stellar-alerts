/**
 * Soroban Contract Instance & Code Restoration Sentinel (#1005)
 *
 * Protocol 20/21/22 introduced state archival: persistent Soroban ledger entries
 * (the contract *instance* entry and its WASM *code* entry) that fall past their
 * `liveUntilLedgerSeq` are evicted from the live state and moved to the archive.
 * A contract can no longer be invoked until *every* evicted key in its footprint
 * is restored (`RestoreFootprint`), which costs rent proportional to the entry
 * size and the number of ledgers the entry is brought back to live for.
 *
 * This engine is pure logic: given the observed TTL/size of an instance entry and
 * its code entry, it classifies eviction risk, computes the *exact* restoration
 * fee in stroops, and emits proactive warnings before an invocation would fail.
 *
 * Temporary entries are intentionally out of scope: once a TEMPORARY entry
 * expires it is permanently deleted and cannot be restored, so no restoration
 * fee applies.
 */

export type EntryKind = 'INSTANCE' | 'CODE';

export type RestorationSeverity = 'OK' | 'WARNING' | 'CRITICAL' | 'EVICTED';

export interface ArchivableEntry {
  /** Hex ledger-key hash uniquely identifying the entry. */
  keyHash: string;
  kind: EntryKind;
  /** Encoded entry size in bytes (drives both write and rent fees). */
  byteSize: number;
  /** Absolute ledger the entry stays live until (inclusive). */
  liveUntilLedgerSeq: number;
}

export interface RestorationFeeBreakdown {
  /** Ledgers the entry must be extended to become live again. */
  ledgersToRestore: number;
  /** One-off write fee charged for re-materialising the entry into live state. */
  writeFeeStroops: bigint;
  /** Rent fee to keep the entry live for `ledgersToRestore` ledgers. */
  rentFeeStroops: bigint;
  /** writeFeeStroops + rentFeeStroops. */
  totalFeeStroops: bigint;
}

export interface EntryRestorationAssessment {
  keyHash: string;
  kind: EntryKind;
  byteSize: number;
  liveUntilLedgerSeq: number;
  remainingLedgers: number;
  isEvicted: boolean;
  severity: RestorationSeverity;
  /** Populated only when the entry is evicted and therefore needs restoration. */
  restoration: RestorationFeeBreakdown | null;
  message: string;
}

export interface ContractRestorationAlert {
  contractId: string;
  currentLedger: number;
  severity: RestorationSeverity;
  /** True when at least one footprint entry is evicted (invocation would fail). */
  requiresRestoration: boolean;
  entries: EntryRestorationAssessment[];
  /** Ledger keys that must be included in a RestoreFootprint operation. */
  keysToRestore: string[];
  totalRestorationFeeStroops: bigint;
  totalRestorationFeeXlm: string;
  message: string;
}

export interface RestorationSentinelOptions {
  /**
   * Warn when a live entry has this many or fewer ledgers of TTL remaining.
   * Defaults to ~1 day at 5s/ledger.
   */
  warningThresholdLedgers?: number;
  /** Escalate to CRITICAL at or below this many remaining ledgers. */
  criticalThresholdLedgers?: number;
  /**
   * Ledgers a restored entry is brought back to live for. Restoration always
   * bumps `liveUntilLedgerSeq` to `currentLedger + minRestoreLedgers`.
   */
  minRestoreLedgers?: number;
  /** Rent fee per byte per ledger, in stroops. */
  rentFeePerBytePerLedgerStroops?: bigint;
  /** One-off write fee per byte, in stroops. */
  writeFeePerByteStroops?: bigint;
}

const STROOPS_PER_XLM = 10_000_000n;

/** Formats a stroop amount as a fixed 7-dp XLM string without floating point. */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export class RestorationSentinelEngine {
  private readonly warningThreshold: number;
  private readonly criticalThreshold: number;
  private readonly minRestoreLedgers: number;
  private readonly rentFeePerBytePerLedgerStroops: bigint;
  private readonly writeFeePerByteStroops: bigint;

  constructor(options: RestorationSentinelOptions = {}) {
    this.warningThreshold = options.warningThresholdLedgers ?? 17_280;
    this.criticalThreshold = options.criticalThresholdLedgers ?? 1_000;
    this.minRestoreLedgers = options.minRestoreLedgers ?? 4_096;
    this.rentFeePerBytePerLedgerStroops = options.rentFeePerBytePerLedgerStroops ?? 100n;
    this.writeFeePerByteStroops = options.writeFeePerByteStroops ?? 1_000n;
  }

  /**
   * Computes the exact fee to restore an evicted entry back to live state for
   * `minRestoreLedgers` ledgers from `currentLedger`.
   */
  public calculateRestorationFee(byteSize: number, currentLedger: number): RestorationFeeBreakdown {
    const safeBytes = BigInt(Math.max(0, Math.trunc(byteSize)));
    const ledgersToRestore = this.minRestoreLedgers;

    const writeFeeStroops = safeBytes * this.writeFeePerByteStroops;
    const rentFeeStroops =
      safeBytes * BigInt(ledgersToRestore) * this.rentFeePerBytePerLedgerStroops;

    return {
      ledgersToRestore,
      writeFeeStroops,
      rentFeeStroops,
      totalFeeStroops: writeFeeStroops + rentFeeStroops,
    };
  }

  /** Classifies a single footprint entry against the current ledger. */
  public assessEntry(entry: ArchivableEntry, currentLedger: number): EntryRestorationAssessment {
    const remainingLedgers = entry.liveUntilLedgerSeq - currentLedger;
    const label = entry.kind === 'INSTANCE' ? 'contract instance' : 'WASM code';

    if (remainingLedgers < 0) {
      const restoration = this.calculateRestorationFee(entry.byteSize, currentLedger);
      return {
        keyHash: entry.keyHash,
        kind: entry.kind,
        byteSize: entry.byteSize,
        liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
        remainingLedgers,
        isEvicted: true,
        severity: 'EVICTED',
        restoration,
        message:
          `EVICTED: ${label} entry ${entry.keyHash} was archived at ledger ` +
          `${entry.liveUntilLedgerSeq}. Restore ~${stroopsToXlm(restoration.totalFeeStroops)} XLM ` +
          `before the next invocation or the transaction will fail.`,
      };
    }

    if (remainingLedgers <= this.criticalThreshold) {
      return {
        ...this.baseLiveAssessment(entry, remainingLedgers),
        severity: 'CRITICAL',
        message:
          `CRITICAL: ${label} entry ${entry.keyHash} will be evicted in ${remainingLedgers} ` +
          `ledgers. Extend its TTL now to avoid a restoration fee.`,
      };
    }

    if (remainingLedgers <= this.warningThreshold) {
      return {
        ...this.baseLiveAssessment(entry, remainingLedgers),
        severity: 'WARNING',
        message:
          `WARNING: ${label} entry ${entry.keyHash} is approaching archival ` +
          `(${remainingLedgers} ledgers of TTL remaining).`,
      };
    }

    return {
      ...this.baseLiveAssessment(entry, remainingLedgers),
      severity: 'OK',
      message: `${label} entry ${entry.keyHash} is live (${remainingLedgers} ledgers remaining).`,
    };
  }

  private baseLiveAssessment(
    entry: ArchivableEntry,
    remainingLedgers: number,
  ): Omit<EntryRestorationAssessment, 'severity' | 'message'> {
    return {
      keyHash: entry.keyHash,
      kind: entry.kind,
      byteSize: entry.byteSize,
      liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
      remainingLedgers,
      isEvicted: false,
      restoration: null,
    };
  }

  /**
   * Assesses a contract's full restoration footprint (instance + code entries)
   * and produces a single actionable alert. `requiresRestoration` is true when
   * any entry is evicted, meaning invocation transactions will fail until the
   * listed keys are restored.
   */
  public assessContractFootprint(
    contractId: string,
    entries: ArchivableEntry[],
    currentLedger: number,
  ): ContractRestorationAlert {
    const assessments = entries.map((entry) => this.assessEntry(entry, currentLedger));

    const keysToRestore: string[] = [];
    let totalRestorationFeeStroops = 0n;
    for (const a of assessments) {
      if (a.isEvicted && a.restoration) {
        keysToRestore.push(a.keyHash);
        totalRestorationFeeStroops += a.restoration.totalFeeStroops;
      }
    }

    const severity = this.rollupSeverity(assessments);
    const requiresRestoration = keysToRestore.length > 0;

    let message: string;
    if (requiresRestoration) {
      const noun = keysToRestore.length === 1 ? 'entry' : 'entries';
      message =
        `Contract ${contractId} has ${keysToRestore.length} evicted footprint ${noun}. ` +
        `Total restoration cost ~${stroopsToXlm(totalRestorationFeeStroops)} XLM before it can be invoked.`;
    } else if (severity === 'CRITICAL') {
      message = `Contract ${contractId} has footprint entries about to be evicted. Extend their TTL now.`;
    } else if (severity === 'WARNING') {
      message = `Contract ${contractId} has footprint entries approaching archival.`;
    } else {
      message = `Contract ${contractId} footprint is live; no restoration required.`;
    }

    return {
      contractId,
      currentLedger,
      severity,
      requiresRestoration,
      entries: assessments,
      keysToRestore,
      totalRestorationFeeStroops,
      totalRestorationFeeXlm: stroopsToXlm(totalRestorationFeeStroops),
      message,
    };
  }

  private rollupSeverity(assessments: EntryRestorationAssessment[]): RestorationSeverity {
    const order: RestorationSeverity[] = ['OK', 'WARNING', 'CRITICAL', 'EVICTED'];
    let worst: RestorationSeverity = 'OK';
    for (const a of assessments) {
      if (order.indexOf(a.severity) > order.indexOf(worst)) {
        worst = a.severity;
      }
    }
    return worst;
  }
}

export const restorationSentinel = new RestorationSentinelEngine();

import * as StellarSdk from 'stellar-sdk';

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

/** Stroops per XLM */
const STROOPS_PER_XLM = 10_000_000;

export const sorobanServer = new (StellarSdk as any).rpc.Server(SOROBAN_RPC_URL);

export interface ParsedSorobanTransfer {
  contractId: string;
  from: string;
  to: string;
  amount: string;
  topic: string;
}

// ---------------------------------------------------------------------------
// Fee-estimation types
// ---------------------------------------------------------------------------

/**
 * Footprint entry describing a single ledger key that will be read or written
 * by the simulated transaction.
 */
export interface LedgerFootprintEntry {
  /** Hex-encoded ledger key XDR */
  key: string;
  /** Durability of the storage entry */
  durability: 'persistent' | 'temporary';
}

/**
 * Detailed fee breakdown returned by {@link simulateTransaction}.
 *
 * All fee values are expressed in *stroops* (1 XLM = 10,000,000 stroops) as
 * strings so they can be used directly with Stellar SDK big-number helpers.
 */
export interface SorobanFeeEstimate {
  /** Total inclusion fee (base network fee) in stroops */
  inclusionFeeStroops: string;
  /** Total resource fee (execution + state rent) in stroops */
  resourceFeeStroops: string;
  /** Rent fee for all ledger entries in stroops */
  rentFeeStroops: string;
  /** Total of all fees in stroops */
  totalFeeStroops: string;
  /** Human-readable total fee in XLM */
  totalFeeXlm: string;
  /** Ledger entries that will be *read* during execution */
  readFootprint: LedgerFootprintEntry[];
  /** Ledger entries that will be *written* during execution */
  writeFootprint: LedgerFootprintEntry[];
  /** Number of read-only ledger entries */
  readCount: number;
  /** Number of read-write ledger entries */
  writeCount: number;
  /** Estimated CPU instructions */
  cpuInstructions: number;
  /** Estimated memory bytes */
  memoryBytes: number;
  /** Whether the simulation succeeded */
  success: boolean;
  /** Error description when success is false */
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a stroops string or number to XLM with 7 decimal places.
 */
export function stroopsToXlm(stroops: string | number): string {
  const n = typeof stroops === 'string' ? BigInt(stroops) : BigInt(Math.round(Number(stroops)));
  const xlmWhole = n / BigInt(STROOPS_PER_XLM);
  const xlmFrac = n % BigInt(STROOPS_PER_XLM);
  return `${xlmWhole}.${xlmFrac.toString().padStart(7, '0')}`;
}

/**
 * Parses the `sorobanData` XDR field inside a SimulateTransactionResponse and
 * extracts read/write footprint entries.  Falls back gracefully when the field
 * is absent (e.g., non-Soroban transactions or unit-test mocks).
 */
export function parseLedgerFootprint(simulationResult: any): {
  readFootprint: LedgerFootprintEntry[];
  writeFootprint: LedgerFootprintEntry[];
} {
  const readFootprint: LedgerFootprintEntry[] = [];
  const writeFootprint: LedgerFootprintEntry[] = [];

  try {
    // The stellar-sdk v13 SimulateTransactionResponse exposes a `result` with
    // `auth` and the raw transaction envelope, but the footprint lives inside
    // the `transactionData` / `sorobanData` field that the SDK attaches.
    const sorobanData =
      simulationResult?.transactionData?.value?.() ??
      simulationResult?.transactionData ??
      simulationResult?.result?.sorobanData ??
      null;

    if (!sorobanData) {
      return { readFootprint, writeFootprint };
    }

    // `footprint()` returns an XDR LedgerFootprint with readOnly / readWrite arrays
    const footprint =
      typeof sorobanData.footprint === 'function'
        ? sorobanData.footprint()
        : sorobanData.footprint ?? null;

    if (!footprint) {
      return { readFootprint, writeFootprint };
    }

    const readOnly: any[] =
      typeof footprint.readOnly === 'function'
        ? footprint.readOnly()
        : footprint.readOnly ?? [];

    const readWrite: any[] =
      typeof footprint.readWrite === 'function'
        ? footprint.readWrite()
        : footprint.readWrite ?? [];

    for (const entry of readOnly) {
      readFootprint.push({
        key: entry.toXDR?.('hex') ?? String(entry),
        durability: _detectDurability(entry),
      });
    }

    for (const entry of readWrite) {
      writeFootprint.push({
        key: entry.toXDR?.('hex') ?? String(entry),
        durability: _detectDurability(entry),
      });
    }
  } catch {
    // Footprint parsing is best-effort; never throw.
  }

  return { readFootprint, writeFootprint };
}

/**
 * Detects whether a ledger key belongs to a persistent or temporary storage
 * entry by inspecting the XDR discriminant.
 */
function _detectDurability(ledgerKey: any): 'persistent' | 'temporary' {
  try {
    const arm: string =
      typeof ledgerKey.switch === 'function'
        ? ledgerKey.switch().name ?? ''
        : '';
    if (arm.toLowerCase().includes('temp') || arm.toLowerCase().includes('temporary')) {
      return 'temporary';
    }
    if (
      typeof ledgerKey.contractData === 'function' ||
      typeof ledgerKey.contractCode === 'function'
    ) {
      const data = ledgerKey.contractData?.();
      const durabilityArm: string =
        typeof data?.durability === 'function' ? data.durability().name ?? '' : '';
      if (durabilityArm.toLowerCase().includes('temp')) {
        return 'temporary';
      }
    }
  } catch {
    // ignore
  }
  return 'persistent';
}

// ---------------------------------------------------------------------------
// simulateTransaction
// ---------------------------------------------------------------------------

/**
 * Wraps the Soroban RPC `simulateTransaction` call and returns a structured
 * {@link SorobanFeeEstimate} with read/write ledger entry footprints and a
 * complete fee breakdown including storage rent.
 *
 * @param xdrEnvelope - Base64-encoded XDR TransactionEnvelope of the Soroban
 *                      transaction to simulate.
 */
export async function simulateTransaction(xdrEnvelope: string): Promise<SorobanFeeEstimate> {
  try {
    // Decode the envelope and let the SDK build a Transaction object so the
    // RPC call receives a proper Transaction instance.
    const transaction = StellarSdk.TransactionBuilder.fromXDR(
      xdrEnvelope,
      (StellarSdk as any).Networks?.TESTNET ?? 'Test SDF Network ; September 2015'
    );

    const simulationResult: any = await sorobanServer.simulateTransaction(transaction);

    // -----------------------------------------------------------------------
    // Error path
    // -----------------------------------------------------------------------
    if (simulationResult?.error) {
      return {
        inclusionFeeStroops: '0',
        resourceFeeStroops: '0',
        rentFeeStroops: '0',
        totalFeeStroops: '0',
        totalFeeXlm: '0.0000000',
        readFootprint: [],
        writeFootprint: [],
        readCount: 0,
        writeCount: 0,
        cpuInstructions: 0,
        memoryBytes: 0,
        success: false,
        error: String(simulationResult.error),
      };
    }

    // -----------------------------------------------------------------------
    // Extract fees
    // The SDK returns minResourceFee as a string (stroops) and the classic
    // base fee is embedded in the transaction itself.  We also surface the
    // rent fee component separately when available.
    // -----------------------------------------------------------------------
    const minResourceFee: string = String(simulationResult?.minResourceFee ?? '0');

    // Inclusion (base) fee: use 100 stroops as the minimum network default
    // when we cannot read it from the transaction directly.
    let inclusionFeeStroops = '100';
    try {
      const fee = transaction.fee;
      if (fee && Number(fee) > 0) {
        inclusionFeeStroops = String(fee);
      }
    } catch {
      // keep default
    }

    // Rent fee is part of the resource fee; the SDK >= v13 may expose it via
    // `transactionData.resourceFee()` decomposition.  We attempt to extract it
    // and fall back to a proportional estimate.
    let rentFeeStroops = '0';
    try {
      const td =
        simulationResult?.transactionData?.value?.() ??
        simulationResult?.transactionData ??
        null;
      const rf: bigint =
        typeof td?.resourceFee === 'function'
          ? BigInt(td.resourceFee().toString())
          : BigInt(0);
      if (rf > BigInt(0)) {
        rentFeeStroops = rf.toString();
      } else if (BigInt(minResourceFee) > BigInt(0)) {
        // Estimate: rent ≈ 30 % of total resource fee
        rentFeeStroops = ((BigInt(minResourceFee) * BigInt(30)) / BigInt(100)).toString();
      }
    } catch {
      if (BigInt(minResourceFee) > BigInt(0)) {
        rentFeeStroops = ((BigInt(minResourceFee) * BigInt(30)) / BigInt(100)).toString();
      }
    }

    const totalFeeStroops = (
      BigInt(inclusionFeeStroops) + BigInt(minResourceFee)
    ).toString();

    // -----------------------------------------------------------------------
    // Extract CPU / memory resource usage
    // -----------------------------------------------------------------------
    let cpuInstructions = 0;
    let memoryBytes = 0;
    try {
      const resources = simulationResult?.result?.auth?.[0]?.resources?.() ?? null;
      if (resources) {
        cpuInstructions = Number(resources.instructions?.() ?? 0);
        memoryBytes = Number(resources.readBytes?.() ?? 0);
      }
    } catch {
      // best-effort
    }

    // -----------------------------------------------------------------------
    // Footprint
    // -----------------------------------------------------------------------
    const { readFootprint, writeFootprint } = parseLedgerFootprint(simulationResult);

    return {
      inclusionFeeStroops,
      resourceFeeStroops: minResourceFee,
      rentFeeStroops,
      totalFeeStroops,
      totalFeeXlm: stroopsToXlm(totalFeeStroops),
      readFootprint,
      writeFootprint,
      readCount: readFootprint.length,
      writeCount: writeFootprint.length,
      cpuInstructions,
      memoryBytes,
      success: true,
    };
  } catch (error: any) {
    return {
      inclusionFeeStroops: '0',
      resourceFeeStroops: '0',
      rentFeeStroops: '0',
      totalFeeStroops: '0',
      totalFeeXlm: '0.0000000',
      readFootprint: [],
      writeFootprint: [],
      readCount: 0,
      writeCount: 0,
      cpuInstructions: 0,
      memoryBytes: 0,
      success: false,
      error: error?.message ?? String(error),
    };
  }
}

/**
 * Fetches latest ledger sequence from Soroban RPC endpoint.
 */
export async function getSorobanLatestLedger(): Promise<number> {
  try {
    const health = await sorobanServer.getLatestLedger();
    return health.sequence;
  } catch (error: any) {
    console.warn(`[SorobanRPC] Could not fetch latest ledger: ${error.message}`);
    return 0;
  }
}

/**
 * Fetches contract events from Soroban RPC for a specific contract address.
 */
export async function fetchContractEvents(
  contractId: string,
  startLedger: number
): Promise<any[]> {
  try {
    const response = await sorobanServer.getEvents({
      startLedger,
      filters: [
        {
          type: 'contract',
          contractIds: [contractId],
        },
      ],
    });
    return response.events || [];
  } catch (error: any) {
    console.error(`[SorobanRPC] Error fetching contract events for ${contractId}:`, error.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Issue #43 – State Snapshot & Historical Event Backfill
// ---------------------------------------------------------------------------

export interface SorobanStateSnapshot {
  contractId: string;
  ledgerSequence: number;
  capturedAt: string; // ISO timestamp
  keyCount: number;
  entries: Array<{ key: string; value: string; durability: 'persistent' | 'temporary' }>;
}

/**
 * Captures a state snapshot of a Soroban contract by fetching all
 * ledger entries for the given contract ID at the current ledger.
 * Falls back gracefully if the RPC call fails.
 */
export async function captureContractSnapshot(
  contractId: string
): Promise<SorobanStateSnapshot> {
  const capturedAt = new Date().toISOString();
  const entries: SorobanStateSnapshot['entries'] = [];

  let ledgerSequence = 0;

  try {
    ledgerSequence = await getSorobanLatestLedger();

    // Build a ContractData ledger key for the contract's instance entry.
    // The stellar-sdk exposes xdr.LedgerKey.contractData(…) for this purpose.
    const xdr = (StellarSdk as any).xdr;

    const contractAddress = new (StellarSdk as any).Address(contractId);
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractAddress.toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );

    const response = await sorobanServer.getLedgerEntries(instanceKey);
    const rawEntries: any[] = response?.entries ?? [];

    for (const entry of rawEntries) {
      try {
        const keyXdr: string = entry.key?.toXDR?.('base64') ?? String(entry.key ?? '');
        const valXdr: string = entry.val?.toXDR?.('base64') ?? String(entry.val ?? '');
        const durability = _detectDurability(entry.key);
        entries.push({ key: keyXdr, value: valXdr, durability });
      } catch {
        // best-effort – skip unparseable entries
      }
    }
  } catch (error: any) {
    console.warn(
      `[SorobanRPC] captureContractSnapshot failed for ${contractId}: ${error?.message ?? error}`
    );
  }

  return {
    contractId,
    ledgerSequence,
    capturedAt,
    keyCount: entries.length,
    entries,
  };
}

export interface BackfillResult {
  contractId: string;
  startLedger: number;
  endLedger: number;
  eventsProcessed: number;
  errors: number;
}

/** Page size (ledgers) used when backfilling historical events. */
const BACKFILL_PAGE_SIZE = 100;

/**
 * Backfills historical Soroban contract events between startLedger and endLedger.
 * Processes events in pages of 100 ledgers and calls `onEvent` for each event.
 */
export async function backfillContractEvents(
  contractId: string,
  startLedger: number,
  endLedger: number,
  onEvent: (event: any) => Promise<void>
): Promise<BackfillResult> {
  let eventsProcessed = 0;
  let errors = 0;

  for (
    let pageStart = startLedger;
    pageStart <= endLedger;
    pageStart += BACKFILL_PAGE_SIZE
  ) {
    try {
      const events = await fetchContractEvents(contractId, pageStart);

      for (const event of events) {
        try {
          await onEvent(event);
          eventsProcessed++;
        } catch (handlerError: any) {
          console.error(
            `[SorobanRPC] backfillContractEvents handler error for ${contractId} at ledger ${pageStart}:`,
            handlerError?.message ?? handlerError
          );
          errors++;
        }
      }
    } catch (fetchError: any) {
      console.error(
        `[SorobanRPC] backfillContractEvents fetch error for ${contractId} at ledger ${pageStart}:`,
        fetchError?.message ?? fetchError
      );
      errors++;
    }
  }

  return {
    contractId,
    startLedger,
    endLedger,
    eventsProcessed,
    errors,
  };
}

// ---------------------------------------------------------------------------

/**
 * Parses raw Soroban RPC event data into a clean transfer object.
 */
export function parseSorobanTransferEvent(event: any): ParsedSorobanTransfer | null {
  if (!event || !event.topic || event.topic.length === 0) {
    return null;
  }

  const contractId = event.contractId || '';
  const topic = event.topic[0] || '';

  // Extract from, to, amount if structured payload exists
  const value = event.value || {};
  const from = value.from || value.transfer?.from || '';
  const to = value.to || value.transfer?.to || '';
  const amount = value.amount ? String(value.amount) : '0';

  return {
    contractId,
    from,
    to,
    amount,
    topic,
  };
}

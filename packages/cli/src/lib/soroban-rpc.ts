export const STROOPS_PER_XLM = 10_000_000;
export const DEFAULT_SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
export const DEFAULT_BASE_FEE_STROOPS = 100;

export interface SorobanResourceCost {
  cpuInstructions: number;
  memoryBytes: number;
  readBytes: number;
  writeBytes: number;
  ledgerReadCount: number;
  ledgerWriteCount: number;
}

export interface SorobanFootprintSummary {
  readOnly: string[];
  readWrite: string[];
}

export interface SimulatedContractEvent {
  index: number;
  type: 'contract' | 'system' | 'diagnostic' | string;
  contractId: string | null;
  topics: string[];
  data: unknown;
  rawXdr?: string;
}

export interface SimulationFeeEstimate {
  baseFeeStroops: number;
  minResourceFeeStroops: number;
  totalFeeStroops: number;
  totalFeeXlm: string;
}

export interface TransactionSimulationReport {
  status: 'SUCCESS' | 'FAILED';
  rpcUrl: string;
  latestLedger: number | null;
  error?: string;
  resources: SorobanResourceCost;
  footprint: SorobanFootprintSummary;
  fees: SimulationFeeEstimate;
  events: SimulatedContractEvent[];
  returnValueXdr?: string | null;
  restorePreambleNeeded: boolean;
}

export interface SorobanRpcRawResponse {
  jsonrpc?: string;
  id?: string | number;
  result?: {
    latestLedger?: number;
    minResourceFee?: string | number;
    error?: string;
    cost?: {
      cpuInsns?: string | number;
      memBytes?: string | number;
      readBytes?: string | number;
      writeBytes?: string | number;
    };
    transactionData?: string | {
      readOnly?: string[];
      readWrite?: string[];
      readBytes?: number;
      writeBytes?: number;
    };
    footprint?: {
      readOnly?: string[];
      readWrite?: string[];
    };
    events?: Array<
      | string
      | {
          type?: string;
          contractId?: string;
          topics?: string[];
          data?: unknown;
          xdr?: string;
        }
    >;
    results?: Array<{
      xdr?: string;
      auth?: string[];
    }>;
    restorePreamble?: {
      minResourceFee?: string | number;
      transactionData?: string;
    };
  };
  error?: {
    code?: number;
    message?: string;
  };
}

/**
 * Validates that an input string is a non-empty, well-formed base64 XDR payload.
 */
export function isValidBase64Xdr(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (trimmed.length < 8 || trimmed.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return false;
  try {
    const decoded = Buffer.from(trimmed, 'base64');
    return decoded.length >= 4 && decoded.toString('base64') === trimmed;
  } catch {
    return false;
  }
}

/**
 * Converts a fee in stroops to a 7-decimal XLM string (`1 XLM = 10,000,000 stroops`).
 */
export function stroopsToXlm(stroops: number): string {
  if (!Number.isFinite(stroops) || stroops < 0) return '0.0000000';
  return (stroops / STROOPS_PER_XLM).toFixed(7);
}

/**
 * Normalizes raw Soroban RPC `events` (either structured event objects or raw XDR strings)
 * into human-readable JSON event objects.
 */
export function parseSimulatedEvents(
  rawEvents: NonNullable<SorobanRpcRawResponse['result']>['events']
): SimulatedContractEvent[] {
  if (!Array.isArray(rawEvents)) return [];

  return rawEvents.map((item, index) => {
    if (typeof item === 'string') {
      return {
        index,
        type: 'contract',
        contractId: null,
        topics: [],
        data: { xdr: item },
        rawXdr: item,
      };
    }

    return {
      index,
      type: item.type || 'contract',
      contractId: item.contractId ?? null,
      topics: Array.isArray(item.topics) ? item.topics : [],
      data: item.data ?? (item.xdr ? { xdr: item.xdr } : null),
      rawXdr: item.xdr,
    };
  });
}

export class SorobanRpcClient {
  constructor(
    private readonly rpcUrl: string = DEFAULT_SOROBAN_RPC_URL,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  /**
   * Simulates a base64-encoded transaction envelope against the configured Soroban RPC node
   * and computes CPU/RAM usage, ledger footprint, contract events, and total fees in stroops & XLM.
   */
  public async simulateTransaction(
    txEnvelopeXdr: string,
    options?: { baseFeeStroops?: number }
  ): Promise<TransactionSimulationReport> {
    const trimmedXdr = (txEnvelopeXdr || '').trim();
    if (!isValidBase64Xdr(trimmedXdr)) {
      throw new Error(
        'Invalid transaction XDR: expected a valid base64-encoded Stellar transaction envelope'
      );
    }

    const baseFeeStroops =
      options?.baseFeeStroops ?? DEFAULT_BASE_FEE_STROOPS;

    const response = await this.fetchFn(this.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'stellar-alerts-cli-simulate',
        method: 'simulateTransaction',
        params: {
          transaction: trimmedXdr,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Soroban RPC request failed with HTTP ${response.status}`
      );
    }

    const payload = (await response.json()) as SorobanRpcRawResponse;
    if (payload.error) {
      throw new Error(
        `Soroban RPC error (${payload.error.code ?? 'unknown'}): ${payload.error.message || 'Unknown RPC error'}`
      );
    }

    const res = payload.result ?? {};
    const cpuInstructions = Number(res.cost?.cpuInsns ?? 0);
    const memoryBytes = Number(res.cost?.memBytes ?? 0);

    const txDataObj =
      typeof res.transactionData === 'object' && res.transactionData !== null
        ? res.transactionData
        : undefined;

    const readOnly =
      res.footprint?.readOnly ?? txDataObj?.readOnly ?? [];
    const readWrite =
      res.footprint?.readWrite ?? txDataObj?.readWrite ?? [];

    const readBytes = Number(
      res.cost?.readBytes ?? txDataObj?.readBytes ?? readOnly.length * 128
    );
    const writeBytes = Number(
      res.cost?.writeBytes ?? txDataObj?.writeBytes ?? readWrite.length * 256
    );

    const minResourceFeeStroops = Number(res.minResourceFee ?? 0);
    const totalFeeStroops = baseFeeStroops + minResourceFeeStroops;
    const events = parseSimulatedEvents(res.events);
    const returnValueXdr = res.results?.[0]?.xdr ?? null;
    const restorePreambleNeeded = Boolean(
      res.restorePreamble && res.restorePreamble.transactionData
    );

    if (res.error) {
      return {
        status: 'FAILED',
        rpcUrl: this.rpcUrl,
        latestLedger: res.latestLedger ?? null,
        error: res.error,
        resources: {
          cpuInstructions,
          memoryBytes,
          readBytes,
          writeBytes,
          ledgerReadCount: readOnly.length,
          ledgerWriteCount: readWrite.length,
        },
        footprint: {
          readOnly,
          readWrite,
        },
        fees: {
          baseFeeStroops,
          minResourceFeeStroops,
          totalFeeStroops,
          totalFeeXlm: stroopsToXlm(totalFeeStroops),
        },
        events,
        returnValueXdr,
        restorePreambleNeeded,
      };
    }

    return {
      status: 'SUCCESS',
      rpcUrl: this.rpcUrl,
      latestLedger: res.latestLedger ?? null,
      resources: {
        cpuInstructions,
        memoryBytes,
        readBytes,
        writeBytes,
        ledgerReadCount: readOnly.length,
        ledgerWriteCount: readWrite.length,
      },
      footprint: {
        readOnly,
        readWrite,
      },
      fees: {
        baseFeeStroops,
        minResourceFeeStroops,
        totalFeeStroops,
        totalFeeXlm: stroopsToXlm(totalFeeStroops),
      },
      events,
      returnValueXdr,
      restorePreambleNeeded,
    };
  }
}

export default SorobanRpcClient;

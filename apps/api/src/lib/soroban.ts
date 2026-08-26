import * as StellarSdk from 'stellar-sdk';
import { getJson, setJson, getSacMetadataCacheKey, SAC_METADATA_TTL } from './cache';
import { formatTokenAmount } from './stellar';

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const STELLAR_NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;

export const sorobanServer = new (StellarSdk as any).rpc.Server(SOROBAN_RPC_URL);

export interface ParsedSorobanTransfer {
  contractId: string;
  from: string;
  to: string;
  amount: string;
  topic: string;
}

export interface SacMetadata {
  contractId: string;
  name: string;
  symbol: string;
  decimals: number;
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

/**
 * Simulates a read-only method invocation on a Soroban contract via RPC.
 */
export async function simulateContractCall(
  contractId: string,
  method: string,
  args: any[] = []
): Promise<any> {
  try {
    if (!contractId) return null;

    const contract = new StellarSdk.Contract(contractId);
    const op = contract.call(method, ...args);

    const dummySource = new StellarSdk.Account(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      '0'
    );

    const tx = new StellarSdk.TransactionBuilder(dummySource, {
      fee: '100',
      networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await sorobanServer.simulateTransaction(tx);

    if (!sim) {
      return null;
    }

    // Check if simulation was successful and has return value
    const retval = sim.result?.retval || (sim as any).retval;
    if (retval) {
      return StellarSdk.scValToNative(retval);
    }

    return null;
  } catch (error: any) {
    return null;
  }
}

/**
 * Queries SAC token metadata (decimals, symbol, name) from Soroban RPC.
 */
export async function fetchSacMetadataFromRpc(contractId: string): Promise<SacMetadata> {
  const fallback: SacMetadata = {
    contractId,
    name: 'Unknown Token',
    symbol: contractId ? contractId.substring(0, 8) : 'Unknown',
    decimals: 7,
  };

  if (!contractId) {
    return fallback;
  }

  try {
    // Query decimals, symbol, name via contract simulation in parallel
    const [decimalsVal, symbolVal, nameVal] = await Promise.all([
      simulateContractCall(contractId, 'decimals'),
      simulateContractCall(contractId, 'symbol'),
      simulateContractCall(contractId, 'name'),
    ]);

    let decimals = fallback.decimals;
    if (typeof decimalsVal === 'number' && Number.isInteger(decimalsVal) && decimalsVal >= 0) {
      decimals = decimalsVal;
    } else if (typeof decimalsVal === 'bigint') {
      decimals = Number(decimalsVal);
    } else if (typeof decimalsVal === 'string' && /^\d+$/.test(decimalsVal)) {
      decimals = parseInt(decimalsVal, 10);
    }

    const symbol =
      typeof symbolVal === 'string' && symbolVal.trim().length > 0
        ? symbolVal.trim()
        : fallback.symbol;

    const name =
      typeof nameVal === 'string' && nameVal.trim().length > 0
        ? nameVal.trim()
        : symbol !== fallback.symbol
        ? symbol
        : fallback.name;

    return {
      contractId,
      name,
      symbol,
      decimals,
    };
  } catch (error: any) {
    console.warn(`[SorobanRPC] Error fetching SAC metadata for contract ${contractId}:`, error.message);
    return fallback;
  }
}

/**
 * Retrieves SAC metadata from Redis cache (24h TTL) or discovers it from Soroban RPC.
 */
export async function getSacMetadata(
  contractId: string,
  forceRefresh: boolean = false
): Promise<SacMetadata> {
  if (!contractId) {
    return {
      contractId: '',
      name: 'Unknown Token',
      symbol: 'Unknown',
      decimals: 7,
    };
  }

  const cacheKey = getSacMetadataCacheKey(contractId);

  if (!forceRefresh) {
    const cached = await getJson<SacMetadata>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const metadata = await fetchSacMetadataFromRpc(contractId);
  await setJson(cacheKey, metadata, SAC_METADATA_TTL);
  return metadata;
}

/**
 * Formats a raw SAC amount into a human-readable string using the contract's discovered decimals.
 */
export async function formatSacAmountWithDiscovery(
  rawAmount: string | number | bigint,
  contractId: string
): Promise<{ formattedAmount: string; metadata: SacMetadata }> {
  const metadata = await getSacMetadata(contractId);
  const formattedAmount = formatTokenAmount(rawAmount, metadata.decimals);
  return {
    formattedAmount,
    metadata,
  };
}

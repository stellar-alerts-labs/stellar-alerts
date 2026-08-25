import * as StellarSdk from 'stellar-sdk';

const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');

export const STROOPS_PER_UNIT = 10_000_000;

function logPaymentsError(publicKey: string, error: any) {
  console.error(
    `[Stellar] Error fetching payments for ${publicKey.substring(0, 8)}...:`,
    error?.message ?? error
  );
}

export interface DecodedStellarAsset {
  assetCode: string;
  assetIssuer: string | null;
}

export interface SacTransfer {
  contractId: string;
  assetCode: string | null;
  assetIssuer: string | null;
  from: string;
  to: string;
  amount: string;
  rawAmount: string;
}

/**
 * Decodes a Horizon payment record into an asset code and issuer address.
 * Native XLM payments resolve to { assetCode: 'XLM', assetIssuer: null } while
 * credit_alphanum4 / credit_alphanum12 records carry their own code + issuer.
 */
export function decodeHorizonAsset(record: any): DecodedStellarAsset {
  if (record?.asset_type === 'native' || !record?.asset_type) {
    return { assetCode: 'XLM', assetIssuer: null };
  }

  return {
    assetCode: record.asset_code || 'Unknown',
    assetIssuer: record.asset_issuer || null,
  };
}

/**
 * Converts a raw token amount (stroops / smallest SAC unit) into a human
 * readable decimal string using the given number of decimals.
 */
export function formatTokenAmount(
  rawAmount: string | number | bigint,
  decimals: number = 7
): string {
  let raw: bigint;
  try {
    raw = typeof rawAmount === 'bigint' ? rawAmount : BigInt(String(rawAmount).trim());
  } catch {
    raw = 0n;
  }

  const sign = raw < 0n ? '-' : '';
  const abs = sign ? -raw : raw;
  const divisor = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');

  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Decodes a Soroban ScVal address (or an already decoded strkey) into its
 * string representation (G... for accounts, C... for contracts).
 */
export function decodeScAddress(scVal: any): string | null {
  if (!scVal) return null;

  if (typeof scVal === 'string') {
    return scVal.startsWith('G') || scVal.startsWith('C') ? scVal : null;
  }

  if (typeof scVal === 'object') {
    try {
      const native = StellarSdk.scValToNative(scVal);
      if (typeof native === 'string') {
        return native.startsWith('G') || native.startsWith('C') ? native : null;
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Decodes a Soroban i128 amount (raw ScVal, { lo, hi } shape or plain value)
 * into a bigint of stroops.
 */
export function decodeScAmount(value: any): bigint | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'bigint') return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }

  if (typeof value === 'object') {
    const i128 = value.i128 ?? value.value?.i128;
    if (i128 && typeof i128 === 'object' && i128.lo !== undefined) {
      const lo = BigInt(i128.lo >>> 0);
      const hi = BigInt(i128.hi >>> 0);
      return (hi << 64n) + lo;
    }
    if (typeof i128 === 'string' && /^-?\d+$/.test(i128)) {
      return BigInt(i128);
    }
    try {
      const native = StellarSdk.scValToNative(value);
      if (typeof native === 'bigint') return native;
      if (typeof native === 'number' && Number.isFinite(native)) {
        return BigInt(Math.trunc(native));
      }
    } catch {
      return null;
    }
  }

  return null;
}

function extractTopicValue(topicEntry: any): string | null {
  if (topicEntry === null || topicEntry === undefined) return null;
  if (typeof topicEntry === 'string') return topicEntry;
  if (typeof topicEntry === 'object' && typeof topicEntry.symbol === 'string') {
    return topicEntry.symbol;
  }
  return null;
}

/**
 * Parses a Soroban Asset Contract (SAC) transfer event into a structured
 * transfer with the decimal-adjusted amount. Supports both canonical RPC
 * events (topic: [symbol, from, to] + i128 data) and simplified payloads.
 */
export function parseSacTransferEvent(event: any, decimals: number = 7): SacTransfer | null {
  if (!event) return null;

  const topics = Array.isArray(event.topic) ? event.topic : [];
  const action = extractTopicValue(topics[0]) ?? (typeof event.topic === 'string' ? event.topic : '');

  const value = event.value ?? event.data ?? {};
  const from = (topics.length > 1 ? decodeScAddress(topics[1]) : null) ?? value.from ?? '';
  const to = (topics.length > 2 ? decodeScAddress(topics[2]) : null) ?? value.to ?? '';

  let rawAmount = decodeScAmount(value.amount);
  if (rawAmount === null && !value.amount && !value.from && !value.to) {
    rawAmount = decodeScAmount(value);
  }

  if (!action || action !== 'transfer' || rawAmount === null) {
    return null;
  }

  if (!from && !to) {
    return null;
  }

  return {
    contractId: event.contractId || '',
    assetCode: event.assetCode ?? null,
    assetIssuer: event.assetIssuer ?? null,
    from,
    to,
    amount: formatTokenAmount(rawAmount, decimals),
    rawAmount: rawAmount.toString(),
  };
}

/**
 * Opens a live Horizon Server-Sent Events payment stream for `publicKey`,
 * resuming from `cursor` (a Horizon paging token). `onmessage` fires for every
 * new payment as soon as the ledger closes; `onerror` fires on connection
 * errors. Returns a closable handle that tears down the underlying EventSource.
 */
export function openPaymentStream(
  publicKey: string,
  cursor: string,
  handlers: { onmessage: (record: any) => void; onerror: (error: any) => void }
): () => void {
  if (!publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
    console.warn(`[Stellar] Not opening SSE stream for invalid public key: "${publicKey}"`);
    return () => {};
  }

  return server
    .payments()
    .forAccount(publicKey)
    .cursor(cursor)
    .stream({
      onmessage: handlers.onmessage,
      onerror: handlers.onerror,
    });
}

export const stellar = {
  server,
  openPaymentStream,
  // Helper to fetch recent payments for a given account
  async getRecentPayments(publicKey: string, limit: number = 10) {
    if (!publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      console.warn(`[Stellar] Skipping invalid public key format or checksum: "${publicKey}"`);
      return [];
    }

    try {
      const payments = await server.payments()
        .forAccount(publicKey)
        .order('desc')
        .limit(limit)
        .call();
      
      return payments.records;
    } catch (error: any) {
      logPaymentsError(publicKey, error);
      return [];
    }
  },

  // Fetch payments recorded after the given Horizon paging token, oldest first
  async getPaymentsSince(publicKey: string, cursor: string, limit: number = 50) {
    if (!publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      console.warn(`[Stellar] Skipping invalid public key format or checksum: "${publicKey}"`);
      return [];
    }

    try {
      const payments = await server.payments()
        .forAccount(publicKey)
        .cursor(cursor)
        .order('asc')
        .limit(limit)
        .call();

      return payments.records;
    } catch (error: any) {
      logPaymentsError(publicKey, error);
      return [];
    }
  },

  // Paging token of the most recent payment, used to seed a fresh cursor
  async getLatestPagingToken(publicKey: string): Promise<string> {
    const records = await this.getRecentPayments(publicKey, 1);
    return (records[0] as any)?.paging_token || '0';
  }
};

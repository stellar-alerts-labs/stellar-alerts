/**
 * WebAssembly LedgerCloseMeta scanner (source: native/xdr-reader, Rust → wasm32).
 *
 * `xdr.LedgerCloseMeta.fromXDR()` builds a full JS object graph for the whole
 * ledger, including the transaction results/meta that operation-level alerting
 * never reads. This module instead hands the raw bytes to a tiny WASM module
 * that walks only the header and tx-set envelopes, skips each operation body by
 * structure, and writes one fixed-size record per *selected* operation type
 * into a table in linear memory. JS reads those records through typed-array
 * views over the same memory — no per-operation objects are allocated unless
 * the caller asks for them (`toArray()`, or decoding a body it cares about).
 *
 * Fallback: if the WASM module is unavailable, or it reports a protocol shape it
 * doesn't know (newer union arms), `scanLedgerOperations()` transparently falls
 * back to the pure-JS SDK path so ingestion never stalls on an upgrade.
 */
import * as StellarSdk from 'stellar-sdk';
import { XDR_READER_WASM_BASE64 } from './xdr-wasm/xdr-reader.wasm';

export const OperationType = {
  createAccount: 0,
  payment: 1,
  pathPaymentStrictReceive: 2,
  manageSellOffer: 3,
  createPassiveSellOffer: 4,
  setOptions: 5,
  changeTrust: 6,
  allowTrust: 7,
  accountMerge: 8,
  inflation: 9,
  manageData: 10,
  bumpSequence: 11,
  manageBuyOffer: 12,
  pathPaymentStrictSend: 13,
  createClaimableBalance: 14,
  claimClaimableBalance: 15,
  beginSponsoringFutureReserves: 16,
  endSponsoringFutureReserves: 17,
  revokeSponsorship: 18,
  clawback: 19,
  clawbackClaimableBalance: 20,
  setTrustLineFlags: 21,
  liquidityPoolDeposit: 22,
  liquidityPoolWithdraw: 23,
  invokeHostFunction: 24,
  extendFootprintTtl: 25,
  restoreFootprint: 26,
} as const;

export const OPERATION_TYPE_NAMES: readonly string[] = Object.keys(OperationType);

export type OperationTypeName = keyof typeof OperationType;

/** Builds the type bitmask passed to the scanner. No arguments selects everything. */
export function operationMask(...types: Array<number | OperationTypeName>): number {
  if (types.length === 0) return 0xffffffff;
  let mask = 0;
  for (const t of types) {
    const id = typeof t === 'number' ? t : OperationType[t];
    mask |= 1 << id;
  }
  return mask >>> 0;
}

const ERROR_MESSAGES: Record<number, string> = {
  [-1]: 'input ended unexpectedly',
  [-2]: 'unsupported XDR union arm (newer protocol shape)',
  [-3]: 'output table full',
  [-4]: 'unknown LedgerCloseMeta version',
  [-5]: 'nesting too deep',
  [-6]: 'malformed XDR',
  [-7]: 'WASM memory allocation failed',
};

export class XdrReaderError extends Error {
  constructor(readonly code: number) {
    super(`xdr-wasm: ${ERROR_MESSAGES[code] ?? `error ${code}`}`);
    this.name = 'XdrReaderError';
  }
}

const REC_WORDS = 11;
const FLAG_HAS_SOURCE = 1;
const FLAG_FEE_BUMP = 2;
const FLAG_V0 = 4;
const INITIAL_OUT_RECORDS = 4096;
const MAX_OUT_RECORDS = 1 << 22;

export interface LedgerScanHeader {
  ledgerSeq: number;
  ledgerVersion: number;
  /** Unix seconds. */
  closeTime: number;
  txCount: number;
  /** Every operation in the tx set, selected or not. */
  opTotal: number;
  metaVersion: number;
}

/** Plain-object copy of an operation record (allocates; prefer the flyweight in hot paths). */
export interface OperationSummary {
  txIndex: number;
  opIndex: number;
  type: number;
  typeName: string;
  feeBump: boolean;
  /** Effective source account (op source, else tx source) as a G... address. */
  sourceAccount: string;
  /** Destination G... address for payment-like operations. */
  destination: string | null;
}

/**
 * Reusable cursor over the scanner's output table. A single instance is
 * repositioned by `seek`/`forEach`; do not retain it across iterations or
 * across the next `scan()` call, which overwrites the underlying memory.
 */
export class OperationRecord {
  private w = 0;
  constructor(
    private readonly table: Uint32Array,
    private readonly input: Uint8Array,
  ) {}

  seek(index: number): this {
    this.w = index * REC_WORDS;
    return this;
  }

  get txIndex(): number { return this.table[this.w]; }
  get opIndex(): number { return this.table[this.w + 1]; }
  get type(): number { return this.table[this.w + 2]; }
  get typeName(): string { return OPERATION_TYPE_NAMES[this.type] ?? `unknown(${this.type})`; }
  get hasSource(): boolean { return (this.table[this.w + 3] & FLAG_HAS_SOURCE) !== 0; }
  get isFeeBump(): boolean { return (this.table[this.w + 3] & FLAG_FEE_BUMP) !== 0; }
  get bodyOffset(): number { return this.table[this.w + 6]; }
  get bodyLength(): number { return this.table[this.w + 7]; }
  get txOffset(): number { return this.table[this.w + 4]; }
  get txLength(): number { return this.table[this.w + 5]; }

  /** Raw XDR of the `OperationBody` union (zero-copy view). */
  body(): Uint8Array {
    return this.input.subarray(this.bodyOffset, this.bodyOffset + this.bodyLength);
  }

  /** Raw XDR of the whole `TransactionEnvelope` (zero-copy view), e.g. for hashing. */
  envelope(): Uint8Array {
    return this.input.subarray(this.txOffset, this.txOffset + this.txLength);
  }

  /** 32-byte ed25519 key of the effective source account (zero-copy view). */
  sourceKey(): Uint8Array {
    const off = this.hasSource ? this.table[this.w + 8] : this.table[this.w + 9];
    return this.input.subarray(off, off + 32);
  }

  /** 32-byte ed25519 destination key for payment-like ops, else null (zero-copy view). */
  destinationKey(): Uint8Array | null {
    const off = this.table[this.w + 10];
    return off === 0 ? null : this.input.subarray(off, off + 32);
  }

  /** Decodes just this operation's body with the SDK (allocates; call only for ops you act on). */
  decodeBody(): StellarSdk.xdr.OperationBody {
    return StellarSdk.xdr.OperationBody.fromXDR(Buffer.from(this.body()));
  }
}

export class LedgerScan {
  private readonly cursor: OperationRecord;
  constructor(
    readonly header: LedgerScanHeader,
    readonly count: number,
    table: Uint32Array,
    private readonly input: Uint8Array,
  ) {
    this.cursor = new OperationRecord(table, input);
  }

  /** Iterates selected operations with a single reused cursor (no per-op allocation). */
  forEach(cb: (op: OperationRecord, index: number) => void): void {
    for (let i = 0; i < this.count; i++) cb(this.cursor.seek(i), i);
  }

  /** Materialises plain objects (allocates; use for tests and low-volume consumers). */
  toArray(): OperationSummary[] {
    const out: OperationSummary[] = [];
    this.forEach((op) => {
      const dest = op.destinationKey();
      out.push({
        txIndex: op.txIndex,
        opIndex: op.opIndex,
        type: op.type,
        typeName: op.typeName,
        feeBump: op.isFeeBump,
        sourceAccount: StellarSdk.StrKey.encodeEd25519PublicKey(Buffer.from(op.sourceKey())),
        destination: dest ? StellarSdk.StrKey.encodeEd25519PublicKey(Buffer.from(dest)) : null,
      });
    });
    return out;
  }
}

interface WasmExports {
  memory: WebAssembly.Memory;
  reserve(len: number): number;
  reserve_out(records: number): number;
  header_ptr(): number;
  scan(len: number, mask: number): number;
}

export class XdrWasmReader {
  private outCap = INITIAL_OUT_RECORDS;

  private constructor(private readonly wasm: WasmExports) {}

  /** Synchronously instantiates the embedded module (~27 KB; compiles in well under a millisecond-scale). */
  static create(): XdrWasmReader {
    const bytes = Buffer.from(XDR_READER_WASM_BASE64, 'base64');
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    return new XdrWasmReader(instance.exports as unknown as WasmExports);
  }

  /** Scans raw `LedgerCloseMeta` XDR bytes. The result is valid until the next scan on this reader. */
  scan(meta: Uint8Array, mask: number = 0xffffffff): LedgerScan {
    const inPtr = this.wasm.reserve(meta.byteLength);
    if (inPtr === 0) throw new XdrReaderError(-7);
    this.ensureOut(this.outCap);
    new Uint8Array(this.wasm.memory.buffer, inPtr, meta.byteLength).set(meta);
    return this.run(inPtr, meta.byteLength, mask);
  }

  /**
   * Scans base64 XDR (the form Horizon/Soroban RPC return). The decode writes
   * straight into WASM memory, so no intermediate decoded Buffer is allocated.
   */
  scanBase64(base64: string, mask: number = 0xffffffff): LedgerScan {
    const maxBytes = Math.floor((base64.length * 3) / 4);
    const inPtr = this.wasm.reserve(maxBytes);
    if (inPtr === 0) throw new XdrReaderError(-7);
    this.ensureOut(this.outCap);
    const written = Buffer.from(this.wasm.memory.buffer, inPtr, maxBytes).write(base64, 0, maxBytes, 'base64');
    return this.run(inPtr, written, mask);
  }

  private ensureOut(records: number): void {
    if (this.wasm.reserve_out(records) === 0) throw new XdrReaderError(-7);
  }

  private run(inPtr: number, length: number, mask: number): LedgerScan {
    let count = this.wasm.scan(length, mask);
    while (count === -3) {
      if (this.outCap >= MAX_OUT_RECORDS) throw new XdrReaderError(-3);
      this.outCap = Math.min(this.outCap * 4, MAX_OUT_RECORDS);
      this.ensureOut(this.outCap); // grows memory; the input region keeps its address
      count = this.wasm.scan(length, mask);
    }
    if (count < 0) throw new XdrReaderError(count);

    const mem = this.wasm.memory.buffer;
    const h = new Uint32Array(mem, this.wasm.header_ptr(), 8);
    const header: LedgerScanHeader = {
      ledgerSeq: h[0],
      ledgerVersion: h[1],
      closeTime: h[2] + h[3] * 2 ** 32,
      txCount: h[4],
      opTotal: h[5],
      metaVersion: h[6],
    };
    // The table lives at the start of the last `reserve_out` region.
    const table = new Uint32Array(mem, this.wasm.reserve_out(this.outCap), count * REC_WORDS);
    return new LedgerScan(header, count, table, new Uint8Array(mem, inPtr, length));
  }
}

// ── pure-JS reference / fallback ─────────────────────────────────────────────

function envelopeOperations(envelope: StellarSdk.xdr.TransactionEnvelope): {
  ops: StellarSdk.xdr.Operation[];
  txSource: Buffer;
  feeBump: boolean;
} {
  const muxedKey = (m: StellarSdk.xdr.MuxedAccount): Buffer =>
    Buffer.from(m.switch().value === 0 ? m.ed25519() : m.med25519().ed25519());
  switch (envelope.switch().value) {
    case 0: {
      const tx = envelope.v0().tx();
      return { ops: tx.operations(), txSource: Buffer.from(tx.sourceAccountEd25519()), feeBump: false };
    }
    case 2: {
      const tx = envelope.v1().tx();
      return { ops: tx.operations(), txSource: muxedKey(tx.sourceAccount()), feeBump: false };
    }
    default: {
      const inner = envelope.feeBump().tx().innerTx().v1().tx();
      return { ops: inner.operations(), txSource: muxedKey(inner.sourceAccount()), feeBump: true };
    }
  }
}

function jsDestinationKey(op: StellarSdk.xdr.Operation): Buffer | null {
  const body = op.body();
  const muxedKey = (m: StellarSdk.xdr.MuxedAccount): Buffer =>
    Buffer.from(m.switch().value === 0 ? m.ed25519() : m.med25519().ed25519());
  switch (body.switch().value) {
    case OperationType.createAccount:
      return Buffer.from(body.createAccountOp().destination().ed25519());
    case OperationType.payment:
      return muxedKey(body.paymentOp().destination());
    case OperationType.pathPaymentStrictReceive:
      return muxedKey(body.pathPaymentStrictReceiveOp().destination());
    case OperationType.pathPaymentStrictSend:
      return muxedKey(body.pathPaymentStrictSendOp().destination());
    case OperationType.accountMerge:
      return muxedKey(body.destination());
    default:
      return null;
  }
}

/** Reference implementation on top of `xdr.LedgerCloseMeta.fromXDR` (the slow path this module replaces). */
export function scanLedgerOperationsJs(
  meta: Uint8Array,
  mask: number = 0xffffffff,
): { header: Omit<LedgerScanHeader, 'opTotal'> & { opTotal: number }; operations: OperationSummary[] } {
  const lcm = StellarSdk.xdr.LedgerCloseMeta.fromXDR(Buffer.from(meta));
  const version = lcm.switch();
  let envelopes: StellarSdk.xdr.TransactionEnvelope[];
  let headerEntry: StellarSdk.xdr.LedgerHeaderHistoryEntry;
  if (version === 0) {
    const v0 = lcm.v0();
    headerEntry = v0.ledgerHeader();
    envelopes = v0.txSet().txes();
  } else {
    const v1 = lcm.v1();
    headerEntry = v1.ledgerHeader();
    envelopes = [];
    for (const phase of v1.txSet().v1TxSet().phases()) {
      for (const comp of phase.v0Components()) envelopes.push(...comp.txsMaybeDiscountedFee().txes());
    }
  }

  const operations: OperationSummary[] = [];
  let opTotal = 0;
  envelopes.forEach((envelope, txIndex) => {
    const { ops, txSource, feeBump } = envelopeOperations(envelope);
    ops.forEach((op, opIndex) => {
      opTotal++;
      const type = op.body().switch().value;
      if (((mask >>> type) & 1) === 0) return;
      const src = op.sourceAccount();
      const srcKey = src ? Buffer.from(src.switch().value === 0 ? src.ed25519() : src.med25519().ed25519()) : txSource;
      const dest = jsDestinationKey(op);
      operations.push({
        txIndex,
        opIndex,
        type,
        typeName: OPERATION_TYPE_NAMES[type] ?? `unknown(${type})`,
        feeBump,
        sourceAccount: StellarSdk.StrKey.encodeEd25519PublicKey(srcKey),
        destination: dest ? StellarSdk.StrKey.encodeEd25519PublicKey(dest) : null,
      });
    });
  });

  const hdr = headerEntry.header();
  return {
    header: {
      ledgerSeq: hdr.ledgerSeq(),
      ledgerVersion: hdr.ledgerVersion(),
      closeTime: Number(hdr.scpValue().closeTime().toString()),
      txCount: envelopes.length,
      opTotal,
      metaVersion: version,
    },
    operations,
  };
}

export interface LedgerOperationsResult {
  header: LedgerScanHeader;
  operations: OperationSummary[];
  engine: 'wasm' | 'js';
}

let sharedReader: XdrWasmReader | null | undefined;

function getSharedReader(): XdrWasmReader | null {
  if (sharedReader === undefined) {
    try {
      sharedReader = XdrWasmReader.create();
    } catch {
      sharedReader = null; // no WebAssembly / corrupt module: JS fallback only
    }
  }
  return sharedReader;
}

/**
 * Extracts the selected operations of a ledger. Uses the WASM scanner when it
 * understands the ledger, and falls back to the SDK when it doesn't (newer
 * protocol shapes) or isn't available.
 */
export function scanLedgerOperations(
  meta: Uint8Array | string,
  mask: number = 0xffffffff,
): LedgerOperationsResult {
  const reader = getSharedReader();
  if (reader) {
    try {
      const scan = typeof meta === 'string' ? reader.scanBase64(meta, mask) : reader.scan(meta, mask);
      return { header: scan.header, operations: scan.toArray(), engine: 'wasm' };
    } catch (err) {
      if (!(err instanceof XdrReaderError)) throw err;
      // fall through to the SDK path
    }
  }
  const bytes = typeof meta === 'string' ? Buffer.from(meta, 'base64') : meta;
  const { header, operations } = scanLedgerOperationsJs(bytes, mask);
  return { header, operations, engine: 'js' };
}

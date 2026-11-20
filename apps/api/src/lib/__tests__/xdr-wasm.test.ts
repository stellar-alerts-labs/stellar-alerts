import { describe, it, expect, vi } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import {
  XdrWasmReader,
  XdrReaderError,
  OperationType,
  operationMask,
  scanLedgerOperations,
  scanLedgerOperationsJs,
} from '../xdr-wasm';
import { buildLedgerCloseMeta, sampleEnvelopes, paymentEnvelopes, kp } from './fixtures/ledger-meta';

const reader = XdrWasmReader.create();

function wasmOps(meta: Uint8Array, mask?: number) {
  const scan = reader.scan(meta, mask);
  return { header: scan.header, operations: scan.toArray() };
}

describe('xdr-wasm: parity with the SDK decoder', () => {
  const envelopes = sampleEnvelopes();

  it('produces identical header + operation lists for every operation shape (v1 meta)', () => {
    const meta = buildLedgerCloseMeta(envelopes);
    const js = scanLedgerOperationsJs(meta);
    const wasm = wasmOps(meta);

    expect(wasm.header).toEqual(js.header);
    expect(wasm.operations).toEqual(js.operations);
    expect(wasm.operations.length).toBeGreaterThan(40);
  });

  it('covers every classic operation type at least once', () => {
    const meta = buildLedgerCloseMeta(envelopes);
    const seen = new Set(wasmOps(meta).operations.map((o) => o.type));
    for (const [name, id] of Object.entries(OperationType)) {
      if (name === 'inflation' || name === 'allowTrust') continue; // not buildable via the SDK any more
      expect(seen.has(id), `operation type ${name}`).toBe(true);
    }
  });

  it('handles legacy v0 meta (plain TransactionSet)', () => {
    const meta = buildLedgerCloseMeta(envelopes, { version: 0, ledgerSeq: 777 });
    const js = scanLedgerOperationsJs(meta);
    const wasm = wasmOps(meta);
    expect(wasm.header.metaVersion).toBe(0);
    expect(wasm.header.ledgerSeq).toBe(777);
    expect(wasm).toEqual({ header: js.header, operations: js.operations });
  });

  it('handles multiple tx-set components, optional base fees and signed StellarValue', () => {
    const meta = buildLedgerCloseMeta(envelopes, { components: 3, signedValue: true });
    const js = scanLedgerOperationsJs(meta);
    const wasm = wasmOps(meta);
    expect(wasm.operations).toEqual(js.operations);
    expect(wasm.header).toEqual(js.header);
  });

  it('flags fee-bump transactions and resolves the inner source/destination', () => {
    const meta = buildLedgerCloseMeta(envelopes);
    const ops = wasmOps(meta).operations;
    const bumped = ops.filter((o) => o.feeBump);
    expect(bumped).toHaveLength(1);
    expect(bumped[0]).toMatchObject({
      typeName: 'payment',
      sourceAccount: kp(2).publicKey(), // inner tx source, not the fee payer
      destination: kp(3).publicKey(),
    });
  });

  it('resolves op-level source overrides and muxed destinations to the underlying G address', () => {
    const meta = buildLedgerCloseMeta(envelopes);
    const payments = wasmOps(meta).operations.filter((o) => o.txIndex === 0);
    expect(payments).toHaveLength(3);
    expect(payments[0].sourceAccount).toBe(kp(1).publicKey()); // tx source
    expect(payments[1].sourceAccount).toBe(kp(3).publicKey()); // op source override
    expect(payments[2].destination).toBe(kp(2).publicKey()); // M... unwrapped
  });

  it('decodes selected operation bodies identically to the SDK (zero-copy body view)', () => {
    const meta = buildLedgerCloseMeta(envelopes);
    const scan = reader.scan(meta, operationMask('setOptions'));
    expect(scan.count).toBe(5);

    const jsBodies = StellarSdk.xdr.LedgerCloseMeta.fromXDR(Buffer.from(meta))
      .v1()
      .txSet()
      .v1TxSet()
      .phases()[0]
      .v0Components()[0]
      .txsMaybeDiscountedFee()
      .txes()
      .filter((e) => e.switch().value === 2) // v1 envelopes (set_options only appears in v1 here)
      .flatMap((e) => e.v1().tx().operations())
      .filter((op) => op.body().switch().value === OperationType.setOptions);

    const decoded: StellarSdk.xdr.SetOptionsOp[] = [];
    scan.forEach((op) => decoded.push(op.decodeBody().setOptionsOp()));
    expect(decoded.map((d) => d.toXDR('hex'))).toEqual(jsBodies.map((o) => o.body().setOptionsOp().toXDR('hex')));
    // First set_options has the signer + thresholds the issue-1 sentinel cares about.
    expect(decoded[0].masterWeight()).toBe(0);
    expect(decoded[0].signer()?.weight()).toBe(5);
  });

  it('exposes raw destination/source keys as zero-copy views into the ledger bytes', () => {
    const meta = buildLedgerCloseMeta(envelopes);
    const scan = reader.scan(meta, operationMask('createAccount'));
    expect(scan.count).toBe(1);
    scan.forEach((op) => {
      expect(Buffer.from(op.destinationKey()!)).toEqual(kp(3).rawPublicKey());
      expect(Buffer.from(op.sourceKey())).toEqual(kp(2).rawPublicKey());
      // The envelope view is a valid TransactionEnvelope on its own.
      const env = StellarSdk.xdr.TransactionEnvelope.fromXDR(Buffer.from(op.envelope()));
      expect(env.v1().tx().operations()).toHaveLength(5);
    });
  });

  it('scans base64 input directly (the form Horizon/RPC return)', () => {
    const meta = buildLedgerCloseMeta(envelopes);
    const fromB64 = reader.scanBase64(meta.toString('base64'));
    const fromBytes = reader.scan(meta);
    expect(fromB64.toArray()).toEqual(fromBytes.toArray());
    expect(fromB64.header).toEqual(fromBytes.header);
  });
});

describe('xdr-wasm: filtering', () => {
  const meta = buildLedgerCloseMeta(sampleEnvelopes());

  it('returns only the selected operation types but counts every op in the ledger', () => {
    const scan = reader.scan(meta, operationMask('payment', 'createAccount'));
    const types = new Set(scan.toArray().map((o) => o.type));
    expect([...types].sort()).toEqual([OperationType.createAccount, OperationType.payment]);
    expect(scan.header.opTotal).toBe(42);
  });

  it('an empty selection yields no records without error', () => {
    const scan = reader.scan(meta, 0);
    expect(scan.count).toBe(0);
    expect(scan.header.opTotal).toBe(42);
  });

  it('keeps tx/op indexes relative to the whole ledger regardless of the mask', () => {
    const all = wasmOps(meta).operations.filter((o) => o.type === OperationType.invokeHostFunction);
    const only = wasmOps(meta, operationMask('invokeHostFunction')).operations;
    expect(only).toEqual(all);
  });
});

describe('xdr-wasm: robustness', () => {
  const meta = buildLedgerCloseMeta(sampleEnvelopes());

  it('grows the output table transparently for large ledgers (>4096 selected ops)', () => {
    const big = buildLedgerCloseMeta(paymentEnvelopes(2600, 2)); // 5200 ops
    const scan = reader.scan(big, operationMask('payment'));
    expect(scan.count).toBe(5200);
    expect(scan.header.txCount).toBe(2600);
    const js = scanLedgerOperationsJs(big, operationMask('payment'));
    expect(scan.toArray()).toEqual(js.operations);
  });

  it('reports truncated input as an error instead of reading out of bounds', () => {
    // End of the tx set = end of the last envelope; the scanner never reads beyond it.
    const scan = reader.scan(meta);
    let txSetEnd = 0;
    scan.forEach((op) => (txSetEnd = Math.max(txSetEnd, op.txOffset + op.txLength)));

    for (const cut of [0, 3, 4, 50, 200, 1000, txSetEnd - 1]) {
      expect(() => reader.scan(meta.subarray(0, cut)), `cut at ${cut}`).toThrow(XdrReaderError);
    }
  });

  it('never reads past the tx set (txProcessing / upgrades / SCP info are skipped entirely)', () => {
    const scan = reader.scan(meta);
    let txSetEnd = 0;
    scan.forEach((op) => (txSetEnd = Math.max(txSetEnd, op.txOffset + op.txLength)));
    // Everything after the tx set can be missing or garbage and the result is unchanged.
    const expected = reader.scan(meta).toArray();
    expect(reader.scan(meta.subarray(0, txSetEnd)).toArray()).toEqual(expected);
    const garbled = Buffer.from(meta);
    garbled.fill(0xff, txSetEnd);
    expect(reader.scan(garbled).toArray()).toEqual(expected);
  });

  it('rejects unknown LedgerCloseMeta versions', () => {
    const bad = Buffer.from(meta);
    bad.writeUInt32BE(9, 0);
    expect(() => reader.scan(bad)).toThrowError(/unknown LedgerCloseMeta version/);
  });

  it('never crashes or hangs on corrupted input (byte-flip fuzz)', () => {
    let seed = 1234567;
    const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    let errors = 0;
    for (let i = 0; i < 1500; i++) {
      const mutated = Buffer.from(meta);
      for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) {
        mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
      }
      try {
        reader.scan(mutated);
      } catch (err) {
        expect(err).toBeInstanceOf(XdrReaderError);
        errors++;
      }
    }
    expect(errors).toBeGreaterThan(0); // corruption is actually being detected
    // The reader must still work afterwards.
    expect(reader.scan(meta).count).toBe(42);
  });

  it('bounds nesting depth (deeply nested ScVal vec) rather than overflowing the stack', () => {
    // ScVal vec nested 200 deep as the sole argument of an invoke_contract call.
    let val = StellarSdk.xdr.ScVal.scvVoid();
    for (let i = 0; i < 200; i++) val = StellarSdk.xdr.ScVal.scvVec([val]);
    const contract = new StellarSdk.Contract('CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA');
    const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(kp(1).publicKey(), '1'), {
      fee: '100',
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(contract.call('f', val))
      .setTimeout(30)
      .build();
    const nested = buildLedgerCloseMeta([tx.toEnvelope()]);
    expect(() => reader.scan(nested)).toThrowError(/nesting too deep/);
  });

  it('can be reused across thousands of scans without leaking memory', () => {
    const fresh = XdrWasmReader.create();
    const memory = (fresh as unknown as { wasm: { memory: WebAssembly.Memory } }).wasm.memory;
    fresh.scan(meta);
    const after = memory.buffer.byteLength;
    for (let i = 0; i < 3000; i++) fresh.scan(meta, operationMask('payment'));
    expect(memory.buffer.byteLength).toBe(after);
  });
});

describe('scanLedgerOperations facade (wasm with SDK fallback)', () => {
  const meta = buildLedgerCloseMeta(sampleEnvelopes());

  it('uses the wasm engine when the ledger is understood', () => {
    const result = scanLedgerOperations(meta, operationMask('setOptions'));
    expect(result.engine).toBe('wasm');
    expect(result.operations).toHaveLength(5);
    expect(result.header.ledgerSeq).toBe(123456);
  });

  it('accepts base64 strings', () => {
    const result = scanLedgerOperations(meta.toString('base64'), operationMask('payment'));
    expect(result.engine).toBe('wasm');
    expect(result.operations.every((o) => o.typeName === 'payment')).toBe(true);
  });

  it('falls back to the SDK when the wasm reader rejects a shape it does not know', () => {
    // Simulate the wasm reader meeting a shape it doesn't know (e.g. a newer protocol's union arm).
    const bytes = Buffer.from(meta);
    expect(scanLedgerOperations(bytes, operationMask('payment')).engine).toBe('wasm');

    const reject = vi.spyOn(XdrWasmReader.prototype, 'scan').mockImplementation(() => {
      throw new XdrReaderError(-2);
    });
    try {
      const result = scanLedgerOperations(bytes, operationMask('payment'));
      expect(result.engine).toBe('js');
      expect(result.operations.length).toBeGreaterThan(0);
      expect(result.operations.every((o) => o.typeName === 'payment')).toBe(true);
    } finally {
      reject.mockRestore();
    }
  });
});

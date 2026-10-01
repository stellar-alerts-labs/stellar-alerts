import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as StellarSdk from 'stellar-sdk';
import {
  assessRisk,
  computeFootprintDiff,
  decodeEnvelope,
  detectDrainIndicators,
  riskLevelForScore,
  RISK_LEVEL_FLOORS,
  SEVERITY_WEIGHTS,
  simulateTransactionEnvelope,
  toStroops,
  verdictFor,
  type SimulationIndicator,
  type SimulationThresholds,
} from './tx-simulation';

const PASS = StellarSdk.Networks.TESTNET;
const X = StellarSdk.xdr;

/** Deterministic keypairs — a fixed seed keeps every hash assertion stable. */
const SOURCE = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const DEST_A = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const DEST_B = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const UNKNOWN_DEST = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const TRUSTED_CONTRACT = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const UNTRUSTED_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const THRESHOLDS: SimulationThresholds = {
  drainExhaustionRatio: 0.9,
  drainSplitDestinationThreshold: 3,
  dustResidueStroops: 1_000_000n,
  ttlExtensionLedgerThreshold: 2_000_000,
  cpuInstructionThreshold: 100_000_000n,
  maxFootprintEntries: 50,
  pathPaymentAsymmetryRatio: 2,
  footprintExpansionRatio: 3,
};

function ledgerKey(id: number): StellarSdk.xdr.LedgerKey {
  return X.LedgerKey.contractData(
    new X.LedgerKeyContractData({
      contract: new StellarSdk.Address(SOURCE.publicKey()).toScAddress(),
      key: X.ScVal.scvU32(id),
      durability: X.ContractDataDurability.persistent(),
    }),
  );
}

function keyXdr(id: number): string {
  return ledgerKey(id).toXDR('base64');
}

/**
 * `SorobanTransactionData.ext` is an anonymous int-union that the SDK's public
 * `xdr` namespace does not re-export, so the type is recovered from the struct's
 * own field map rather than hard-coding an internal constructor name.
 */
const SOROBAN_DATA_EXT = (
  (X.SorobanTransactionData as unknown as { _fields: Array<[string, unknown]> })._fields.find(
    ([name]) => name === 'ext',
  )?.[1] as new (arm: number) => StellarSdk.xdr.TransactionExt
) ?? null;

function sorobanData(readOnly: number[], readWrite: number[]): StellarSdk.xdr.SorobanTransactionData {
  if (!SOROBAN_DATA_EXT) throw new Error('SorobanTransactionData.ext type not found');
  return new X.SorobanTransactionData({
    ext: new SOROBAN_DATA_EXT(0),
    resources: new X.SorobanResources({
      footprint: new X.LedgerFootprint({
        readOnly: readOnly.map(ledgerKey),
        readWrite: readWrite.map(ledgerKey),
      }),
      instructions: 1_000,
      readBytes: 1_000,
      writeBytes: 1_000,
    }),
    resourceFee: X.Int64.fromString('1000'),
  });
}

interface BuildOptions {
  operations: StellarSdk.Operation[];
  readOnly?: number[];
  readWrite?: number[];
  sequence?: string;
}

/**
 * Builds a real, decodable base64 envelope. Operations go through the normal
 * `TransactionBuilder` path; the Soroban footprint is then grafted onto the
 * raw `Transaction` ext, which is the only way to produce an envelope that
 * actually declares a footprint without a live RPC simulation.
 */
function buildEnvelope(options: BuildOptions): string {
  // `addOperation` takes exactly one operation per call in this SDK version —
  // spreading an array silently keeps only the first, so chain explicitly.
  const builder = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account(SOURCE.publicKey(), options.sequence ?? '1'),
    { fee: StellarSdk.BASE_FEE, networkPassphrase: PASS },
  );
  for (const operation of options.operations) {
    builder.addOperation(operation);
  }
  const tx = builder.setTimeout(30).build();

  // Graft the footprint onto the envelope the builder already produced. This is
  // the only way to get an envelope that genuinely declares a footprint without
  // a live RPC simulation to derive one from.
  const envelope = tx.toEnvelope();
  envelope.v1().tx().ext(
    new X.TransactionExt(1, sorobanData(options.readOnly ?? [], options.readWrite ?? [])),
  );

  return envelope.toXDR('base64');
}

function payment(destination: string, amount: string): StellarSdk.Operation {
  return StellarSdk.Operation.payment({
    destination,
    asset: StellarSdk.Asset.native(),
    amount,
  });
}

function buildFeeBump(innerXdr: string): string {
  return StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    SOURCE,
    '400',
    StellarSdk.TransactionBuilder.fromXDR(innerXdr, PASS) as StellarSdk.Transaction,
    PASS,
  ).toXDR();
}

function codes(indicators: SimulationIndicator[]): string[] {
  return indicators.map((i) => i.code).sort();
}

/* ─────────────────────────── envelope decoding ────────────────────── */

describe('decodeEnvelope', () => {
  it('decodes a classic payment envelope into an account-affecting shape', () => {
    const xdr = buildEnvelope({ operations: [payment(DEST_A, '250.5')] });

    const decoded = decodeEnvelope(xdr, PASS);

    expect(decoded.isFeeBump).toBe(false);
    expect(decoded.sourceAccount).toBe(SOURCE.publicKey());
    expect(decoded.operationCount).toBe(1);
    expect(decoded.signatureCount).toBe(0);
    expect(decoded.hasTimeBounds).toBe(true);
    expect(decoded.outflows).toEqual([
      {
        kind: 'payment',
        destination: DEST_A,
        asset: 'native',
        amountStroops: '2505000000',
        debitsSourceAccount: true,
      },
    ]);
  });

  // Regression: `xdr.Operation` is only `{sourceAccount, body}` — the arm
  // accessors live on `rawOp.body()`. Reading them off the operation itself
  // silently yields `undefined`, which made every Soroban envelope look like it
  // touched no contracts at all.
  it('resolves contract invocations from the operation body union', () => {
    const xdr = buildEnvelope({
      operations: [
        new StellarSdk.Contract(UNTRUSTED_CONTRACT).call(
          'swap',
          StellarSdk.nativeToScVal(1, { type: 'u32' }),
          StellarSdk.nativeToScVal('alpha', { type: 'symbol' }),
        ),
      ],
    });

    const decoded = decodeEnvelope(xdr, PASS);

    expect(decoded.contractInvocations).toEqual([
      {
        hostFunction: 'invokeContract',
        contractId: UNTRUSTED_CONTRACT,
        functionName: 'swap',
        argumentCount: 2,
      },
    ]);
  });

  it('reads the largest extendFootprintTtl target in the envelope', () => {
    const xdr = buildEnvelope({
      operations: [
        StellarSdk.Operation.extendFootprintTtl({ extendTo: 1_500_000 }),
        payment(DEST_A, '1'),
        StellarSdk.Operation.extendFootprintTtl({ extendTo: 9_000_000 }),
      ],
    });

    const decoded = decodeEnvelope(xdr, PASS);

    expect(decoded.ttlExtensions).toEqual({
      operationCount: 2,
      maxExtendToLedger: 9_000_000,
      restoreFootprintOperationCount: 0,
    });
  });

  it('round-trips the declared footprint out of the sorobanData ext', () => {
    const xdr = buildEnvelope({
      operations: [payment(DEST_A, '1')],
      readOnly: [1, 2],
      readWrite: [3],
    });

    const decoded = decodeEnvelope(xdr, PASS);

    expect(decoded.declaredFootprint.readOnly.sort()).toEqual([keyXdr(1), keyXdr(2)]);
    expect(decoded.declaredFootprint.readWrite).toEqual([keyXdr(3)]);
  });

  it('reports an empty declared footprint for a non-Soroban envelope', () => {
    const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(SOURCE.publicKey(), '1'), {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: PASS,
    })
      .addOperation(payment(DEST_A, '1'))
      .setTimeout(30)
      .build();

    expect(decodeEnvelope(tx.toXDR(), PASS).declaredFootprint).toEqual({
      readOnly: [],
      readWrite: [],
    });
  });

  // Regression: the audit identity must be the outer envelope hash, which is
  // what the ledger indexes — the inner transaction hash is a different value.
  it('hashes the outer envelope for a fee bump and keeps the inner hash distinct', () => {
    const innerXdr = buildEnvelope({ operations: [payment(DEST_A, '1')] });
    const inner = decodeEnvelope(innerXdr, PASS);

    const decoded = decodeEnvelope(buildFeeBump(innerXdr), PASS);

    expect(decoded.isFeeBump).toBe(true);
    expect(decoded.txHash).toBe(
      StellarSdk.TransactionBuilder.fromXDR(buildFeeBump(innerXdr), PASS).hash().toString('hex'),
    );
    expect(decoded.innerTxHash).toBe(inner.txHash);
    expect(decoded.txHash).not.toBe(decoded.innerTxHash);
  });

  it('throws rather than reporting a clean bill of health on undecodable XDR', () => {
    expect(() => decodeEnvelope('not-xdr', PASS)).toThrow();
  });

  // `fromXDR` does not verify signatures, so the network passphrase is used for
  // decoding context rather than as a check. Recorded here so the limitation is
  // a tested, documented fact rather than an assumption in the service layer.
  it('decodes an envelope regardless of the passphrase it was built for', () => {
    const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(SOURCE.publicKey(), '1'), {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.PUBLIC,
    })
      .addOperation(payment(DEST_A, '1'))
      .setTimeout(30)
      .build();

    expect(decodeEnvelope(tx.toXDR(), PASS).sourceAccount).toBe(SOURCE.publicKey());
  });
});

/* ──────────────────────────── footprint diff ───────────────────────── */

describe('computeFootprintDiff', () => {
  it('separates undeclared writes from undeclared reads', () => {
    const diff = computeFootprintDiff(
      { readOnly: [keyXdr(1)], readWrite: [keyXdr(2)] },
      { readOnly: [keyXdr(1), keyXdr(3)], readWrite: [keyXdr(2), keyXdr(4)] },
    );

    expect(diff.undeclaredReadWrite).toEqual([keyXdr(4)]);
    expect(diff.undeclaredReadOnly).toEqual([keyXdr(3)]);
    expect(diff.declaredCount).toBe(2);
    expect(diff.accessedCount).toBe(4);
    expect(diff.accessExpansionRatio).toBe(2);
  });

  it('flags declared read-write entries the simulation only read or never touched', () => {
    const diff = computeFootprintDiff(
      { readOnly: [], readWrite: [keyXdr(1), keyXdr(2)] },
      { readOnly: [keyXdr(1)], readWrite: [] },
    );

    // key 1 was declared read-write but only ever read; key 2 was never touched.
    expect(diff.readWriteOverlap).toEqual([keyXdr(1)]);
    expect(diff.unusedReadWrite).toEqual([keyXdr(2)]);
  });

  it('treats a key declared read-only but written as an undeclared write', () => {
    const diff = computeFootprintDiff(
      { readOnly: [keyXdr(1)], readWrite: [] },
      { readOnly: [], readWrite: [keyXdr(1)] },
    );

    expect(diff.undeclaredReadWrite).toEqual([keyXdr(1)]);
  });

  it('de-duplicates and sorts so repeated runs produce identical output', () => {
    const args = { readOnly: [], readWrite: [keyXdr(3), keyXdr(1), keyXdr(1)] };
    const declared = { readOnly: [], readWrite: [keyXdr(2), keyXdr(1), keyXdr(1)] };

    expect(computeFootprintDiff(declared, args)).toEqual(computeFootprintDiff(declared, args));
    expect(computeFootprintDiff(declared, args).accessedReadWrite).toEqual([keyXdr(1), keyXdr(3)]);
  });

  it('does not divide by zero when nothing was declared', () => {
    const diff = computeFootprintDiff({ readOnly: [], readWrite: [] }, { readOnly: [], readWrite: [] });

    expect(diff.declaredCount).toBe(0);
    expect(diff.accessExpansionRatio).toBe(0);
  });

  it('carries archived entries through as a separate list', () => {
    const diff = computeFootprintDiff(
      { readOnly: [], readWrite: [] },
      { readOnly: [], readWrite: [], archived: [keyXdr(9)] },
    );

    expect(diff.archivedEntries).toEqual([keyXdr(9)]);
  });
});

/* ───────────────────────── risk scoring / verdict ──────────────────── */

describe('assessRisk', () => {
  const make = (severity: SimulationIndicator['severity']): SimulationIndicator => ({
    code: `TEST_${severity.toUpperCase()}`,
    category: 'footprint',
    severity,
    title: 't',
    detail: 'd',
    remediation: `fix ${severity}`,
    evidence: {},
  });

  // Regression: a single critical indicator scored 40 while the level floors
  // sat at 70, so a confirmed drain came back as `high`/`review` — a prompt to
  // "have a look" rather than a refusal.
  it('reports and blocks on a single critical indicator at its own severity', () => {
    const risk = assessRisk([make('critical')]);

    expect(risk.score).toBe(40);
    expect(risk.level).toBe('critical');
    expect(risk.verdict).toBe('block');
  });

  it('never reports a lone indicator below its own severity', () => {
    expect(assessRisk([make('low')]).level).toBe('low');
    expect(assessRisk([make('medium')]).level).toBe('medium');
    expect(assessRisk([make('high')]).level).toBe('high');
    expect(assessRisk([make('critical')]).level).toBe('critical');
  });

  it('blocks on a critical reached by accumulation alone', () => {
    const risk = assessRisk([make('high'), make('high'), make('high')]);

    expect(risk.score).toBe(75);
    expect(risk.level).toBe('critical');
    expect(risk.verdict).toBe('block');
  });

  it('caps the score at 100', () => {
    const risk = assessRisk(Array.from({ length: 10 }, () => make('critical')));

    expect(risk.score).toBe(100);
  });

  it('reviews high and medium, allows low and clean', () => {
    expect(assessRisk([make('high')]).verdict).toBe('review');
    expect(assessRisk([make('medium')]).verdict).toBe('review');
    expect(assessRisk([make('low')]).verdict).toBe('allow');
    expect(assessRisk([]).verdict).toBe('allow');
  });

  it('returns an empty breakdown when there is nothing to explain', () => {
    expect(assessRisk([]).breakdown).toEqual([]);
  });

  it('breaks the score down per category and names the worst severity', () => {
    const risk = assessRisk([
      { ...make('critical'), category: 'drain' },
      { ...make('low'), category: 'footprint' },
    ]);

    // Categories come back in the fixed footprint→drain→… order, not in
    // severity order, so the shape of a response is stable across runs.
    expect(risk.breakdown.map((b) => b.category)).toEqual(['footprint', 'drain']);
    expect(risk.breakdown[0]).toMatchObject({ score: 5, worstSeverity: 'low' });
    expect(risk.breakdown[1]).toMatchObject({ score: 40, worstSeverity: 'critical' });
  });

  it('lists each distinct remediation once, worst severity first', () => {
    const risk = assessRisk([
      { ...make('critical'), remediation: 'stop' },
      { ...make('high'), remediation: 'check' },
      { ...make('high'), remediation: 'check' },
      { ...make('low'), remediation: 'tidy' },
    ]);

    expect(risk.recommendations).toEqual(['stop', 'check']);
  });
});

describe('riskLevelForScore', () => {
  // Floors are set equal to the severity weights, so each band starts exactly
  // where a single indicator of that severity lands.
  it.each([
    [0, 'none'],
    [5, 'low'],
    [11, 'low'],
    [12, 'medium'],
    [24, 'medium'],
    [25, 'high'],
    [39, 'high'],
    [40, 'critical'],
    [100, 'critical'],
  ] as const)('maps %i to %s', (score, level) => {
    expect(riskLevelForScore(score)).toBe(level);
  });
});

describe('verdictFor', () => {
  it('blocks on a critical level or a critical indicator', () => {
    expect(verdictFor('critical', 'high')).toBe('block');
    expect(verdictFor('high', 'critical')).toBe('block');
    expect(verdictFor('none', 'critical')).toBe('block');
  });

  it('reviews medium and high without a critical indicator', () => {
    expect(verdictFor('high', 'high')).toBe('review');
    expect(verdictFor('medium', 'medium')).toBe('review');
  });

  it('allows low and clean reports', () => {
    expect(verdictFor('low', 'low')).toBe('allow');
    expect(verdictFor('none', null)).toBe('allow');
  });
});

/* ──────────────────────────── drain detection ─────────────────────── */

describe('detectDrainIndicators', () => {
  function decode(operations: StellarSdk.Operation[]) {
    return decodeEnvelope(buildEnvelope({ operations }), PASS);
  }

  it('flags a sweep that empties the account down to dust', () => {
    const indicators = detectDrainIndicators(
      decode([payment(UNKNOWN_DEST, '998.9998500')]),
      { nativeBalanceStroops: '1000000000', knownRecipients: [DEST_A] },
      THRESHOLDS,
    );

    expect(codes(indicators)).toContain('DRAIN_BALANCE_EXHAUSTION');
  });

  it('stays quiet on a payment well inside the balance', () => {
    const indicators = detectDrainIndicators(
      decode([payment(UNKNOWN_DEST, '1')]),
      { nativeBalanceStroops: '10000000000', knownRecipients: [DEST_A] },
      THRESHOLDS,
    );

    expect(codes(indicators)).not.toContain('DRAIN_BALANCE_EXHAUSTION');
  });

  it('flags one envelope fanning out at or past the recipient threshold', () => {
    const destinations = [
      DEST_A,
      DEST_B,
      StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey(),
    ];

    const indicators = detectDrainIndicators(
      decode(destinations.map((d) => payment(d, '1'))),
      { knownRecipients: [DEST_A] },
      THRESHOLDS,
    );

    expect(codes(indicators)).toContain('DRAIN_MULTI_DESTINATION_SPLIT');
  });

  it('stays quiet below the fan-out threshold', () => {
    const indicators = detectDrainIndicators(
      decode([payment(DEST_A, '1'), payment(DEST_B, '1')]),
      { knownRecipients: [DEST_A, DEST_B] },
      THRESHOLDS,
    );

    expect(codes(indicators)).not.toContain('DRAIN_MULTI_DESTINATION_SPLIT');
  });

  it('flags an account merge as unrecoverable', () => {
    const indicators = detectDrainIndicators(
      decode([StellarSdk.Operation.accountMerge({ destination: UNKNOWN_DEST })]),
      null,
      THRESHOLDS,
    );

    expect(codes(indicators)).toContain('DRAIN_ACCOUNT_MERGE');
  });

  it('skips balance math entirely when no baseline was supplied', () => {
    const indicators = detectDrainIndicators(
      decode([payment(UNKNOWN_DEST, '999999999')]),
      null,
      THRESHOLDS,
    );

    expect(codes(indicators)).not.toContain('DRAIN_BALANCE_EXHAUSTION');
  });
});

/* ──────────────────────────── orchestration ───────────────────────── */

describe('simulateTransactionEnvelope', () => {
  it('blocks an envelope whose simulation writes outside its declared footprint', () => {
    const xdr = buildEnvelope({
      operations: [new StellarSdk.Contract(UNTRUSTED_CONTRACT).call('drain')],
      readOnly: [1],
    });

    const report = simulateTransactionEnvelope({
      envelopeXdr: xdr,
      networkPassphrase: PASS,
      simulation: { readOnlyLedgerKeys: [keyXdr(1)], readWriteLedgerKeys: [keyXdr(7)] },
    });

    expect(report.footprintDiff?.undeclaredReadWrite).toEqual([keyXdr(7)]);
    expect(report.risk.verdict).toBe('block');
    expect(report.risk.indicators.map((i) => i.code)).toContain('FOOTPRINT_UNDECLARED_WRITE');
  });

  it('blocks a drain that also reaches an untrusted contract', () => {
    const xdr = buildEnvelope({
      operations: [payment(UNKNOWN_DEST, '999.9998500')],
    });

    const report = simulateTransactionEnvelope({
      envelopeXdr: xdr,
      networkPassphrase: PASS,
      ledgerBaseline: {
        nativeBalanceStroops: '1000000000',
        knownRecipients: [DEST_A],
        trustedContracts: [TRUSTED_CONTRACT],
      },
    });

    expect(report.risk.verdict).toBe('block');
    expect(report.risk.indicators.map((i) => i.code)).toContain('DRAIN_BALANCE_EXHAUSTION');
  });

  it('allows a small payment to a known recipient', () => {
    const xdr = buildEnvelope({ operations: [payment(DEST_A, '1.0000001')] });

    const report = simulateTransactionEnvelope({
      envelopeXdr: xdr,
      networkPassphrase: PASS,
      ledgerBaseline: {
        nativeBalanceStroops: '1000000000000',
        knownRecipients: [DEST_A],
        trustedContracts: [TRUSTED_CONTRACT],
      },
    });

    expect(report.risk.score).toBe(0);
    expect(report.risk.verdict).toBe('allow');
  });

  it('stays quiet about untrusted contracts when the allow-list was not supplied', () => {
    const xdr = buildEnvelope({
      operations: [new StellarSdk.Contract(UNTRUSTED_CONTRACT).call('swap')],
    });

    const report = simulateTransactionEnvelope({ envelopeXdr: xdr, networkPassphrase: PASS });

    expect(report.risk.indicators.map((i) => i.code)).not.toContain('CONTRACT_UNTRUSTED_TARGET');
  });

  it('reports which surfaces it could actually analyze', () => {
    const xdr = buildEnvelope({ operations: [payment(DEST_A, '1')], readOnly: [1] });

    const bare = simulateTransactionEnvelope({ envelopeXdr: xdr, networkPassphrase: PASS });
    expect(bare.coverage).toEqual({
      footprintDiff: false,
      balanceBaseline: false,
      trustedContractBaseline: false,
      recipientBaseline: false,
    });
    expect(bare.footprintDiff).toBeNull();

    const full = simulateTransactionEnvelope({
      envelopeXdr: xdr,
      networkPassphrase: PASS,
      simulation: { readOnlyLedgerKeys: [keyXdr(1)] },
      ledgerBaseline: {
        nativeBalanceStroops: '1000000000',
        knownRecipients: [DEST_A],
        trustedContracts: [TRUSTED_CONTRACT],
      },
    });
    expect(full.coverage).toEqual({
      footprintDiff: true,
      balanceBaseline: true,
      trustedContractBaseline: true,
      recipientBaseline: true,
    });
  });

  it('honours caller-supplied thresholds over the defaults', () => {
    // 500 XLM out of a 10,000 XLM baseline is 5% of the balance — under the
    // default 90% and the lenient 99%, over a strict 1%.
    const xdr = buildEnvelope({ operations: [payment(UNKNOWN_DEST, '500')] });
    const ledgerBaseline = {
      nativeBalanceStroops: '100000000000',
      knownRecipients: [DEST_A],
    };

    const strict = simulateTransactionEnvelope({
      envelopeXdr: xdr,
      networkPassphrase: PASS,
      ledgerBaseline,
      options: { drainExhaustionRatio: 0.01 },
    });
    const lenient = simulateTransactionEnvelope({
      envelopeXdr: xdr,
      networkPassphrase: PASS,
      ledgerBaseline,
      options: { drainExhaustionRatio: 0.99 },
    });

    expect(strict.risk.indicators.map((i) => i.code)).toContain('DRAIN_BALANCE_EXHAUSTION');
    expect(lenient.risk.indicators.map((i) => i.code)).not.toContain('DRAIN_BALANCE_EXHAUSTION');
  });

  it('is deterministic for the same input', () => {
    const xdr = buildEnvelope({
      operations: [payment(UNKNOWN_DEST, '900')],
      readWrite: [1],
    });
    const input = {
      envelopeXdr: xdr,
      networkPassphrase: PASS,
      simulation: { readOnlyLedgerKeys: [keyXdr(2)], readWriteLedgerKeys: [keyXdr(1), keyXdr(3)] },
      ledgerBaseline: { nativeBalanceStroops: '1000000000', knownRecipients: [DEST_A] },
    };

    expect(simulateTransactionEnvelope(input)).toEqual(simulateTransactionEnvelope(input));
  });
});

describe('toStroops', () => {
  it('converts without losing precision on values a double cannot hold', () => {
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('1')).toBe(10_000_000n);
    // Exactly Int64.max, the largest value a ledger amount can hold. A double
    // cannot represent it, so any float-based implementation lands elsewhere.
    expect(toStroops('922337203685.4775807')).toBe(9_223_372_036_854_775_807n);
  });

  it('truncates rather than rounding sub-stroop precision', () => {
    expect(toStroops('0.00000019')).toBe(1n);
  });

  it('returns zero for input it cannot read', () => {
    expect(toStroops(undefined)).toBe(0n);
    expect(toStroops(null)).toBe(0n);
    expect(toStroops('abc')).toBe(0n);
    expect(toStroops('-5')).toBe(0n);
  });
});

/**
 * The published severity of every indicator is part of this engine's contract:
 * the docs quote it, downstream gates threshold on it, and callers key alerts
 * off it. Nothing about it is derivable from a single envelope, so it is pinned
 * here as an explicit catalogue. A test that hard-codes this table fails on any
 * silent retune; that is the point — a severity change must be a deliberate,
 * reviewed edit rather than a drive-by.
 */
const CATALOGUE: Array<[string, string, string]> = [
  ['FOOTPRINT_UNDECLARED_WRITE', 'footprint', 'critical'],
  ['FOOTPRINT_UNDECLARED_READ', 'footprint', 'medium'],
  ['FOOTPRINT_READ_WRITE_OVERLAP', 'footprint', 'medium'],
  ['FOOTPRINT_UNUSED_WRITE', 'footprint', 'low'],
  ['FOOTPRINT_ACCESS_EXPANSION', 'footprint', 'high'],
  ['FOOTPRINT_ARCHIVE_RESURRECTION', 'footprint', 'medium'],
  ['FOOTPRINT_RESTORE_REQUIRED', 'footprint', 'medium'],
  ['DRAIN_BALANCE_EXHAUSTION', 'drain', 'critical'],
  ['DRAIN_DUST_RESIDUE', 'drain', 'high'],
  ['DRAIN_MULTI_DESTINATION_SPLIT', 'drain', 'high'],
  ['DRAIN_UNKNOWN_RECIPIENT', 'drain', 'medium'],
  ['DRAIN_ASYMMETRIC_PATH_PAYMENT', 'drain', 'high'],
  ['DRAIN_ACCOUNT_MERGE', 'drain', 'high'],
  ['DRAIN_TRUSTLINE_AUTHORIZATION_REVOKED', 'drain', 'high'],
  ['DRAIN_CLAWBACK', 'drain', 'medium'],
  ['AUTH_MASTER_KEY_GRANT', 'authorization', 'critical'],
  ['AUTH_THRESHOLD_CHANGE', 'authorization', 'medium'],
  ['CONTRACT_UNVERIFIED_INTERACTION', 'contract', 'high'],
  ['CONTRACT_COMPOSITION_MULTIPLE', 'contract', 'medium'],
  ['CONTRACT_UNVERIFIED_DEPLOYMENT', 'contract', 'high'],
  ['CONTRACT_TTL_EXTENSION_EXCESSIVE', 'contract', 'medium'],
  ['CONTRACT_RESTORE_FOOTPRINT_OP', 'contract', 'high'],
  ['RESOURCE_CPU_BUDGET_ANOMALY', 'resource', 'medium'],
  ['RESOURCE_FOOTPRINT_SIZE', 'resource', 'low'],
];

describe('indicator catalogue', () => {
  /**
   * Reads the `indicator(...)` call sites out of the engine source and returns
   * them as `[code, category, severity]`. Deriving the actual table from the
   * implementation is what makes the comparison below meaningful: asserting the
   * literal against itself would pass no matter what the engine did.
   */
  function readEngineCatalogue(): Array<[string, string, string]> {
    const source = readFileSync(new URL('./tx-simulation.ts', import.meta.url), 'utf8');
    const call = /indicator\(\s*'([A-Z_]+)',\s*'([a-z]+)',\s*'([a-z]+)'/g;
    return [...source.matchAll(call)].map((m) => [m[1], m[2], m[3]]);
  }

  it('matches the engine call sites exactly, so a retune must be a deliberate edit', () => {
    expect(readEngineCatalogue()).toEqual(CATALOGUE);
  });

  it('has no duplicate codes', () => {
    expect(new Set(CATALOGUE.map(([code]) => code)).size).toBe(CATALOGUE.length);
  });

  it('assigns every code a category and severity the scoring model understands', () => {
    const categories = new Set(['footprint', 'drain', 'authorization', 'contract', 'resource']);
    for (const [code, category, severity] of CATALOGUE) {
      expect(categories.has(category), `${code} category`).toBe(true);
      expect(Object.hasOwn(SEVERITY_WEIGHTS, severity), `${code} severity`).toBe(true);
    }
  });

  it('keeps a level floor equal to its severity weight, so no indicator reads below itself', () => {
    // The engine leans on this identity: RISK_LEVEL_FLOORS is derived from
    // SEVERITY_WEIGHTS, so a lone indicator always scores at its own level.
    expect(RISK_LEVEL_FLOORS).toEqual(SEVERITY_WEIGHTS);
    for (const severity of ['low', 'medium', 'high', 'critical'] as const) {
      expect(riskLevelForScore(SEVERITY_WEIGHTS[severity])).toBe(severity);
    }
  });

  it('never lets added low-severity noise pull the reported level down', () => {
    expect(riskLevelForScore(SEVERITY_WEIGHTS.critical)).toBe('critical');
    expect(
      riskLevelForScore(SEVERITY_WEIGHTS.critical + 5 * SEVERITY_WEIGHTS.low),
    ).toBe('critical');
  });
});

describe('verdictFor', () => {
  it('blocks on the level, and blocks on a critical indicator even at a lower level', () => {
    expect(verdictFor('critical', 'critical')).toBe('block');
    // A critical indicator is worth 40 points, which on its own sits at the
    // `high` floor. Without the critical override this would read `review`.
    expect(verdictFor('high', 'critical')).toBe('block');
  });

  it('reviews high and medium, and allows anything lower', () => {
    expect(verdictFor('high', 'high')).toBe('review');
    expect(verdictFor('medium', 'medium')).toBe('review');
    expect(verdictFor('low', 'low')).toBe('allow');
    expect(verdictFor('none', 'none')).toBe('allow');
  });
});


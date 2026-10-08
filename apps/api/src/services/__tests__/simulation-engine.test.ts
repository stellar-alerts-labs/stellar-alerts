import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMULATION_OPTIONS,
  SimulationEngine,
  analyzeContractInteractions,
  analyzeDrain,
  analyzeEnvelopeIntegrity,
  analyzeFootprintThreats,
  assertScoreReconciliation,
  declaredAccessFor,
  dedupeIndicators,
  diffFootprints,
  footprintContractIds,
  indexFootprint,
  isDeclaredWritable,
  isEmptyFootprint,
  isPrivilegedFunction,
  normalizeFootprint,
  scoreRisk,
  scoreToBand,
  type ContractThresholds,
  type DrainThresholds,
  type FootprintKey,
  type FootprintThreatThresholds,
  type RiskIndicator,
  type SimulationRequest,
  type TransactionFootprint,
} from '../simulation/index';

const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOB = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CAROL = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const DAVE = 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const EVE = 'GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
const FRAUD = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const DRAIN_THRESHOLDS: DrainThresholds = {
  nearTotalOutflowRatio: 0.85,
  fanOutDestinationThreshold: 3,
  sequentialTransferThreshold: 8,
  dustAmountStroops: 10n,
};

const CONTRACT_THRESHOLDS: ContractThresholds = { maxInvocationsPerContract: 5 };

const FOOTPRINT_THRESHOLDS: FootprintThreatThresholds = {
  maxFootprintReadWriteKeys: 64,
  footprintProbeContractThreshold: 5,
};

function key(k: string, access: FootprintKey['access'], contractId?: string): FootprintKey {
  return { key: k, entryType: 'contractData', access, contractId };
}

function fp(partial: Partial<TransactionFootprint>): TransactionFootprint {
  return normalizeFootprint(partial);
}

function codes(indicators: RiskIndicator[]): string[] {
  return indicators.map((i) => i.code);
}

function indicator(
  code: string,
  weight: number,
  category: RiskIndicator['category'],
  severity: RiskIndicator['severity'] = 'medium',
): RiskIndicator {
  return { code, category, severity, weight, title: code, detail: code, remediation: code, evidence: {} };
}

// ── Footprint normalization, indexing, lookup ────────────────────────────────

describe('normalizeFootprint', () => {
  it('defaults every bucket to an empty array', () => {
    expect(normalizeFootprint(undefined)).toEqual({ readOnly: [], readWrite: [], archived: [] });
    expect(normalizeFootprint(null)).toEqual({ readOnly: [], readWrite: [], archived: [] });
  });

  it('treats a missing bucket as empty rather than absent', () => {
    const normalized = normalizeFootprint({ readWrite: [key('a', 'readWrite')] });
    expect(normalized.readOnly).toEqual([]);
    expect(normalized.archived).toEqual([]);
    expect(normalized.readWrite).toHaveLength(1);
  });
});

describe('indexFootprint', () => {
  it('collapses duplicate ids within a footprint', () => {
    // The host treats a repeated key as one access; counting it twice would
    // inflate the diff summary and could trip the read-write ceiling.
    const index = indexFootprint({
      readWrite: [key('a', 'readWrite'), key('a', 'readWrite')],
    });
    expect(index.size).toBe(1);
  });

  it('resolves an ambiguous key to the least-privileged bucket', () => {
    // A key listed in two buckets is malformed input. Indexing it as readOnly
    // (not readWrite) is the safe resolution: the diff then reports a mode
    // change and the write-downgrade rule fires, instead of the ambiguity
    // silently reading as "already declared writable" and hiding a write.
    const index = indexFootprint({
      readWrite: [key('a', 'readWrite')],
      readOnly: [key('a', 'readOnly')],
    });
    expect(index.get('a')!.access).toBe('readOnly');
  });
});

describe('isDeclaredWritable / declaredAccessFor', () => {
  const footprint = fp({ readOnly: [key('ro', 'readOnly')], readWrite: [key('rw', 'readWrite')] });

  it('reports writability for a declared key', () => {
    expect(isDeclaredWritable(footprint, 'rw')).toBe(true);
    expect(isDeclaredWritable(footprint, 'ro')).toBe(false);
    expect(isDeclaredWritable(footprint, 'absent')).toBe(false);
  });

  it('reports the declared access mode for a key', () => {
    expect(declaredAccessFor(footprint, 'ro')).toBe('readOnly');
    expect(declaredAccessFor(footprint, 'rw')).toBe('readWrite');
    expect(declaredAccessFor(footprint, 'absent')).toBeUndefined();
  });
});

describe('isEmptyFootprint', () => {
  it('is true only when every bucket is empty', () => {
    expect(isEmptyFootprint({})).toBe(true);
    expect(isEmptyFootprint({ readOnly: [], readWrite: [], archived: [] })).toBe(true);
    expect(isEmptyFootprint(undefined)).toBe(true);
    expect(isEmptyFootprint({ readWrite: [key('a', 'readWrite')] })).toBe(false);
    expect(isEmptyFootprint({ archived: [key('a', 'archived')] })).toBe(false);
  });
});

describe('footprintContractIds', () => {
  it('deduplicates and sorts contract ids across all buckets', () => {
    const ids = footprintContractIds({
      readOnly: [key('k1', 'readOnly', 'CB')],
      readWrite: [key('k2', 'readWrite', 'CA'), key('k3', 'readWrite', 'CB')],
    });
    expect(ids).toEqual(['CA', 'CB']);
  });
});

// ── Footprint diffing ───────────────────────────────────────────────────────

describe('diffFootprints', () => {
  it('reports no changes for identical footprints', () => {
    const footprint = fp({ readOnly: [key('a', 'readOnly')], readWrite: [key('b', 'readWrite')] });
    const diff = diffFootprints(footprint, footprint);
    expect(diff.summary.missingCount).toBe(0);
    expect(diff.summary.unusedCount).toBe(0);
    expect(diff.summary.modeChangedCount).toBe(0);
    expect(diff.entries.every((e) => e.change === 'unchanged')).toBe(true);
  });

  it('classifies a required-but-undeclared key as missing', () => {
    const diff = diffFootprints(fp({}), fp({ readWrite: [key('contractData:X:1', 'readWrite', FRAUD)] }));
    expect(diff.summary.missingCount).toBe(1);
    expect(diff.entries[0].change).toBe('missing');
    expect(diff.entries[0].requiredAccess).toBe('readWrite');
    expect(diff.entries[0].declaredAccess).toBeUndefined();
  });

  it('classifies a declared-readOnly-but-required-readWrite key as a mode change', () => {
    const diff = diffFootprints(
      fp({ readOnly: [key('contractData:X:1', 'readOnly', FRAUD)] }),
      fp({ readWrite: [key('contractData:X:1', 'readWrite', FRAUD)] }),
    );
    expect(diff.summary.modeChangedCount).toBe(1);
    const entry = diff.entries[0];
    expect(entry.change).toBe('mode_changed');
    expect(entry.declaredAccess).toBe('readOnly');
    expect(entry.requiredAccess).toBe('readWrite');
  });

  it('classifies a declared-but-untouched key as unused', () => {
    const diff = diffFootprints(fp({ readOnly: [key('contractData:X:1', 'readOnly', FRAUD)] }), fp({}));
    expect(diff.summary.unusedCount).toBe(1);
    expect(diff.entries[0].change).toBe('unused');
  });

  it('summarizes counts consistently with the entry list', () => {
    const diff = diffFootprints(
      fp({ readOnly: [key('ro', 'readOnly')], readWrite: [key('rw', 'readWrite')] }),
      // 'rw' moves from the declared readWrite bucket to the required readOnly
      // bucket, and 'extra' is required but never declared.
      fp({ readOnly: [key('ro', 'readOnly'), key('extra', 'readOnly'), key('rw', 'readOnly')] }),
    );
    expect(diff.entries).toHaveLength(3);
    expect(diff.summary.declaredReadOnly).toBe(1);
    expect(diff.summary.declaredReadWrite).toBe(1);
    expect(diff.summary.requiredReadOnly).toBe(3);
    expect(diff.summary.requiredReadWrite).toBe(0);
    expect(diff.summary.modeChangedCount).toBe(1);
    expect(diff.summary.missingCount).toBe(1);
    expect(diff.summary.unusedCount).toBe(0);
  });

  it('orders entries by key so two runs are byte-identical', () => {
    const a = diffFootprints(fp({ readWrite: [key('c', 'readWrite'), key('a', 'readWrite')] }), fp({}));
    const b = diffFootprints(fp({ readWrite: [key('a', 'readWrite'), key('c', 'readWrite')] }), fp({}));
    expect(a.entries.map((e) => e.key)).toEqual(['a', 'c']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('counts distinct contract ids spanned by the declared footprint', () => {
    const diff = diffFootprints(
      fp({ readOnly: [key('k1', 'readOnly', 'CA'), key('k2', 'readOnly', 'CB')] }),
      fp({ readOnly: [key('k1', 'readOnly', 'CA'), key('k2', 'readOnly', 'CB')] }),
    );
    expect(diff.summary.contractIdCount).toBe(2);
  });
});

// ── Footprint threat indicators ─────────────────────────────────────────────

describe('analyzeFootprintThreats', () => {
  it('flags undeclared keys as critical when they must be written', () => {
    const declared = fp({});
    const required = fp({ readWrite: [key('contractData:X:1', 'readWrite', FRAUD)] });
    const found = analyzeFootprintThreats(diffFootprints(declared, required), declared, true, FOOTPRINT_THRESHOLDS);
    const found2 = found.find((i) => i.code === 'UNDECLARED_FOOTPRINT_ACCESS')!;
    expect(found2.severity).toBe('critical');
    expect(found2.evidence.writeDowngradeCount).toBe(1);
  });

  it('flags a read-only declaration over a written key as critical', () => {
    const declared = fp({ readOnly: [key('contractData:X:1', 'readOnly', FRAUD)] });
    const required = fp({ readWrite: [key('contractData:X:1', 'readWrite', FRAUD)] });
    const found = analyzeFootprintThreats(diffFootprints(declared, required), declared, true, FOOTPRINT_THRESHOLDS);
    const hit = found.find((i) => i.code === 'FOOTPRINT_WRITE_DOWNGRADE')!;
    expect(hit.severity).toBe('critical');
    expect(hit.evidence.count).toBe(1);
  });

  it('flags over-permission distinctly from a write downgrade', () => {
    const declared = fp({ readWrite: [key('contractData:X:1', 'readWrite', FRAUD)] });
    const required = fp({ readOnly: [key('contractData:X:1', 'readOnly', FRAUD)] });
    const found = analyzeFootprintThreats(diffFootprints(declared, required), declared, true, FOOTPRINT_THRESHOLDS);
    expect(codes(found)).toContain('FOOTPRINT_OVER_PERMISSION');
    expect(codes(found)).not.toContain('FOOTPRINT_WRITE_DOWNGRADE');
  });

  it('flags unused footprint entries', () => {
    const declared = fp({ readOnly: [key('contractData:X:1', 'readOnly', FRAUD)] });
    const found = analyzeFootprintThreats(diffFootprints(declared, fp({})), declared, true, FOOTPRINT_THRESHOLDS);
    expect(codes(found)).toContain('UNUSED_FOOTPRINT_ENTRIES');
  });

  it('flags a declared read-write footprint above the ceiling', () => {
    const readWrite = Array.from({ length: 65 }, (_, i) => key(`k${i}`, 'readWrite', FRAUD));
    const declared = fp({ readWrite });
    const found = analyzeFootprintThreats(diffFootprints(declared, declared), declared, true, FOOTPRINT_THRESHOLDS);
    const hit = found.find((i) => i.code === 'UNBOUNDED_FOOTPRINT_GROWTH')!;
    expect(hit.severity).toBe('high');
    expect(hit.evidence.declaredReadWrite).toBe(65);
  });

  it('stays quiet for a footprint exactly at the ceiling', () => {
    const readWrite = Array.from({ length: 64 }, (_, i) => key(`k${i}`, 'readWrite', FRAUD));
    const declared = fp({ readWrite });
    const found = analyzeFootprintThreats(diffFootprints(declared, declared), declared, true, FOOTPRINT_THRESHOLDS);
    expect(codes(found)).not.toContain('UNBOUNDED_FOOTPRINT_GROWTH');
  });

  it('flags a footprint spanning many contracts as probing', () => {
    const ids = ['CA', 'CB', 'CC', 'CD', 'CE'].map((s) => `${s}${'A'.repeat(54)}`);
    const readOnly = ids.map((id, i) => key(`contractData:${id}:${i}`, 'readOnly', id));
    const declared = fp({ readOnly });
    const found = analyzeFootprintThreats(diffFootprints(declared, declared), declared, true, FOOTPRINT_THRESHOLDS);
    expect(codes(found)).toContain('FOOTPRINT_KEY_PROBING');
  });

  it('flags an empty declared footprint only when a contract is invoked', () => {
    const empty = fp({});
    const diff = diffFootprints(empty, empty);
    expect(codes(analyzeFootprintThreats(diff, empty, true, FOOTPRINT_THRESHOLDS))).toContain(
      'EMPTY_FOOTPRINT_WITH_INVOCATION',
    );
    expect(codes(analyzeFootprintThreats(diff, empty, false, FOOTPRINT_THRESHOLDS))).not.toContain(
      'EMPTY_FOOTPRINT_WITH_INVOCATION',
    );
  });

  it('does not flag a footprint that was simply never supplied', () => {
    // A classic payment declares no Soroban footprint and that is legitimate;
    // reporting it as footprint-avoidance would fire on every non-Soroban
    // envelope.
    const diff = diffFootprints(undefined, fp({}));
    expect(codes(analyzeFootprintThreats(diff, undefined, true, FOOTPRINT_THRESHOLDS))).not.toContain(
      'EMPTY_FOOTPRINT_WITH_INVOCATION',
    );
  });

  it('flags archived keys harder when they are not actually required', () => {
    const used = fp({ archived: [key('contractData:X:1', 'archived', FRAUD)] });
    const usedCodes = codes(
      analyzeFootprintThreats(diffFootprints(used, used), used, true, FOOTPRINT_THRESHOLDS),
    );
    expect(usedCodes).toContain('ARCHIVED_KEY_ACCESS');

    const unexpected = analyzeFootprintThreats(diffFootprints(used, fp({})), used, true, FOOTPRINT_THRESHOLDS);
    const hit = unexpected.find((i) => i.code === 'ARCHIVED_KEY_ACCESS')!;
    expect(hit.severity).toBe('high');
  });
});

// ── Drain detection ─────────────────────────────────────────────────────────

function drain(
  operations: SimulationRequest['operations'],
  preState: SimulationRequest['preState'],
  postState?: SimulationRequest['postState'],
  thresholds: DrainThresholds = DRAIN_THRESHOLDS,
) {
  return analyzeDrain(ALICE, operations, preState, postState, thresholds);
}

describe('analyzeDrain', () => {
  it('produces no indicators when there is no post state to compare against', () => {
    const result = drain(
      [{ kind: 'pay', destination: BOB, amount: '100' }],
      [{ accountId: ALICE, nativeBalance: '100' }],
    );
    expect(result.indicators).toHaveLength(0);
    expect(result.analysis.drainedAssets).toHaveLength(0);
    expect(result.analysis.totalOutflowStroops).toBe('0');
  });

  it('flags a full native drain', () => {
    const result = drain(
      [{ kind: 'pay', destination: BOB, amount: '100' }],
      [{ accountId: ALICE, nativeBalance: '100' }],
      [{ accountId: ALICE, nativeBalance: '0' }],
    );
    expect(result.analysis.drainedAssets).toEqual(['native']);
    const flow = result.analysis.flows[0];
    expect(flow.outflowStroops).toBe('1000000000');
    expect(flow.outflowPercent).toBe('100.00');
    expect(flow.drained).toBe(true);
    expect(codes(result.indicators)).toContain('FULL_BALANCE_DRAIN');
  });

  it('flags a near-total but incomplete drain with the near-total code', () => {
    const result = drain(
      [{ kind: 'pay', destination: BOB, amount: '90' }],
      [{ accountId: ALICE, nativeBalance: '100' }],
      [{ accountId: ALICE, nativeBalance: '10' }],
    );
    expect(codes(result.indicators)).toContain('NEAR_TOTAL_BALANCE_OUTFLOW');
    expect(result.analysis.flows[0].drained).toBe(true);
  });

  it('stays quiet for a transfer well below the drain ratio', () => {
    const result = drain(
      [{ kind: 'pay', destination: BOB, amount: '10' }],
      [{ accountId: ALICE, nativeBalance: '100' }],
      [{ accountId: ALICE, nativeBalance: '90' }],
    );
    expect(result.analysis.drainedAssets).toHaveLength(0);
    expect(result.indicators).toHaveLength(0);
  });

  it('honors a custom outflow ratio threshold', () => {
    const ops = [{ kind: 'pay' as const, destination: BOB, amount: '50' }];
    const pre = [{ accountId: ALICE, nativeBalance: '100' }];
    const post = [{ accountId: ALICE, nativeBalance: '50' }];
    expect(drain(ops, pre, post, DRAIN_THRESHOLDS).analysis.drainedAssets).toHaveLength(0);
    expect(
      drain(ops, pre, post, { ...DRAIN_THRESHOLDS, nearTotalOutflowRatio: 0.4 }).analysis.drainedAssets,
    ).toHaveLength(1);
  });

  it('never reports a negative outflow for an account that only receives', () => {
    // A negative outflow would net against a sibling asset's drain and shrink it.
    const result = drain(
      [{ kind: 'pay', source: BOB, destination: ALICE, amount: '10' }],
      [{ accountId: ALICE, nativeBalance: '100' }],
      [{ accountId: ALICE, nativeBalance: '110' }],
    );
    expect(result.analysis.totalOutflowStroops).toBe('0');
    expect(result.analysis.drainedAssets).toHaveLength(0);
  });

  it('flags a full account merge', () => {
    const result = drain(
      [{ kind: 'accountMerge', destination: BOB }],
      [{ accountId: ALICE, nativeBalance: '100' }],
      [{ accountId: ALICE, nativeBalance: '0' }],
    );
    expect(codes(result.indicators)).toContain('ACCOUNT_MERGE_SWEEP');
  });

  it('flags fan-out to distinct destinations', () => {
    const result = drain(
      [
        { kind: 'pay', destination: BOB, amount: '10' },
        { kind: 'pay', destination: CAROL, amount: '10' },
        { kind: 'pay', destination: DAVE, amount: '10' },
        { kind: 'pay', destination: EVE, amount: '10' },
      ],
      [{ accountId: ALICE, nativeBalance: '100' }],
      [{ accountId: ALICE, nativeBalance: '60' }],
    );
    expect(codes(result.indicators)).toContain('DESTINATION_FAN_OUT');
    expect(result.analysis.destinations).toHaveLength(4);
  });

  it('does not flag repeated payments to one destination as fan-out', () => {
    const result = drain(
      Array.from({ length: 6 }, () => ({ kind: 'pay' as const, destination: BOB, amount: '1' })),
      [{ accountId: ALICE, nativeBalance: '100' }],
      [{ accountId: ALICE, nativeBalance: '94' }],
    );
    expect(codes(result.indicators)).not.toContain('DESTINATION_FAN_OUT');
  });

  it('flags a burst of sequential transfers at the threshold', () => {
    const result = drain(
      Array.from({ length: 8 }, () => ({ kind: 'pay' as const, destination: BOB, amount: '1' })),
      [{ accountId: ALICE, nativeBalance: '100' }],
      [{ accountId: ALICE, nativeBalance: '92' }],
    );
    expect(codes(result.indicators)).toContain('UNBOUNDED_SEQUENTIAL_TRANSFERS');
  });

  it('flags a round trip through an intermediate account', () => {
    const result = drain(
      [
        { kind: 'pay', destination: BOB, amount: '50' },
        { kind: 'pay', source: BOB, destination: CAROL, amount: '50' },
      ],
      [{ accountId: ALICE, nativeBalance: '100' }, { accountId: BOB, nativeBalance: '0' }],
      [{ accountId: ALICE, nativeBalance: '50' }, { accountId: BOB, nativeBalance: '0' }],
    );
    expect(codes(result.indicators)).toContain('ROUND_TRIP_SELF_DEAL');
  });

  it('flags a clawback as an outgoing transfer', () => {
    const asset = { type: 'credit_alphanumeric' as const, code: 'USDC', issuer: ALICE };
    const result = drain(
      [{ kind: 'clawback', destination: BOB, asset }],
      [{ accountId: ALICE, balances: [{ asset, balance: '500' }] }],
      [{ accountId: ALICE, balances: [{ asset, balance: '0' }] }],
    );
    expect(result.analysis.drainedAssets).toHaveLength(1);
  });

  it('flags a revocation that empties a revocable balance', () => {
    const asset = { type: 'credit_alphanumeric' as const, code: 'USDC', issuer: CAROL };
    const result = drain(
      [
        {
          kind: 'setTrustlineFlags',
          destination: BOB,
          trustlineAsset: asset,
          trustlineFlagMask: 1,
        },
      ],
      [{ accountId: ALICE, balances: [{ asset, balance: '250', revocable: true }] }],
      [{ accountId: ALICE, balances: [{ asset, balance: '0', revocable: true }] }],
    );
    expect(codes(result.indicators)).toContain('REVOCABLE_ASSET_TRANSFER');
  });

  it('flags dust as an indicator without calling it a full drain', () => {
    const result = drain(
      [{ kind: 'pay', destination: BOB, amount: '0.0000001' }],
      [{ accountId: ALICE, nativeBalance: '0.0000005' }],
      [{ accountId: ALICE, nativeBalance: '0.0000004' }],
    );
    expect(codes(result.indicators)).toContain('DUST_AMOUNT_TRANSFER');
    expect(result.analysis.drainedAssets).toHaveLength(0);
  });

  it('tracks distinct assets independently', () => {
    const usdc = { type: 'credit_alphanumeric' as const, code: 'USDC', issuer: CAROL };
    const result = drain(
      [{ kind: 'pay', destination: BOB, asset: { type: 'native' }, amount: '100' }],
      [
        {
          accountId: ALICE,
          nativeBalance: '100',
          balances: [{ asset: usdc, balance: '100' }],
        },
      ],
      [{ accountId: ALICE, nativeBalance: '0', balances: [{ asset: usdc, balance: '100' }] }],
    );
    // Only the native asset drained; the untouched USDC balance must not be
    // swept into the finding.
    expect(result.analysis.drainedAssets).toEqual(['native']);
  });
});

// ── Contract trust ──────────────────────────────────────────────────────────

function contracts(
  operations: SimulationRequest['operations'],
  contractsSnapshot?: SimulationRequest['contracts'],
  registry?: Parameters<typeof analyzeContractInteractions>[4],
  auth?: Parameters<typeof analyzeContractInteractions>[5],
  thresholds: ContractThresholds = CONTRACT_THRESHOLDS,
) {
  return analyzeContractInteractions(ALICE, operations, contractsSnapshot, registry, auth, thresholds);
}

describe('isPrivilegedFunction', () => {
  it('recognizes common privileged entry points', () => {
    expect(isPrivilegedFunction('set_admin')).toBe(true);
    expect(isPrivilegedFunction('upgrade')).toBe(true);
    expect(isPrivilegedFunction(undefined)).toBe(false);
    expect(isPrivilegedFunction('transfer')).toBe(false);
  });
});

describe('analyzeContractInteractions', () => {
  it('flags an invocation of an unverified contract', () => {
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'withdraw' }],
      [{ contractId: FRAUD, wasmHash: 'abc', deployed: true }],
    );
    expect(result.analysis.unverifiableContracts).toContain(FRAUD);
    expect(codes(result.indicators)).toContain('UNVERIFIED_CONTRACT_INVOCATION');
  });

  it('does not flag a contract on the operator allowlist', () => {
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'swap' }],
      [{ contractId: FRAUD }],
      { allowlist: [FRAUD] },
    );
    expect(result.analysis.unverifiableContracts).toHaveLength(0);
    expect(codes(result.indicators)).not.toContain('UNVERIFIED_CONTRACT_INVOCATION');
  });

  it('does not flag a contract the registry marks verified', () => {
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'swap' }],
      [{ contractId: FRAUD }],
      { byContractId: { [FRAUD]: { contractId: FRAUD, verified: true } } },
    );
    expect(result.analysis.unverifiableContracts).toHaveLength(0);
  });

  it('flags a deployed code hash that disagrees with the registry', () => {
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'swap' }],
      [{ contractId: FRAUD, wasmHash: 'onchain-hash', deployed: true }],
      { byContractId: { [FRAUD]: { contractId: FRAUD, verified: true, wasmHash: 'registry-hash' } } },
    );
    expect(codes(result.indicators)).toContain('CONTRACT_CODE_HASH_MISMATCH');
    expect(result.analysis.codeHashMismatches).toContain(FRAUD);
  });

  it('flags an authenticated privileged call', () => {
    // Without auth the stronger PRIVILEGED_FUNCTION_WITHOUT_AUTH fires instead;
    // this rule covers the reviewable case where a valid auth entry is present.
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'set_admin' }],
      [{ contractId: FRAUD }],
      undefined,
      [{ credentialsAddress: ALICE, contractId: FRAUD, function: 'set_admin' }],
    );
    expect(codes(result.indicators)).toContain('PRIVILEGED_CONTRACT_FUNCTION');
  });

  it('prefers the unauthenticated variant when auth is absent', () => {
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'set_admin' }],
      [{ contractId: FRAUD }],
    );
    const found = codes(result.indicators);
    expect(found).toContain('PRIVILEGED_FUNCTION_WITHOUT_AUTH');
    expect(found).not.toContain('PRIVILEGED_CONTRACT_FUNCTION');
  });

  it('flags a privileged function invoked with an empty auth list', () => {
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'set_admin' }],
      [{ contractId: FRAUD }],
      undefined,
      [],
    );
    const hit = result.indicators.find((i) => i.code === 'PRIVILEGED_FUNCTION_WITHOUT_AUTH')!;
    expect(hit.severity).toBe('critical');
  });

  it('does not flag a privileged function that has matching auth', () => {
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'set_admin' }],
      [{ contractId: FRAUD }],
      undefined,
      [{ credentialsAddress: ALICE, contractId: FRAUD, function: 'set_admin' }],
    );
    expect(codes(result.indicators)).not.toContain('PRIVILEGED_FUNCTION_WITHOUT_AUTH');
  });

  it('flags a contract deployed and invoked in the same envelope', () => {
    const result = contracts(
      [
        { kind: 'createContract', contractId: FRAUD },
        { kind: 'invokeContract', contractId: FRAUD, function: 'withdraw' },
      ],
      [{ contractId: FRAUD, deployed: true }],
    );
    expect(codes(result.indicators)).toContain('NEWLY_DEPLOYED_CONTRACT_INVOKED');
  });

  it('flags an invocation burst against a single contract', () => {
    const result = contracts(
      Array.from({ length: 6 }, () => ({ kind: 'invokeContract' as const, contractId: FRAUD, function: 'withdraw' })),
      [{ contractId: FRAUD }],
    );
    expect(codes(result.indicators)).toContain('INVOCATION_FAN_OUT');
  });

  it('fires the fan-out rule exactly at the invocation ceiling', () => {
    // The documented contract is "invocations ... that count as fan-out", so the
    // threshold is inclusive: maxInvocationsPerContract: 5 fires at 5.
    const result = contracts(
      Array.from({ length: 5 }, () => ({ kind: 'invokeContract' as const, contractId: FRAUD, function: 'withdraw' })),
      [{ contractId: FRAUD }],
    );
    expect(codes(result.indicators)).toContain('INVOCATION_FAN_OUT');
  });

  it('stays quiet one invocation below the ceiling', () => {
    const result = contracts(
      Array.from({ length: 4 }, () => ({ kind: 'invokeContract' as const, contractId: FRAUD, function: 'withdraw' })),
      [{ contractId: FRAUD }],
    );
    expect(codes(result.indicators)).not.toContain('INVOCATION_FAN_OUT');
  });

  it('flags invocation of a contract recorded as not deployed', () => {
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'withdraw' }],
      [{ contractId: FRAUD, deployed: false }],
    );
    expect(codes(result.indicators)).toContain('CONTRACT_NOT_DEPLOYED');
  });

  it('flags invocation of an archived contract', () => {
    const result = contracts(
      [{ kind: 'invokeContract', contractId: FRAUD, function: 'withdraw' }],
      [{ contractId: FRAUD, codeArchived: true }],
    );
    expect(codes(result.indicators)).toContain('INVOCATION_OF_ARCHIVED_CONTRACT');
  });

  it('reports nothing for an envelope with no contract interaction', () => {
    const result = contracts([]);
    expect(result.indicators).toHaveLength(0);
    expect(result.analysis.interactions).toHaveLength(0);
  });
});

// ── Envelope integrity ──────────────────────────────────────────────────────

function integrity(input: Parameters<typeof analyzeEnvelopeIntegrity>[0]) {
  return analyzeEnvelopeIntegrity({ sourceAccount: ALICE, ...input });
}

describe('analyzeEnvelopeIntegrity', () => {
  it('flags an envelope that was never simulated', () => {
    const found = integrity({ operations: [{ kind: 'pay' }], hasInvocation: false, simulated: false });
    expect(codes(found)).toContain('NO_SIMULATION_RESULT');
  });

  it('does not flag a simulated envelope as unsimulated', () => {
    const found = integrity({ operations: [{ kind: 'pay' }], hasInvocation: false, simulated: true });
    expect(codes(found)).not.toContain('NO_SIMULATION_RESULT');
  });

  it('flags a reverted simulation', () => {
    const found = integrity({
      operations: [{ kind: 'pay' }],
      hasInvocation: false,
      simulated: true,
      outcome: { success: false, errors: [{ type: 'invocation_error', message: 'boom' }] },
    });
    expect(codes(found)).toContain('SIMULATION_REVERTED');
  });

  it('flags host errors raised during a nominally successful simulation', () => {
    const found = integrity({
      operations: [{ kind: 'invokeContract', contractId: FRAUD }],
      hasInvocation: true,
      simulated: true,
      outcome: { success: true, errors: [{ type: 'host_error', message: 'budget exceeded' }] },
    });
    expect(codes(found)).toContain('SIMULATION_HOST_ERRORS');
  });

  it('flags a missing time bound', () => {
    const found = integrity({
      operations: [{ kind: 'pay' }],
      hasInvocation: false,
      simulated: true,
      resources: { hasTimeBounds: false, ledgerBounds: { min: 1, max: 2 } },
    });
    expect(codes(found)).toContain('MISSING_TIME_BOUNDS');
  });

  it('flags unbounded resource limits only when resources were described', () => {
    expect(
      codes(
        integrity({
          operations: [{ kind: 'pay' }],
          hasInvocation: false,
          simulated: true,
          resources: { ledgerBounds: null },
        }),
      ),
    ).toContain('UNBOUNDED_RESOURCE_LIMITS');

    expect(
      codes(integrity({ operations: [{ kind: 'pay' }], hasInvocation: false, simulated: true })),
    ).not.toContain('UNBOUNDED_RESOURCE_LIMITS');
  });

  it('flags a zero ledger bounds maximum', () => {
    const found = integrity({
      operations: [{ kind: 'invokeContract', contractId: FRAUD }],
      hasInvocation: true,
      simulated: true,
      resources: { ledgerBounds: { min: 0, max: 0 } },
    });
    expect(codes(found)).toContain('ZERO_RESOURCE_LIMITS');
  });

  it('flags a zero fee on an envelope that performs contract work', () => {
    const found = integrity({
      operations: [{ kind: 'invokeContract', contractId: FRAUD }],
      hasInvocation: true,
      simulated: true,
      resources: { ledgerBounds: { min: 1, max: 2 }, feeStroops: '0' },
    });
    expect(codes(found)).toContain('ZERO_FEE_SOROBAN_ENVELOPE');
  });

  it('does not mistake the minimum real fee for a zero fee', () => {
    // Regression: `Number.parseInt('0.00001')` returns 0, so a decimal stroop
    // string must be parsed exactly. 0.00001 == 100 stroops, a real fee.
    const found = integrity({
      operations: [{ kind: 'invokeContract', contractId: FRAUD }],
      hasInvocation: true,
      simulated: true,
      resources: { ledgerBounds: { min: 1, max: 2 }, feeStroops: '0.00001' },
    });
    expect(codes(found)).not.toContain('ZERO_FEE_SOROBAN_ENVELOPE');
  });
});

// ── Scoring ─────────────────────────────────────────────────────────────────

describe('dedupeIndicators', () => {
  it('keeps only the first occurrence of a repeated code', () => {
    const first = indicator('X', 1, 'drain', 'low');
    const second = indicator('X', 40, 'drain', 'critical');
    const result = dedupeIndicators([first, second, first]);
    expect(result).toHaveLength(1);
    expect(result[0].weight).toBe(1);
  });

  it('preserves the original order of first occurrences', () => {
    const result = dedupeIndicators([
      indicator('A', 1, 'drain'),
      indicator('B', 1, 'footprint'),
      indicator('A', 1, 'contract'),
    ]);
    expect(codes(result)).toEqual(['A', 'B']);
  });
});

describe('scoreToBand', () => {
  it('maps score boundaries onto bands', () => {
    expect(scoreToBand(0)).toBe('SAFE');
    expect(scoreToBand(19)).toBe('SAFE');
    expect(scoreToBand(20)).toBe('LOW');
    expect(scoreToBand(39)).toBe('LOW');
    expect(scoreToBand(40)).toBe('MODERATE');
    expect(scoreToBand(59)).toBe('MODERATE');
    expect(scoreToBand(60)).toBe('HIGH');
    expect(scoreToBand(79)).toBe('HIGH');
    expect(scoreToBand(80)).toBe('CRITICAL');
    expect(scoreToBand(100)).toBe('CRITICAL');
  });

  it('clamps out-of-range scores into the valid band range', () => {
    expect(scoreToBand(-5)).toBe('SAFE');
    expect(scoreToBand(1000)).toBe('CRITICAL');
    expect(scoreToBand(45.9)).toBe('MODERATE');
  });
});

describe('scoreRisk', () => {
  it('returns a SAFE zero assessment for no indicators', () => {
    const risk = scoreRisk([]);
    expect(risk.score).toBe(0);
    expect(risk.band).toBe('SAFE');
    expect(risk.blockExecution).toBe(false);
    expect(risk.breakdown).toHaveLength(0);
    expect(risk.actions).toHaveLength(0);
    expect(risk.summary).toContain('no drain');
  });

  it('sums indicator weights', () => {
    const risk = scoreRisk([
      indicator('A', 10, 'drain'),
      indicator('B', 20, 'footprint'),
      indicator('C', 15, 'contract'),
    ]);
    expect(risk.score).toBe(45);
    expect(risk.band).toBe('MODERATE');
  });

  it('caps the score at 100 however many indicators fire', () => {
    const risk = scoreRisk(Array.from({ length: 20 }, (_, i) => indicator(`C${i}`, 30, 'drain')));
    expect(risk.score).toBe(100);
    expect(risk.band).toBe('CRITICAL');
  });

  it('deduplicates by indicator code before scoring', () => {
    const risk = scoreRisk([indicator('A', 30, 'drain'), indicator('A', 30, 'drain')]);
    expect(risk.score).toBe(30);
  });

  it('sets blockExecution at or above the threshold', () => {
    expect(scoreRisk([indicator('A', 60, 'drain')]).blockExecution).toBe(false);
    expect(scoreRisk([indicator('A', 79, 'drain')]).blockExecution).toBe(false);
    expect(scoreRisk([indicator('A', 80, 'drain')]).blockExecution).toBe(true);
  });

  it('honors a custom block threshold and reports it', () => {
    const risk = scoreRisk([indicator('A', 20, 'drain')], { blockThreshold: 10 });
    expect(risk.blockThreshold).toBe(10);
    expect(risk.blockExecution).toBe(true);
  });

  it('groups the breakdown by category with per-category scores', () => {
    const risk = scoreRisk([
      indicator('A', 30, 'drain'),
      indicator('B', 10, 'drain'),
      indicator('C', 25, 'footprint'),
    ]);
    const drain = risk.breakdown.find((b) => b.category === 'drain')!;
    expect(drain.score).toBe(40);
    expect(drain.codes).toEqual(['A', 'B']);
    expect(drain.indicatorCount).toBe(2);
    const footprint = risk.breakdown.find((b) => b.category === 'footprint')!;
    expect(footprint.score).toBe(25);
  });

  it('orders the breakdown by score descending', () => {
    const risk = scoreRisk([
      indicator('A', 5, 'contract'),
      indicator('B', 40, 'drain'),
      indicator('C', 20, 'footprint'),
    ]);
    expect(risk.breakdown.map((b) => b.category)).toEqual(['drain', 'footprint', 'contract']);
  });

  it('reports a share percentage per category', () => {
    const risk = scoreRisk([indicator('A', 25, 'drain'), indicator('B', 25, 'footprint')]);
    expect(risk.breakdown.find((b) => b.category === 'drain')!.sharePercent).toBe('50.00');
  });

  it('counts indicators by severity', () => {
    const risk = scoreRisk([
      indicator('A', 40, 'drain', 'critical'),
      indicator('B', 25, 'drain', 'high'),
      indicator('C', 5, 'drain', 'low'),
    ]);
    expect(risk.severityCounts.critical).toBe(1);
    expect(risk.severityCounts.high).toBe(1);
    expect(risk.severityCounts.low).toBe(1);
    expect(risk.severityCounts.medium).toBe(0);
  });

  it('emits de-duplicated remediation actions most severe first', () => {
    const shared = { ...indicator('A', 40, 'drain', 'critical'), remediation: 'block it' };
    const risk = scoreRisk([shared, { ...indicator('B', 5, 'drain', 'low'), remediation: 'block it' }]);
    expect(risk.actions).toEqual(['block it']);
  });

  it('keeps the breakdown reconcilable with the headline score', () => {
    const risk = scoreRisk([
      indicator('A', 40, 'drain'),
      indicator('B', 40, 'footprint'),
      indicator('C', 40, 'contract'),
    ]);
    expect(risk.score).toBe(100);
    // Category sum exceeds the capped headline by design.
    expect(risk.breakdown.reduce((sum, b) => sum + b.score, 0)).toBe(120);
    expect(assertScoreReconciliation(risk)).toBe(true);
  });

  it('reconciles exactly when the score is under the cap', () => {
    const risk = scoreRisk([indicator('A', 30, 'drain'), indicator('B', 20, 'footprint')]);
    expect(risk.score).toBe(50);
    expect(risk.breakdown.reduce((sum, b) => sum + b.score, 0)).toBe(50);
    expect(assertScoreReconciliation(risk)).toBe(true);
  });
});

// ── Engine orchestration ────────────────────────────────────────────────────

describe('SimulationEngine', () => {
  const engine = new SimulationEngine();

  const benignRequest: SimulationRequest = {
    sourceAccount: ALICE,
    network: 'PUBLIC',
    label: 'rent payment',
    operations: [{ kind: 'pay', source: ALICE, destination: BOB, asset: { type: 'native' }, amount: '10' }],
    resources: { hasTimeBounds: true, ledgerBounds: { min: 100, max: 200 }, feeStroops: '0.00001' },
    preState: [{ accountId: ALICE, nativeBalance: '100' }],
    postState: [{ accountId: ALICE, nativeBalance: '90' }],
    outcome: { success: true, ledger: 12345 },
  };

  it('scores a benign simulated transfer as SAFE or LOW', () => {
    const report = engine.simulate(benignRequest);
    expect(['SAFE', 'LOW']).toContain(report.risk.band);
    expect(report.risk.blockExecution).toBe(false);
  });

  it('echoes the envelope identity into the report', () => {
    const report = engine.simulate(benignRequest);
    expect(report.sourceAccount).toBe(ALICE);
    expect(report.network).toBe('PUBLIC');
    expect(report.label).toBe('rent payment');
    expect(report.meta.simulated).toBe(true);
    expect(report.meta.simulationSucceeded).toBe(true);
    expect(report.meta.operationCount).toBe(1);
  });

  it('produces a timestamped report', () => {
    const report = engine.simulate(benignRequest);
    expect(Number.isNaN(Date.parse(report.analyzedAt))).toBe(false);
  });

  it('scores a full drain well above a partial one', () => {
    const full = engine.simulate({
      ...benignRequest,
      operations: [{ kind: 'pay', source: ALICE, destination: BOB, amount: '100' }],
      postState: [{ accountId: ALICE, nativeBalance: '0' }],
    });
    const partial = engine.simulate({
      ...benignRequest,
      operations: [{ kind: 'pay', source: ALICE, destination: BOB, amount: '90' }],
      postState: [{ accountId: ALICE, nativeBalance: '10' }],
    });
    expect(codes(full.indicators)).toContain('FULL_BALANCE_DRAIN');
    expect(codes(partial.indicators)).toContain('NEAR_TOTAL_BALANCE_OUTFLOW');
    expect(full.risk.score).toBeGreaterThan(partial.risk.score);
  });

  it('marks an unsimulated envelope as a lower bound', () => {
    const report = engine.simulate({
      sourceAccount: ALICE,
      operations: [{ kind: 'pay', source: ALICE, destination: BOB, amount: '10' }],
      preState: [{ accountId: ALICE, nativeBalance: '100' }],
    });
    expect(report.meta.simulated).toBe(false);
    expect(report.meta.hasBalanceDiff).toBe(false);
    expect(codes(report.indicators)).toContain('NO_SIMULATION_RESULT');
  });

  it('falls back to the simulation result balances for the post state', () => {
    const report = engine.simulate({
      sourceAccount: ALICE,
      operations: [{ kind: 'pay', source: ALICE, destination: BOB, amount: '100' }],
      preState: [{ accountId: ALICE, nativeBalance: '100' }],
      outcome: { success: true, resultingBalances: [{ accountId: ALICE, nativeBalance: '0' }] },
    });
    expect(report.meta.hasBalanceDiff).toBe(true);
    expect(codes(report.indicators)).toContain('FULL_BALANCE_DRAIN');
  });

  it('reports a null footprint for a non-Soroban envelope', () => {
    expect(engine.simulate(benignRequest).footprint).toBeNull();
  });

  it('diffs the footprint when either side is present', () => {
    const report = engine.simulate({
      ...benignRequest,
      resources: {
        footprint: { readOnly: [key('contractData:X:1', 'readOnly', FRAUD)] },
        requiredFootprint: { readWrite: [key('contractData:X:1', 'readWrite', FRAUD)] },
      },
    });
    expect(report.footprint!.summary.modeChangedCount).toBe(1);
    expect(codes(report.indicators)).toContain('FOOTPRINT_WRITE_DOWNGRADE');
  });

  it('records the thresholds actually applied so a report stays explainable', () => {
    const report = engine.simulate(benignRequest, { riskBlockThreshold: 10 });
    expect(report.meta.thresholds.riskBlockThreshold).toBe(10);
    expect(report.meta.thresholds.dustAmountStroops).toBe('10');
  });

  it('honors an overridden block threshold', () => {
    const request: SimulationRequest = {
      ...benignRequest,
      operations: [{ kind: 'pay', source: ALICE, destination: BOB, amount: '100' }],
      postState: [{ accountId: ALICE, nativeBalance: '0' }],
    };
    expect(engine.simulate(request).risk.blockExecution).toBe(false);
    expect(engine.simulate(request, { riskBlockThreshold: 1 }).risk.blockExecution).toBe(true);
  });

  it('clamps an out-of-range outflow ratio instead of trusting it', () => {
    const report = engine.simulate(benignRequest, { nearTotalOutflowRatio: 5 });
    expect(report.meta.thresholds.nearTotalOutflowRatio).toBe(1);
  });

  it('combines footprint, drain and contract findings in one report', () => {
    const report = engine.simulate({
      sourceAccount: ALICE,
      operations: [
        { kind: 'pay', source: ALICE, destination: BOB, amount: '100' },
        { kind: 'invokeContract', contractId: FRAUD, function: 'withdraw_all' },
      ],
      resources: { footprint: { readOnly: [key('contractData:X:1', 'readOnly', FRAUD)] } },
      preState: [{ accountId: ALICE, nativeBalance: '100' }],
      postState: [{ accountId: ALICE, nativeBalance: '0' }],
      contracts: [{ contractId: FRAUD, deployed: true }],
      outcome: { success: true },
    });

    const found = codes(report.indicators);
    expect(found).toContain('FULL_BALANCE_DRAIN');
    expect(found).toContain('UNVERIFIED_CONTRACT_INVOCATION');

    // Every category that contributed must appear in the breakdown.
    const categories = new Set(report.indicators.map((i) => i.category));
    for (const category of categories) {
      expect(report.risk.breakdown.some((b) => b.category === category)).toBe(true);
    }
    expect(report.risk.score).toBeGreaterThan(0);
  });

  it('deduplicates repeated indicator codes in the report', () => {
    const report = engine.simulate({
      sourceAccount: ALICE,
      operations: Array.from({ length: 5 }, (_, i) => ({
        kind: 'invokeContract' as const,
        contractId: `${'C'}${String.fromCharCode(66 + i)}${'A'.repeat(53)}`,
        function: 'x',
      })),
      contracts: undefined,
      outcome: { success: true },
    });
    const found = codes(report.indicators);
    expect(new Set(found).size).toBe(found.length);
  });

  it('keeps the score within 0-100 even for a maximally hostile envelope', () => {
    const report = engine.simulate({
      sourceAccount: ALICE,
      operations: [
        ...Array.from({ length: 10 }, () => ({
          kind: 'invokeContract' as const,
          contractId: FRAUD,
          function: 'set_admin',
        })),
        { kind: 'accountMerge' as const, destination: BOB },
      ],
      preState: [{ accountId: ALICE, nativeBalance: '100' }],
      postState: [{ accountId: ALICE, nativeBalance: '0' }],
      contracts: [{ contractId: FRAUD, deployed: false }],
      outcome: { success: false },
    });
    expect(report.risk.score).toBeLessThanOrEqual(100);
    expect(report.risk.score).toBeGreaterThanOrEqual(0);
    expect(report.risk.band).toBe('CRITICAL');
    expect(assertScoreReconciliation(report.risk)).toBe(true);
  });

  it('escalates a total drain to HIGH but does not auto-block it alone', () => {
    // Moving an entire balance to another account is routine, so a lone total
    // drain must be reviewable rather than automatically blocked.
    const report = engine.simulate({
      ...benignRequest,
      operations: [{ kind: 'pay', source: ALICE, destination: BOB, amount: '100' }],
      postState: [{ accountId: ALICE, nativeBalance: '0' }],
    });
    expect(report.risk.band).toBe('HIGH');
    expect(report.risk.blockExecution).toBe(false);
  });

  it('blocks a total drain once any corroborating signal is present', () => {
    // The calibration that matters: "emptied the account AND something else is
    // wrong" must never execute.
    const withFanOut = engine.simulate({
      ...benignRequest,
      operations: [
        { kind: 'pay', source: ALICE, destination: BOB, amount: '30' },
        { kind: 'pay', source: ALICE, destination: CAROL, amount: '30' },
        { kind: 'pay', source: ALICE, destination: DAVE, amount: '40' },
      ],
      postState: [{ accountId: ALICE, nativeBalance: '0' }],
    });
    expect(withFanOut.risk.score).toBeGreaterThanOrEqual(80);
    expect(withFanOut.risk.blockExecution).toBe(true);

    const withUnverifiedContract = engine.simulate({
      ...benignRequest,
      operations: [
        { kind: 'pay', source: ALICE, destination: BOB, amount: '100' },
        { kind: 'invokeContract', contractId: FRAUD, function: 'withdraw' },
      ],
      postState: [{ accountId: ALICE, nativeBalance: '0' }],
      contracts: [{ contractId: FRAUD, deployed: true }],
    });
    expect(withUnverifiedContract.risk.score).toBeGreaterThanOrEqual(80);
    expect(withUnverifiedContract.risk.blockExecution).toBe(true);

    const withMerge = engine.simulate({
      ...benignRequest,
      operations: [{ kind: 'accountMerge', source: ALICE, destination: BOB }],
      postState: [{ accountId: ALICE, nativeBalance: '0' }],
    });
    expect(withMerge.risk.score).toBeGreaterThanOrEqual(80);
    expect(withMerge.risk.blockExecution).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const a = engine.simulate(benignRequest);
    const b = engine.simulate(benignRequest);
    expect(a.risk.score).toBe(b.risk.score);
    expect(codes(a.indicators)).toEqual(codes(b.indicators));
  });

  it('exposes scoreOnly for gate decisions without retaining the report', () => {
    const risk = engine.scoreOnly(benignRequest);
    expect(risk.score).toBe(engine.simulate(benignRequest).risk.score);
    expect(risk.band).toBeTruthy();
  });

  it('never throws on an envelope with no operations or state', () => {
    const report = engine.simulate({ sourceAccount: ALICE, operations: [] });
    expect(report.risk.score).toBeGreaterThanOrEqual(0);
    expect(report.sourceAccount).toBe(ALICE);
  });

  it('publishes defaults matching the documented thresholds', () => {
    expect(DEFAULT_SIMULATION_OPTIONS.nearTotalOutflowRatio).toBe(0.85);
    expect(DEFAULT_SIMULATION_OPTIONS.fanOutDestinationThreshold).toBe(3);
    expect(DEFAULT_SIMULATION_OPTIONS.sequentialTransferThreshold).toBe(8);
    expect(DEFAULT_SIMULATION_OPTIONS.dustAmountStroops).toBe(10n);
    expect(DEFAULT_SIMULATION_OPTIONS.maxFootprintReadWriteKeys).toBe(64);
    expect(DEFAULT_SIMULATION_OPTIONS.footprintProbeContractThreshold).toBe(5);
    expect(DEFAULT_SIMULATION_OPTIONS.maxInvocationsPerContract).toBe(5);
    expect(DEFAULT_SIMULATION_OPTIONS.riskBlockThreshold).toBe(80);
  });
});
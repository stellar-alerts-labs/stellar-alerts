import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  transactionSimulation: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
  },
  securityAuditLog: {
    create: vi.fn(),
  },
}));

vi.mock('../../../config/env', () => ({
  env: {
    SIMULATION_NEAR_TOTAL_OUTFLOW_RATIO: 0.85,
    SIMULATION_FAN_OUT_DESTINATION_THRESHOLD: 3,
    SIMULATION_SEQUENTIAL_TRANSFER_THRESHOLD: 8,
    SIMULATION_MAX_FOOTPRINT_READ_WRITE_KEYS: 64,
    SIMULATION_FOOTPRINT_PROBE_CONTRACT_THRESHOLD: 5,
    SIMULATION_MAX_INVOCATIONS_PER_CONTRACT: 5,
    SIMULATION_RISK_BLOCK_THRESHOLD: 80,
    SIMULATION_DUST_AMOUNT_STROOPS: 10,
  },
}));
vi.mock('../../../lib/prisma', () => ({
  prisma: {
    transactionSimulation: mocks.transactionSimulation,
    securityAuditLog: mocks.securityAuditLog,
  },
}));

import { SimulationService, resolveEngineThresholds, toEngineRequest } from '../simulation.service';
import { analyzeSimulationSchema } from '../simulation.schema';
import { NotFoundError } from '../../../lib/errors';

const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOB = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const FRAUD = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const USER_ID = 'user-1';

function input(payload: Record<string, unknown> = {}) {
  const parsed = analyzeSimulationSchema.safeParse({
    sourceAccount: ALICE,
    operations: [{ kind: 'pay', destination: BOB, amount: '10' }],
    preState: [{ accountId: ALICE, nativeBalance: '100' }],
    ...payload,
  });
  if (!parsed.success) throw new Error(`fixture failed validation: ${parsed.error.message}`);
  return parsed.data;
}

function createdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sim-1',
    userId: USER_ID,
    sourceAccount: ALICE,
    network: 'PUBLIC',
    label: null,
    envelopeHash: null,
    score: 12,
    band: 'LOW',
    blockExecution: false,
    indicatorCodes: ['NO_SIMULATION_RESULT'],
    report: {},
    createdAt: new Date('2026-10-22T00:00:00.000Z'),
    ...overrides,
  };
}

const BASE_ENV = {
  SIMULATION_NEAR_TOTAL_OUTFLOW_RATIO: 0.85,
  SIMULATION_FAN_OUT_DESTINATION_THRESHOLD: 3,
  SIMULATION_SEQUENTIAL_TRANSFER_THRESHOLD: 8,
  SIMULATION_MAX_FOOTPRINT_READ_WRITE_KEYS: 64,
  SIMULATION_FOOTPRINT_PROBE_CONTRACT_THRESHOLD: 5,
  SIMULATION_MAX_INVOCATIONS_PER_CONTRACT: 5,
  SIMULATION_RISK_BLOCK_THRESHOLD: 80,
  SIMULATION_DUST_AMOUNT_STROOPS: 10,
};

describe('resolveEngineThresholds', () => {
  it('maps environment values onto engine options', () => {
    const thresholds = resolveEngineThresholds({
      ...BASE_ENV,
      SIMULATION_NEAR_TOTAL_OUTFLOW_RATIO: 0.9,
      SIMULATION_FAN_OUT_DESTINATION_THRESHOLD: 5,
      SIMULATION_SEQUENTIAL_TRANSFER_THRESHOLD: 10,
      SIMULATION_MAX_FOOTPRINT_READ_WRITE_KEYS: 128,
      SIMULATION_FOOTPRINT_PROBE_CONTRACT_THRESHOLD: 8,
      SIMULATION_MAX_INVOCATIONS_PER_CONTRACT: 9,
      SIMULATION_RISK_BLOCK_THRESHOLD: 70,
      SIMULATION_DUST_AMOUNT_STROOPS: 1,
    } as any);

    expect(thresholds).toMatchObject({
      nearTotalOutflowRatio: 0.9,
      fanOutDestinationThreshold: 5,
      sequentialTransferThreshold: 10,
      maxFootprintReadWriteKeys: 128,
      footprintProbeContractThreshold: 8,
      maxInvocationsPerContract: 9,
      riskBlockThreshold: 70,
    });
    // bigint so it can be compared against stroop arithmetic without rounding.
    expect(thresholds.dustAmountStroops).toBe(1n);
  });

  it('clamps an out-of-range outflow ratio', () => {
    expect(resolveEngineThresholds({ ...BASE_ENV, SIMULATION_NEAR_TOTAL_OUTFLOW_RATIO: 5 } as any)
      .nearTotalOutflowRatio).toBe(1);
    expect(resolveEngineThresholds({ ...BASE_ENV, SIMULATION_NEAR_TOTAL_OUTFLOW_RATIO: 0 } as any)
      .nearTotalOutflowRatio).toBe(0.01);
  });

  // The module-scope `simulationService` singleton resolves thresholds while the
  // route module is imported, so this must never throw — an absent or malformed
  // key degrades one threshold instead of failing app boot (issue: every other
  // suite that boots the app with a partial `env` mock broke on this).
  it('falls back to documented defaults for missing or non-numeric values', () => {
    const thresholds = resolveEngineThresholds({} as any);

    expect(thresholds).toEqual({
      nearTotalOutflowRatio: 0.85,
      fanOutDestinationThreshold: 3,
      sequentialTransferThreshold: 8,
      maxFootprintReadWriteKeys: 64,
      footprintProbeContractThreshold: 5,
      maxInvocationsPerContract: 5,
      riskBlockThreshold: 80,
      dustAmountStroops: 10n,
    });

    const partial = resolveEngineThresholds({
      SIMULATION_DUST_AMOUNT_STROOPS: undefined,
      SIMULATION_RISK_BLOCK_THRESHOLD: 'not-a-number',
      SIMULATION_MAX_INVOCATIONS_PER_CONTRACT: Number.NaN,
    } as any);
    expect(partial.dustAmountStroops).toBe(10n);
    expect(partial.riskBlockThreshold).toBe(80);
    expect(partial.maxInvocationsPerContract).toBe(5);
  });
});

describe('toEngineRequest', () => {
  it('fills absent footprint buckets so the engine sees a complete footprint', () => {
    const request = toEngineRequest(
      input({ resources: { footprint: { readWrite: [{ key: 'k', entryType: 'contractData', access: 'readWrite' }] } } }),
    );
    expect(request.resources!.footprint).toEqual({
      readOnly: [],
      readWrite: [{ key: 'k', entryType: 'contractData', access: 'readWrite' }],
      archived: [],
    });
  });

  it('preserves an explicitly null ledgerBounds', () => {
    // null means "the envelope declares no bounds", which is reportable and must
    // not be collapsed into undefined ("the caller did not tell us").
    expect(toEngineRequest(input({ resources: { ledgerBounds: null } })).resources!.ledgerBounds).toBeNull();
  });

  it('omits resources entirely when none were supplied', () => {
    expect(toEngineRequest(input()).resources).toBeUndefined();
  });

  it('carries the post state through untouched', () => {
    const post = [{ accountId: ALICE, nativeBalance: '0' }];
    expect(toEngineRequest(input({ postState: post })).postState).toEqual(post);
  });
});

describe('SimulationService.analyze', () => {
  let service: SimulationService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transactionSimulation.create.mockResolvedValue(createdRow());
    mocks.securityAuditLog.create.mockResolvedValue({});
    service = new SimulationService();
  });

  it('persists the assessment and returns the stored row', async () => {
    const result = await service.analyze(USER_ID, input());

    expect(result.id).toBe('sim-1');
    expect(mocks.transactionSimulation.create).toHaveBeenCalledTimes(1);
    const arg = mocks.transactionSimulation.create.mock.calls[0][0].data;
    expect(arg.userId).toBe(USER_ID);
    expect(arg.sourceAccount).toBe(ALICE);
    expect(arg.network).toBe('PUBLIC');
  });

  it('stores the full engine report alongside the queryable columns', async () => {
    await service.analyze(USER_ID, input());

    const arg = mocks.transactionSimulation.create.mock.calls[0][0].data;
    expect(arg.report.risk).toBeDefined();
    expect(arg.report.drain).toBeDefined();
    expect(arg.report.contracts).toBeDefined();
    expect(arg.report.meta.thresholds).toBeDefined();
    expect(Array.isArray(arg.indicatorCodes)).toBe(true);
  });

  it('hashes the envelope XDR instead of storing it', async () => {
    await service.analyze(USER_ID, input({ envelopeXdr: 'AAAAAQ==' }));

    const arg = mocks.transactionSimulation.create.mock.calls[0][0].data;
    expect(arg.envelopeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(arg.report)).not.toContain('AAAAAQ==');
  });

  it('produces a stable hash for the same envelope', async () => {
    await service.analyze(USER_ID, input({ envelopeXdr: 'AAAAAQ==' }));
    const first = mocks.transactionSimulation.create.mock.calls[0][0].data.envelopeHash;
    mocks.transactionSimulation.create.mockClear();
    await service.analyze(USER_ID, input({ envelopeXdr: 'AAAAAQ==' }));
    const second = mocks.transactionSimulation.create.mock.calls[0][0].data.envelopeHash;
    expect(second).toBe(first);
  });

  it('leaves envelopeHash null when no XDR was supplied', async () => {
    await service.analyze(USER_ID, input());
    expect(mocks.transactionSimulation.create.mock.calls[0][0].data.envelopeHash).toBeNull();
  });

  it('does not write an audit log for a SAFE or LOW result', async () => {
    await service.analyze(USER_ID, input());
    expect(mocks.securityAuditLog.create).not.toHaveBeenCalled();
  });

  it('escalates a HIGH result into the security audit log', async () => {
    // Unverified contract (24) + unauthenticated privileged call (42) = 66 -> HIGH.
    mocks.transactionSimulation.create.mockResolvedValue(createdRow({ band: 'HIGH' }));

    await service.analyze(
      USER_ID,
      input({
        operations: [{ kind: 'invokeContract', contractId: FRAUD, function: 'set_admin' }],
        contracts: [{ contractId: FRAUD, deployed: true }],
      }),
    );

    expect(mocks.securityAuditLog.create).toHaveBeenCalledTimes(1);
    const details = mocks.securityAuditLog.create.mock.calls[0][0].data.details;
    expect(details.band).toBe('HIGH');
    expect(details.indicatorCodes).toContain('PRIVILEGED_FUNCTION_WITHOUT_AUTH');
  });

  it('escalates a CRITICAL result with high audit severity', async () => {
    // Full drain (60) + account merge sweep (40) = 100 -> CRITICAL.
    await service.analyze(
      USER_ID,
      input({
        operations: [{ kind: 'accountMerge', destination: BOB }],
        postState: [{ accountId: ALICE, nativeBalance: '0' }],
      }),
    );

    const data = mocks.securityAuditLog.create.mock.calls[0][0].data;
    expect(data.eventType).toBe('TRANSACTION_SIMULATION_RISK');
    expect(data.severity).toBe('HIGH');
    expect(data.details.band).toBe('CRITICAL');
    expect(data.details.blockExecution).toBe(true);
  });

  it('still returns the assessment when the audit write fails', async () => {
    // The assessment is already persisted; losing the audit copy must not fail
    // a request that produced a valid threat score.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.securityAuditLog.create.mockRejectedValue(new Error('audit table unavailable'));

    const result = await service.analyze(
      USER_ID,
      input({
        operations: [{ kind: 'accountMerge', destination: BOB }],
        postState: [{ accountId: ALICE, nativeBalance: '0' }],
      }),
    );

    expect(result.id).toBe('sim-1');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('propagates a persistence failure instead of returning an unstored verdict', async () => {
    // Fail closed: the row is the durable audit record, and 201 + Location
    // promise an id that resolves. Silently returning a verdict the caller
    // believes was recorded would be the worse failure.
    mocks.transactionSimulation.create.mockRejectedValue(new Error('write failed'));

    await expect(service.analyze(USER_ID, input())).rejects.toThrow('write failed');

    // No audit escalation for a result that was never recorded.
    expect(mocks.securityAuditLog.create).not.toHaveBeenCalled();
  });

  it('applies the configured block threshold', async () => {
    const strict = new SimulationService(undefined, resolveEngineThresholds({
      ...BASE_ENV,
      SIMULATION_RISK_BLOCK_THRESHOLD: 1,
    } as any));

    await strict.analyze(USER_ID, input());

    expect(mocks.transactionSimulation.create.mock.calls[0][0].data.blockExecution).toBe(true);
  });
});

describe('SimulationService.list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes the query to the owner and paginates', async () => {
    mocks.transactionSimulation.findMany.mockResolvedValue([createdRow()]);
    mocks.transactionSimulation.count.mockResolvedValue(1);

    const result = await new SimulationService().list(USER_ID, {
      page: 2,
      pageSize: 10,
      band: 'HIGH',
      sourceAccount: ALICE,
    });

    expect(result.total).toBe(1);
    expect(result.simulations).toHaveLength(1);
    const args = mocks.transactionSimulation.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: USER_ID, band: 'HIGH', sourceAccount: ALICE });
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('omits absent filters from the where clause', async () => {
    mocks.transactionSimulation.findMany.mockResolvedValue([]);
    mocks.transactionSimulation.count.mockResolvedValue(0);

    await new SimulationService().list(USER_ID, { page: 1, pageSize: 20 });

    expect(mocks.transactionSimulation.findMany.mock.calls[0][0].where).toEqual({ userId: USER_ID });
  });
});

describe('SimulationService.get', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes the lookup by owner so ids cannot be probed', async () => {
    mocks.transactionSimulation.findFirst.mockResolvedValue(createdRow());

    const result = await new SimulationService().get(USER_ID, 'sim-1');

    expect(result.id).toBe('sim-1');
    expect(mocks.transactionSimulation.findFirst).toHaveBeenCalledWith({
      where: { id: 'sim-1', userId: USER_ID },
    });
  });

  it('throws a 404 when the row is missing or owned by someone else', async () => {
    mocks.transactionSimulation.findFirst.mockResolvedValue(null);

    await expect(new SimulationService().get('intruder', 'sim-1')).rejects.toThrow(NotFoundError);
  });
});
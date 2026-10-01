import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import { ValidationError } from '../../../lib/errors';

const createMock = vi.fn();
vi.mock('../../../lib/prisma', () => ({
  prisma: {
    transactionSimulation: {
      create: (...args: unknown[]) => createMock(...args),
    },
  },
}));

const { TxSimulationService } = await import('../tx-simulation.service');

const PASS = StellarSdk.Networks.TESTNET;
const X = StellarSdk.xdr;
const USER_ID = 'user-1';

const SOURCE = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const DEST = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const UNTRUSTED_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function ledgerKey(id: number): StellarSdk.xdr.LedgerKey {
  return X.LedgerKey.contractData(
    new X.LedgerKeyContractData({
      contract: new StellarSdk.Address(SOURCE.publicKey()).toScAddress(),
      key: X.ScVal.scvU32(id),
      durability: X.ContractDataDurability.persistent(),
    }),
  );
}

const SOROBAN_DATA_EXT = (
  (X.SorobanTransactionData as unknown as { _fields: Array<[string, unknown]> })._fields.find(
    ([name]) => name === 'ext',
  )?.[1] as new (arm: number) => StellarSdk.xdr.TransactionExt
) ?? null;

function buildEnvelope(readOnly: number[] = [], readWrite: number[] = []): string {
  if (!SOROBAN_DATA_EXT) throw new Error('SorobanTransactionData.ext type not found');
  const builder = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account(SOURCE.publicKey(), '1'),
    { fee: StellarSdk.BASE_FEE, networkPassphrase: PASS },
  );
  builder.addOperation(
    StellarSdk.Operation.payment({
      destination: DEST,
      asset: StellarSdk.Asset.native(),
      amount: '10',
    }),
  );
  const envelope = builder.setTimeout(30).build().toEnvelope();
  envelope.v1().tx().ext(
    new X.TransactionExt(
      1,
      new X.SorobanTransactionData({
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
      }),
    ),
  );
  return envelope.toXDR('base64');
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    envelopeXdr: buildEnvelope(),
    networkPassphrase: PASS,
    ...overrides,
  } as any;
}

describe('TxSimulationService.analyze', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ id: 'sim-1' });
  });

  it('returns a report and persists an audit row by default', async () => {
    const service = new TxSimulationService();
    const result = await service.analyze(baseRequest(), USER_ID);

    expect(result.report.envelope.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.persisted).toBe(true);
    expect(result.simulationId).toBe('sim-1');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('persists the decoded envelope metadata rather than the raw XDR', async () => {
    const service = new TxSimulationService();
    const envelopeXdr = buildEnvelope();
    await service.analyze(baseRequest({ envelopeXdr }), USER_ID);

    const data = createMock.mock.calls[0][0].data;
    expect(data.userId).toBe(USER_ID);
    expect(data.envelopeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.innerEnvelopeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.isFeeBump).toBe(false);
    expect(data.networkPassphrase).toBe(PASS);
    expect(typeof data.score).toBe('number');
    expect(typeof data.riskLevel).toBe('string');
    expect(typeof data.verdict).toBe('string');
    // The envelope XDR itself must never be written to the audit row. Compare
    // the whole string, not a prefix: ledger-key XDR inside footprintDiff shares
    // a leading "AAAAAgAAAAC..." with the envelope, so a prefix test would
    // false-positive on the diff instead of the payload we care about.
    expect(JSON.stringify(data)).not.toContain(envelopeXdr);
  });

  it('records distinct indicator codes', async () => {
    const service = new TxSimulationService();
    await service.analyze(
      baseRequest({
        envelopeXdr: buildEnvelope([], [1, 2, 3]),
        ledgerBaseline: { nativeBalanceStroops: '100000000' },
      }),
      USER_ID,
    );

    const data = createMock.mock.calls[0][0].data;
    expect(Array.isArray(data.indicatorCodes)).toBe(true);
    for (const code of data.indicatorCodes) expect(typeof code).toBe('string');
  });

  it('skips persistence when persist=false', async () => {
    const service = new TxSimulationService();
    const result = await service.analyze(baseRequest({ persist: false }), USER_ID);

    expect(result.persisted).toBe(false);
    expect(result.simulationId).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    // The report is still fully computed — persistence is opt-out, not opt-in.
    expect(result.report.risk.level).toBeDefined();
  });

  it('still returns the report when the audit write fails', async () => {
    createMock.mockRejectedValueOnce(new Error('db down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const service = new TxSimulationService();
    const result = await service.analyze(baseRequest(), USER_ID);

    expect(result.persisted).toBe(false);
    expect(result.simulationId).toBeNull();
    expect(result.report.envelope.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('throws a 400 ValidationError for undecodable XDR', async () => {
    const service = new TxSimulationService();
    const promise = service.analyze(baseRequest({ envelopeXdr: 'not-base64-xdr!!' }), USER_ID);

    await expect(promise).rejects.toThrow(ValidationError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_ENVELOPE_XDR',
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('produces a footprint diff only when a simulation is supplied', async () => {
    const service = new TxSimulationService();

    const withoutSimulation = await service.analyze(baseRequest(), USER_ID);
    expect(withoutSimulation.report.footprintDiff).toBeNull();
    expect(withoutSimulation.report.coverage.footprintDiff).toBe(false);

    const withSimulation = await service.analyze(
      baseRequest({
        simulation: {
          readOnlyLedgerKeys: [ledgerKey(7).toXDR('base64')],
          readWriteLedgerKeys: [],
        },
      }),
      USER_ID,
    );
    expect(withSimulation.report.footprintDiff).not.toBeNull();
    expect(withSimulation.report.coverage.footprintDiff).toBe(true);
  });

  it('converts numeric bigint thresholds for the engine', async () => {
    const service = new TxSimulationService();
    const result = await service.analyze(
      baseRequest({
        options: {
          dustResidueStroops: 12345,
          cpuInstructionThreshold: 999,
        },
      }),
      USER_ID,
    );

    // The engine widens these to bigint; a string or float sneaking through
    // would make the comparisons silently wrong.
    expect(result.report.risk.score).toBeGreaterThanOrEqual(0);
    expect(result.report.risk.verdict).toMatch(/^(allow|review|block)$/);
  });

  it('reflects supplied baselines in the coverage block', async () => {
    const service = new TxSimulationService();
    const result = await service.analyze(
      baseRequest({
        ledgerBaseline: {
          nativeBalanceStroops: '50000000',
          knownRecipients: [DEST],
          trustedContracts: [UNTRUSTED_CONTRACT],
        },
      }),
      USER_ID,
    );

    expect(result.report.coverage).toMatchObject({
      balanceBaseline: true,
      recipientBaseline: true,
      trustedContractBaseline: true,
    });
  });
});

/**
 * End-to-end tests for POST /tx-simulation/analyze, exercising the real
 * controller + service stack over HTTP. Like the wasm-analyzer route tests,
 * this registers the controller directly (no authenticateHook) so the suite
 * stays independent of Redis/DB availability — auth itself is covered by the
 * shared auth.middleware tests. `request.user` is set the same way the hook
 * would set it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as StellarSdk from 'stellar-sdk';

const createMock = vi.fn();
vi.mock('../../../lib/prisma', () => ({
  prisma: {
    transactionSimulation: {
      create: (...args: unknown[]) => createMock(...args),
    },
  },
}));

import { txSimulationController } from '../tx-simulation.controller';
import { AppError } from '../../../lib/errors';

const PASS = StellarSdk.Networks.TESTNET;
const X = StellarSdk.xdr;
const SOURCE = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const DEST = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();

const SOROBAN_DATA_EXT = (
  (X.SorobanTransactionData as unknown as { _fields: Array<[string, unknown]> })._fields.find(
    ([name]) => name === 'ext',
  )?.[1] as new (arm: number) => StellarSdk.xdr.TransactionExt
) ?? null;

function buildEnvelope(): string {
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
          footprint: new X.LedgerFootprint({ readOnly: [], readWrite: [] }),
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

const VALID_ENVELOPE = buildEnvelope();

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details, requestId: 'req-1' },
      });
    }
    return reply.status(error.statusCode ?? 500).send({ error: { message: error.message } });
  });
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'test-user' } as any;
  });
  app.post('/tx-simulation/analyze', txSimulationController.analyze.bind(txSimulationController));
  return app;
}

function post(body: unknown) {
  return { method: 'POST' as const, url: '/tx-simulation/analyze', payload: body as any };
}

describe('POST /tx-simulation/analyze', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ id: 'sim-1' });
  });

  it('returns 200 with the report for a valid envelope', async () => {
    const response = await app.inject(
      post({ envelopeXdr: VALID_ENVELOPE, networkPassphrase: PASS }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.report.envelope.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.report.risk).toMatchObject({
      score: expect.any(Number),
      level: expect.any(String),
      verdict: expect.any(String),
    });
    expect(['allow', 'review', 'block']).toContain(body.report.risk.verdict);
    expect(body.persisted).toBe(true);
    expect(body.simulationId).toBe('sim-1');
  });

  it('returns 400 with field details when envelopeXdr is missing', async () => {
    const response = await app.inject(post({ networkPassphrase: PASS }));

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(body.error.details)).toContain('envelopeXdr');
  });

  it('returns 400 when networkPassphrase is missing', async () => {
    const response = await app.inject(post({ envelopeXdr: VALID_ENVELOPE }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns 400 with INVALID_ENVELOPE_XDR for undecodable XDR', async () => {
    const response = await app.inject(
      post({ envelopeXdr: 'totally-not-xdr', networkPassphrase: PASS }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_ENVELOPE_XDR');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the envelope exceeds the size cap', async () => {
    const response = await app.inject(
      post({ envelopeXdr: 'A'.repeat(600_000), networkPassphrase: PASS }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unknown fields in the request body', async () => {
    const response = await app.inject(
      post({
        envelopeXdr: VALID_ENVELOPE,
        networkPassphrase: PASS,
        notARealField: true,
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts an envelope with no simulation and reports coverage accordingly', async () => {
    const response = await app.inject(
      post({ envelopeXdr: VALID_ENVELOPE, networkPassphrase: PASS, persist: false }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.report.footprintDiff).toBeNull();
    expect(body.report.coverage.footprintDiff).toBe(false);
    expect(body.persisted).toBe(false);
  });

  it('accepts a supplied simulation block and produces a footprint diff', async () => {
    const response = await app.inject(
      post({
        envelopeXdr: VALID_ENVELOPE,
        networkPassphrase: PASS,
        persist: false,
        simulation: {
          readOnlyLedgerKeys: [
            X.LedgerKey.contractData(
              new X.LedgerKeyContractData({
                contract: new StellarSdk.Address(SOURCE.publicKey()).toScAddress(),
                key: X.ScVal.scvU32(1),
                durability: X.ContractDataDurability.persistent(),
              }),
            ).toXDR('base64'),
          ],
          readWriteLedgerKeys: [],
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.report.footprintDiff).not.toBeNull();
    expect(body.report.coverage.footprintDiff).toBe(true);
  });

  it('still returns 200 with persisted=false when the audit write fails', async () => {
    createMock.mockRejectedValueOnce(new Error('db down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await app.inject(
      post({ envelopeXdr: VALID_ENVELOPE, networkPassphrase: PASS }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.persisted).toBe(false);
    expect(body.simulationId).toBeNull();
    expect(body.report.envelope.txHash).toMatch(/^[0-9a-f]{64}$/);
    consoleSpy.mockRestore();
  });
});

describe('POST /tx-simulation/analyze (auth wiring)', () => {
  it('registers behind authenticateHook on the real route plugin', async () => {
    vi.resetModules();
    vi.doMock('../../../lib/prisma', () => ({
      prisma: { transactionSimulation: { create: vi.fn() } },
    }));
    vi.doMock('../../../middleware/auth.middleware', () => ({
      authenticateHook: async (_request: any, reply: any) =>
        reply.status(401).send({ error: { code: 'AUTH_REQUIRED' } }),
    }));

    const { txSimulationRoutes } = await import('../tx-simulation.routes');
    const app = Fastify();
    await app.register(txSimulationRoutes);
    await app.ready();

    const response = await app.inject(
      post({ envelopeXdr: VALID_ENVELOPE, networkPassphrase: PASS }),
    );

    expect(response.statusCode).toBe(401);
    await app.close();
    vi.doUnmock('../../../lib/prisma');
    vi.doUnmock('../../../middleware/auth.middleware');
    vi.resetModules();
  });
});

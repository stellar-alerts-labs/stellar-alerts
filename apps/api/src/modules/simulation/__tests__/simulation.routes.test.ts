import Fastify, { FastifyInstance } from 'fastify';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  service: {
    analyze: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('../../../config/env', () => ({
  env: {
    JWT_SECRET: 'test-jwt-secret',
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
vi.mock('../../../lib/prisma', () => ({ prisma: {} }));
// Stand-in for the JWT hook: `x-test-user` plays the role of a valid bearer token.
vi.mock('../../../middleware/auth.middleware', () => ({
  authenticateHook: async (request: any, reply: any) => {
    const userId = request.headers['x-test-user'];
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    }
    request.user = { id: userId, email: `${userId}@example.com` };
  },
}));
vi.mock('../simulation.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../simulation.service')>();
  return { ...original, simulationService: mocks.service };
});

import { simulationRoutes } from '../simulation.routes';
import { NotFoundError } from '../../../lib/errors';

const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOB = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const validPayload = {
  sourceAccount: ALICE,
  operations: [{ kind: 'pay', destination: BOB, amount: '10' }],
  preState: [{ accountId: ALICE, nativeBalance: '100' }],
};

const storedSimulation = {
  id: 'sim-1',
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
};

describe('simulation routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(simulationRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('authentication', () => {
    it.each([
      ['POST', '/simulations/analyze'],
      ['GET', '/simulations'],
      ['GET', '/simulations/sim-1'],
    ] as const)('%s %s requires a bearer token', async (method, url) => {
      const res = await app.inject({
        method,
        url,
        payload: method === 'POST' ? validPayload : undefined,
      });

      expect(res.statusCode).toBe(401);
      expect(mocks.service.analyze).not.toHaveBeenCalled();
      expect(mocks.service.list).not.toHaveBeenCalled();
      expect(mocks.service.get).not.toHaveBeenCalled();
    });
  });

  describe('POST /simulations/analyze', () => {
    it('returns 201 with the persisted assessment and a Location header', async () => {
      mocks.service.analyze.mockResolvedValue(storedSimulation);

      const res = await app.inject({
        method: 'POST',
        url: '/simulations/analyze',
        headers: { 'x-test-user': 'user-1' },
        payload: validPayload,
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers.location).toBe('/simulations/sim-1');
      expect(res.json().simulation).toMatchObject({ id: 'sim-1', band: 'LOW', score: 12 });
      expect(mocks.service.analyze).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ sourceAccount: ALICE, preState: validPayload.preState }),
      );
    });

    it('defaults preState to an empty list when omitted', async () => {
      mocks.service.analyze.mockResolvedValue(storedSimulation);

      await app.inject({
        method: 'POST',
        url: '/simulations/analyze',
        headers: { 'x-test-user': 'user-1' },
        payload: { sourceAccount: ALICE, operations: [] },
      });

      expect(mocks.service.analyze).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ preState: [], operations: [] }),
      );
    });

    it.each([
      ['a missing source account', { operations: [] }],
      ['a malformed source account', { sourceAccount: 'not-a-key', operations: [] }],
      ['a missing operations array', { sourceAccount: ALICE }],
      ['an unknown operation kind', { sourceAccount: ALICE, operations: [{ kind: 'teleport' }] }],
      ['a negative amount', { sourceAccount: ALICE, operations: [{ kind: 'pay', amount: '-5' }] }],
      [
        'an amount with too much precision',
        { sourceAccount: ALICE, operations: [{ kind: 'pay', amount: '0.00000001' }] },
      ],
      ['a credit asset missing its issuer', {
        sourceAccount: ALICE,
        operations: [{ kind: 'pay', asset: { type: 'credit_alphanumeric', code: 'USDC' } }],
      }],
      ['an unknown asset type', {
        sourceAccount: ALICE,
        operations: [{ kind: 'pay', asset: { type: 'derivative' } }],
      }],
    ])('rejects %s with 400', async (_label, payload) => {
      const res = await app.inject({
        method: 'POST',
        url: '/simulations/analyze',
        headers: { 'x-test-user': 'user-1' },
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(mocks.service.analyze).not.toHaveBeenCalled();
    });

    it('accepts a null ledgerBounds, which is a meaningful declaration', async () => {
      mocks.service.analyze.mockResolvedValue(storedSimulation);

      const res = await app.inject({
        method: 'POST',
        url: '/simulations/analyze',
        headers: { 'x-test-user': 'user-1' },
        payload: { ...validPayload, resources: { ledgerBounds: null } },
      });

      expect(res.statusCode).toBe(201);
      expect(mocks.service.analyze).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ resources: expect.objectContaining({ ledgerBounds: null }) }),
      );
    });

    it('lets unexpected errors surface as 500', async () => {
      mocks.service.analyze.mockRejectedValue(new Error('db down'));

      const res = await app.inject({
        method: 'POST',
        url: '/simulations/analyze',
        headers: { 'x-test-user': 'user-1' },
        payload: validPayload,
      });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('GET /simulations', () => {
    it("lists the caller's simulations with paging", async () => {
      mocks.service.list.mockResolvedValue({ simulations: [], total: 0, page: 2, pageSize: 10 });

      const res = await app.inject({
        method: 'GET',
        url: '/simulations?page=2&pageSize=10',
        headers: { 'x-test-user': 'user-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, simulations: [], total: 0, page: 2, pageSize: 10 });
      expect(mocks.service.list).toHaveBeenCalledWith('user-1', { page: 2, pageSize: 10 });
    });

    it('accepts a band filter', async () => {
      mocks.service.list.mockResolvedValue({ simulations: [], total: 0, page: 1, pageSize: 20 });

      await app.inject({
        method: 'GET',
        url: '/simulations?band=CRITICAL',
        headers: { 'x-test-user': 'user-1' },
      });

      expect(mocks.service.list).toHaveBeenCalledWith('user-1', expect.objectContaining({ band: 'CRITICAL' }));
    });

    it.each([
      ['an oversized page size', '/simulations?pageSize=1000'],
      ['a zero page', '/simulations?page=0'],
      ['an unknown band', '/simulations?band=CATASTROPHIC'],
    ])('rejects %s with 400', async (_label, url) => {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-test-user': 'user-1' } });

      expect(res.statusCode).toBe(400);
      expect(mocks.service.list).not.toHaveBeenCalled();
    });
  });

  describe('GET /simulations/:id', () => {
    it('returns the assessment uncached', async () => {
      mocks.service.get.mockResolvedValue(storedSimulation);

      const res = await app.inject({
        method: 'GET',
        url: '/simulations/sim-1',
        headers: { 'x-test-user': 'user-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json().simulation).toMatchObject({ id: 'sim-1', band: 'LOW' });
      expect(mocks.service.get).toHaveBeenCalledWith('user-1', 'sim-1');
    });

    it("returns 404 for another user's simulation", async () => {
      mocks.service.get.mockRejectedValue(new NotFoundError('Simulation not found', 'SIMULATION_NOT_FOUND'));

      const res = await app.inject({
        method: 'GET',
        url: '/simulations/sim-1',
        headers: { 'x-test-user': 'intruder' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('SIMULATION_NOT_FOUND');
      // The lookup is scoped by owner in the query, not filtered afterwards.
      expect(mocks.service.get).toHaveBeenCalledWith('intruder', 'sim-1');
    });

    it('rejects an oversized id with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/simulations/${'x'.repeat(65)}`,
        headers: { 'x-test-user': 'user-1' },
      });

      expect(res.statusCode).toBe(400);
      expect(mocks.service.get).not.toHaveBeenCalled();
    });
  });
});
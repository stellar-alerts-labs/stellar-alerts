import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProof: vi.fn(),
}));

vi.mock('../../../middleware/auth.middleware', () => ({
  authenticateHook: async (request: any, reply: any) => {
    if (!request.headers['x-test-user']) {
      return reply.status(401).send({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    }
    request.user = { id: request.headers['x-test-user'] };
  },
}));

vi.mock('../onchain-notary.service', () => ({
  onChainNotaryService: { getProof: mocks.getProof },
}));

import { auditRoutes } from '../audit.routes';
import { AppError } from '../../../lib/errors';

describe('GET /audit/:id/proof', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    app.setErrorHandler((error: any, _request, reply) => {
      const status = error instanceof AppError ? error.statusCode : 500;
      return reply.status(status).send({
        error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message },
      });
    });
    await app.register(auditRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit/log-1/proof' });
    expect(res.statusCode).toBe(401);
    expect(mocks.getProof).not.toHaveBeenCalled();
  });

  it('returns the leaf hash, path, root and Stellar anchor hash', async () => {
    const proof = {
      leafIndex: 1,
      leafHash: 'a'.repeat(64),
      path: [{ siblingHash: 'b'.repeat(64), direction: 'left' }],
      rootHash: 'c'.repeat(64),
      hourKey: '2026-11-24T14',
      stellarTransactionHash: 'stellar-tx-hash',
      anchored: true,
    };
    mocks.getProof.mockResolvedValue(proof);

    const res = await app.inject({
      method: 'GET',
      url: '/audit/log-1/proof',
      headers: { 'x-test-user': 'user-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ success: true, proof });
    expect(mocks.getProof).toHaveBeenCalledWith('log-1');
  });

  it('returns 404 when the audit log does not exist', async () => {
    mocks.getProof.mockResolvedValue(null);
    const res = await app.inject({
      method: 'GET',
      url: '/audit/missing/proof',
      headers: { 'x-test-user': 'user-1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

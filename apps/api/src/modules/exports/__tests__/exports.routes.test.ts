import fs from 'fs';
import os from 'os';
import path from 'path';
import Fastify, { FastifyInstance } from 'fastify';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const mocks = vi.hoisted(() => ({
  service: {
    createExport: vi.fn(),
    listExports: vi.fn(),
    getExport: vi.fn(),
    resolveDownload: vi.fn(),
  },
}));

vi.mock('../../../config/env', () => ({ env: { JWT_SECRET: 'test-jwt-secret' } }));
vi.mock('../../../lib/prisma', () => ({ prisma: {} }));
vi.mock('../../../lib/export-queue', () => ({ enqueueExportJob: vi.fn() }));
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
vi.mock('../exports.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../exports.service')>();
  return { ...original, exportsService: mocks.service };
});

import { exportsRoutes } from '../exports.routes';
import { ExportError } from '../exports.service';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exports-routes-test-'));
const SIG = 'a'.repeat(64);

describe('exports routes (#321)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(exportsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('authentication', () => {
    it.each([
      ['POST', '/exports'],
      ['GET', '/exports'],
      ['GET', '/exports/job-1'],
    ] as const)('%s %s requires a bearer token', async (method, url) => {
      const res = await app.inject({ method, url, payload: method === 'POST' ? { type: 'ledger_csv' } : undefined });

      expect(res.statusCode).toBe(401);
      expect(mocks.service.createExport).not.toHaveBeenCalled();
      expect(mocks.service.getExport).not.toHaveBeenCalled();
      expect(mocks.service.listExports).not.toHaveBeenCalled();
    });

    it('does not require a bearer token for the signed download route', async () => {
      mocks.service.resolveDownload.mockRejectedValue(new ExportError('Invalid download link', 403, 'INVALID_DOWNLOAD_LINK'));

      const res = await app.inject({ method: 'GET', url: `/exports/job-1/download?expires=9999999999&sig=${SIG}` });

      expect(res.statusCode).toBe(403);
      expect(mocks.service.resolveDownload).toHaveBeenCalledWith('job-1', 9999999999, SIG);
    });
  });

  describe('POST /exports', () => {
    it('returns 202 with the job and a Location header', async () => {
      mocks.service.createExport.mockResolvedValue({ id: 'job-1', status: 'queued', progress: 0, download: null });

      const res = await app.inject({
        method: 'POST',
        url: '/exports',
        headers: { 'x-test-user': 'user-1' },
        payload: { type: 'ledger_pdf', walletId: 'w-1', periodStart: '2026-01-01', periodEnd: '2026-03-31T00:00:00Z' },
      });

      expect(res.statusCode).toBe(202);
      expect(res.headers.location).toBe('/exports/job-1');
      expect(res.json()).toEqual({ success: true, export: { id: 'job-1', status: 'queued', progress: 0, download: null } });
      expect(mocks.service.createExport).toHaveBeenCalledWith('user-1', {
        type: 'ledger_pdf',
        walletId: 'w-1',
        periodStart: '2026-01-01',
        periodEnd: '2026-03-31T00:00:00Z',
      });
    });

    it.each([
      ['missing type', {}],
      ['unknown type', { type: 'xlsx' }],
      ['bad date', { type: 'ledger_csv', periodStart: 'last tuesday' }],
      ['inverted period', { type: 'ledger_csv', periodStart: '2026-05-01', periodEnd: '2026-01-01' }],
      ['unknown tax format', { type: 'tax_csv', format: 'turbotax' }],
    ])('rejects %s with 400', async (_label, payload) => {
      const res = await app.inject({ method: 'POST', url: '/exports', headers: { 'x-test-user': 'user-1' }, payload });

      expect(res.statusCode).toBe(400);
      expect(mocks.service.createExport).not.toHaveBeenCalled();
    });

    it.each([
      [404, 'WALLET_NOT_FOUND'],
      [429, 'TOO_MANY_ACTIVE_EXPORTS'],
    ])('maps service ExportError %i %s', async (status, code) => {
      mocks.service.createExport.mockRejectedValue(new ExportError('nope', status, code));

      const res = await app.inject({ method: 'POST', url: '/exports', headers: { 'x-test-user': 'user-1' }, payload: { type: 'ledger_csv' } });

      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: code, message: 'nope' });
    });

    it('lets unexpected errors surface as 500', async () => {
      mocks.service.createExport.mockRejectedValue(new Error('db down'));

      const res = await app.inject({ method: 'POST', url: '/exports', headers: { 'x-test-user': 'user-1' }, payload: { type: 'ledger_csv' } });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('GET /exports and /exports/:id', () => {
    it('lists the caller\'s exports with paging', async () => {
      mocks.service.listExports.mockResolvedValue({ exports: [], page: 2, pageSize: 10, total: 11 });

      const res = await app.inject({ method: 'GET', url: '/exports?page=2&pageSize=10', headers: { 'x-test-user': 'user-1' } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, exports: [], page: 2, pageSize: 10, total: 11 });
      expect(mocks.service.listExports).toHaveBeenCalledWith('user-1', { page: 2, pageSize: 10 });
    });

    it('rejects an oversized page size', async () => {
      const res = await app.inject({ method: 'GET', url: '/exports?pageSize=1000', headers: { 'x-test-user': 'user-1' } });
      expect(res.statusCode).toBe(400);
    });

    it('returns status and progress for the owner, uncached', async () => {
      mocks.service.getExport.mockResolvedValue({ id: 'job-1', status: 'running', progress: 45, download: null });

      const res = await app.inject({ method: 'GET', url: '/exports/job-1', headers: { 'x-test-user': 'user-1' } });

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json().export).toMatchObject({ status: 'running', progress: 45 });
      expect(mocks.service.getExport).toHaveBeenCalledWith('job-1', 'user-1');
    });

    it("returns 404 for another user's export", async () => {
      mocks.service.getExport.mockRejectedValue(new ExportError('Export not found', 404, 'EXPORT_NOT_FOUND'));

      const res = await app.inject({ method: 'GET', url: '/exports/job-1', headers: { 'x-test-user': 'intruder' } });

      expect(res.statusCode).toBe(404);
      expect(mocks.service.getExport).toHaveBeenCalledWith('job-1', 'intruder');
    });

    it('rejects an oversized id with 400', async () => {
      const res = await app.inject({ method: 'GET', url: `/exports/${'x'.repeat(65)}`, headers: { 'x-test-user': 'user-1' } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /exports/:id/download', () => {
    it('streams the file as an attachment with no-store caching', async () => {
      const filePath = path.join(tmpRoot, 'job-1.csv');
      fs.writeFileSync(filePath, 'Date,Amount\n2026-01-01,5');
      mocks.service.resolveDownload.mockResolvedValue({
        filePath,
        fileSize: 24,
        contentType: 'text/csv; charset=utf-8',
        downloadName: 'ledger "statement".csv',
      });

      const res = await app.inject({ method: 'GET', url: `/exports/job-1/download?expires=9999999999&sig=${SIG}` });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('Date,Amount\n2026-01-01,5');
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-length']).toBe('24');
      // Quotes in the stored name can't break out of the header value.
      expect(res.headers['content-disposition']).toBe('attachment; filename="ledger__statement_.csv"');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it.each([
      ['missing signature', '/exports/job-1/download?expires=9999999999'],
      ['missing expiry', `/exports/job-1/download?sig=${SIG}`],
      ['non-numeric expiry', `/exports/job-1/download?expires=soon&sig=${SIG}`],
    ])('rejects a %s with 403 before touching storage', async (_label, url) => {
      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('INVALID_DOWNLOAD_LINK');
      expect(mocks.service.resolveDownload).not.toHaveBeenCalled();
    });

    it.each([
      [403, 'DOWNLOAD_LINK_EXPIRED'],
      [409, 'EXPORT_NOT_READY'],
      [410, 'EXPORT_EXPIRED'],
    ])('maps %i %s from the service', async (status, code) => {
      mocks.service.resolveDownload.mockRejectedValue(new ExportError('x', status, code));

      const res = await app.inject({ method: 'GET', url: `/exports/job-1/download?expires=9999999999&sig=${SIG}` });

      expect(res.statusCode).toBe(status);
      expect(res.json().error).toBe(code);
    });

    it('omits Content-Length when the size is unknown', async () => {
      const filePath = path.join(tmpRoot, 'job-2.pdf');
      fs.writeFileSync(filePath, '%PDF-1.3');
      mocks.service.resolveDownload.mockResolvedValue({
        filePath,
        fileSize: null,
        contentType: 'application/pdf',
        downloadName: 'statement.pdf',
      });

      const res = await app.inject({ method: 'GET', url: `/exports/job-2/download?expires=9999999999&sig=${SIG}` });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('%PDF-1.3');
    });
  });
});

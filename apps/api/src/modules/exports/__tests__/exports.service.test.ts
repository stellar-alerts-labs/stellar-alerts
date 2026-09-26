import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    JWT_SECRET: 'test-jwt-secret',
    EXPORT_STORAGE_DIR: '',
    EXPORT_TTL_SECONDS: 3600,
    EXPORT_DOWNLOAD_URL_TTL_SECONDS: 300,
    EXPORT_MAX_ROWS: 1000,
    EXPORT_BATCH_SIZE: 2,
    EXPORT_MAX_ACTIVE_JOBS_PER_USER: 2,
    EXPORT_STALE_JOB_MS: 30 * 60 * 1000,
  },
  prisma: {
    wallet: { findFirst: vi.fn() },
    payment: { count: vi.fn(), findMany: vi.fn() },
    exportJob: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  enqueueExportJob: vi.fn(),
}));

vi.mock('../../../config/env', () => ({ env: mocks.env }));
vi.mock('../../../lib/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../../../lib/export-queue', () => ({ enqueueExportJob: mocks.enqueueExportJob }));

import { ExportError, ExportsService, resolveExportParams } from '../exports.service';
import { resolveExportFilePath, writeExportFile } from '../../../lib/export-storage';
import { signDownload } from '../../../utils/download-signer';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exports-service-test-'));
const { prisma } = mocks;

function payment(i: number) {
  return {
    id: `pay-${i}`,
    txHash: `tx-${i}`,
    fromAddress: `GFROM${i}`,
    amount: { toString: () => `${i}.5` },
    asset: 'XLM',
    receivedAt: new Date(Date.UTC(2026, 0, i + 1)),
  };
}

function job(overrides: Record<string, any> = {}) {
  return {
    id: 'job-1',
    userId: 'user-1',
    type: 'ledger_csv',
    params: { walletId: null, periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-12-31T23:59:59.999Z', format: null },
    status: 'queued',
    progress: 0,
    rowsTotal: null,
    rowsProcessed: 0,
    fileName: null,
    downloadName: null,
    contentType: null,
    fileSize: null,
    error: null,
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    user: { email: 'owner@example.com' },
    ...overrides,
  };
}

/** Feeds `rows` to payment.findMany in EXPORT_BATCH_SIZE pages. */
function mockPaymentPages(rows: any[]) {
  prisma.payment.count.mockResolvedValue(rows.length);
  let offset = 0;
  prisma.payment.findMany.mockImplementation(async ({ take }: any) => {
    const page = rows.slice(offset, offset + take);
    offset += page.length;
    return page;
  });
}

describe('ExportsService (#321)', () => {
  let service: ExportsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.EXPORT_STORAGE_DIR = path.join(root, `run-${Math.random().toString(36).slice(2)}`);
    mocks.env.EXPORT_MAX_ROWS = 1000;
    service = new ExportsService();
    prisma.exportJob.update.mockResolvedValue({});
    prisma.exportJob.updateMany.mockResolvedValue({ count: 1 });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('resolveExportParams', () => {
    const now = new Date('2026-09-25T12:00:00.000Z');

    it('defaults ledger exports to the trailing 365 days', () => {
      expect(resolveExportParams({ type: 'ledger_pdf' }, now)).toEqual({
        walletId: null,
        periodStart: '2025-09-25T12:00:00.000Z',
        periodEnd: '2026-09-25T12:00:00.000Z',
        format: null,
      });
    });

    it('defaults tax exports to full history and the cointracker format', () => {
      expect(resolveExportParams({ type: 'tax_csv' }, now)).toEqual({
        walletId: null,
        periodStart: null,
        periodEnd: null,
        format: 'cointracker',
      });
    });

    it('treats a date-only periodEnd as inclusive of that whole day', () => {
      const params = resolveExportParams(
        { type: 'ledger_csv', walletId: 'w-1', periodStart: '2026-01-01', periodEnd: '2026-01-31' },
        now,
      );
      expect(params.periodStart).toBe('2026-01-01T00:00:00.000Z');
      expect(params.periodEnd).toBe('2026-01-31T23:59:59.999Z');
      expect(params.walletId).toBe('w-1');
    });
  });

  describe('createExport', () => {
    it('persists a queued job, dispatches it and returns it without a download link', async () => {
      prisma.exportJob.count.mockResolvedValue(0);
      prisma.exportJob.create.mockImplementation(async ({ data }: any) => job({ ...data, params: data.params }));
      mocks.enqueueExportJob.mockResolvedValue('queued');

      const result = await service.createExport('user-1', { type: 'tax_csv', format: 'koinly' });

      expect(prisma.exportJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'user-1', type: 'tax_csv', status: 'queued' }),
      });
      expect(prisma.exportJob.create.mock.calls[0][0].data.params.format).toBe('koinly');
      expect(mocks.enqueueExportJob).toHaveBeenCalledWith('job-1', expect.any(Function));
      expect(result).toMatchObject({ id: 'job-1', status: 'queued', download: null });
    });

    it("rejects a wallet the user doesn't own with 404", async () => {
      prisma.wallet.findFirst.mockResolvedValue(null);

      await expect(service.createExport('user-1', { type: 'ledger_csv', walletId: 'someone-elses' })).rejects.toMatchObject({
        statusCode: 404,
        code: 'WALLET_NOT_FOUND',
      });
      expect(prisma.wallet.findFirst).toHaveBeenCalledWith({
        where: { id: 'someone-elses', userId: 'user-1' },
        select: { id: true },
      });
      expect(prisma.exportJob.create).not.toHaveBeenCalled();
    });

    it('caps concurrent active exports per user with 429', async () => {
      prisma.exportJob.count.mockResolvedValue(2);

      await expect(service.createExport('user-1', { type: 'ledger_csv' })).rejects.toMatchObject({
        statusCode: 429,
        code: 'TOO_MANY_ACTIVE_EXPORTS',
      });
      expect(prisma.exportJob.count).toHaveBeenCalledWith({
        where: { userId: 'user-1', status: { in: ['queued', 'running'] } },
      });
      expect(prisma.exportJob.create).not.toHaveBeenCalled();
    });

    it("hands the dispatcher a callback that processes the job", async () => {
      prisma.exportJob.count.mockResolvedValue(0);
      prisma.exportJob.create.mockResolvedValue(job());
      mocks.enqueueExportJob.mockResolvedValue('inline');
      const spy = vi.spyOn(service, 'processExportJob').mockResolvedValue({ status: 'completed' });

      await service.createExport('user-1', { type: 'ledger_csv' });
      await mocks.enqueueExportJob.mock.calls[0][1]('job-1');

      expect(spy).toHaveBeenCalledWith('job-1');
    });
  });

  describe('getExport / listExports (authorization)', () => {
    it("scopes lookups to the owner and 404s another user's job", async () => {
      prisma.exportJob.findFirst.mockResolvedValue(null);

      await expect(service.getExport('job-1', 'intruder')).rejects.toMatchObject({ statusCode: 404, code: 'EXPORT_NOT_FOUND' });
      expect(prisma.exportJob.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'intruder' } });
    });

    it('attaches a signed download link to a completed, unexpired job', async () => {
      prisma.exportJob.findFirst.mockResolvedValue(
        job({ status: 'completed', fileName: 'job-1.csv', expiresAt: new Date(Date.now() + 3600_000), progress: 100 }),
      );

      const result = await service.getExport('job-1', 'user-1');

      expect(result.download?.url).toMatch(/^\/exports\/job-1\/download\?expires=\d+&sig=[0-9a-f]{64}$/);
      const expiresIn = new Date(result.download!.expiresAt).getTime() - Date.now();
      expect(expiresIn).toBeGreaterThan(290_000);
      expect(expiresIn).toBeLessThanOrEqual(300_000);
    });

    it("never signs a link that outlives the file", () => {
      const now = Date.now();
      const result = service.serialize(
        job({ status: 'completed', fileName: 'job-1.csv', expiresAt: new Date(now + 10_000) }),
        now,
      );
      expect(new Date(result.download!.expiresAt).getTime()).toBeLessThanOrEqual(now + 10_000);
    });

    it.each([
      ['running', { status: 'running' }],
      ['failed', { status: 'failed' }],
      ['expired', { status: 'expired' }],
      ['completed but past expiry', { status: 'completed', fileName: 'job-1.csv', expiresAt: new Date(Date.now() - 1) }],
    ])('does not offer a download link when %s', (_label, overrides) => {
      expect(service.serialize(job(overrides)).download).toBeNull();
    });

    it('lists only the caller\'s jobs, newest first, with paging', async () => {
      prisma.exportJob.findMany.mockResolvedValue([job()]);
      prisma.exportJob.count.mockResolvedValue(7);

      const result = await service.listExports('user-1', { page: 2, pageSize: 5 });

      expect(prisma.exportJob.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
        skip: 5,
        take: 5,
      });
      expect(result).toMatchObject({ page: 2, pageSize: 5, total: 7 });
      expect(result.exports).toHaveLength(1);
    });
  });

  describe('processExportJob (lifecycle + progress)', () => {
    it('claims only queued jobs and skips anything else', async () => {
      prisma.exportJob.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'skipped' });
      expect(prisma.exportJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-1', status: 'queued' },
        data: expect.objectContaining({ status: 'running' }),
      });
      expect(prisma.exportJob.findUnique).not.toHaveBeenCalled();
    });

    it('skips a claimed job whose row vanished', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(null);
      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'skipped' });
    });

    it('generates a ledger CSV in batches, reporting progress, then completes with an expiry', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(job());
      mockPaymentPages([payment(1), payment(2), payment(3), payment(4), payment(5)]);

      const before = Date.now();
      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'completed' });

      // Owner + period scoping on the payments query.
      const where = prisma.payment.count.mock.calls[0][0].where;
      expect(where.wallet).toEqual({ userId: 'user-1' });
      expect(where.receivedAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');

      // Keyset pagination: 3 batches of <=2, cursor from the previous page.
      expect(prisma.payment.findMany).toHaveBeenCalledTimes(3);
      expect(prisma.payment.findMany.mock.calls[1][0]).toMatchObject({ skip: 1, cursor: { id: 'pay-2' } });

      const progressUpdates = prisma.exportJob.update.mock.calls
        .map(([args]: any) => args.data)
        .filter((data: any) => data.progress !== undefined && data.status === undefined);
      expect(progressUpdates.map((d: any) => d.progress)).toEqual([36, 72, 90]);
      expect(progressUpdates.map((d: any) => d.rowsProcessed)).toEqual([2, 4, 5]);

      const final = prisma.exportJob.update.mock.calls.at(-1)![0].data;
      expect(final).toMatchObject({
        status: 'completed',
        progress: 100,
        rowsProcessed: 5,
        fileName: 'job-1.csv',
        contentType: 'text/csv; charset=utf-8',
        downloadName: 'ledger-statement-2026-01-01.csv',
      });
      expect(final.expiresAt.getTime() - final.completedAt.getTime()).toBe(3600 * 1000);
      expect(final.completedAt.getTime()).toBeGreaterThanOrEqual(before);

      const csv = fs.readFileSync(resolveExportFilePath('job-1.csv'), 'utf8').split('\n');
      expect(csv[0]).toBe('Date,Transaction Hash,From Address,Amount,Asset');
      expect(csv).toHaveLength(6);
      expect(final.fileSize).toBe(fs.statSync(resolveExportFilePath('job-1.csv')).size);
    });

    it('generates a PDF with wallet metadata scoped to the owner', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(
        job({ type: 'ledger_pdf', params: { ...job().params, walletId: 'w-1' } }),
      );
      prisma.wallet.findFirst.mockResolvedValue({ publicKey: 'GWALLET', label: 'Treasury' });
      mockPaymentPages([payment(1)]);

      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'completed' });

      expect(prisma.wallet.findFirst).toHaveBeenCalledWith({
        where: { id: 'w-1', userId: 'user-1' },
        select: { publicKey: true, label: true },
      });
      expect(prisma.payment.count.mock.calls[0][0].where).toMatchObject({ walletId: 'w-1', wallet: { userId: 'user-1' } });
      const bytes = fs.readFileSync(resolveExportFilePath('job-1.pdf'));
      expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
      expect(prisma.exportJob.update.mock.calls.at(-1)![0].data.contentType).toBe('application/pdf');
    });

    it('generates a tax CSV in the requested format for the full history', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(
        job({ type: 'tax_csv', params: { walletId: null, periodStart: null, periodEnd: null, format: 'koinly' } }),
      );
      mockPaymentPages([payment(1), payment(2)]);

      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'completed' });

      expect(prisma.payment.count.mock.calls[0][0].where.receivedAt).toBeUndefined();
      const final = prisma.exportJob.update.mock.calls.at(-1)![0].data;
      expect(final.downloadName).toBe('tax-export-koinly.csv');
      expect(fs.readFileSync(resolveExportFilePath('job-1.csv'), 'utf8').length).toBeGreaterThan(0);
    });

    it('completes an empty export with a header-only file', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(job());
      mockPaymentPages([]);

      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'completed' });
      expect(fs.readFileSync(resolveExportFilePath('job-1.csv'), 'utf8')).toBe('Date,Transaction Hash,From Address,Amount,Asset');
    });

    it('fails with a user-facing reason when the export exceeds the row limit', async () => {
      mocks.env.EXPORT_MAX_ROWS = 3;
      prisma.exportJob.findUnique.mockResolvedValue(job());
      prisma.payment.count.mockResolvedValue(10);

      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'failed' });

      expect(prisma.payment.findMany).not.toHaveBeenCalled();
      const final = prisma.exportJob.update.mock.calls.at(-1)![0].data;
      expect(final.status).toBe('failed');
      expect(final.error).toMatch(/10 payments, above the 3 row limit/);
    });

    it('records a generic failure (not internals) and removes no stray file when the DB errors', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(job());
      prisma.payment.count.mockResolvedValue(3);
      prisma.payment.findMany.mockRejectedValue(new Error('connection to 10.0.0.5:5432 refused'));

      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'failed' });

      const final = prisma.exportJob.update.mock.calls.at(-1)![0].data;
      expect(final).toMatchObject({ status: 'failed', fileName: null, error: 'Export generation failed. Please try again.' });
      expect(fs.existsSync(mocks.env.EXPORT_STORAGE_DIR)).toBe(false);
    });

    it('deletes the written file if marking the job completed fails', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(job());
      mockPaymentPages([payment(1)]);
      prisma.exportJob.update.mockImplementation(async ({ data }: any) => {
        if (data.status === 'completed') throw new Error('write conflict');
        return {};
      });

      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'failed' });
      expect(fs.existsSync(resolveExportFilePath('job-1.csv'))).toBe(false);
    });

    it('never throws even if recording the failure also fails', async () => {
      prisma.exportJob.findUnique.mockRejectedValue(new Error('db down'));
      prisma.exportJob.update.mockRejectedValue(new Error('db still down'));

      await expect(service.processExportJob('job-1')).resolves.toEqual({ status: 'failed' });
    });
  });

  describe('resolveDownload', () => {
    const futureExpiry = () => new Date(Date.now() + 3600_000);

    async function completedJobWithFile(overrides: Record<string, any> = {}) {
      const record = job({
        status: 'completed',
        fileName: 'job-1.csv',
        downloadName: 'ledger.csv',
        contentType: 'text/csv; charset=utf-8',
        fileSize: 3,
        expiresAt: futureExpiry(),
        ...overrides,
      });
      await writeExportFile('job-1.csv', 'a,b');
      prisma.exportJob.findUnique.mockResolvedValue(record);
      return record;
    }

    it('returns the file for a valid link', async () => {
      await completedJobWithFile();
      const { expires, sig } = signDownload('test-jwt-secret', 'job-1', 'user-1', 60);

      const file = await service.resolveDownload('job-1', expires, sig);

      expect(file).toEqual({
        filePath: resolveExportFilePath('job-1.csv'),
        fileSize: 3,
        contentType: 'text/csv; charset=utf-8',
        downloadName: 'ledger.csv',
      });
    });

    it('rejects a link signed for another user (403)', async () => {
      await completedJobWithFile();
      const { expires, sig } = signDownload('test-jwt-secret', 'job-1', 'intruder', 60);

      await expect(service.resolveDownload('job-1', expires, sig)).rejects.toMatchObject({ statusCode: 403, code: 'INVALID_DOWNLOAD_LINK' });
    });

    it('answers an unknown job exactly like a bad signature (403, no enumeration)', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(null);
      const { expires, sig } = signDownload('test-jwt-secret', 'nope', 'user-1', 60);

      await expect(service.resolveDownload('nope', expires, sig)).rejects.toMatchObject({ statusCode: 403, code: 'INVALID_DOWNLOAD_LINK' });
    });

    it('rejects an elapsed link (403 DOWNLOAD_LINK_EXPIRED)', async () => {
      await completedJobWithFile();
      const { expires, sig } = signDownload('test-jwt-secret', 'job-1', 'user-1', 60);

      await expect(service.resolveDownload('job-1', expires, sig, Date.now() + 61_000)).rejects.toMatchObject({
        statusCode: 403,
        code: 'DOWNLOAD_LINK_EXPIRED',
      });
    });

    it.each([
      ['marked expired', { status: 'expired', fileName: null }],
      ['past its expiry but not yet cleaned up', { expiresAt: new Date(Date.now() - 1000) }],
    ])('returns 410 for an export %s', async (_label, overrides) => {
      await completedJobWithFile(overrides);
      const { expires, sig } = signDownload('test-jwt-secret', 'job-1', 'user-1', 60);

      await expect(service.resolveDownload('job-1', expires, sig)).rejects.toMatchObject({ statusCode: 410, code: 'EXPORT_EXPIRED' });
    });

    it('returns 410 when the file is missing from disk', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(
        job({ status: 'completed', fileName: 'job-1.csv', expiresAt: futureExpiry() }),
      );
      const { expires, sig } = signDownload('test-jwt-secret', 'job-1', 'user-1', 60);

      await expect(service.resolveDownload('job-1', expires, sig)).rejects.toMatchObject({ statusCode: 410 });
    });

    it('returns 409 for a job that is not finished yet', async () => {
      prisma.exportJob.findUnique.mockResolvedValue(job({ status: 'running' }));
      const { expires, sig } = signDownload('test-jwt-secret', 'job-1', 'user-1', 60);

      await expect(service.resolveDownload('job-1', expires, sig)).rejects.toMatchObject({ statusCode: 409, code: 'EXPORT_NOT_READY' });
    });
  });

  describe('cleanupExpiredExports', () => {
    it('deletes expired files, marks jobs expired, fails stale jobs and sweeps temp files', async () => {
      await writeExportFile('job-old.csv', 'x');
      const tmp = path.join(mocks.env.EXPORT_STORAGE_DIR, 'crashed.pdf.tmp');
      fs.writeFileSync(tmp, 'partial');
      const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(tmp, longAgo, longAgo);

      prisma.exportJob.findMany.mockResolvedValue([
        { id: 'job-old', fileName: 'job-old.csv' },
        { id: 'job-gone', fileName: 'job-gone.csv' },
      ]);
      prisma.exportJob.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 4 });

      const now = new Date();
      const report = await service.cleanupExpiredExports(now);

      expect(report).toEqual({ expired: 2, filesDeleted: 1, staleFailed: 4, tempFilesRemoved: 1 });
      expect(fs.readdirSync(mocks.env.EXPORT_STORAGE_DIR)).toEqual([]);
      expect(prisma.exportJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'completed', expiresAt: { lte: now } } }),
      );
      expect(prisma.exportJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-old', status: 'completed' },
        data: { status: 'expired', fileName: null },
      });
      const staleCall = prisma.exportJob.updateMany.mock.calls[2][0];
      expect(staleCall.where.status).toEqual({ in: ['queued', 'running'] });
      expect(staleCall.where.updatedAt.lt.getTime()).toBe(now.getTime() - 30 * 60 * 1000);
      expect(staleCall.data.status).toBe('failed');
    });

    it('keeps going when one job cannot be expired', async () => {
      prisma.exportJob.findMany.mockResolvedValue([
        { id: 'bad', fileName: '../../etc/passwd' },
        { id: 'ok', fileName: null },
      ]);
      prisma.exportJob.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      const report = await service.cleanupExpiredExports();

      expect(report.expired).toBe(1);
      expect(report.filesDeleted).toBe(0);
    });
  });

  it('ExportError carries a status code and machine-readable code', () => {
    const err = new ExportError('nope', 418, 'TEAPOT');
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ message: 'nope', statusCode: 418, code: 'TEAPOT', name: 'ExportError' });
    expect(new ExportError('default')).toMatchObject({ statusCode: 400, code: 'EXPORT_ERROR' });
  });
});

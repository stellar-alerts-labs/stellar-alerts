import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  processExportJob: vi.fn(),
  cleanupExpiredExports: vi.fn(),
  workerCtor: vi.fn(),
  workerOn: vi.fn(),
  workerClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config/env', () => ({
  env: { EXPORT_WORKER_CONCURRENCY: 3, EXPORT_CLEANUP_INTERVAL_MS: 60_000 },
}));
vi.mock('../../lib/prisma', () => ({ prisma: { $disconnect: vi.fn() } }));
vi.mock('../../lib/queue', () => ({ createRedisConnectionConfig: () => ({ host: 'localhost', port: 6379 }) }));
vi.mock('../../lib/export-queue', () => ({ EXPORT_QUEUE_NAME: 'export-jobs' }));
vi.mock('../../modules/exports/exports.service', () => ({
  exportsService: {
    processExportJob: mocks.processExportJob,
    cleanupExpiredExports: mocks.cleanupExpiredExports,
  },
}));
vi.mock('bullmq', () => ({
  Worker: class {
    on = mocks.workerOn;
    close = mocks.workerClose;
    constructor(...args: any[]) {
      mocks.workerCtor(...args);
    }
  },
}));

import { exportJobProcessor, exportWorkerLifecycle, runExportCleanupPass, runExportWorker } from '../export.worker';

describe('export worker (#321)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates each queue job to ExportsService.processExportJob', async () => {
    mocks.processExportJob.mockResolvedValue({ status: 'completed' });

    await expect(exportJobProcessor({ data: { exportJobId: 'job-9' } })).resolves.toEqual({ status: 'completed' });
    expect(mocks.processExportJob).toHaveBeenCalledWith('job-9');
  });

  it('runs a cleanup pass through the lifecycle manager', async () => {
    mocks.cleanupExpiredExports.mockResolvedValue({ expired: 1, filesDeleted: 1, staleFailed: 0, tempFilesRemoved: 0 });

    await expect(runExportCleanupPass()).resolves.toMatchObject({ expired: 1 });
  });

  it('starts a BullMQ worker, runs cleanup immediately and closes the worker on drain', async () => {
    mocks.cleanupExpiredExports.mockRejectedValueOnce(new Error('db blip'));

    await runExportWorker();

    expect(mocks.workerCtor).toHaveBeenCalledWith('export-jobs', exportJobProcessor, expect.objectContaining({ concurrency: 3 }));
    // A failing cleanup pass is logged, not fatal.
    expect(mocks.cleanupExpiredExports).toHaveBeenCalledTimes(1);
    expect(exportWorkerLifecycle.isRunning()).toBe(true);

    await exportWorkerLifecycle.drainAndShutdown('test');
    expect(mocks.workerClose).toHaveBeenCalled();
    expect(exportWorkerLifecycle.isStopped()).toBe(true);
  });
});

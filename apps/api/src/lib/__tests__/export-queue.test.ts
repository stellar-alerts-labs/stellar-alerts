import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { EXPORT_WORKER_ENABLED: 'true' },
  add: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  queueCtor: vi.fn(),
  registerRedisCleanupTask: vi.fn(),
}));

vi.mock('../../config/env', () => ({ env: mocks.env }));
vi.mock('../queue', () => ({ createRedisConnectionConfig: () => ({ host: 'localhost', port: 6379 }) }));
vi.mock('../redis', () => ({ registerRedisCleanupTask: mocks.registerRedisCleanupTask }));
vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.add;
    close = mocks.close;
    constructor(...args: any[]) {
      mocks.queueCtor(...args);
    }
  },
}));

import { EXPORT_QUEUE_NAME, enqueueExportJob, getExportQueue, resetExportQueueForTests } from '../export-queue';

const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

describe('export-queue (#321)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetExportQueueForTests();
    mocks.env.EXPORT_WORKER_ENABLED = 'true';
  });

  it('creates the queue lazily, once, with a Redis cleanup hook', async () => {
    expect(mocks.queueCtor).not.toHaveBeenCalled();

    const first = getExportQueue();
    const second = getExportQueue();

    expect(first).toBe(second);
    expect(mocks.queueCtor).toHaveBeenCalledTimes(1);
    expect(mocks.queueCtor.mock.calls[0][0]).toBe(EXPORT_QUEUE_NAME);
    expect(mocks.queueCtor.mock.calls[0][1].defaultJobOptions.attempts).toBe(1);

    await mocks.registerRedisCleanupTask.mock.calls[0][0]();
    expect(mocks.close).toHaveBeenCalled();
  });

  it('enqueues with a deterministic job id and does not run inline', async () => {
    mocks.add.mockResolvedValue({ id: 'export-job-1' });
    const runInline = vi.fn().mockResolvedValue(undefined);

    const mode = await enqueueExportJob('job-1', runInline);
    await flushImmediate();

    expect(mode).toBe('queued');
    expect(mocks.add).toHaveBeenCalledWith('generate-export', { exportJobId: 'job-1' }, { jobId: 'export-job-1' });
    expect(runInline).not.toHaveBeenCalled();
  });

  it('falls back to inline processing when Redis rejects the job', async () => {
    mocks.add.mockRejectedValue(new Error('ECONNREFUSED'));
    const runInline = vi.fn().mockResolvedValue(undefined);

    const mode = await enqueueExportJob('job-2', runInline);
    await flushImmediate();

    expect(mode).toBe('inline');
    expect(runInline).toHaveBeenCalledWith('job-2');
  });

  it('falls back to inline processing when enqueueing hangs', async () => {
    vi.useFakeTimers();
    try {
      mocks.add.mockReturnValue(new Promise(() => {}));
      const runInline = vi.fn().mockResolvedValue(undefined);

      const pending = enqueueExportJob('job-3', runInline);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await pending).toBe('inline');
      await vi.runAllTimersAsync();
      expect(runInline).toHaveBeenCalledWith('job-3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs inline without touching Redis when the export worker is disabled', async () => {
    mocks.env.EXPORT_WORKER_ENABLED = 'false';
    const runInline = vi.fn().mockRejectedValue(new Error('boom'));

    const mode = await enqueueExportJob('job-4', runInline);
    await flushImmediate();

    expect(mode).toBe('inline');
    expect(mocks.queueCtor).not.toHaveBeenCalled();
    // A rejected inline run is logged, never an unhandled rejection.
    expect(runInline).toHaveBeenCalledWith('job-4');
  });
});

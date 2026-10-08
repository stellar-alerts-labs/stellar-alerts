import { Worker } from 'bullmq';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { createRedisConnectionConfig } from '../lib/queue';
import { EXPORT_QUEUE_NAME, ExportQueueJobData } from '../lib/export-queue';
import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { exportsService } from '../modules/exports/exports.service';

/**
 * Export worker (#321): consumes the `export-jobs` BullMQ queue, generates
 * CSV/PDF files with progress tracking, and periodically expires old files
 * and fails stuck jobs. Run standalone (`npm run dev:exports`) or under the
 * supervisor (spawned when EXPORT_WORKER_ENABLED=true).
 */

const log = createLogger({ module: 'ExportWorker' });

export const exportWorkerLifecycle = new WorkerLifecycleManager({
  workerName: 'ExportWorker',
  drainTimeoutMs: 30_000,
  maxInFlight: 1,
  autoRegisterSignals: true,
});

export async function exportJobProcessor(job: { data: ExportQueueJobData }) {
  return exportsService.processExportJob(job.data.exportJobId);
}

export async function runExportCleanupPass() {
  return exportWorkerLifecycle.runTask(() => exportsService.cleanupExpiredExports());
}

/**
 * Replies to the supervisor's IPC pings so the worker is not considered
 * frozen and killed (see workers/supervisor.ts heartbeat logic).
 */
function registerSupervisorHeartbeat() {
  process.on('message', (message: any) => {
    if (message?.type === 'ping') {
      process.send?.({ type: 'pong' });
    }
  });
}

export async function runExportWorker() {
  const worker = new Worker<ExportQueueJobData>(EXPORT_QUEUE_NAME, exportJobProcessor, {
    connection: createRedisConnectionConfig() as any,
    concurrency: env.EXPORT_WORKER_CONCURRENCY,
  });
  worker.on('failed', (job, err) => {
    log.error({ exportJobId: job?.data?.exportJobId, err: err?.message }, 'Export queue job failed');
  });

  // Closing the BullMQ worker waits for in-flight exports to finish.
  exportWorkerLifecycle.registerCleanup('bullmq', async () => {
    await worker.close();
  });
  exportWorkerLifecycle.registerCleanup('prisma', async () => {
    await prisma.$disconnect();
  });

  const cleanup = async () => {
    try {
      await runExportCleanupPass();
    } catch (err: any) {
      log.error({ err: err?.message }, 'Export cleanup pass failed');
    }
  };
  await cleanup();
  exportWorkerLifecycle.trackInterval(setInterval(cleanup, env.EXPORT_CLEANUP_INTERVAL_MS));
  exportWorkerLifecycle.markRunning();

  log.info(
    { concurrency: env.EXPORT_WORKER_CONCURRENCY, cleanupIntervalMs: env.EXPORT_CLEANUP_INTERVAL_MS },
    'Export worker started',
  );
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runExportWorker().catch((err) => {
    log.error({ err: err?.message }, 'Export worker failed to start');
    process.exit(1);
  });
}

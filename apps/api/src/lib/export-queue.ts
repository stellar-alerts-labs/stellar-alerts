import { Queue } from 'bullmq';
import { env } from '../config/env';
import { createLogger } from './logger';
import { createRedisConnectionConfig } from './queue';
import { registerRedisCleanupTask } from './redis';

/**
 * BullMQ queue feeding the export worker (workers/export.worker.ts) (#321).
 *
 * The queue is created lazily so importing this module never opens a Redis
 * connection. The queue only carries the ExportJob id — the job row in
 * Postgres is the source of truth, and the processor atomically claims
 * `queued` rows, so a job delivered twice (or run by the inline fallback and
 * the worker) is still generated only once.
 */

export const EXPORT_QUEUE_NAME = 'export-jobs';
const ENQUEUE_TIMEOUT_MS = 5_000;

export interface ExportQueueJobData {
  exportJobId: string;
}

export type ExportDispatchMode = 'queued' | 'inline';

const log = createLogger({ module: 'ExportQueue' });

let exportQueue: Queue<ExportQueueJobData> | null = null;

export function getExportQueue(): Queue<ExportQueueJobData> {
  if (!exportQueue) {
    exportQueue = new Queue<ExportQueueJobData>(EXPORT_QUEUE_NAME, {
      connection: createRedisConnectionConfig() as any,
      defaultJobOptions: {
        // Failures are recorded on the ExportJob row; the user re-requests.
        attempts: 1,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
    const queue = exportQueue;
    registerRedisCleanupTask(async () => {
      await queue.close().catch(() => {});
    });
  }
  return exportQueue;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Hands an export job to the worker. When the worker is disabled
 * (EXPORT_WORKER_ENABLED=false) or Redis is unavailable, the job is run
 * in-process on the next tick instead so exports keep working.
 */
export async function enqueueExportJob(
  exportJobId: string,
  runInline: (exportJobId: string) => Promise<unknown>,
): Promise<ExportDispatchMode> {
  const scheduleInline = () => {
    setImmediate(() => {
      runInline(exportJobId).catch((err: any) => {
        log.error({ exportJobId, err: err?.message }, 'Inline export processing failed');
      });
    });
  };

  if (env.EXPORT_WORKER_ENABLED !== 'true') {
    scheduleInline();
    return 'inline';
  }

  try {
    await withTimeout(
      getExportQueue().add('generate-export', { exportJobId }, { jobId: `export-${exportJobId}` }),
      ENQUEUE_TIMEOUT_MS,
    );
    return 'queued';
  } catch (err: any) {
    log.warn({ exportJobId, err: err?.message }, 'Could not enqueue export job; processing inline');
    scheduleInline();
    return 'inline';
  }
}

/** Test hook: forget the memoized queue. */
export function resetExportQueueForTests(): void {
  exportQueue = null;
}

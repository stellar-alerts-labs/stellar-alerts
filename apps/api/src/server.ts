import { env } from './config/env';
import { buildApp } from './app';
import { prisma, connectWithRetry } from './lib/prisma';
import { startTelemetry, shutdownTelemetry } from './lib/telemetry';
import { closeRedisConnections } from './lib/redis';

const start = async () => {
  try {
    await connectWithRetry();
    await startTelemetry();
    const app = await buildApp();
    const port = parseInt(env.PORT, 10);

    await app.listen({ port, host: '0.0.0.0' });
    console.log(`🚀 Server listening on http://localhost:${port}`);

    if (process.env.START_WORKER !== 'false') {
      const { runWatcher } = await import('./workers/watcher.worker');
      runWatcher().catch((err) => console.error('⚠️ Watcher worker error:', err));
    }

    // Without a dedicated export worker, exports run in-process (see
    // lib/export-queue.ts), so expiry/cleanup has to run here too.
    if (env.EXPORT_WORKER_ENABLED !== 'true') {
      const { exportsService } = await import('./modules/exports/exports.service');
      const cleanupExports = () =>
        exportsService.cleanupExpiredExports().catch((err) => console.error('⚠️ Export cleanup error:', err));
      void cleanupExports();
      setInterval(cleanupExports, env.EXPORT_CLEANUP_INTERVAL_MS).unref();
    }

    const shutdown = async () => {
      console.log('🛑 Graceful shutdown initiated...');
      setTimeout(() => {
        console.error('⚠️ Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 5000);

      await app.close();
      await prisma.$disconnect();
      await shutdownTelemetry();
      await closeRedisConnections();
      console.log('✅ Server, Prisma, and Redis closed cleanly');
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();

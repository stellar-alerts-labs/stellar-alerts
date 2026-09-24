import { env } from './config/env';
import { buildApp } from './app';
import { prisma, connectWithRetry } from './lib/prisma';
import { startTelemetry, shutdownTelemetry } from './lib/telemetry';
import { createLogger } from './lib/logger';

const log = createLogger({ module: 'ApiServer' });

const start = async () => {
  try {
    await connectWithRetry();
    await startTelemetry();
    const app = await buildApp();
    const port = parseInt(env.PORT, 10);

    await app.listen({ port, host: '0.0.0.0' });
    log.info({ port }, 'Server listening');

    if (process.env.START_WORKER !== 'false') {
      const { runWatcher } = await import('./workers/watcher.worker');
      runWatcher().catch((err) =>
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Watcher worker error')
      );
    }

    const shutdown = async () => {
      log.info('Graceful shutdown initiated');
      setTimeout(() => {
        log.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 5000);

      await app.close();
      await prisma.$disconnect();
      await shutdownTelemetry();
      log.info('Server and Prisma closed cleanly');
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

start();

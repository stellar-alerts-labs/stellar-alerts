import { env } from './config/env';
import { buildApp } from './app';
import { connectWithRetry, prisma } from './lib/prisma';

const start = async () => {
  try {
    await connectWithRetry();
    const app = await buildApp();
    const port = parseInt(env.PORT, 10);

    await app.listen({ port, host: '0.0.0.0' });
    console.log(`🚀 Server listening on http://localhost:${port}`);

    // Issue #20: Graceful shutdown — handle SIGTERM and SIGINT
    const shutdown = async (signal: string) => {
      console.log(`[Server] Received ${signal}. Shutting down gracefully...`);

      // 5-second safety timeout: force exit if shutdown hangs
      const safetyTimer = setTimeout(() => {
        console.error('[Server] Graceful shutdown timed out after 5 s. Forcing exit.');
        process.exit(1);
      }, 5000);

      // Ensure the timer does not keep the event loop alive
      safetyTimer.unref();

      try {
        await app.close();
        await prisma.$disconnect();
        clearTimeout(safetyTimer);
        console.log('[Server] Shutdown complete.');
        process.exit(0);
      } catch (err) {
        console.error('[Server] Error during shutdown:', err);
        clearTimeout(safetyTimer);
        process.exit(1);
      }
    };

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();

/**
 * Scrape endpoint for worker processes.
 *
 * The dispatcher worker does not serve HTTP, so the Prometheus series it
 * collects (webhook dispatch phase timings, attempt outcomes) would otherwise
 * only be visible on the API server — and only for the fraction of dispatches
 * that fall back to in-process delivery when BullMQ is unavailable. This
 * exposes the same registry the API's `/metrics` route serves, so a worker pod
 * can be scraped directly and its delivery numbers are complete.
 *
 * Opt-in via `WORKER_METRICS_ENABLED`; off by default because a worker pod
 * normally has no ServiceMonitor and an idle listener is just one more thing to
 * reason about during an incident.
 */
import http from 'node:http';
import { env, envFlag } from '../config/env';
import { generatePrometheusMetrics } from '../plugins/metrics';
import { createLogger } from './logger';

const log = createLogger({ module: 'WorkerMetrics' });

let server: http.Server | null = null;

export function isWorkerMetricsEnabled(): boolean {
  return envFlag(env.WORKER_METRICS_ENABLED, false);
}

/**
 * Starts the scrape server. Returns `null` when disabled or already running, so
 * callers can invoke it unconditionally on worker boot.
 *
 * A bind failure is logged and swallowed: failing to expose metrics must never
 * take a worker down.
 */
export function startWorkerMetricsServer(): http.Server | null {
  if (!isWorkerMetricsEnabled()) return null;
  if (server) return server;

  const created = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/metrics' || path === '/') {
      const body = generatePrometheusMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
      return;
    }

    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  created.on('error', (err: NodeJS.ErrnoException) => {
    log.error({ err: err.message }, 'Worker metrics server error');
    if (err.code === 'EADDRINUSE') {
      log.error(
        { port: env.WORKER_METRICS_PORT },
        'Port already in use; worker metrics endpoint will not be available',
      );
    }
  });

  const port = env.WORKER_METRICS_PORT;
  created.listen(port, () => {
    log.info({ port }, 'Worker metrics endpoint listening');
  });

  server = created;
  return server;
}

export async function stopWorkerMetricsServer(): Promise<void> {
  if (!server) return;
  const closing = server;
  server = null;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
}

import { fork, ChildProcess } from 'child_process';
import path from 'path';

// How often the supervisor pings a worker over IPC to check it's alive.
const PING_INTERVAL_MS = 10_000;

// How long a worker has to answer a ping before it's considered frozen.
const PONG_TIMEOUT_MS = 10_000;

// Delay before respawning a worker after it exits, to avoid a hot crash loop.
const RESTART_DELAY_MS = 1_000;

interface SupervisedWorker {
  name: string;
  filename: string;
  child: ChildProcess | null;
  pingTimer: NodeJS.Timeout | null;
  pongTimeout: NodeJS.Timeout | null;
  restartCount: number;
}

/**
 * Resolves the on-disk entry point for a worker relative to this file.
 * Workers run as plain .js under `node` once built (dist/), but as .ts
 * under `tsx` in dev, so the child needs the same tsx loader hooked in via
 * execArgv when running from source.
 */
function resolveWorkerScript(filename: string): { scriptPath: string; execArgv: string[] } {
  const isTs = __filename.endsWith('.ts');
  const ext = isTs ? '.ts' : '.js';
  return {
    scriptPath: path.join(__dirname, `${filename}${ext}`),
    execArgv: isTs ? ['--require', 'tsx/cjs'] : [],
  };
}

export class WorkerSupervisor {
  private workers = new Map<string, SupervisedWorker>();

  spawn(name: string, filename: string): void {
    const { scriptPath, execArgv } = resolveWorkerScript(filename);
    const worker: SupervisedWorker = this.workers.get(name) ?? {
      name,
      filename,
      child: null,
      pingTimer: null,
      pongTimeout: null,
      restartCount: 0,
    };

    const child = fork(scriptPath, [], { execArgv });
    worker.child = child;
    this.workers.set(name, worker);

    console.log(`[Supervisor] 🚀 Spawned worker "${name}" (pid ${child.pid})`);

    child.on('message', (message: any) => {
      if (message?.type === 'pong') {
        this.clearPongTimeout(worker);
      }
    });

    child.on('exit', (code, signal) => {
      console.error(
        `[Supervisor] ⚠️ Worker "${name}" (pid ${child.pid}) exited — code=${code} signal=${signal}. ` +
          `Restart #${worker.restartCount + 1} scheduled.`
      );
      this.stopHeartbeat(worker);
      worker.child = null;
      worker.restartCount += 1;
      setTimeout(() => this.spawn(name, filename), RESTART_DELAY_MS);
    });

    child.on('error', (err) => {
      console.error(`[Supervisor] Worker "${name}" (pid ${child.pid}) process error:`, err);
    });

    this.startHeartbeat(worker);
  }

  getRestartCount(name: string): number {
    return this.workers.get(name)?.restartCount ?? 0;
  }

  stopAll(): void {
    for (const worker of this.workers.values()) {
      this.stopHeartbeat(worker);
      worker.child?.removeAllListeners('exit');
      worker.child?.kill('SIGTERM');
      worker.child = null;
    }
  }

  private startHeartbeat(worker: SupervisedWorker): void {
    worker.pingTimer = setInterval(() => {
      const child = worker.child;
      if (!child || child.killed) return;

      child.send({ type: 'ping' });

      worker.pongTimeout = setTimeout(() => {
        console.error(
          `[Supervisor] ⏱️ Worker "${worker.name}" (pid ${child.pid}) missed its heartbeat and appears frozen. ` +
            `Killing so it can be restarted.`
        );
        child.kill('SIGKILL');
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(worker: SupervisedWorker): void {
    if (worker.pingTimer) clearInterval(worker.pingTimer);
    this.clearPongTimeout(worker);
    worker.pingTimer = null;
  }

  private clearPongTimeout(worker: SupervisedWorker): void {
    if (worker.pongTimeout) {
      clearTimeout(worker.pongTimeout);
      worker.pongTimeout = null;
    }
  }
}

export function startSupervisor(): WorkerSupervisor {
  const supervisor = new WorkerSupervisor();
  supervisor.spawn('watcher', 'watcher.worker');
  return supervisor;
}

if (require.main === module) {
  startSupervisor();
}

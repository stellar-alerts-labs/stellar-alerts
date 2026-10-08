import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export interface StreamCursor {
  /** Opaque resume token sent to the server as `?cursor=` (paging token, or payment id). */
  cursor: string;
  /** Id of the last payment fully handled — seeds duplicate suppression after a restart. */
  lastId: string;
  updatedAt: string;
}

interface CursorFile extends StreamCursor {
  version: 1;
}

export function defaultCursorFile(walletId?: string): string {
  const name = walletId ? `stream-cursor-${walletId.replace(/[^A-Za-z0-9_-]/g, '_')}.json` : 'stream-cursor.json';
  return path.join(os.homedir(), '.stellar-alerts', name);
}

/**
 * Persists the stream checkpoint on disk. Writes go to a temp file that is then
 * renamed over the target, so a crash mid-write never leaves a truncated cursor.
 */
export class CursorStore {
  constructor(
    readonly filePath: string,
    private readonly onWarning: (message: string) => void = () => {}
  ) {}

  async load(): Promise<StreamCursor | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.onWarning(`Could not read cursor file ${this.filePath}: ${(error as Error).message}`);
      }
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<CursorFile>;
      if (parsed.version !== 1 || typeof parsed.cursor !== 'string' || !parsed.cursor || typeof parsed.lastId !== 'string') {
        throw new Error('unexpected shape');
      }
      return { cursor: parsed.cursor, lastId: parsed.lastId, updatedAt: String(parsed.updatedAt ?? '') };
    } catch {
      this.onWarning(`Ignoring corrupted cursor file ${this.filePath}; starting from the live stream.`);
      return null;
    }
  }

  async save(checkpoint: Omit<StreamCursor, 'updatedAt'>): Promise<void> {
    const body: CursorFile = { version: 1, ...checkpoint, updatedAt: new Date().toISOString() };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(body), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

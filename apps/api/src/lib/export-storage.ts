import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { env } from '../config/env';

/**
 * Local-disk storage for generated export files (#321).
 *
 * Files are addressed only by a server-generated basename (`<jobId>.<ext>`);
 * anything that is not a plain basename is rejected so a stored value can
 * never be turned into a path traversal. Writes go to a `.tmp` sibling first
 * and are renamed into place so a download never sees a half-written file.
 */

const SAFE_FILE_NAME = /^[A-Za-z0-9_-]+\.(csv|pdf)$/;
export const TMP_SUFFIX = '.tmp';

export function getExportStorageDir(): string {
  return env.EXPORT_STORAGE_DIR || path.join(os.tmpdir(), 'stellar-alerts-exports');
}

export function resolveExportFilePath(fileName: string): string {
  if (!SAFE_FILE_NAME.test(fileName)) {
    throw new Error(`Refusing unsafe export file name: ${fileName}`);
  }
  return path.join(getExportStorageDir(), fileName);
}

export async function writeExportFile(fileName: string, data: Buffer | string): Promise<number> {
  const finalPath = resolveExportFilePath(fileName);
  const tmpPath = `${finalPath}${TMP_SUFFIX}`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tmpPath, data, { mode: 0o600 });
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
  const stat = await fs.stat(finalPath);
  return stat.size;
}

export async function exportFileExists(fileName: string): Promise<boolean> {
  try {
    const stat = await fs.stat(resolveExportFilePath(fileName));
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Deletes an export file; returns false when it was already gone. */
export async function deleteExportFile(fileName: string): Promise<boolean> {
  const filePath = resolveExportFilePath(fileName);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Removes `.tmp` leftovers from writes interrupted by a crash, once they are
 * older than `olderThanMs`. Returns the number of files removed.
 */
export async function sweepStaleTempFiles(olderThanMs: number, now: number = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(getExportStorageDir());
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(TMP_SUFFIX)) continue;
    const filePath = path.join(getExportStorageDir(), entry);
    try {
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs >= olderThanMs) {
        await fs.rm(filePath, { force: true });
        removed += 1;
      }
    } catch {
      // Raced with another sweeper or the writer's own cleanup — ignore.
    }
  }
  return removed;
}

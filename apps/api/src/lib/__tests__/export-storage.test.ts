import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const mockEnv = vi.hoisted(() => ({ EXPORT_STORAGE_DIR: '' }));
vi.mock('../../config/env', () => ({ env: mockEnv }));

import {
  deleteExportFile,
  exportFileExists,
  getExportStorageDir,
  resolveExportFilePath,
  sweepStaleTempFiles,
  writeExportFile,
} from '../export-storage';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-storage-test-'));

describe('export-storage (#321)', () => {
  beforeEach(() => {
    mockEnv.EXPORT_STORAGE_DIR = path.join(root, `run-${Math.random().toString(36).slice(2)}`);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('defaults to a directory under the OS temp dir', () => {
    mockEnv.EXPORT_STORAGE_DIR = '';
    expect(getExportStorageDir()).toBe(path.join(os.tmpdir(), 'stellar-alerts-exports'));
  });

  it('writes a file atomically (no .tmp left behind) and reports its size', async () => {
    const size = await writeExportFile('job-1.csv', 'a,b\n1,2');

    expect(size).toBe(7);
    expect(fs.readFileSync(resolveExportFilePath('job-1.csv'), 'utf8')).toBe('a,b\n1,2');
    expect(fs.readdirSync(mockEnv.EXPORT_STORAGE_DIR)).toEqual(['job-1.csv']);
    expect(await exportFileExists('job-1.csv')).toBe(true);
  });

  it.each(['../escape.csv', 'nested/job.csv', 'job.exe', '..\\job.pdf', '', 'job.csv.tmp'])(
    'refuses unsafe file name %j',
    (name) => {
      expect(() => resolveExportFilePath(name)).toThrow(/unsafe export file name/);
    },
  );

  it('deletes a file and reports false once it is already gone', async () => {
    await writeExportFile('job-2.pdf', Buffer.from('%PDF'));

    expect(await deleteExportFile('job-2.pdf')).toBe(true);
    expect(await exportFileExists('job-2.pdf')).toBe(false);
    expect(await deleteExportFile('job-2.pdf')).toBe(false);
  });

  it('treats a missing storage directory as having no files', async () => {
    expect(await exportFileExists('job-3.csv')).toBe(false);
    expect(await sweepStaleTempFiles(0)).toBe(0);
  });

  it('sweeps only .tmp files older than the threshold', async () => {
    await writeExportFile('keep.csv', 'x');
    const dir = mockEnv.EXPORT_STORAGE_DIR;
    fs.writeFileSync(path.join(dir, 'old.csv.tmp'), 'partial');
    fs.writeFileSync(path.join(dir, 'fresh.csv.tmp'), 'partial');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, 'old.csv.tmp'), old, old);

    const removed = await sweepStaleTempFiles(30 * 60 * 1000);

    expect(removed).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(['fresh.csv.tmp', 'keep.csv']);
  });
});

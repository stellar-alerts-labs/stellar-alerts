import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CursorStore, defaultCursorFile } from './cursor-store.js';

describe('CursorStore', () => {
  let dir: string;
  let warnings: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-cursor-'));
    warnings = [];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const store = (file = path.join(dir, 'nested', 'cursor.json')) =>
    new CursorStore(file, (m) => warnings.push(m));

  it('round-trips a checkpoint, creating the parent directory', async () => {
    const s = store();
    await s.save({ cursor: 'tok-9', lastId: 'p9' });
    expect(await s.load()).toMatchObject({ cursor: 'tok-9', lastId: 'p9' });
  });

  it('writes atomically without leaving temp files behind', async () => {
    const s = store();
    await s.save({ cursor: 'a', lastId: 'a' });
    await s.save({ cursor: 'b', lastId: 'b' });
    expect(await fs.readdir(path.dirname(s.filePath))).toEqual(['cursor.json']);
    expect((await s.load())?.cursor).toBe('b');
  });

  it('returns null without warning when the file is missing', async () => {
    expect(await store().load()).toBeNull();
    expect(warnings).toEqual([]);
  });

  it.each([
    ['truncated JSON', '{"version":1,"cursor":"ab'],
    ['wrong shape', JSON.stringify({ version: 1, cursor: 42 })],
    ['unknown version', JSON.stringify({ version: 2, cursor: 'x', lastId: 'x' })],
    ['empty cursor', JSON.stringify({ version: 1, cursor: '', lastId: 'x' })],
  ])('falls back safely on a corrupted file (%s)', async (_label, contents) => {
    const file = path.join(dir, 'cursor.json');
    await fs.writeFile(file, contents);
    expect(await store(file).load()).toBeNull();
    expect(warnings[0]).toMatch(/corrupted cursor file/);
  });

  it('scopes the default path per wallet and sanitises the id', () => {
    expect(defaultCursorFile()).toBe(path.join(os.homedir(), '.stellar-alerts', 'stream-cursor.json'));
    expect(defaultCursorFile('../w/1')).toBe(
      path.join(os.homedir(), '.stellar-alerts', 'stream-cursor-___w_1.json')
    );
  });
});

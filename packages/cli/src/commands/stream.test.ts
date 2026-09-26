import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { registerStreamCommands } from './stream.js';
import { apiClient } from '../lib/api.js';

// Mock the API client
vi.mock('../lib/api.js', () => ({
  apiClient: {
    addWallet: vi.fn(),
    getWallets: vi.fn(),
    deleteWallet: vi.fn(),
    getPayments: vi.fn(),
    streamPayments: vi.fn(),
    openPaymentStream: vi.fn(),
  },
}));

describe('Stream Commands', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerStreamCommands(program);
  });

  it('should have stream command group', () => {
    const streamCmd = program.commands.find(cmd => cmd.name() === 'stream');
    expect(streamCmd).toBeDefined();
    expect(streamCmd!.description()).toBe('Watch real-time payment streams');
  });

  it('should have watch subcommand', () => {
    const streamCmd = program.commands.find(cmd => cmd.name() === 'stream');
    const watchCmd = streamCmd!.commands.find(cmd => cmd.name() === 'watch');

    expect(watchCmd).toBeDefined();
    expect(watchCmd!.description()).toBe('Watch real-time payment feed');
  });

  it('should have history subcommand', () => {
    const streamCmd = program.commands.find(cmd => cmd.name() === 'stream');
    const historyCmd = streamCmd!.commands.find(cmd => cmd.name() === 'history');

    expect(historyCmd).toBeDefined();
    expect(historyCmd!.description()).toBe('Show recent payment history');
  });

  it('should have wallet filter option for watch command', () => {
    const streamCmd = program.commands.find(cmd => cmd.name() === 'stream');
    const watchCmd = streamCmd!.commands.find(cmd => cmd.name() === 'watch');

    const options = watchCmd!.options;
    const walletOption = options.find((o: any) => o.short === '-w');
    expect(walletOption).toBeDefined();
  });

  it('should have token option for watch command', () => {
    const streamCmd = program.commands.find(cmd => cmd.name() === 'stream');
    const watchCmd = streamCmd!.commands.find(cmd => cmd.name() === 'watch');

    const options = watchCmd!.options;
    const tokenOption = options.find((o: any) => o.short === '-t');
    expect(tokenOption).toBeDefined();
  });

  it('should expose reconnect and resume options for watch command', () => {
    const streamCmd = program.commands.find(cmd => cmd.name() === 'stream');
    const watchCmd = streamCmd!.commands.find(cmd => cmd.name() === 'watch');

    const flags = watchCmd!.options.map((o: any) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining(['--cursor', '--cursor-file', '--no-resume', '--max-retries', '--max-backoff'])
    );
  });

  describe('watch lifecycle', () => {
    let dir: string;
    let cursorFile: string;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-watch-'));
      cursorFile = path.join(dir, 'cursor.json');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      process.exitCode = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    });

    function liveStream(payments: Array<{ id: string }>, onDrained: () => void) {
      return async (opts: { signal?: AbortSignal }) =>
        (async function* () {
          yield* payments;
          onDrained();
          await new Promise((_, reject) => {
            const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (opts.signal!.aborted) fail();
            else opts.signal!.addEventListener('abort', fail);
          });
        })();
    }

    const sample = (id: string) => ({
      id,
      walletId: 'w1',
      txHash: `tx-${id}`,
      fromAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
      amount: '1',
      asset: 'XLM',
      receivedAt: '2026-09-25T00:00:00.000Z',
    });

    it('flushes the cursor and releases signal handlers on SIGINT', async () => {
      const sigintBefore = process.listenerCount('SIGINT');
      const sigtermBefore = process.listenerCount('SIGTERM');
      vi.mocked(apiClient.openPaymentStream).mockImplementation(
        liveStream([sample('p1'), sample('p2')], () => process.emit('SIGINT'))
      );

      await program.parseAsync(['node', 'cli', 'stream', 'watch', '--cursor-file', cursorFile]);

      const saved = JSON.parse(await fs.readFile(cursorFile, 'utf8'));
      expect(saved).toMatchObject({ version: 1, cursor: 'p2', lastId: 'p2' });
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(process.exitCode).toBeUndefined();
    });

    it('resumes from the saved cursor on the next run', async () => {
      await fs.writeFile(cursorFile, JSON.stringify({ version: 1, cursor: 'p2', lastId: 'p2' }));
      vi.mocked(apiClient.openPaymentStream).mockImplementation(
        liveStream([], () => process.emit('SIGTERM'))
      );

      await program.parseAsync(['node', 'cli', 'stream', 'watch', '--cursor-file', cursorFile, '-w', 'w1']);

      expect(apiClient.openPaymentStream).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'p2', walletId: 'w1' })
      );
    });

    it('--cursor now ignores the saved cursor and --no-resume skips the file', async () => {
      await fs.writeFile(cursorFile, JSON.stringify({ version: 1, cursor: 'p2', lastId: 'p2' }));
      vi.mocked(apiClient.openPaymentStream).mockImplementation(
        liveStream([], () => process.emit('SIGINT'))
      );

      await program.parseAsync(['node', 'cli', 'stream', 'watch', '--cursor-file', cursorFile, '--cursor', 'now']);
      expect(apiClient.openPaymentStream).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: undefined }));

      vi.mocked(apiClient.openPaymentStream).mockImplementation(
        liveStream([sample('p9')], () => process.emit('SIGINT'))
      );
      await program.parseAsync(['node', 'cli', 'stream', 'watch', '--cursor-file', cursorFile, '--no-resume']);
      expect(apiClient.openPaymentStream).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: undefined }));
      expect(JSON.parse(await fs.readFile(cursorFile, 'utf8')).cursor).toBe('p2');
    });

    it('rejects an invalid --max-retries value', async () => {
      await program.parseAsync(['node', 'cli', 'stream', 'watch', '--max-retries', '-1', '--cursor-file', cursorFile]);
      expect(process.exitCode).toBe(1);
      expect(apiClient.openPaymentStream).not.toHaveBeenCalled();
    });
  });

  it('should have limit option for history command', () => {
    const streamCmd = program.commands.find(cmd => cmd.name() === 'stream');
    const historyCmd = streamCmd!.commands.find(cmd => cmd.name() === 'history');

    const options = historyCmd!.options;
    const limitOption = options.find((o: any) => o.short === '-l');
    expect(limitOption).toBeDefined();
  });

  it('should have default limit value for history command', () => {
    const streamCmd = program.commands.find(cmd => cmd.name() === 'stream');
    const historyCmd = streamCmd!.commands.find(cmd => cmd.name() === 'history');

    const options = historyCmd!.options;
    const limitOption = options.find((o: any) => o.short === '-l');
    expect(limitOption?.defaultValue).toBe('20');
  });
});

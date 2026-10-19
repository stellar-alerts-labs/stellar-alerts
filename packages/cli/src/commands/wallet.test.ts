import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerWalletCommands } from './wallet.js';

const mockGetWallets = vi.fn();
const mockAddWallet = vi.fn();
const mockDeleteWallet = vi.fn();

// Mock the API client and auth resolver
vi.mock('../lib/api.js', () => ({
  ApiClient: vi.fn().mockImplementation(() => ({
    getWallets: mockGetWallets,
    addWallet: mockAddWallet,
    deleteWallet: mockDeleteWallet,
  })),
  apiClient: {
    addWallet: vi.fn(),
    getWallets: vi.fn(),
    deleteWallet: vi.fn(),
    getPayments: vi.fn(),
    streamPayments: vi.fn(),
  },
}));

vi.mock('../lib/auth.js', () => ({
  resolveAuth: vi.fn(() => ({
    apiUrl: 'http://localhost:3001',
    token: 'test-token',
    tokenSource: 'flag',
    urlSource: 'env',
    activeProfile: null,
  })),
}));

const mockWallets = [
  {
    id: 'wallet-1',
    publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    label: 'Treasury',
    createdAt: '2026-01-15T10:00:00.000Z',
  },
  {
    id: 'wallet-2',
    publicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWJX',
    label: null,
    createdAt: '2026-01-16T12:30:00.000Z',
  },
];

describe('Wallet Commands', () => {
  let program: Command;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerWalletCommands(program);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should have wallet command group', () => {
    const walletCmd = program.commands.find(cmd => cmd.name() === 'wallet');
    expect(walletCmd).toBeDefined();
    expect(walletCmd!.description()).toBe('Manage watched Stellar wallets');
  });

  it('should have add subcommand with required publicKey argument', () => {
    const walletCmd = program.commands.find(cmd => cmd.name() === 'wallet');
    const addCmd = walletCmd!.commands.find(cmd => cmd.name() === 'add');

    expect(addCmd).toBeDefined();
    expect(addCmd!.description()).toBe('Add a new wallet to watch');

    // Check that publicKey is a required argument
    const args = addCmd!._args;
    expect(args).toHaveLength(1);
    expect(args[0].required).toBe(true);
    expect(args[0].name()).toBe('publicKey');
  });

  it('should have list subcommand with --json option', () => {
    const walletCmd = program.commands.find(cmd => cmd.name() === 'wallet');
    const listCmd = walletCmd!.commands.find(cmd => cmd.name() === 'list');

    expect(listCmd).toBeDefined();
    expect(listCmd!.description()).toBe('List all watched wallets');
    expect(listCmd!.options.some((o: any) => o.long === '--json')).toBe(true);
  });

  it('should have remove subcommand with alias rm', () => {
    const walletCmd = program.commands.find(cmd => cmd.name() === 'wallet');
    const removeCmd = walletCmd!.commands.find(cmd => cmd.name() === 'remove');

    expect(removeCmd).toBeDefined();
    expect(removeCmd!.description()).toBe('Remove a watched wallet');
    expect(removeCmd!._aliases).toContain('rm');
  });

  it('should have label option for add command', () => {
    const walletCmd = program.commands.find(cmd => cmd.name() === 'wallet');
    const addCmd = walletCmd!.commands.find(cmd => cmd.name() === 'add');

    const options = addCmd!.options;
    const labelOption = options.find((o: any) => o.short === '-l');
    expect(labelOption).toBeDefined();
  });

  it('should have token option for add command', () => {
    const walletCmd = program.commands.find(cmd => cmd.name() === 'wallet');
    const addCmd = walletCmd!.commands.find(cmd => cmd.name() === 'add');

    const options = addCmd!.options;
    const tokenOption = options.find((o: any) => o.short === '-t');
    expect(tokenOption).toBeDefined();
  });

  it('wallet list --json: outputs valid JSON matching wallet schema and omits table borders', async () => {
    mockGetWallets.mockResolvedValue(mockWallets);

    await program.parseAsync(['wallet', 'list', '--json'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const rawOutput = String(consoleSpy.mock.calls[0][0]);
    expect(rawOutput).not.toContain('─');
    expect(rawOutput).not.toContain('Watched Wallets');

    const parsed = JSON.parse(rawOutput);
    expect(parsed).toEqual(mockWallets);
    expect(rawOutput).toBe(JSON.stringify(mockWallets, null, 2));
  });

  it('wallet list --json: outputs empty JSON array [] when no wallets exist', async () => {
    mockGetWallets.mockResolvedValue([]);

    await program.parseAsync(['wallet', 'list', '--json'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const rawOutput = String(consoleSpy.mock.calls[0][0]);
    expect(JSON.parse(rawOutput)).toEqual([]);
    expect(rawOutput).toBe('[]');
  });

  it('wallet list (without --json): preserves standard human-readable table output', async () => {
    mockGetWallets.mockResolvedValue(mockWallets);

    await program.parseAsync(['wallet', 'list'], { from: 'user' });

    const allLogs = consoleSpy.mock.calls.flat().join('\n');
    expect(allLogs).toContain('Watched Wallets (2)');
    expect(allLogs).toContain('─'.repeat(80));
    expect(allLogs).toContain(mockWallets[0].publicKey);
    expect(allLogs).toContain('Treasury');
  });
});

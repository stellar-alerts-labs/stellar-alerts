import { describe, expect, it, vi } from 'vitest';
import {
  AccountMergeTracker,
  InMemoryAccountMergeStore,
  formatXlm,
  isAccountMergeOperation,
  nextWalletStatus,
  parseAccountMerge,
  parseStroops,
  type AccountMergeOperation,
  type MergeEffect,
} from '../account-merge.service';

const VICTIM = 'GVICTIM00000000000000000000000000000000000000000000000000';
const ATTACKER = 'GATTACKER000000000000000000000000000000000000000000000000';
const OTHER = 'GOTHER0000000000000000000000000000000000000000000000000000';

function merge(overrides: Partial<AccountMergeOperation> = {}): AccountMergeOperation {
  return {
    id: 'op-1',
    type: 'account_merge',
    source_account: VICTIM,
    into: ATTACKER,
    transaction_hash: 'tx-1',
    ledger: 5_000,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function credited(amount: string, account = ATTACKER, assetType = 'native'): MergeEffect {
  return { type: 'account_credited', account, asset_type: assetType, amount };
}

describe('parseStroops / formatXlm', () => {
  it.each([
    ['0', 0n],
    ['1', 10_000_000n],
    ['1.5', 15_000_000n],
    ['12.3400000', 123_400_000n],
    ['0.0000001', 1n],
    ['922337203685.4775807', 9_223_372_036_854_775_807n],
  ])('parses %s exactly', (text, expected) => {
    expect(parseStroops(text)).toBe(expected);
  });

  it.each(['', '-1', '1.', '.5', '1.12345678', 'abc', '1e3', '1,5'])('rejects %j', (text) => {
    expect(parseStroops(text)).toBeNull();
  });

  it('returns null for a missing amount', () => {
    expect(parseStroops(undefined)).toBeNull();
  });

  it('round-trips through formatXlm without losing a stroop', () => {
    for (const stroops of [0n, 1n, 9_999_999n, 10_000_000n, 123_456_789_012_345n]) {
      expect(parseStroops(formatXlm(stroops))).toBe(stroops);
    }
    expect(formatXlm(15_000_000n)).toBe('1.5000000');
  });
});

describe('parseAccountMerge', () => {
  it('captures source, destination, ledger and the exact swept amount', () => {
    const event = parseAccountMerge(merge(), [credited('250.1234567')]);

    expect(event).toMatchObject({
      sourceAccount: VICTIM,
      destinationAccount: ATTACKER,
      ledgerSeq: 5_000,
      transactionHash: 'tx-1',
      sweptStroops: 2_501_234_567n,
      sweptXlm: '250.1234567',
    });
  });

  it('takes the credit to the destination, not another account in the same transaction', () => {
    const event = parseAccountMerge(merge(), [credited('1.0000000', OTHER), credited('7.0000000')]);
    expect(event?.sweptStroops).toBe(70_000_000n);
  });

  it('ignores a credit in a non-native asset', () => {
    const event = parseAccountMerge(merge(), [credited('5.0000000', ATTACKER, 'credit_alphanum4')]);
    expect(event?.sweptStroops).toBeNull();
  });

  it('reports the amount as unresolved, not zero, when there is no credit effect', () => {
    const event = parseAccountMerge(merge(), []);
    expect(event?.sweptStroops).toBeNull();
    expect(event?.sweptXlm).toBeNull();
  });

  it('records a genuine zero sweep as zero', () => {
    expect(parseAccountMerge(merge(), [credited('0.0000000')])?.sweptStroops).toBe(0n);
  });

  it('returns null for other operation types and for incomplete operations', () => {
    expect(parseAccountMerge(merge({ type: 'payment' }), [])).toBeNull();
    expect(parseAccountMerge(merge({ into: '' }), [])).toBeNull();
    expect(parseAccountMerge(merge({ source_account: '' }), [])).toBeNull();
    expect(isAccountMergeOperation({ type: 'account_merge' })).toBe(true);
    expect(isAccountMergeOperation({ type: 'payment' })).toBe(false);
  });
});

describe('nextWalletStatus', () => {
  it('moves an active wallet to MERGED', () => {
    expect(nextWalletStatus('ACTIVE')).toEqual({ status: 'MERGED', changed: true });
  });

  it('keeps a MERGED wallet MERGED and reports no change', () => {
    expect(nextWalletStatus('MERGED')).toEqual({ status: 'MERGED', changed: false });
  });
});

describe('AccountMergeTracker: monitored account is destroyed', () => {
  it('raises a critical alert, records the sweep and links the wallet to the destination', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(VICTIM);

    const result = await new AccountMergeTracker(store).process(merge(), [credited('250.1234567')]);

    expect(result?.alerts).toEqual([
      expect.objectContaining({
        type: 'ACCOUNT_MERGED_AWAY',
        severity: 'CRITICAL',
        role: 'SOURCE_DESTROYED',
        monitoredAccount: VICTIM,
        destinationAccount: ATTACKER,
        sweptXlm: '250.1234567',
        sweptStroops: '2501234567',
        ledgerSeq: 5_000,
      }),
    ]);
    expect(result?.walletsMerged).toEqual([VICTIM]);
    expect(store.wallets.get(VICTIM)).toEqual({
      status: 'MERGED',
      merged: {
        status: 'MERGED',
        mergedIntoAccount: ATTACKER,
        mergedAtLedger: 5_000,
        sweptStroops: '2501234567',
        mergeTransactionHash: 'tx-1',
      },
    });
  });

  it('keeps the sweep unresolved (null) in the alert and record when no credit effect is given', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(VICTIM);

    const result = await new AccountMergeTracker(store).process(merge(), []);

    expect(result?.alerts[0].sweptStroops).toBeNull();
    expect(store.wallets.get(VICTIM)?.merged?.sweptStroops).toBeNull();
  });
});

describe('AccountMergeTracker: monitored account receives the sweep', () => {
  it('raises an informational alert and does not mark the receiver as merged', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(ATTACKER);

    const result = await new AccountMergeTracker(store).process(merge(), [credited('9.0000000')]);

    expect(result?.alerts).toEqual([
      expect.objectContaining({
        type: 'ACCOUNT_MERGE_RECEIVED',
        severity: 'INFO',
        role: 'DESTINATION_RECEIVED',
        monitoredAccount: ATTACKER,
        sweptXlm: '9.0000000',
      }),
    ]);
    expect(result?.walletsMerged).toEqual([]);
    expect(store.wallets.get(ATTACKER)?.status).toBe('ACTIVE');
  });

  it('raises both alerts, one per account, when both sides are monitored', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(VICTIM);
    store.addWallet(ATTACKER);

    const result = await new AccountMergeTracker(store).process(merge(), [credited('3.0000000')]);

    expect(result?.alerts.map((a) => a.role)).toEqual(['SOURCE_DESTROYED', 'DESTINATION_RECEIVED']);
    expect(result?.alerts.map((a) => a.monitoredAccount)).toEqual([VICTIM, ATTACKER]);
  });
});

describe('AccountMergeTracker: nothing to report', () => {
  it('produces no alert for a merge between unmonitored accounts', async () => {
    const result = await new AccountMergeTracker(new InMemoryAccountMergeStore()).process(merge(), []);
    expect(result?.alerts).toEqual([]);
    expect(result?.walletsMerged).toEqual([]);
  });

  it('ignores non-merge operations', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(VICTIM);
    expect(await new AccountMergeTracker(store).process(merge({ type: 'payment' }), [])).toBeNull();
    expect(store.wallets.get(VICTIM)?.status).toBe('ACTIVE');
  });
});

describe('AccountMergeTracker: replays', () => {
  it('processes an operation once; a replay raises no second alert and changes nothing', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(VICTIM);
    const tracker = new AccountMergeTracker(store);

    const first = await tracker.process(merge(), [credited('1.0000000')]);
    const replay = await tracker.process(merge(), [credited('1.0000000')]);

    expect(first?.alerts).toHaveLength(1);
    expect(replay?.duplicate).toBe(true);
    expect(replay?.alerts).toEqual([]);
    expect(replay?.walletsMerged).toEqual([]);
  });

  it('does not alert twice for an already MERGED wallet reached by a different operation id', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(VICTIM);
    const tracker = new AccountMergeTracker(store);
    await tracker.process(merge({ id: 'op-1' }), [credited('1.0000000')]);

    const second = await tracker.process(merge({ id: 'op-2', ledger: 5_001 }), [credited('2.0000000')]);

    expect(second?.alerts).toEqual([]);
    expect(store.wallets.get(VICTIM)?.merged?.mergedAtLedger).toBe(5_000);
  });
});

describe('AccountMergeTracker: tracing the beneficiary', () => {
  it('starts a trace watcher on the destination of a destroyed monitored wallet when enabled', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(VICTIM);
    const spawn = vi.fn().mockResolvedValue(undefined);

    const result = await new AccountMergeTracker(store, {
      autoTraceBeneficiary: true,
      spawnTraceWatcher: spawn,
    }).process(merge(), [credited('1.0000000')]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(ATTACKER, expect.objectContaining({ sourceAccount: VICTIM }));
    expect(result?.tracedBeneficiary).toBe(ATTACKER);
  });

  it('does not start one by default', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(VICTIM);
    const spawn = vi.fn();

    const result = await new AccountMergeTracker(store, { spawnTraceWatcher: spawn }).process(merge(), []);

    expect(spawn).not.toHaveBeenCalled();
    expect(result?.tracedBeneficiary).toBeNull();
  });

  it('does not start a second watcher when the beneficiary is already watched', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(VICTIM);
    store.watched.add(ATTACKER);
    const spawn = vi.fn();

    const result = await new AccountMergeTracker(store, {
      autoTraceBeneficiary: true,
      spawnTraceWatcher: spawn,
    }).process(merge(), []);

    expect(spawn).not.toHaveBeenCalled();
    expect(result?.tracedBeneficiary).toBeNull();
  });

  it('does not trace when the monitored account is only the receiver', async () => {
    const store = new InMemoryAccountMergeStore();
    store.addWallet(ATTACKER);
    const spawn = vi.fn();

    await new AccountMergeTracker(store, { autoTraceBeneficiary: true, spawnTraceWatcher: spawn }).process(merge(), []);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses to be configured to trace without a way to spawn the watcher', () => {
    expect(() => new AccountMergeTracker(new InMemoryAccountMergeStore(), { autoTraceBeneficiary: true })).toThrow(
      /spawnTraceWatcher/,
    );
  });
});

import { describe, it, expect, vi } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import { processLedgerCloseMeta, syncMonitoredAddresses, monitoredAddresses } from '../watcher.worker';
import { buildLedgerCloseMeta, sampleEnvelopes, kp } from '../../lib/__tests__/fixtures/ledger-meta';

describe('watcher: ledger-level set_options inspection', () => {
  const meta = buildLedgerCloseMeta(sampleEnvelopes());

  it('syncs the monitored index from wallets and replaces stale entries', () => {
    expect(syncMonitoredAddresses([{ publicKey: kp(3).publicKey() }, { publicKey: 'not-a-key!' }])).toEqual({
      loaded: 1,
      skipped: 1,
    });
    expect(monitoredAddresses.has(kp(3).publicKey())).toBe(true);
    expect(monitoredAddresses.has(kp(1).publicKey())).toBe(false);

    syncMonitoredAddresses([{ publicKey: kp(1).publicKey() }]);
    expect(monitoredAddresses.has(kp(3).publicKey())).toBe(false);
    expect(monitoredAddresses.has(kp(1).publicKey())).toBe(true);
  });

  it('inspects only monitored accounts that issued set_options in the ledger', async () => {
    // The fixture's set_options transaction is sourced from kp(3).
    syncMonitoredAddresses([{ publicKey: kp(3).publicKey() }, { publicKey: kp(1).publicKey() }]);
    const inspect = vi.fn().mockResolvedValue(null);

    const result = await processLedgerCloseMeta(meta, inspect);

    expect(result).toMatchObject({ ledgerSeq: 123456, engine: 'wasm', setOptionsOperations: 5 });
    expect(inspect).toHaveBeenCalledTimes(1); // deduplicated across the 5 set_options ops
    expect(inspect).toHaveBeenCalledWith(kp(3).publicKey());
  });

  it('does nothing for ledgers whose set_options sources are not monitored', async () => {
    syncMonitoredAddresses([{ publicKey: kp(1).publicKey() }]);
    const inspect = vi.fn();
    const result = await processLedgerCloseMeta(meta.toString('base64'), inspect);
    expect(result.inspectedAccounts).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
    // sanity: the StellarSdk import above is only to prove the fixture addresses are real G keys
    expect(StellarSdk.StrKey.isValidEd25519PublicKey(kp(3).publicKey())).toBe(true);
  });
});

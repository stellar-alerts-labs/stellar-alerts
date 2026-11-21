import { describe, expect, it } from 'vitest';
import {
  AUTH_FAILURE_WINDOW_LEDGERS,
  DAY_LEDGERS,
  isValidSecp256r1PublicKey,
  SmartAccountSentinel,
  type SmartAccountAlert,
  type SmartAccountSigner,
  type SmartAccountSnapshot,
} from '../smart-account-sentinel';

const WALLET = 'CSMARTWALLET00000000000000000000000000000000000000000000';
const OTHER_WALLET = 'COTHERWALLET00000000000000000000000000000000000000000000';

const PASSKEY_KEY = `04${'ab'.repeat(32)}${'cd'.repeat(32)}`;
const OWNER_KEY: SmartAccountSigner = { id: 'owner', kind: 'ed25519' };
const passkey = (id = 'passkey-1', extra: Partial<SmartAccountSigner> = {}): SmartAccountSigner => ({
  id,
  kind: 'secp256r1',
  publicKey: PASSKEY_KEY,
  ...extra,
});

function snapshot(signers: SmartAccountSigner[] = [OWNER_KEY], policy: SmartAccountSnapshot['policy'] = null): SmartAccountSnapshot {
  return { signers, policy };
}

function watched(initial: SmartAccountSnapshot = snapshot()) {
  const sentinel = new SmartAccountSentinel();
  sentinel.watch(WALLET, initial);
  return sentinel;
}

const types = (alerts: SmartAccountAlert[]) => alerts.map((a) => a.type);

describe('isValidSecp256r1PublicKey', () => {
  it('accepts a 65-byte uncompressed key as hex, in either case', () => {
    expect(isValidSecp256r1PublicKey(PASSKEY_KEY)).toBe(true);
    expect(isValidSecp256r1PublicKey(PASSKEY_KEY.toUpperCase())).toBe(true);
  });

  it.each([
    ['a compressed key', `02${'ab'.repeat(32)}`],
    ['a key without the 04 prefix', `05${'ab'.repeat(64)}`],
    ['a key that is too short', `04${'ab'.repeat(63)}`],
    ['a key that is too long', `04${'ab'.repeat(65)}`],
    ['non-hex characters', `04${'zz'.repeat(64)}`],
    ['an empty string', ''],
    ['a number', 4],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isValidSecp256r1PublicKey(value)).toBe(false);
  });
});

describe('passkey signers', () => {
  it('alerts when a passkey is registered, with its public key', () => {
    const alerts = watched().processSnapshot(WALLET, snapshot([OWNER_KEY, passkey()]), 500);

    expect(alerts).toEqual([
      expect.objectContaining({
        type: 'PASSKEY_SIGNER_ADDED',
        severity: 'WARNING',
        accountId: WALLET,
        signerId: 'passkey-1',
        publicKey: PASSKEY_KEY,
        ledgerSeq: 500,
      }),
    ]);
  });

  it('alerts when a passkey is removed', () => {
    const sentinel = watched(snapshot([OWNER_KEY, passkey()]));

    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY]), 600);

    expect(types(alerts)).toEqual(['PASSKEY_SIGNER_REMOVED']);
    expect(alerts[0]).toMatchObject({ signerId: 'passkey-1', publicKey: PASSKEY_KEY });
  });

  it('flags a secp256r1 signer registered with a malformed key as critical', () => {
    const bad = passkey('bad', { publicKey: 'deadbeef' });

    const alerts = watched().processSnapshot(WALLET, snapshot([OWNER_KEY, bad]), 500);

    expect(types(alerts)).toEqual(['PASSKEY_KEY_MALFORMED']);
    expect(alerts[0].severity).toBe('CRITICAL');
  });

  it('reports a passkey swap as one removal and one addition', () => {
    const sentinel = watched(snapshot([OWNER_KEY, passkey('old')]));

    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY, passkey('new')]), 700);

    expect(types(alerts).sort()).toEqual(['PASSKEY_SIGNER_ADDED', 'PASSKEY_SIGNER_REMOVED']);
  });

  it('raises nothing when the signers have not changed', () => {
    const sentinel = watched(snapshot([OWNER_KEY, passkey()]));
    expect(sentinel.processSnapshot(WALLET, snapshot([passkey(), OWNER_KEY]), 800)).toEqual([]);
  });

  it('does not alert for a plain ed25519 signer being added', () => {
    expect(watched().processSnapshot(WALLET, snapshot([OWNER_KEY, { id: 'extra', kind: 'ed25519' }]), 500)).toEqual([]);
  });

  it('does not report the same passkey twice after the snapshot is accepted', () => {
    const sentinel = watched();
    sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY, passkey()]), 500);
    expect(sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY, passkey()]), 501)).toEqual([]);
  });
});

describe('session keys', () => {
  const session = (id = 'session-1', expirationLedger = 1_000): SmartAccountSigner => ({
    id,
    kind: 'ed25519',
    expirationLedger,
  });

  it('notes a session key being added with its expiration', () => {
    const alerts = watched().processSnapshot(WALLET, snapshot([OWNER_KEY, session()]), 500);
    expect(alerts).toEqual([expect.objectContaining({ type: 'SESSION_KEY_ADDED', severity: 'INFO', expirationLedger: 1_000 })]);
  });

  it('reports both the passkey and the session aspect of a passkey session key', () => {
    const alerts = watched().processSnapshot(WALLET, snapshot([OWNER_KEY, passkey('p', { expirationLedger: 900 })]), 500);
    expect(types(alerts)).toEqual(['PASSKEY_SIGNER_ADDED', 'SESSION_KEY_ADDED']);
  });

  it('reports an expiry once, the ledger after the expiration ledger', () => {
    const sentinel = watched(snapshot([OWNER_KEY, session()]));

    expect(sentinel.checkExpirations(1_000)).toEqual([]); // still valid on its last ledger
    const expired = sentinel.checkExpirations(1_001);
    expect(expired).toEqual([expect.objectContaining({ type: 'SESSION_KEY_EXPIRED', signerId: 'session-1', expirationLedger: 1_000 })]);
    expect(sentinel.checkExpirations(1_002)).toEqual([]);
  });

  it('does not expire permanent signers', () => {
    expect(watched(snapshot([OWNER_KEY, passkey()])).checkExpirations(99_999_999)).toEqual([]);
  });

  it('treats a null expiration as permanent', () => {
    const sentinel = watched(snapshot([{ id: 'k', kind: 'ed25519', expirationLedger: null }]));
    expect(sentinel.checkExpirations(99_999_999)).toEqual([]);
  });

  it('reports a session key removed before it expired as revoked', () => {
    const sentinel = watched(snapshot([OWNER_KEY, session()]));
    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY]), 900);
    expect(types(alerts)).toEqual(['SESSION_KEY_REVOKED']);
  });

  it('does not call the removal of an already expired session key a revocation', () => {
    const sentinel = watched(snapshot([OWNER_KEY, session()]));
    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY]), 1_200);
    expect(types(alerts)).toEqual(['PASSKEY_SIGNER_REMOVED']);
  });

  it('expires each watched account\'s keys independently', () => {
    const sentinel = watched(snapshot([session('a', 100)]));
    sentinel.watch(OTHER_WALLET, snapshot([session('b', 5_000)]));

    const alerts = sentinel.checkExpirations(200);

    expect(alerts.map((a) => [a.accountId, a.signerId])).toEqual([[WALLET, 'a']]);
  });
});

describe('spending policy changes', () => {
  const policy = (perTxLimit: bigint | null, dailyLimit: bigint | null) => ({ perTxLimit, dailyLimit });

  it('alerts when a limit is raised, with the old and new value', () => {
    const sentinel = watched(snapshot([OWNER_KEY], policy(100n, 1_000n)));

    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY], policy(500n, 1_000n)), 500);

    expect(alerts).toEqual([
      expect.objectContaining({ type: 'POLICY_LIMIT_RAISED', severity: 'WARNING', limit: 'perTxLimit', previousValue: '100', newValue: '500' }),
    ]);
  });

  it('reports a lowered limit as informational', () => {
    const sentinel = watched(snapshot([OWNER_KEY], policy(100n, 1_000n)));
    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY], policy(100n, 400n)), 500);
    expect(alerts).toEqual([expect.objectContaining({ type: 'POLICY_LIMIT_LOWERED', severity: 'INFO', limit: 'dailyLimit' })]);
  });

  it('treats removing a limit (unlimited) as raising it', () => {
    const sentinel = watched(snapshot([OWNER_KEY], policy(100n, 1_000n)));
    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY], policy(null, 1_000n)), 500);
    expect(alerts).toEqual([expect.objectContaining({ type: 'POLICY_LIMIT_RAISED', limit: 'perTxLimit', previousValue: '100', newValue: null })]);
  });

  it('treats adding a limit to an unlimited account as lowering it', () => {
    const sentinel = watched(snapshot([OWNER_KEY], policy(null, null)));
    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY], policy(50n, null)), 500);
    expect(alerts).toEqual([expect.objectContaining({ type: 'POLICY_LIMIT_LOWERED', previousValue: null, newValue: '50' })]);
  });

  it('treats a missing policy as no limits', () => {
    const sentinel = watched(snapshot([OWNER_KEY], policy(100n, 1_000n)));
    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY], null), 500);
    expect(alerts.map((a) => [a.type, a.limit])).toEqual([
      ['POLICY_LIMIT_RAISED', 'perTxLimit'],
      ['POLICY_LIMIT_RAISED', 'dailyLimit'],
    ]);
  });

  it('reports both limits when both move', () => {
    const sentinel = watched(snapshot([OWNER_KEY], policy(100n, 1_000n)));
    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY], policy(200n, 500n)), 500);
    expect(types(alerts)).toEqual(['POLICY_LIMIT_RAISED', 'POLICY_LIMIT_LOWERED']);
  });

  it('raises nothing when the policy is unchanged', () => {
    const sentinel = watched(snapshot([OWNER_KEY], policy(100n, 1_000n)));
    expect(sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY], policy(100n, 1_000n)), 500)).toEqual([]);
  });

  it('reports a passkey registration and a limit raise from one snapshot together', () => {
    const sentinel = watched(snapshot([OWNER_KEY], policy(100n, 1_000n)));
    const alerts = sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY, passkey()], policy(10_000_000n, null)), 500);
    expect(types(alerts)).toEqual(['PASSKEY_SIGNER_ADDED', 'POLICY_LIMIT_RAISED', 'POLICY_LIMIT_RAISED']);
  });
});

describe('spending limit breaches', () => {
  const limited = () => watched(snapshot([OWNER_KEY], { perTxLimit: 100n, dailyLimit: 250n }));

  it('does not alert for a spend within both limits', () => {
    expect(limited().recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_000 })).toEqual([]);
  });

  it('alerts for a single spend over the per-transaction limit', () => {
    const alerts = limited().recordSpend({ accountId: WALLET, amount: 101n, ledgerSeq: 1_000, transactionHash: 'tx' });

    expect(alerts).toEqual([
      expect.objectContaining({ type: 'SPENDING_LIMIT_BREACH', severity: 'CRITICAL', breach: 'PER_TX', amount: '101', limitValue: '100', transactionHash: 'tx' }),
    ]);
  });

  it('alerts when the rolling day total passes the daily limit', () => {
    const sentinel = limited();
    sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_000 });
    sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_010 });

    const alerts = sentinel.recordSpend({ accountId: WALLET, amount: 60n, ledgerSeq: 1_020 });

    expect(alerts).toEqual([expect.objectContaining({ breach: 'DAILY', spentInWindow: '260', limitValue: '250' })]);
  });

  it('does not alert at exactly the daily limit', () => {
    const sentinel = limited();
    sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_000 });
    sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_001 });
    expect(sentinel.recordSpend({ accountId: WALLET, amount: 50n, ledgerSeq: 1_002 })).toEqual([]);
  });

  it('reports both breaches when one spend breaks both limits', () => {
    const alerts = limited().recordSpend({ accountId: WALLET, amount: 300n, ledgerSeq: 1_000 });
    expect(alerts.map((a) => a.breach)).toEqual(['PER_TX', 'DAILY']);
  });

  it('lets old spends fall out of the 24-hour window', () => {
    const sentinel = limited();
    sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_000 });
    sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_001 });

    // Exactly one day later the first two spends are out of the window.
    const alerts = sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_001 + DAY_LEDGERS });

    expect(alerts).toEqual([]);
  });

  it('drops a spend made exactly one day earlier, and counts one made a ledger later', () => {
    const tight = () => watched(snapshot([OWNER_KEY], { perTxLimit: 100n, dailyLimit: 150n }));

    const exactlyADay = tight();
    exactlyADay.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 5_000 });
    expect(exactlyADay.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 5_000 + DAY_LEDGERS })).toEqual([]);

    const aLedgerLess = tight();
    aLedgerLess.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 5_000 });
    expect(aLedgerLess.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 5_000 + DAY_LEDGERS - 1 })).toHaveLength(1);
  });

  it('keeps a spend that is still inside the window', () => {
    const sentinel = limited();
    sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_000 });
    sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_001 });
    expect(sentinel.recordSpend({ accountId: WALLET, amount: 100n, ledgerSeq: 1_000 + DAY_LEDGERS - 1 })).toHaveLength(1);
  });

  it('uses the policy in force: a limit raised mid-way applies to later spends', () => {
    const sentinel = limited();
    sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY], { perTxLimit: 1_000n, dailyLimit: 5_000n }), 1_000);
    expect(sentinel.recordSpend({ accountId: WALLET, amount: 900n, ledgerSeq: 1_001 })).toEqual([]);
  });

  it('never alerts for an account with no limits', () => {
    const sentinel = watched(snapshot([OWNER_KEY], null));
    expect(sentinel.recordSpend({ accountId: WALLET, amount: 1_000_000_000_000n, ledgerSeq: 1 })).toEqual([]);
    const unlimited = watched(snapshot([OWNER_KEY], { perTxLimit: null, dailyLimit: null }));
    expect(unlimited.recordSpend({ accountId: WALLET, amount: 1_000_000_000_000n, ledgerSeq: 1 })).toEqual([]);
  });

  it('handles amounts beyond 2^53 exactly', () => {
    const sentinel = watched(snapshot([OWNER_KEY], { perTxLimit: 9_007_199_254_740_993n, dailyLimit: null }));
    expect(sentinel.recordSpend({ accountId: WALLET, amount: 9_007_199_254_740_993n, ledgerSeq: 1 })).toEqual([]);
    expect(sentinel.recordSpend({ accountId: WALLET, amount: 9_007_199_254_740_994n, ledgerSeq: 2 })).toHaveLength(1);
  });
});

describe('rejected __check_auth attempts', () => {
  it('alerts immediately on a rejected attempt', () => {
    const alerts = watched().recordAuthAttempt({
      accountId: WALLET,
      success: false,
      signerId: 'passkey-1',
      reason: 'invalid signature',
      ledgerSeq: 900,
      transactionHash: 'tx9',
    });

    expect(alerts).toEqual([
      expect.objectContaining({
        type: 'AUTH_REJECTED',
        severity: 'CRITICAL',
        signerId: 'passkey-1',
        reason: 'invalid signature',
        failuresInWindow: 1,
        transactionHash: 'tx9',
      }),
    ]);
  });

  it('does not alert for a successful attempt', () => {
    expect(watched().recordAuthAttempt({ accountId: WALLET, success: true, ledgerSeq: 900 })).toEqual([]);
  });

  it('counts recent rejections so a brute-force run stands out', () => {
    const sentinel = watched();
    const counts = [900, 901, 902].map((ledgerSeq) => sentinel.recordAuthAttempt({ accountId: WALLET, success: false, ledgerSeq })[0].failuresInWindow);
    expect(counts).toEqual([1, 2, 3]);
  });

  it('lets old rejections age out of the count', () => {
    const sentinel = watched();
    sentinel.recordAuthAttempt({ accountId: WALLET, success: false, ledgerSeq: 900 });
    const later = sentinel.recordAuthAttempt({ accountId: WALLET, success: false, ledgerSeq: 900 + AUTH_FAILURE_WINDOW_LEDGERS });
    expect(later[0].failuresInWindow).toBe(1);
  });
});

describe('watched accounts only', () => {
  it('ignores every kind of event for an account that is not watched', () => {
    const sentinel = new SmartAccountSentinel();

    expect(sentinel.isWatched(WALLET)).toBe(false);
    expect(sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY, passkey()]), 1)).toEqual([]);
    expect(sentinel.recordSpend({ accountId: WALLET, amount: 1n, ledgerSeq: 1 })).toEqual([]);
    expect(sentinel.recordAuthAttempt({ accountId: WALLET, success: false, ledgerSeq: 1 })).toEqual([]);
    expect(sentinel.checkExpirations(1)).toEqual([]);
  });

  it('starts watching from a snapshot without alerting for what is already there', () => {
    const sentinel = new SmartAccountSentinel();
    sentinel.watch(WALLET, snapshot([OWNER_KEY, passkey()], { perTxLimit: 1n, dailyLimit: 2n }));

    expect(sentinel.isWatched(WALLET)).toBe(true);
    expect(sentinel.processSnapshot(WALLET, snapshot([OWNER_KEY, passkey()], { perTxLimit: 1n, dailyLimit: 2n }), 1)).toEqual([]);
  });
});

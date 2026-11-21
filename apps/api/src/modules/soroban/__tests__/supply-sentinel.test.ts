import { describe, expect, it } from 'vitest';
import { SupplyInvariantSentinel, type TokenSupplyEvent } from '../supply-sentinel';

const TOKEN = 'CTOKENCONTRACT0000000000000000000000000000000000000000000';
const OTHER_TOKEN = 'COTHERTOKEN0000000000000000000000000000000000000000000000';
const ADMIN = 'GADMIN00000000000000000000000000000000000000000000000000';
const ROGUE = 'GROGUE00000000000000000000000000000000000000000000000000';
const USER = 'GUSER000000000000000000000000000000000000000000000000000';

let counter = 0;
function event(kind: TokenSupplyEvent['kind'], amount: bigint, overrides: Partial<TokenSupplyEvent> = {}): TokenSupplyEvent {
  counter += 1;
  return {
    eventId: `e-${counter}`,
    kind,
    tokenContractId: TOKEN,
    authorizer: kind === 'mint' ? ADMIN : null,
    account: USER,
    amount,
    ledgerSeq: 100,
    ...overrides,
  };
}

function sentinel(opts: { baseline?: bigint; whitelist?: readonly string[] | null } = {}) {
  const s = new SupplyInvariantSentinel();
  s.monitor({
    tokenContractId: TOKEN,
    baselineSupply: opts.baseline ?? 1_000n,
    minterWhitelist: 'whitelist' in opts ? (opts.whitelist as readonly string[] | null) : [ADMIN],
  });
  return s;
}

describe('running total', () => {
  it('starts at the baseline', () => {
    expect(sentinel({ baseline: 5_000n }).expectedSupply(TOKEN)).toBe(5_000n);
  });

  it('adds mints and subtracts burns and clawbacks', () => {
    const s = sentinel();

    s.processLedger(TOKEN, 100, [event('mint', 500n), event('burn', 200n), event('clawback', 50n)], 1_250n);

    expect(s.expectedSupply(TOKEN)).toBe(1_250n);
  });

  it('keeps the total across ledgers', () => {
    const s = sentinel();
    s.processLedger(TOKEN, 100, [event('mint', 100n)], 1_100n);
    s.processLedger(TOKEN, 101, [event('mint', 100n)], 1_200n);
    s.processLedger(TOKEN, 102, [event('burn', 50n)], 1_150n);
    expect(s.expectedSupply(TOKEN)).toBe(1_150n);
  });

  it('handles amounts far beyond 2^53 without rounding', () => {
    const big = 170_141_183_460_469_231_731_687_303_715_884_105_727n; // i128 max
    const s = sentinel({ baseline: 0n });

    const result = s.processLedger(TOKEN, 100, [event('mint', big)], big);

    expect(result.discrepancy).toBe(0n);
    expect(result.alerts.filter((a) => a.type === 'SUPPLY_DISCREPANCY')).toEqual([]);
  });

  it('ignores a replayed event and events for another token', () => {
    const s = sentinel();
    const mint = event('mint', 100n);

    s.processLedger(TOKEN, 100, [mint, mint, event('mint', 999n, { tokenContractId: OTHER_TOKEN })], 1_100n);

    expect(s.expectedSupply(TOKEN)).toBe(1_100n);
    s.processLedger(TOKEN, 101, [mint], 1_100n);
    expect(s.expectedSupply(TOKEN)).toBe(1_100n);
  });

  it('refuses to process a token that is not monitored', () => {
    expect(() => new SupplyInvariantSentinel().processLedger(TOKEN, 1, [], 0n)).toThrow(/not monitored/);
  });

  it('rejects a negative baseline', () => {
    expect(() => new SupplyInvariantSentinel().monitor({ tokenContractId: TOKEN, baselineSupply: -1n, minterWhitelist: null })).toThrow();
  });
});

describe('supply invariant', () => {
  it('raises nothing when events and the contract agree', () => {
    const result = sentinel().processLedger(TOKEN, 100, [event('mint', 500n), event('burn', 100n)], 1_400n);

    expect(result.alerts).toEqual([]);
    expect(result.discrepancy).toBe(0n);
  });

  it('flags supply that grew with no mint event (an unlogged mint)', () => {
    const result = sentinel().processLedger(TOKEN, 100, [event('mint', 100n)], 1_000_000_000n);

    expect(result.alerts).toEqual([
      expect.objectContaining({
        type: 'SUPPLY_DISCREPANCY',
        severity: 'CRITICAL',
        expectedSupply: '1100',
        onChainSupply: '1000000000',
        discrepancy: '999998900',
        ledgerSeq: 100,
      }),
    ]);
  });

  it('flags supply that shrank with no burn event, as a negative discrepancy', () => {
    const result = sentinel().processLedger(TOKEN, 100, [], 900n);
    expect(result.alerts[0]).toMatchObject({ type: 'SUPPLY_DISCREPANCY', discrepancy: '-100' });
  });

  it('flags a mint the contract did not apply (event without effect)', () => {
    const result = sentinel().processLedger(TOKEN, 100, [event('mint', 100n)], 1_000n);
    expect(result.alerts[0]).toMatchObject({ type: 'SUPPLY_DISCREPANCY', discrepancy: '-100' });
  });

  it('keeps the discrepancy standing, and alerts again only when it changes', () => {
    const s = sentinel();

    const first = s.processLedger(TOKEN, 100, [], 1_500n);
    const same = s.processLedger(TOKEN, 101, [], 1_500n);
    const grown = s.processLedger(TOKEN, 102, [], 1_800n);

    expect(first.alerts).toHaveLength(1);
    expect(same.alerts).toEqual([]);
    expect(same.discrepancy).toBe(500n); // still reported as standing, not rebased away
    expect(grown.alerts).toHaveLength(1);
    expect(grown.alerts[0].discrepancy).toBe('800');
  });

  it('alerts again if the discrepancy clears and then returns', () => {
    const s = sentinel();
    s.processLedger(TOKEN, 100, [], 1_500n);
    s.processLedger(TOKEN, 101, [event('burn', 500n)], 1_000n); // supply fell back: now consistent
    expect(s.processLedger(TOKEN, 102, [], 1_500n).alerts).toHaveLength(1);
  });

  it('does not judge the invariant when the supply could not be read', () => {
    const result = sentinel().processLedger(TOKEN, 100, [event('mint', 100n)], null);

    expect(result).toMatchObject({ supplyUnread: true, discrepancy: null, expectedSupply: 1_100n });
    expect(result.alerts).toEqual([]);
  });

  it('does not forget a standing discrepancy across an unreadable ledger', () => {
    const s = sentinel();
    s.processLedger(TOKEN, 100, [], 1_500n);
    s.processLedger(TOKEN, 101, [], null);
    expect(s.processLedger(TOKEN, 102, [], 1_500n).alerts).toEqual([]);
  });

  it('acknowledging a discrepancy rebases the baseline and silences it', () => {
    const s = sentinel();
    s.processLedger(TOKEN, 100, [], 1_500n);

    expect(s.acknowledge(TOKEN, 1_500n)).toBe(500n);

    expect(s.expectedSupply(TOKEN)).toBe(1_500n);
    expect(s.processLedger(TOKEN, 101, [event('mint', 10n)], 1_510n).alerts.filter((a) => a.type === 'SUPPLY_DISCREPANCY')).toEqual([]);
    expect(() => s.acknowledge(OTHER_TOKEN, 1n)).toThrow(/not monitored/);
  });
});

describe('minter whitelist', () => {
  it('raises an immediate critical alert for a mint authorised by an address outside the whitelist', () => {
    const result = sentinel().processLedger(TOKEN, 100, [event('mint', 777n, { authorizer: ROGUE, transactionHash: 'tx1' })], 1_777n);

    expect(result.alerts).toEqual([
      expect.objectContaining({
        type: 'UNAUTHORIZED_MINT',
        severity: 'CRITICAL',
        authorizer: ROGUE,
        account: USER,
        amount: '777',
        transactionHash: 'tx1',
      }),
    ]);
  });

  it('accepts a mint from a whitelisted minter', () => {
    expect(sentinel().processLedger(TOKEN, 100, [event('mint', 1n)], 1_001n).alerts).toEqual([]);
  });

  it('flags a mint that carries no authorizer when a whitelist is enforced', () => {
    const result = sentinel().processLedger(TOKEN, 100, [event('mint', 1n, { authorizer: null })], 1_001n);
    expect(result.alerts[0]).toMatchObject({ type: 'UNAUTHORIZED_MINT', authorizer: null });
  });

  it('flags every mint when the whitelist is empty', () => {
    const result = sentinel({ whitelist: [] }).processLedger(TOKEN, 100, [event('mint', 1n)], 1_001n);
    expect(result.alerts.map((a) => a.type)).toEqual(['UNAUTHORIZED_MINT']);
  });

  it('checks only the supply invariant when no whitelist is configured', () => {
    const result = sentinel({ whitelist: null }).processLedger(TOKEN, 100, [event('mint', 1n, { authorizer: ROGUE })], 1_001n);
    expect(result.alerts).toEqual([]);
  });

  it('reports an unauthorized mint and still counts its supply, so no false discrepancy follows', () => {
    const result = sentinel().processLedger(TOKEN, 100, [event('mint', 50n, { authorizer: ROGUE })], 1_050n);
    expect(result.alerts.map((a) => a.type)).toEqual(['UNAUTHORIZED_MINT']);
    expect(result.discrepancy).toBe(0n);
  });

  it('does not apply the whitelist to burns and clawbacks', () => {
    const result = sentinel().processLedger(TOKEN, 100, [event('burn', 1n, { authorizer: ROGUE }), event('clawback', 1n, { authorizer: ROGUE })], 998n);
    expect(result.alerts).toEqual([]);
  });

  it('reports both problems when an unauthorized mint also leaves the supply off', () => {
    const result = sentinel().processLedger(TOKEN, 100, [event('mint', 50n, { authorizer: ROGUE })], 9_999n);
    expect(result.alerts.map((a) => a.type)).toEqual(['UNAUTHORIZED_MINT', 'SUPPLY_DISCREPANCY']);
  });
});

describe('malformed events', () => {
  it.each([0n, -5n])('reports a mint of %s and leaves the total alone', (amount) => {
    const s = sentinel();

    const result = s.processLedger(TOKEN, 100, [event('mint', amount)], 1_000n);

    expect(result.alerts).toEqual([expect.objectContaining({ type: 'MALFORMED_EVENT', severity: 'WARNING' })]);
    expect(s.expectedSupply(TOKEN)).toBe(1_000n);
  });
});

describe('several tokens', () => {
  it('keeps each token\'s total, whitelist and discrepancy separate', () => {
    const s = sentinel();
    s.monitor({ tokenContractId: OTHER_TOKEN, baselineSupply: 50n, minterWhitelist: [ROGUE] });

    s.processLedger(TOKEN, 100, [event('mint', 10n)], 1_010n);
    const other = s.processLedger(OTHER_TOKEN, 100, [event('mint', 5n, { tokenContractId: OTHER_TOKEN, authorizer: ROGUE })], 70n);

    expect(s.expectedSupply(TOKEN)).toBe(1_010n);
    expect(s.expectedSupply(OTHER_TOKEN)).toBe(55n);
    expect(other.alerts.map((a) => a.type)).toEqual(['SUPPLY_DISCREPANCY']);
  });
});

/**
 * Token supply invariant verifier (#973).
 *
 * For each monitored SEP-41 / Stellar Asset Contract token it keeps a running total from `mint`,
 * `burn` and `clawback` events and, after every ledger, compares it with the contract's own
 * `TotalSupply` reading:
 *
 *     expected = baseline + sum(mint) - sum(burn) - sum(clawback)
 *
 * A difference means supply changed without an event (an unlogged mint, storage corruption) and is
 * alerted on, together with any `mint` authorised by an address outside the verified minter
 * whitelist. The discrepancy is NOT silently rebased away: it keeps being reported (once per
 * distinct value) until an operator calls `acknowledge`.
 *
 * It works on normalised events and a supply reading supplied by the caller. Decoding contract
 * events and reading the contract data entry from the ledger are the watcher's job.
 */

export type SupplyEventKind = 'mint' | 'burn' | 'clawback';

export interface TokenSupplyEvent {
  /** Unique per event (for example `<ledger>-<tx>-<index>`); replays are ignored. */
  eventId: string;
  kind: SupplyEventKind;
  tokenContractId: string;
  /** Who authorised a mint (the admin or minter). `null` when the event does not carry one. */
  authorizer: string | null;
  /** The account that received (mint) or lost (burn, clawback) the tokens. */
  account: string;
  /** Always positive, in the token's base units. */
  amount: bigint;
  ledgerSeq: number;
  transactionHash?: string;
}

export type SupplyAlertType = 'UNAUTHORIZED_MINT' | 'SUPPLY_DISCREPANCY' | 'MALFORMED_EVENT';

export interface SupplyAlert {
  type: SupplyAlertType;
  severity: 'CRITICAL' | 'WARNING';
  tokenContractId: string;
  ledgerSeq: number;
  /** Unauthorized mint: who minted, to whom and how much. */
  authorizer?: string | null;
  account?: string;
  amount?: string;
  transactionHash?: string;
  /** Supply discrepancy: what the events imply, what the contract reports, and the difference. */
  expectedSupply?: string;
  onChainSupply?: string;
  /** `onChain - expected`: positive means unlogged inflation, negative means unlogged removal. */
  discrepancy?: string;
  reason?: string;
}

export interface MonitoredToken {
  tokenContractId: string;
  /** Total supply at the moment monitoring starts (read from the contract). */
  baselineSupply: bigint;
  /**
   * Addresses allowed to authorise a mint. `null` turns the check off, leaving only the supply
   * invariant. An empty list means no address is verified, so every mint is flagged.
   */
  minterWhitelist: readonly string[] | null;
}

export interface LedgerResult {
  alerts: SupplyAlert[];
  expectedSupply: bigint;
  /** `null` when the on-chain supply could not be read this ledger. */
  discrepancy: bigint | null;
  /** `true` when the invariant could not be judged because the supply reading was missing. */
  supplyUnread: boolean;
}

interface TokenState {
  expected: bigint;
  minters: ReadonlySet<string> | null;
  seen: Set<string>;
  lastReportedDiscrepancy: bigint;
}

export class SupplyInvariantSentinel {
  private readonly tokens = new Map<string, TokenState>();

  /** Starts monitoring a token. Re-registering resets its running total to the new baseline. */
  monitor(token: MonitoredToken): void {
    if (token.baselineSupply < 0n) throw new Error('baselineSupply must not be negative');
    this.tokens.set(token.tokenContractId, {
      expected: token.baselineSupply,
      minters: token.minterWhitelist === null ? null : new Set(token.minterWhitelist),
      seen: new Set(),
      lastReportedDiscrepancy: 0n,
    });
  }

  isMonitored(tokenContractId: string): boolean {
    return this.tokens.has(tokenContractId);
  }

  /** The running total the events imply, or `undefined` for an unmonitored token. */
  expectedSupply(tokenContractId: string): bigint | undefined {
    return this.tokens.get(tokenContractId)?.expected;
  }

  /**
   * Applies one ledger's events for a token and reconciles against the contract's supply.
   * Events are applied in the order given. Pass `onChainSupply = null` if it could not be read.
   * @throws if the token is not monitored.
   */
  processLedger(
    tokenContractId: string,
    ledgerSeq: number,
    events: readonly TokenSupplyEvent[],
    onChainSupply: bigint | null,
  ): LedgerResult {
    const state = this.tokens.get(tokenContractId);
    if (!state) throw new Error(`Token ${tokenContractId} is not monitored`);
    const alerts: SupplyAlert[] = [];

    for (const event of events) {
      if (event.tokenContractId !== tokenContractId || state.seen.has(event.eventId)) continue;
      state.seen.add(event.eventId);

      if (event.amount <= 0n) {
        alerts.push({
          type: 'MALFORMED_EVENT',
          severity: 'WARNING',
          tokenContractId,
          ledgerSeq: event.ledgerSeq,
          transactionHash: event.transactionHash,
          reason: `${event.kind} with non-positive amount ${event.amount}`,
        });
        continue;
      }

      if (event.kind === 'mint') {
        state.expected += event.amount;
        if (state.minters !== null && (event.authorizer === null || !state.minters.has(event.authorizer))) {
          alerts.push({
            type: 'UNAUTHORIZED_MINT',
            severity: 'CRITICAL',
            tokenContractId,
            ledgerSeq: event.ledgerSeq,
            authorizer: event.authorizer,
            account: event.account,
            amount: event.amount.toString(),
            transactionHash: event.transactionHash,
          });
        }
      } else {
        state.expected -= event.amount;
      }
    }

    if (onChainSupply === null) {
      return { alerts, expectedSupply: state.expected, discrepancy: null, supplyUnread: true };
    }

    const discrepancy = onChainSupply - state.expected;
    if (discrepancy !== 0n && discrepancy !== state.lastReportedDiscrepancy) {
      alerts.push({
        type: 'SUPPLY_DISCREPANCY',
        severity: 'CRITICAL',
        tokenContractId,
        ledgerSeq,
        expectedSupply: state.expected.toString(),
        onChainSupply: onChainSupply.toString(),
        discrepancy: discrepancy.toString(),
      });
    }
    state.lastReportedDiscrepancy = discrepancy;

    return { alerts, expectedSupply: state.expected, discrepancy, supplyUnread: false };
  }

  /**
   * An operator accepts the current on-chain supply as the new baseline after investigating a
   * discrepancy. Returns the discrepancy that was cleared.
   * @throws if the token is not monitored.
   */
  acknowledge(tokenContractId: string, onChainSupply: bigint): bigint {
    const state = this.tokens.get(tokenContractId);
    if (!state) throw new Error(`Token ${tokenContractId} is not monitored`);
    const cleared = onChainSupply - state.expected;
    state.expected = onChainSupply;
    state.lastReportedDiscrepancy = 0n;
    return cleared;
  }
}

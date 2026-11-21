/**
 * Soroban smart account sentinel (#968).
 *
 * Watches custom account contracts (`__check_auth`) for the changes that matter to their owners:
 * WebAuthn passkey (secp256r1) signers being added or removed, session keys expiring or being
 * revoked, spending policy limits moving, spends breaching those limits, and rejected
 * `__check_auth` attempts.
 *
 * It works on a normalised model of an account's storage (`SmartAccountSnapshot`) and of spend and
 * auth events. Decoding a particular smart account implementation's XDR storage entries into that
 * model is a separate adapter, because the layout differs between implementations; this module
 * deliberately does not guess one.
 */

export type SignerKind = 'secp256r1' | 'ed25519' | 'policy';

export interface SmartAccountSigner {
  /** Stable identifier of the signer in the account's storage (a key id or address). */
  id: string;
  kind: SignerKind;
  /** secp256r1 only: the uncompressed SEC1 public key as hex (65 bytes, starting `04`). */
  publicKey?: string;
  /** Last ledger the signer is valid for. Set for session keys, `null` or absent for permanent. */
  expirationLedger?: number | null;
}

export interface SpendingPolicy {
  /** Maximum per transaction, in base units. `null` means unlimited. */
  perTxLimit: bigint | null;
  /** Maximum per rolling day, in base units. `null` means unlimited. */
  dailyLimit: bigint | null;
}

export interface SmartAccountSnapshot {
  signers: readonly SmartAccountSigner[];
  policy: SpendingPolicy | null;
}

export type SmartAccountAlertType =
  | 'PASSKEY_SIGNER_ADDED'
  | 'PASSKEY_SIGNER_REMOVED'
  | 'PASSKEY_KEY_MALFORMED'
  | 'SESSION_KEY_ADDED'
  | 'SESSION_KEY_EXPIRED'
  | 'SESSION_KEY_REVOKED'
  | 'POLICY_LIMIT_RAISED'
  | 'POLICY_LIMIT_LOWERED'
  | 'SPENDING_LIMIT_BREACH'
  | 'AUTH_REJECTED';

export interface SmartAccountAlert {
  type: SmartAccountAlertType;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  accountId: string;
  ledgerSeq: number;
  signerId?: string;
  publicKey?: string;
  expirationLedger?: number;
  /** Policy changes: which limit moved and its old and new value (`null` is unlimited). */
  limit?: 'perTxLimit' | 'dailyLimit';
  previousValue?: string | null;
  newValue?: string | null;
  /** Spending breaches. */
  breach?: 'PER_TX' | 'DAILY';
  amount?: string;
  limitValue?: string;
  spentInWindow?: string;
  /** Rejected auth attempts. */
  reason?: string;
  failuresInWindow?: number;
  transactionHash?: string;
}

export interface SpendEvent {
  accountId: string;
  /** Amount in base units. */
  amount: bigint;
  ledgerSeq: number;
  transactionHash?: string;
}

export interface AuthAttempt {
  accountId: string;
  success: boolean;
  /** Which signer was tried, when the diagnostics say. */
  signerId?: string;
  reason?: string;
  ledgerSeq: number;
  transactionHash?: string;
}

/** Ledgers in about 24 hours at one ledger every 5 seconds. */
export const DAY_LEDGERS = 17_280;
/** Window over which rejected attempts are counted for context. */
export const AUTH_FAILURE_WINDOW_LEDGERS = 120;

/** An uncompressed secp256r1 key: 65 bytes as hex, with the `04` prefix. */
export function isValidSecp256r1PublicKey(hex: unknown): hex is string {
  return typeof hex === 'string' && /^04[0-9a-fA-F]{128}$/.test(hex);
}

function limitText(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

/** `true` when `next` allows more than `previous` (unlimited counts as the most). */
function isRaised(previous: bigint | null, next: bigint | null): boolean {
  if (previous === next) return false;
  if (next === null) return true;
  if (previous === null) return false;
  return next > previous;
}

interface AccountState {
  signers: Map<string, SmartAccountSigner>;
  policy: SpendingPolicy | null;
  expired: Set<string>;
  spends: { ledgerSeq: number; amount: bigint }[];
  failures: number[];
}

export class SmartAccountSentinel {
  private readonly accounts = new Map<string, AccountState>();

  /** Starts watching an account from a known snapshot. Raises no alerts. */
  watch(accountId: string, snapshot: SmartAccountSnapshot): void {
    this.accounts.set(accountId, {
      signers: new Map(snapshot.signers.map((signer) => [signer.id, signer])),
      policy: snapshot.policy,
      expired: new Set(),
      spends: [],
      failures: [],
    });
  }

  isWatched(accountId: string): boolean {
    return this.accounts.has(accountId);
  }

  /**
   * Compares the account's new storage with the last one seen and returns an alert for each
   * change. Unwatched accounts are ignored.
   */
  processSnapshot(accountId: string, next: SmartAccountSnapshot, ledgerSeq: number): SmartAccountAlert[] {
    const state = this.accounts.get(accountId);
    if (!state) return [];
    const alerts: SmartAccountAlert[] = [];
    const nextSigners = new Map(next.signers.map((signer) => [signer.id, signer]));

    for (const [id, signer] of nextSigners) {
      if (state.signers.has(id)) continue;
      alerts.push(...this.signerAdded(accountId, signer, ledgerSeq));
    }
    for (const [id, signer] of state.signers) {
      if (nextSigners.has(id)) continue;
      alerts.push(this.signerRemoved(accountId, signer, ledgerSeq));
    }

    alerts.push(...this.policyChanges(accountId, state.policy, next.policy, ledgerSeq));

    state.signers = nextSigners;
    state.policy = next.policy;
    return alerts;
  }

  private signerAdded(accountId: string, signer: SmartAccountSigner, ledgerSeq: number): SmartAccountAlert[] {
    const alerts: SmartAccountAlert[] = [];
    const expiration = signer.expirationLedger ?? undefined;

    if (signer.kind === 'secp256r1') {
      if (!isValidSecp256r1PublicKey(signer.publicKey)) {
        alerts.push({
          type: 'PASSKEY_KEY_MALFORMED',
          severity: 'CRITICAL',
          accountId,
          ledgerSeq,
          signerId: signer.id,
          publicKey: signer.publicKey,
          reason: 'secp256r1 signer without a valid uncompressed public key',
        });
      } else {
        alerts.push({
          type: 'PASSKEY_SIGNER_ADDED',
          severity: 'WARNING',
          accountId,
          ledgerSeq,
          signerId: signer.id,
          publicKey: signer.publicKey.toLowerCase(),
          expirationLedger: expiration,
        });
      }
    }

    if (expiration !== undefined) {
      alerts.push({
        type: 'SESSION_KEY_ADDED',
        severity: 'INFO',
        accountId,
        ledgerSeq,
        signerId: signer.id,
        expirationLedger: expiration,
      });
    }
    return alerts;
  }

  private signerRemoved(accountId: string, signer: SmartAccountSigner, ledgerSeq: number): SmartAccountAlert {
    const expiration = signer.expirationLedger ?? undefined;
    const revokedEarly = expiration !== undefined && ledgerSeq <= expiration;
    if (signer.kind === 'secp256r1') {
      return {
        type: 'PASSKEY_SIGNER_REMOVED',
        severity: 'WARNING',
        accountId,
        ledgerSeq,
        signerId: signer.id,
        publicKey: signer.publicKey?.toLowerCase(),
        expirationLedger: expiration,
      };
    }
    return {
      type: revokedEarly ? 'SESSION_KEY_REVOKED' : 'PASSKEY_SIGNER_REMOVED',
      severity: revokedEarly ? 'INFO' : 'WARNING',
      accountId,
      ledgerSeq,
      signerId: signer.id,
      expirationLedger: expiration,
    };
  }

  private policyChanges(
    accountId: string,
    previous: SpendingPolicy | null,
    next: SpendingPolicy | null,
    ledgerSeq: number,
  ): SmartAccountAlert[] {
    const alerts: SmartAccountAlert[] = [];
    // No policy behaves as no limits at all.
    const before: SpendingPolicy = previous ?? { perTxLimit: null, dailyLimit: null };
    const after: SpendingPolicy = next ?? { perTxLimit: null, dailyLimit: null };

    for (const limit of ['perTxLimit', 'dailyLimit'] as const) {
      if (before[limit] === after[limit]) continue;
      const raised = isRaised(before[limit], after[limit]);
      alerts.push({
        type: raised ? 'POLICY_LIMIT_RAISED' : 'POLICY_LIMIT_LOWERED',
        severity: raised ? 'WARNING' : 'INFO',
        accountId,
        ledgerSeq,
        limit,
        previousValue: limitText(before[limit]),
        newValue: limitText(after[limit]),
      });
    }
    return alerts;
  }

  /**
   * Alerts for each session key whose expiration ledger has passed. Each key is reported once.
   * Call it as ledgers close.
   */
  checkExpirations(ledgerSeq: number): SmartAccountAlert[] {
    const alerts: SmartAccountAlert[] = [];
    for (const [accountId, state] of this.accounts) {
      for (const signer of state.signers.values()) {
        const expiration = signer.expirationLedger;
        if (expiration === null || expiration === undefined || ledgerSeq <= expiration) continue;
        if (state.expired.has(signer.id)) continue;
        state.expired.add(signer.id);
        alerts.push({
          type: 'SESSION_KEY_EXPIRED',
          severity: 'INFO',
          accountId,
          ledgerSeq,
          signerId: signer.id,
          expirationLedger: expiration,
        });
      }
    }
    return alerts;
  }

  /**
   * Records a spend and alerts if it breaks the policy: a single spend over the per-transaction
   * limit, or the rolling 24-hour total over the daily limit. The spend counts either way.
   */
  recordSpend(spend: SpendEvent): SmartAccountAlert[] {
    const state = this.accounts.get(spend.accountId);
    if (!state) return [];

    const windowStart = spend.ledgerSeq - DAY_LEDGERS;
    state.spends = state.spends.filter((entry) => entry.ledgerSeq > windowStart);
    state.spends.push({ ledgerSeq: spend.ledgerSeq, amount: spend.amount });
    const spent = state.spends.reduce((total, entry) => total + entry.amount, 0n);

    const alerts: SmartAccountAlert[] = [];
    const policy = state.policy;
    if (policy?.perTxLimit != null && spend.amount > policy.perTxLimit) {
      alerts.push({
        type: 'SPENDING_LIMIT_BREACH',
        severity: 'CRITICAL',
        accountId: spend.accountId,
        ledgerSeq: spend.ledgerSeq,
        breach: 'PER_TX',
        amount: spend.amount.toString(),
        limitValue: policy.perTxLimit.toString(),
        spentInWindow: spent.toString(),
        transactionHash: spend.transactionHash,
      });
    }
    if (policy?.dailyLimit != null && spent > policy.dailyLimit) {
      alerts.push({
        type: 'SPENDING_LIMIT_BREACH',
        severity: 'CRITICAL',
        accountId: spend.accountId,
        ledgerSeq: spend.ledgerSeq,
        breach: 'DAILY',
        amount: spend.amount.toString(),
        limitValue: policy.dailyLimit.toString(),
        spentInWindow: spent.toString(),
        transactionHash: spend.transactionHash,
      });
    }
    return alerts;
  }

  /** Records a `__check_auth` result. A rejected attempt alerts immediately; a success does not. */
  recordAuthAttempt(attempt: AuthAttempt): SmartAccountAlert[] {
    const state = this.accounts.get(attempt.accountId);
    if (!state || attempt.success) return [];

    state.failures = state.failures.filter((ledger) => ledger > attempt.ledgerSeq - AUTH_FAILURE_WINDOW_LEDGERS);
    state.failures.push(attempt.ledgerSeq);

    return [
      {
        type: 'AUTH_REJECTED',
        severity: 'CRITICAL',
        accountId: attempt.accountId,
        ledgerSeq: attempt.ledgerSeq,
        signerId: attempt.signerId,
        reason: attempt.reason,
        failuresInWindow: state.failures.length,
        transactionHash: attempt.transactionHash,
      },
    ];
  }
}

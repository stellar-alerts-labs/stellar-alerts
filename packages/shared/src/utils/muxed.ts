import { Account, MuxedAccount } from 'stellar-sdk';
import { isValidEd25519PublicKey, parseMuxedAddress } from '../strkey';

/** Largest value of the unsigned 64-bit mux id (CAP-0027). */
export const MAX_MUXED_ID = (1n << 64n) - 1n;

/**
 * The canonical form of an address a payment was sent to.
 *
 * `baseAccountId` is always the underlying `G...` Ed25519 account. `muxedId` is the unsigned 64-bit
 * virtual id as a decimal string, or `null` for a plain `G...` address.
 */
export interface ResolvedAddress {
  baseAccountId: string;
  muxedId: string | null;
}

/** A watcher's subscription: a plain `G...` account, or one specific `M...` virtual address. */
export interface AddressSubscription {
  address: string;
}

/** Fields added to an outgoing alert payload for a payment that involved a muxed address. */
export interface MuxedPayloadFields {
  /** The full `M...` address the payment was sent to, or `null` for a plain account. */
  muxedAccount: string | null;
  /** The 64-bit virtual id as a decimal string, or `null` for a plain account. */
  muxedId: string | null;
}

function isCanonicalMuxedId(value: string): boolean {
  // No sign, no leading zeros (except "0" itself), digits only, and within 64 bits.
  return /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= MAX_MUXED_ID;
}

/**
 * Decodes, encodes and matches CAP-0027 muxed accounts (`M...`), so payments sent to a virtual
 * sub-account can be attributed to the underlying `G...` account and to its 64-bit id.
 */
export class MuxedAccountResolver {
  /**
   * Resolves a `G...` or `M...` address into its canonical `{ baseAccountId, muxedId }` pair.
   * Returns `null` for anything that is not a valid account address (including contract ids).
   */
  resolve(address: unknown): ResolvedAddress | null {
    if (typeof address !== 'string') return null;
    if (isValidEd25519PublicKey(address)) return { baseAccountId: address, muxedId: null };

    const parts = parseMuxedAddress(address);
    if (!parts) return null;
    return { baseAccountId: parts.accountId, muxedId: parts.id };
  }

  /**
   * Builds the `M...` address for a base account and a virtual id.
   *
   * @throws if the base account is not a valid `G...` key or the id is not an unsigned 64-bit
   *   decimal string (`0` to `18446744073709551615`).
   */
  encode(baseAccountId: string, muxedId: string): string {
    if (!isValidEd25519PublicKey(baseAccountId)) {
      throw new Error('baseAccountId must be a valid Ed25519 public key (G...)');
    }
    if (!isCanonicalMuxedId(muxedId)) {
      throw new Error('muxedId must be an unsigned 64-bit decimal string');
    }
    return new MuxedAccount(new Account(baseAccountId, '0'), muxedId).accountId();
  }

  /**
   * Whether a payment sent to `destination` is for a watcher subscribed to `subscribed`.
   *
   * - A `G...` subscription matches a payment to that account **and** to any `M...` address of it.
   * - An `M...` subscription matches only that exact virtual address: not the bare `G...`, and not
   *   a different id of the same account.
   * - Anything invalid on either side never matches.
   */
  matches(destination: unknown, subscribed: unknown): boolean {
    const target = this.resolve(destination);
    const subscription = this.resolve(subscribed);
    if (!target || !subscription) return false;
    if (target.baseAccountId !== subscription.baseAccountId) return false;
    if (subscription.muxedId === null) return true;
    return target.muxedId === subscription.muxedId;
  }

  /** The watchers a payment sent to `destination` should be delivered to, in their given order. */
  matchWatchers<T extends AddressSubscription>(destination: unknown, watchers: readonly T[]): T[] {
    return watchers.filter((watcher) => this.matches(destination, watcher.address));
  }

  /** The `muxedAccount` / `muxedId` fields for an outgoing webhook alert payload. */
  payloadFields(destination: unknown): MuxedPayloadFields {
    const resolved = this.resolve(destination);
    if (!resolved || resolved.muxedId === null) return { muxedAccount: null, muxedId: null };
    return { muxedAccount: destination as string, muxedId: resolved.muxedId };
  }

  /** Returns a copy of `payload` with the `muxedAccount` and `muxedId` fields set. */
  annotate<T extends object>(payload: T, destination: unknown): T & MuxedPayloadFields {
    return { ...payload, ...this.payloadFields(destination) };
  }
}

export const muxedAccountResolver = new MuxedAccountResolver();

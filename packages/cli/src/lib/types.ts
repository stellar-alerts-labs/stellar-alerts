import { isValidEd25519PublicKey } from '@stellar-alerts/shared';

/**
 * Validates whether a given string is a valid Stellar Ed25519 Public Key.
 * Delegates to the shared StrKey utility (version byte + CRC16-XMODEM
 * checksum), so the CLI performs the same validation as apps/api and apps/web
 * instead of a shape-only `length === 56 && startsWith('G')` check.
 */
export function isValidStellarPublicKey(publicKey: string): boolean {
  return isValidEd25519PublicKey(publicKey);
}

export interface WalletDTO {
  id: string;
  userId: string;
  publicKey: string;
  label?: string | null;
  createdAt: Date | string;
}

export interface PaymentDTO {
  id: string;
  walletId: string;
  txHash: string;
  fromAddress: string;
  amount: number | string;
  asset: string;
  memo?: string | null;
  receivedAt: Date | string;
}

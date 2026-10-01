/**
 * Barrel export for all test factories and fixtures.
 *
 * Import from here in test files:
 *   import { makeUser, makeWallet, makePayment, makeAlertJob } from '../../tests/factories';
 */

export {
  makeUser,
  resetUserCounter,
  invalidUserFixtures,
} from './user.factory';
export type { UserRecord } from './user.factory';

export {
  makeWallet,
  makeWalletWithCursor,
  makeIngestionCursor,
  resetWalletCounter,
  invalidWalletFixtures,
  STELLAR_PUBLIC_KEYS,
} from './wallet.factory';
export type { WalletRecord, WalletWithCursor, IngestionCursorRecord } from './wallet.factory';

export {
  makePayment,
  makePayments,
  resetPaymentCounter,
  invalidPaymentFixtures,
} from './payment.factory';
export type { PaymentRecord } from './payment.factory';

export {
  makeAlertJob,
  makeAlertJobs,
  resetJobCounter,
  invalidJobFixtures,
} from './job.factory';
export type { AlertJobData } from './job.factory';

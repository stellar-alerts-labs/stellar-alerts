import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import crypto from 'crypto';
import {
  PreAuthTxSentinel,
  InMemoryPreAuthTxStore,
  isPreAuthTxStrKey,
  txHashToPreAuthTxKey,
  preAuthTxKeyToHash,
  decodePreAuthTxEnvelope,
  formatPreAuthTxTelegramHtml,
  formatPreAuthTxWebhookPayload,
  deliverPreAuthTxAlert,
  escapeTelegramHtml,
  type PreAuthTxAlert,
  type HorizonOperationRecord,
  type HorizonTransactionRecord,
} from '../preauth-tx-sentinel';

const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

function createTestTransaction(params: {
  sourceAccountKeypair?: StellarSdk.Keypair;
  sequence?: string;
  timebounds?: { minTime: string; maxTime: string };
  fee?: string;
}) {
  const kp = params.sourceAccountKeypair ?? StellarSdk.Keypair.random();
  const seq = params.sequence ?? '100';
  const account = new StellarSdk.Account(kp.publicKey(), seq);

  let builder = new StellarSdk.TransactionBuilder(account, {
    fee: params.fee ?? '100',
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: params.timebounds,
  });

  if (!params.timebounds) {
    builder = builder.setTimeout(300);
  }

  builder = builder.addOperation(
    StellarSdk.Operation.payment({
      destination: StellarSdk.Keypair.random().publicKey(),
      asset: StellarSdk.Asset.native(),
      amount: '50',
    }),
  );

  const tx = builder.build();
  tx.sign(kp);

  const xdr = tx.toXDR();
  const txHash = tx.hash().toString('hex').toLowerCase();
  const signerKey = StellarSdk.StrKey.encodePreAuthTx(tx.hash());

  return {
    tx,
    xdr,
    txHash,
    signerKey,
    sourceAccount: kp.publicKey(),
    sequence: tx.sequence,
    timebounds: tx.timeBounds
      ? { minTime: String(tx.timeBounds.minTime), maxTime: String(tx.timeBounds.maxTime) }
      : null,
  };
}

describe('PreAuthTxSentinel (#1032)', () => {
  let sentinel: PreAuthTxSentinel;
  let mockNow: number;

  beforeEach(() => {
    mockNow = 1_700_000_000_000; // Mock current timestamp
    sentinel = new PreAuthTxSentinel(undefined, { alertCooldownMs: 0 }, () => mockNow);
  });

  // ── 1. StrKey & Helper Functions ───────────────────────────────────────────
  describe('StrKey and Hash Encoding/Decoding', () => {
    it('validates a valid T... PreAuthTx StrKey', () => {
      const hash = crypto.randomBytes(32);
      const strKey = StellarSdk.StrKey.encodePreAuthTx(hash);

      expect(isPreAuthTxStrKey(strKey)).toBe(true);
      expect(strKey.startsWith('T')).toBe(true);
      expect(strKey).toHaveLength(56);
    });

    it('rejects invalid StrKeys, ed25519 public keys, and non-T keys', () => {
      const ed25519 = StellarSdk.Keypair.random().publicKey();
      expect(isPreAuthTxStrKey(ed25519)).toBe(false);
      expect(isPreAuthTxStrKey('')).toBe(false);
      expect(isPreAuthTxStrKey('TINVALID')).toBe(false);
      expect(isPreAuthTxStrKey(null as any)).toBe(false);
    });

    it('converts between 32-byte hash and T... StrKey deterministically', () => {
      const hash = crypto.randomBytes(32);
      const hex = hash.toString('hex').toLowerCase();

      const keyFromBuf = txHashToPreAuthTxKey(hash);
      const keyFromHex = txHashToPreAuthTxKey(hex);
      const keyWith0x = txHashToPreAuthTxKey(`0x${hex}`);

      expect(keyFromBuf).toBe(keyFromHex);
      expect(keyFromBuf).toBe(keyWith0x);

      const decodedHex = preAuthTxKeyToHash(keyFromBuf);
      expect(decodedHex).toBe(hex);
    });

    it('throws error when converting invalid length hash to PreAuthTxKey', () => {
      expect(() => txHashToPreAuthTxKey(Buffer.from('too-short'))).toThrow(
        /Expected 32-byte hash/,
      );
    });

    it('decodes envelope XDR and extracts pre-auth signer details', () => {
      const { xdr, txHash, signerKey, sourceAccount, sequence, timebounds } =
        createTestTransaction({
          timebounds: { minTime: '1700000000', maxTime: '1700003600' },
        });

      const decoded = decodePreAuthTxEnvelope(xdr, NETWORK_PASSPHRASE);
      expect(decoded).not.toBeNull();
      expect(decoded?.sourceAccount).toBe(sourceAccount);
      expect(decoded?.txHash).toBe(txHash);
      expect(decoded?.signerKey).toBe(signerKey);
      expect(decoded?.sequenceNumber).toBe(sequence);
      expect(decoded?.timeBounds).toEqual(timebounds);
      expect(decoded?.isFeeBump).toBe(false);
    });

    it('returns null when decoding invalid envelope XDR', () => {
      expect(decodePreAuthTxEnvelope('not-a-valid-xdr', NETWORK_PASSPHRASE)).toBeNull();
    });
  });

  // ── 2. Operation Monitor: Signer Addition & Removal ─────────────────────────
  describe('Operation Monitor: set_options detection', () => {
    it('detects set_options adding a pre-auth tx signer (weight > 0)', async () => {
      const accountId = StellarSdk.Keypair.random().publicKey();
      const hash = crypto.randomBytes(32);
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(hash);
      const txHash = hash.toString('hex').toLowerCase();

      const alerts: PreAuthTxAlert[] = [];
      sentinel.subscribe((alert) => alerts.push(alert));

      const op: HorizonOperationRecord = {
        id: '1001',
        type: 'set_options',
        source_account: accountId,
        signer_key: signerKey,
        signer_weight: 1,
        signer_type: 'preAuthTx',
        transaction_hash: 'tx-add-signer',
        created_at: new Date(mockNow).toISOString(),
      };

      const alert = await sentinel.processOperation(op);

      expect(alert).not.toBeNull();
      expect(alert?.eventType).toBe('PREAUTH_TX_SIGNER_ADDED');
      expect(alert?.severity).toBe('INFO');
      expect(alert?.account).toBe(accountId);
      expect(alert?.signerKey).toBe(signerKey);
      expect(alert?.txHash).toBe(txHash);
      expect(alert?.weight).toBe(1);
      expect(alerts).toHaveLength(1);

      const tracked = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(tracked).not.toBeNull();
      expect(tracked?.status).toBe('ACTIVE');
      expect(tracked?.weight).toBe(1);
    });

    it('detects set_options removing a pre-auth tx signer (weight = 0)', async () => {
      const accountId = StellarSdk.Keypair.random().publicKey();
      const hash = crypto.randomBytes(32);
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(hash);

      // Pre-register active signer
      await sentinel.registerPreAuthTx({
        accountId,
        signerKey,
        weight: 1,
      });

      const opRemove: HorizonOperationRecord = {
        id: '1002',
        type: 'set_options',
        source_account: accountId,
        signer_key: signerKey,
        signer_weight: 0,
        transaction_hash: 'tx-remove-signer',
        created_at: new Date(mockNow).toISOString(),
      };

      const alert = await sentinel.processOperation(opRemove);

      expect(alert).not.toBeNull();
      expect(alert?.eventType).toBe('PREAUTH_TX_SIGNER_REMOVED');
      expect(alert?.severity).toBe('WARNING');
      expect(alert?.weight).toBe(0);

      const tracked = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(tracked?.status).toBe('REMOVED');
      expect(tracked?.weight).toBe(0);
    });

    it('does not emit removal warning if signer was already consumed by execution', async () => {
      const accountId = StellarSdk.Keypair.random().publicKey();
      const hash = crypto.randomBytes(32);
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(hash);
      const txHash = hash.toString('hex').toLowerCase();

      // Register and mark consumed
      const signer = await sentinel.registerPreAuthTx({
        accountId,
        signerKey,
        weight: 1,
      });
      await sentinel.processTransaction({
        hash: txHash,
        successful: true,
        source_account: accountId,
      });

      const trackedBefore = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(trackedBefore?.status).toBe('CONSUMED');

      // Now horizon emits set_options with weight 0 as part of protocol consumption
      const opZero: HorizonOperationRecord = {
        id: '1003',
        type: 'set_options',
        source_account: accountId,
        signer_key: signerKey,
        signer_weight: 0,
      };

      const alert = await sentinel.processOperation(opZero);
      expect(alert).toBeNull(); // Suppressed because it was consumed
    });

    it('ignores standard ed25519 G... signers and failed operations', async () => {
      const accountId = StellarSdk.Keypair.random().publicKey();
      const ed25519Signer = StellarSdk.Keypair.random().publicKey();

      const opEd25519: HorizonOperationRecord = {
        id: '1004',
        type: 'set_options',
        source_account: accountId,
        signer_key: ed25519Signer,
        signer_weight: 2,
      };
      expect(await sentinel.processOperation(opEd25519)).toBeNull();

      const opFailed: HorizonOperationRecord = {
        id: '1005',
        type: 'set_options',
        transaction_successful: false,
        source_account: accountId,
        signer_key: StellarSdk.StrKey.encodePreAuthTx(crypto.randomBytes(32)),
        signer_weight: 1,
      };
      expect(await sentinel.processOperation(opFailed)).toBeNull();
    });
  });

  // ── 3. Sequence Number Invalidation Guard ───────────────────────────────────
  describe('Sequence Number Invalidation Guard', () => {
    it('triggers critical alert when another transaction increments sequence >= pre-auth tx sequence', async () => {
      const kp = StellarSdk.Keypair.random();
      const accountId = kp.publicKey();

      // Pre-authorized transaction built for sequence 105
      const { txHash, signerKey } = createTestTransaction({
        sourceAccountKeypair: kp,
        sequence: '104', // Transaction sequence will be 105
      });

      await sentinel.registerPreAuthTx({
        accountId,
        signerKey,
        txHash,
        sequenceNumber: '105',
      });

      const alerts: PreAuthTxAlert[] = [];
      sentinel.subscribe((a) => alerts.push(a));

      // Another transaction executes from the same account with sequence 105
      const otherTx: HorizonTransactionRecord = {
        hash: 'unrelated-tx-hash-111111111111111111111111111111111111111111111111111111',
        successful: true,
        source_account: accountId,
        source_account_sequence: '105',
        created_at: new Date(mockNow).toISOString(),
      };

      const emitted = await sentinel.processTransaction(otherTx);

      expect(emitted).toHaveLength(1);
      const alert = emitted[0];
      expect(alert.eventType).toBe('PREAUTH_TX_SEQUENCE_INVALIDATED');
      expect(alert.severity).toBe('CRITICAL');
      expect(alert.account).toBe(accountId);
      expect(alert.signerKey).toBe(signerKey);
      expect(alert.sequenceNumber).toBe('105');
      expect(alert.details?.accountSequenceAfterTx).toBe('105');
      expect(alert.message).toContain('CRITICAL: Pre-authorized transaction');

      const tracked = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(tracked?.status).toBe('INVALIDATED');
      expect(tracked?.invalidatedAt).toBeDefined();
    });

    it('triggers critical alert when bump_sequence operation jumps past pre-auth sequence', async () => {
      const kp = StellarSdk.Keypair.random();
      const accountId = kp.publicKey();

      const { txHash, signerKey } = createTestTransaction({
        sourceAccountKeypair: kp,
        sequence: '200',
      });

      await sentinel.registerPreAuthTx({
        accountId,
        signerKey,
        txHash,
        sequenceNumber: '201',
      });

      const bumpOp: HorizonOperationRecord = {
        id: 'op-bump-1',
        type: 'bump_sequence',
        source_account: accountId,
        bump_to: '300',
        transaction_hash: 'tx-bump',
        created_at: new Date(mockNow).toISOString(),
      };

      const alert = await sentinel.processOperation(bumpOp);

      expect(alert).not.toBeNull();
      expect(alert?.eventType).toBe('PREAUTH_TX_SEQUENCE_INVALIDATED');
      expect(alert?.severity).toBe('CRITICAL');
      expect(alert?.details?.bumpTo).toBe('300');

      const tracked = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(tracked?.status).toBe('INVALIDATED');
    });

    it('does not invalidate when another transaction has a lower sequence number', async () => {
      const kp = StellarSdk.Keypair.random();
      const accountId = kp.publicKey();

      const { txHash, signerKey } = createTestTransaction({
        sourceAccountKeypair: kp,
        sequence: '500',
      });

      await sentinel.registerPreAuthTx({
        accountId,
        signerKey,
        txHash,
        sequenceNumber: '501',
      });

      // An intermediate transaction executes with sequence 490 (< 501)
      const earlierTx: HorizonTransactionRecord = {
        hash: 'earlier-tx',
        successful: true,
        source_account: accountId,
        source_account_sequence: '490',
      };

      const alerts = await sentinel.processTransaction(earlierTx);
      expect(alerts).toHaveLength(0);

      const tracked = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(tracked?.status).toBe('ACTIVE');
    });

    it('does not invalidate when a transaction is from a different source account', async () => {
      const kp1 = StellarSdk.Keypair.random();
      const kp2 = StellarSdk.Keypair.random();

      const { txHash, signerKey } = createTestTransaction({
        sourceAccountKeypair: kp1,
        sequence: '100',
      });

      await sentinel.registerPreAuthTx({
        accountId: kp1.publicKey(),
        signerKey,
        txHash,
        sequenceNumber: '101',
      });

      const otherAccountTx: HorizonTransactionRecord = {
        hash: 'other-acc-tx',
        successful: true,
        source_account: kp2.publicKey(),
        source_account_sequence: '999',
      };

      const alerts = await sentinel.processTransaction(otherAccountTx);
      expect(alerts).toHaveLength(0);

      const tracked = await sentinel.getPreAuthTx(kp1.publicKey(), signerKey);
      expect(tracked?.status).toBe('ACTIVE');
    });
  });

  // ── 4. Expiration Window Monitor ───────────────────────────────────────────
  describe('Expiration Window Monitor', () => {
    it('detects when an active pre-authorized transaction exceeds max_time', async () => {
      const accountId = StellarSdk.Keypair.random().publicKey();
      const hash = crypto.randomBytes(32);
      const txHash = hash.toString('hex').toLowerCase();
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(hash);

      const maxTimeSeconds = 1_700_000_100;

      await sentinel.registerPreAuthTx({
        accountId,
        signerKey,
        txHash,
        timeBounds: {
          minTime: '1700000000',
          maxTime: String(maxTimeSeconds),
        },
      });

      // 1. Current time is before expiration -> No alert
      const beforeAlerts = await sentinel.checkExpirations(maxTimeSeconds - 50);
      expect(beforeAlerts).toHaveLength(0);

      let tracked = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(tracked?.status).toBe('ACTIVE');

      // 2. Current time / ledger close exceeds max_time -> Emits PREAUTH_TX_EXPIRED
      const expiredAlerts = await sentinel.checkExpirations(maxTimeSeconds + 1);
      expect(expiredAlerts).toHaveLength(1);

      const alert = expiredAlerts[0];
      expect(alert.eventType).toBe('PREAUTH_TX_EXPIRED');
      expect(alert.severity).toBe('CRITICAL');
      expect(alert.account).toBe(accountId);
      expect(alert.signerKey).toBe(signerKey);
      expect(alert.txHash).toBe(txHash);
      expect(alert.timeBounds?.maxTime).toBe(String(maxTimeSeconds));

      tracked = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(tracked?.status).toBe('EXPIRED');
      expect(tracked?.expiredAt).toBeDefined();
    });

    it('does not expire transactions with unbounded max_time (max_time = 0)', async () => {
      const accountId = StellarSdk.Keypair.random().publicKey();
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(crypto.randomBytes(32));

      await sentinel.registerPreAuthTx({
        accountId,
        signerKey,
        timeBounds: { minTime: '0', maxTime: '0' },
      });

      const alerts = await sentinel.checkExpirations(2_000_000_000);
      expect(alerts).toHaveLength(0);

      const tracked = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(tracked?.status).toBe('ACTIVE');
    });

    it('does not expire transactions that are already CONSUMED or INVALIDATED', async () => {
      const accountId = StellarSdk.Keypair.random().publicKey();
      const hash = crypto.randomBytes(32);
      const txHash = hash.toString('hex').toLowerCase();
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(hash);

      await sentinel.registerPreAuthTx({
        accountId,
        signerKey,
        txHash,
        timeBounds: { minTime: '1000', maxTime: '2000' },
      });

      // Mark consumed via transaction execution
      await sentinel.processTransaction({
        hash: txHash,
        successful: true,
        source_account: accountId,
      });

      const trackedBefore = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(trackedBefore?.status).toBe('CONSUMED');

      // Check expirations past maxTime (3000)
      const alerts = await sentinel.checkExpirations(3000);
      expect(alerts).toHaveLength(0);

      const trackedAfter = await sentinel.getPreAuthTx(accountId, signerKey);
      expect(trackedAfter?.status).toBe('CONSUMED');
    });
  });

  // ── 5. Automatic Consumption Detection ─────────────────────────────────────
  describe('Automatic Consumption Detection', () => {
    it('detects on-chain execution and marks pre-auth tx as consumed', async () => {
      const kp = StellarSdk.Keypair.random();
      const { xdr, txHash, signerKey, sourceAccount, sequence } = createTestTransaction({
        sourceAccountKeypair: kp,
        sequence: '100',
      });

      // Register from envelope
      await sentinel.registerPreAuthTx({
        envelopeXdr: xdr,
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const alerts: PreAuthTxAlert[] = [];
      sentinel.subscribe((a) => alerts.push(a));

      // Transaction executes on-chain
      const txRecord: HorizonTransactionRecord = {
        hash: txHash,
        successful: true,
        source_account: sourceAccount,
        source_account_sequence: sequence,
        created_at: new Date(mockNow).toISOString(),
      };

      const emitted = await sentinel.processTransaction(txRecord);

      expect(emitted).toHaveLength(1);
      const alert = emitted[0];
      expect(alert.eventType).toBe('PREAUTH_TX_EXECUTED_AND_CONSUMED');
      expect(alert.severity).toBe('INFO');
      expect(alert.account).toBe(sourceAccount);
      expect(alert.signerKey).toBe(signerKey);
      expect(alert.txHash).toBe(txHash);
      expect(alert.weight).toBe(0);

      const tracked = await sentinel.getPreAuthTx(sourceAccount, signerKey);
      expect(tracked?.status).toBe('CONSUMED');
      expect(tracked?.weight).toBe(0);
      expect(tracked?.consumedAt).toBeDefined();
    });

    it('detects execution of an inner fee-bump transaction', async () => {
      const kp = StellarSdk.Keypair.random();
      const sponsor = StellarSdk.Keypair.random();
      const { tx, txHash, signerKey, sourceAccount } = createTestTransaction({
        sourceAccountKeypair: kp,
      });

      const bump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
        sponsor,
        '300',
        tx,
        NETWORK_PASSPHRASE,
      );
      bump.sign(sponsor);

      await sentinel.registerPreAuthTx({
        accountId: sourceAccount,
        signerKey,
        txHash,
      });

      const bumpRecord: HorizonTransactionRecord = {
        hash: bump.hash().toString('hex'),
        successful: true,
        source_account: sponsor.publicKey(),
        inner_transaction: {
          hash: txHash,
        },
      };

      const emitted = await sentinel.processTransaction(bumpRecord);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].eventType).toBe('PREAUTH_TX_EXECUTED_AND_CONSUMED');
      expect(emitted[0].txHash).toBe(txHash);

      const tracked = await sentinel.getPreAuthTx(sourceAccount, signerKey);
      expect(tracked?.status).toBe('CONSUMED');
    });
  });

  // ── 6. Full Ledger Processing ──────────────────────────────────────────────
  describe('Full Ledger Processing (processLedger)', () => {
    it('processes operations, transactions, and expirations in correct order', async () => {
      const kp = StellarSdk.Keypair.random();
      const accountId = kp.publicKey();

      const tx1 = createTestTransaction({
        sourceAccountKeypair: kp,
        sequence: '10',
        timebounds: { minTime: '1000', maxTime: '1500' },
      });

      const tx2 = createTestTransaction({
        sourceAccountKeypair: kp,
        sequence: '20',
        timebounds: { minTime: '1000', maxTime: '1500' },
      });

      // Ledger block data
      const operations: HorizonOperationRecord[] = [
        {
          id: 'op-1',
          type: 'set_options',
          source_account: accountId,
          signer_key: tx1.signerKey,
          signer_weight: 1,
        },
        {
          id: 'op-2',
          type: 'set_options',
          source_account: accountId,
          signer_key: tx2.signerKey,
          signer_weight: 1,
        },
      ];

      // tx1 executes, while tx2's sequence (21) is invalidated by an unexpected tx with seq 25
      const transactions: HorizonTransactionRecord[] = [
        {
          hash: tx1.txHash,
          successful: true,
          source_account: accountId,
          source_account_sequence: tx1.sequence,
        },
        {
          hash: 'rogue-tx-hash',
          successful: true,
          source_account: accountId,
          source_account_sequence: '25',
        },
      ];

      // Pre-register tx2 with sequence to test invalidation
      await sentinel.registerPreAuthTx({
        accountId,
        signerKey: tx2.signerKey,
        txHash: tx2.txHash,
        sequenceNumber: '21',
        timeBounds: { minTime: '1000', maxTime: '1500' },
      });

      const alerts = await sentinel.processLedger(1200, transactions, operations);

      const eventTypes = alerts.map((a) => a.eventType);
      expect(eventTypes).toContain('PREAUTH_TX_SIGNER_ADDED');
      expect(eventTypes).toContain('PREAUTH_TX_EXECUTED_AND_CONSUMED');
      expect(eventTypes).toContain('PREAUTH_TX_SEQUENCE_INVALIDATED');

      const tx1Status = await sentinel.getPreAuthTx(accountId, tx1.signerKey);
      expect(tx1Status?.status).toBe('CONSUMED');

      const tx2Status = await sentinel.getPreAuthTx(accountId, tx2.signerKey);
      expect(tx2Status?.status).toBe('INVALIDATED');
    });
  });

  // ── 7. Notification & Webhook Formatting ───────────────────────────────────
  describe('Notification and Webhook Formatting', () => {
    it('formats Telegram HTML message with escaped entities', () => {
      const alert: PreAuthTxAlert = {
        eventType: 'PREAUTH_TX_SEQUENCE_INVALIDATED',
        severity: 'CRITICAL',
        account: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
        signerKey: 'TAD5CYF5A67T5T7QFXVUP2I77P2M4K3X2R7ZWIENQH4TYSQVXKNUVZIK',
        txHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        weight: 1,
        sequenceNumber: '12345',
        timeBounds: { minTime: '0', maxTime: '1700000000' },
        occurredAt: '2026-11-27T12:00:00.000Z',
        message: 'Sequence invalidated <script>alert("hack")</script>',
      };

      const html = formatPreAuthTxTelegramHtml(alert);

      expect(html).toContain('<b>[CRITICAL] Stellar Pre-Auth Transaction Sentinel</b>');
      expect(html).toContain('<code>PREAUTH_TX_SEQUENCE_INVALIDATED</code>');
      expect(html).toContain('<code>12345</code>');
      expect(html).toContain('&lt;script&gt;alert(&quot;hack&quot;)&lt;/script&gt;');
      expect(html).not.toContain('<script>');
    });

    it('formats Webhook JSON payload with all standard metadata', () => {
      const alert: PreAuthTxAlert = {
        eventType: 'PREAUTH_TX_EXPIRED',
        severity: 'CRITICAL',
        account: 'GACC',
        signerKey: 'TKEY',
        txHash: 'hash123',
        weight: 1,
        sequenceNumber: '99',
        timeBounds: { minTime: '100', maxTime: '200' },
        occurredAt: '2026-11-27T12:00:00.000Z',
        message: 'Pre-auth tx expired',
        details: { maxTime: '200' },
      };

      const payload = formatPreAuthTxWebhookPayload(alert);

      expect(payload).toEqual({
        event: 'stellar.preauth_tx.alert',
        eventType: 'PREAUTH_TX_EXPIRED',
        severity: 'CRITICAL',
        account: 'GACC',
        signerKey: 'TKEY',
        txHash: 'hash123',
        weight: 1,
        sequenceNumber: '99',
        timeBounds: { minTime: '100', maxTime: '200' },
        operationId: null,
        transactionHash: null,
        message: 'Pre-auth tx expired',
        occurredAt: '2026-11-27T12:00:00.000Z',
        details: { maxTime: '200' },
      });
    });

    it('delivers alert through injected notifier', async () => {
      const mockNotifier = vi.fn().mockResolvedValue(undefined);

      const alert: PreAuthTxAlert = {
        eventType: 'PREAUTH_TX_SIGNER_ADDED',
        severity: 'INFO',
        account: 'GACC',
        signerKey: 'TKEY',
        txHash: 'tx123',
        weight: 1,
        occurredAt: '2026-11-27T12:00:00.000Z',
        message: 'Signer added',
      };

      await deliverPreAuthTxAlert(alert, 'user-123', mockNotifier);

      expect(mockNotifier).toHaveBeenCalledTimes(1);
      expect(mockNotifier).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ eventType: 'PREAUTH_TX_SIGNER_ADDED' }),
        expect.stringContaining('Stellar Pre-Auth Transaction Sentinel'),
      );
    });

    it('escapes special characters properly in escapeTelegramHtml', () => {
      expect(escapeTelegramHtml('<div>"Hello" & \'World\'</div>')).toBe(
        '&lt;div&gt;&quot;Hello&quot; &amp; &#39;World&#39;&lt;/div&gt;',
      );
    });
  });

  // ── 8. Cooldown and Storage Management ─────────────────────────────────────
  describe('Deduplication & Sentinel Reset', () => {
    it('respects alert cooldown window to prevent alert spamming', async () => {
      const cooldownSentinel = new PreAuthTxSentinel(
        undefined,
        { alertCooldownMs: 60_000 },
        () => mockNow,
      );

      const alerts: PreAuthTxAlert[] = [];
      cooldownSentinel.subscribe((a) => alerts.push(a));

      const accountId = StellarSdk.Keypair.random().publicKey();
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(crypto.randomBytes(32));

      const op: HorizonOperationRecord = {
        id: 'op-1',
        type: 'set_options',
        source_account: accountId,
        signer_key: signerKey,
        signer_weight: 1,
      };

      // First run emits alert
      await cooldownSentinel.processOperation(op);
      expect(alerts).toHaveLength(1);

      // Duplicate run at same timestamp is suppressed by cooldown
      await cooldownSentinel.processOperation(op);
      expect(alerts).toHaveLength(1);

      // Advance mock time past cooldown window (61s)
      mockNow += 61_000;
      await cooldownSentinel.processOperation(op);
      expect(alerts).toHaveLength(2);
    });

    it('clears all state cleanly via clear()', async () => {
      const accountId = StellarSdk.Keypair.random().publicKey();
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(crypto.randomBytes(32));

      await sentinel.registerPreAuthTx({ accountId, signerKey });
      expect(await sentinel.getPreAuthTxs(accountId)).toHaveLength(1);

      sentinel.clear();
      expect(await sentinel.getPreAuthTxs(accountId)).toHaveLength(0);
    });
  });
});

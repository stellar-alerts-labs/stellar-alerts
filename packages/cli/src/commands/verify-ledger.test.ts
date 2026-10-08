import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { buildMerkleTree, hashMerkleLeaf, verifyMerkleProof } from '@stellar-alerts/shared';
import { apiClient } from '../lib/api.js';
import { PaymentDTO } from '../lib/types.js';
import {
  registerVerifyLedgerCommands,
  runAudit,
  canonicalRecordString,
  checkCertificateRecords,
  VerificationCertificate,
} from './verify-ledger.js';

// Mock the API client the same way wallet.test.ts / stream.test.ts do.
vi.mock('../lib/api.js', () => ({
  apiClient: {
    addWallet: vi.fn(),
    getWallets: vi.fn(),
    deleteWallet: vi.fn(),
    getPayments: vi.fn(),
    streamPayments: vi.fn(),
  },
}));

// Mock the Horizon SDK's call-builder chain: `new Horizon.Server(url).payments().forTransaction(hash).call()`.
// vi.mock factories are hoisted above top-level declarations, so the mock
// functions themselves must be created via vi.hoisted().
const { mockCall, mockForTransaction, mockPayments, MockServer } = vi.hoisted(() => {
  const mockCall = vi.fn();
  const mockForTransaction = vi.fn(() => ({ call: mockCall }));
  const mockPayments = vi.fn(() => ({ forTransaction: mockForTransaction }));
  const MockServer = vi.fn().mockImplementation(() => ({ payments: mockPayments }));
  return { mockCall, mockForTransaction, mockPayments, MockServer };
});

vi.mock('stellar-sdk', () => ({
  Horizon: {
    Server: MockServer,
  },
}));

function makePayment(overrides: Partial<PaymentDTO> = {}): PaymentDTO {
  return {
    id: 'payment-1',
    walletId: 'wallet-1',
    txHash: 'a'.repeat(64),
    fromAddress: 'GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234',
    amount: '100.0000000',
    asset: 'XLM',
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function matchingHorizonPage(payment: PaymentDTO) {
  return {
    records: [
      {
        type: 'payment',
        from: payment.fromAddress,
        amount: String(payment.amount),
        asset_type: 'native',
      },
    ],
  };
}

describe('verify-ledger command registration', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerVerifyLedgerCommands(program);
  });

  it('registers the verify-ledger command with a check subcommand', () => {
    const cmd = program.commands.find((c) => c.name() === 'verify-ledger');
    expect(cmd).toBeDefined();

    const checkCmd = cmd!.commands.find((c) => c.name() === 'check');
    expect(checkCmd).toBeDefined();
  });

  it('exposes wallet, limit, output and token options', () => {
    const cmd = program.commands.find((c) => c.name() === 'verify-ledger')!;
    const shorts = cmd.options.map((o: any) => o.short);
    expect(shorts).toEqual(expect.arrayContaining(['-w', '-l', '-o', '-t']));
  });
});

describe('runAudit: cross-checking cached records against Horizon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks a record verified when it matches what Horizon reports, and includes it in the Merkle tree', async () => {
    const payment = makePayment();
    (apiClient.getPayments as any).mockResolvedValue([payment]);
    mockCall.mockResolvedValueOnce(matchingHorizonPage(payment));

    const certificate = await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' });

    expect(certificate).not.toBeNull();
    expect(certificate!.summary).toEqual({ total: 1, verified: 1, mismatched: 0, unverifiable: 0 });
    expect(certificate!.merkleRoot).toMatch(/^[0-9a-f]{64}$/);

    const record = certificate!.records[0];
    expect(record.status).toBe('verified');
    expect(record.leafHash).toBeDefined();
    expect(record.merkleProof).toEqual([]); // single-leaf tree: leaf hash IS the root, empty path

    // The certificate must be independently checkable via the shared verifier.
    expect(verifyMerkleProof({ leafHash: record.leafHash!, path: record.merkleProof! }, certificate!.merkleRoot!)).toBe(
      true
    );
  });

  it('detects a mismatch when the cached amount does not match Horizon, and excludes it from the Merkle tree', async () => {
    const payment = makePayment({ amount: '100.0000000' });
    (apiClient.getPayments as any).mockResolvedValue([payment]);
    mockCall.mockResolvedValueOnce({
      records: [
        {
          type: 'payment',
          from: payment.fromAddress,
          amount: '999.0000000', // tampered/corrupted local record wouldn't match this
          asset_type: 'native',
        },
      ],
    });

    const certificate = await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' });

    expect(certificate!.summary).toEqual({ total: 1, verified: 0, mismatched: 1, unverifiable: 0 });
    expect(certificate!.merkleRoot).toBeNull();

    const record = certificate!.records[0];
    expect(record.status).toBe('mismatch');
    expect(record.horizonRecord?.amount).toBe('999.0000000');
    expect(record.leafHash).toBeUndefined();
  });

  it('detects a mismatch when the cached sender does not match Horizon', async () => {
    const payment = makePayment();
    (apiClient.getPayments as any).mockResolvedValue([payment]);
    mockCall.mockResolvedValueOnce({
      records: [
        {
          type: 'payment',
          from: 'GDIFFERENTSENDERADDRESS1234567890ABCDEF1234567890ABCDEF12',
          amount: String(payment.amount),
          asset_type: 'native',
        },
      ],
    });

    const certificate = await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' });
    expect(certificate!.records[0].status).toBe('mismatch');
  });

  it('handles a Horizon network failure gracefully as "unverifiable", not a crash', async () => {
    const payment = makePayment();
    (apiClient.getPayments as any).mockResolvedValue([payment]);
    mockCall.mockRejectedValueOnce(new Error('network timeout'));

    const certificate = await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' });

    expect(certificate!.summary).toEqual({ total: 1, verified: 0, mismatched: 0, unverifiable: 1 });
    const record = certificate!.records[0];
    expect(record.status).toBe('unverifiable');
    expect(record.reason).toContain('Horizon lookup failed');
  });

  it('handles a transaction not found on Horizon (404) gracefully', async () => {
    const payment = makePayment();
    (apiClient.getPayments as any).mockResolvedValue([payment]);
    const notFoundError: any = new Error('Not Found');
    notFoundError.response = { status: 404 };
    mockCall.mockRejectedValueOnce(notFoundError);

    const certificate = await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' });

    const record = certificate!.records[0];
    expect(record.status).toBe('unverifiable');
    expect(record.reason).toContain('not found');
  });

  it('treats a transaction with no payment operations as unverifiable', async () => {
    const payment = makePayment();
    (apiClient.getPayments as any).mockResolvedValue([payment]);
    mockCall.mockResolvedValueOnce({ records: [] });

    const certificate = await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' });
    expect(certificate!.records[0].status).toBe('unverifiable');
  });

  it('computes a correct Merkle root over multiple verified records, matching the shared primitives directly', async () => {
    const paymentA = makePayment({ id: 'payment-a', txHash: 'a'.repeat(64) });
    const paymentB = makePayment({ id: 'payment-b', txHash: 'b'.repeat(64), amount: '50.0000000' });

    (apiClient.getPayments as any).mockResolvedValue([paymentA, paymentB]);
    mockCall.mockResolvedValueOnce(matchingHorizonPage(paymentA)).mockResolvedValueOnce(matchingHorizonPage(paymentB));

    const certificate = await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' });

    expect(certificate!.summary.verified).toBe(2);

    // Independently recompute the expected root the same way the command does,
    // using the real shared Merkle primitives (not the CLI's internals).
    const leafA = Buffer.from(
      canonicalRecordString({
        paymentId: paymentA.id,
        txHash: paymentA.txHash,
        fromAddress: paymentA.fromAddress,
        amount: String(paymentA.amount),
        asset: paymentA.asset,
        receivedAt: new Date(paymentA.receivedAt).toISOString(),
      }),
      'utf8'
    );
    const leafB = Buffer.from(
      canonicalRecordString({
        paymentId: paymentB.id,
        txHash: paymentB.txHash,
        fromAddress: paymentB.fromAddress,
        amount: String(paymentB.amount),
        asset: paymentB.asset,
        receivedAt: new Date(paymentB.receivedAt).toISOString(),
      }),
      'utf8'
    );
    const expectedTree = buildMerkleTree([leafA, leafB]);

    expect(certificate!.merkleRoot).toBe(expectedTree.root);
    expect(certificate!.records[0].leafHash).toBe(hashMerkleLeaf(leafA));
    expect(certificate!.records[1].leafHash).toBe(hashMerkleLeaf(leafB));
  });

  it('returns null and does not call Horizon when there are no cached payments', async () => {
    (apiClient.getPayments as any).mockResolvedValue([]);
    const certificate = await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' });
    expect(certificate).toBeNull();
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('checkCertificateRecords: the Merkle proof checker', () => {
  async function generateValidCertificate(): Promise<VerificationCertificate> {
    const payment = makePayment();
    (apiClient.getPayments as any).mockResolvedValue([payment]);
    mockCall.mockResolvedValueOnce(matchingHorizonPage(payment));
    const certificate = await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' });
    return certificate!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes for a freshly generated, untampered certificate', async () => {
    const certificate = await generateValidCertificate();
    const result = checkCertificateRecords(certificate);
    expect(result.passed).toBe(true);
    expect(result.failures).toBe(0);
    expect(result.checked).toBe(1);
  });

  it('detects a certificate whose record data was edited after generation (leaf hash no longer matches)', async () => {
    const certificate = await generateValidCertificate();
    // Simulate someone editing the cached amount in the certificate file directly,
    // without recomputing the leaf hash / proof.
    certificate.records[0].amount = '999999.0000000';

    const result = checkCertificateRecords(certificate);
    expect(result.passed).toBe(false);
    expect(result.failures).toBe(1);
    expect(result.failureReasons[certificate.records[0].paymentId]).toMatch(/leaf hash/i);
  });

  it('detects a certificate whose Merkle proof/root was corrupted directly', async () => {
    // Build a two-leaf certificate so there is a non-empty proof path to corrupt.
    const paymentA = makePayment({ id: 'payment-a', txHash: 'a'.repeat(64) });
    const paymentB = makePayment({ id: 'payment-b', txHash: 'b'.repeat(64), amount: '50.0000000' });
    (apiClient.getPayments as any).mockResolvedValue([paymentA, paymentB]);
    mockCall.mockResolvedValueOnce(matchingHorizonPage(paymentA)).mockResolvedValueOnce(matchingHorizonPage(paymentB));
    const certificate = (await runAudit({ horizonUrl: 'https://horizon-testnet.stellar.org' }))!;

    // Corrupt the stored sibling hash in the first record's proof path.
    certificate.records[0].merkleProof![0].siblingHash = '0'.repeat(64);

    const result = checkCertificateRecords(certificate);
    expect(result.passed).toBe(false);
    expect(result.failureReasons[certificate.records[0].paymentId]).toMatch(/proof/i);
  });

  it('passes trivially (no-op) for a certificate with no verified records', () => {
    const certificate: VerificationCertificate = {
      certificateVersion: 1,
      generatedAt: new Date().toISOString(),
      horizonUrl: 'https://horizon-testnet.stellar.org',
      scopeNote: 'test',
      summary: { total: 1, verified: 0, mismatched: 0, unverifiable: 1 },
      merkleRoot: null,
      records: [
        {
          paymentId: 'p1',
          walletId: 'w1',
          txHash: 'x'.repeat(64),
          fromAddress: 'G...',
          amount: '1',
          asset: 'XLM',
          receivedAt: new Date().toISOString(),
          status: 'unverifiable',
          reason: 'could not verify',
        },
      ],
    };

    const result = checkCertificateRecords(certificate);
    expect(result.passed).toBe(true);
    expect(result.checked).toBe(0);
  });
});

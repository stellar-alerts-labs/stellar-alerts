import {
  evaluateNewApproval,
  evaluateApprovalExpiry,
  detectAllowanceAlertsFromEventBatch,
} from '../soroban-allowance-watcher.worker';
import { parseApprovalEvent, type ParsedSorobanApproval } from '../../lib/soroban';

function makeApproval(overrides: Partial<ParsedSorobanApproval> = {}): ParsedSorobanApproval {
  return {
    contractId: 'CCONTRACT1',
    from: 'GAOWNER1',
    spender: 'GASPENDER1',
    amount: '1000',
    rawAmount: 1000n,
    liveUntilLedger: 100_000,
    ledgerSeq: 50_000,
    ...overrides,
  };
}

describe('parseApprovalEvent (#422)', () => {
  it('parses a well-formed approve event', () => {
    const event = {
      contractId: 'CCONTRACT1',
      topic: ['approve', 'GAOWNER1', 'GASPENDER1'],
      value: { from: 'GAOWNER1', spender: 'GASPENDER1', amount: '5000000', live_until_ledger: 123456 },
      ledgerSeq: 99999,
    };
    const result = parseApprovalEvent(event);
    expect(result).not.toBeNull();
    expect(result?.from).toBe('GAOWNER1');
    expect(result?.spender).toBe('GASPENDER1');
    expect(result?.liveUntilLedger).toBe(123456);
  });

  it('returns null for a non-approve event', () => {
    const event = { contractId: 'CCONTRACT1', topic: ['transfer'], value: { amount: '100' } };
    expect(parseApprovalEvent(event)).toBeNull();
  });

  it('returns null when the amount is missing/undecodable', () => {
    const event = { contractId: 'CCONTRACT1', topic: ['approve'], value: {} };
    expect(parseApprovalEvent(event)).toBeNull();
  });

  it('accepts expiration_ledger as a fallback field name', () => {
    const event = {
      contractId: 'CCONTRACT1',
      topic: ['approve', 'GAOWNER1', 'GASPENDER1'],
      value: { amount: '10', expiration_ledger: 555 },
    };
    expect(parseApprovalEvent(event)?.liveUntilLedger).toBe(555);
  });
});

describe('evaluateNewApproval (#422)', () => {
  it('flags an allowance at or above the threshold', () => {
    const approval = makeApproval({ rawAmount: 1_000_000_000_000n, amount: '1000000000000' });
    const alert = evaluateNewApproval(approval, 1_000_000_000_000n);
    expect(alert).not.toBeNull();
    expect(alert?.alertType).toBe('HIGH_VALUE_GRANTED');
  });

  it('does not flag an allowance below the threshold', () => {
    const approval = makeApproval({ rawAmount: 999n });
    expect(evaluateNewApproval(approval, 1000n)).toBeNull();
  });

  it('uses the event ledger, not the expiration ledger, as eventLedgerSeq', () => {
    const approval = makeApproval({ rawAmount: 5000n, ledgerSeq: 42, liveUntilLedger: 99999999 });
    const alert = evaluateNewApproval(approval, 1n);
    expect(alert?.eventLedgerSeq).toBe(42);
  });
});

describe('evaluateApprovalExpiry (#422)', () => {
  it('flags an allowance within the warning window', () => {
    const approval = makeApproval({ liveUntilLedger: 100_100 });
    const alert = evaluateApprovalExpiry(approval, 100_000, 200);
    expect(alert).not.toBeNull();
    expect(alert?.alertType).toBe('APPROACHING_EXPIRY');
    expect(alert?.ledgersUntilExpiry).toBe(100);
  });

  it('does not flag an allowance far from expiring', () => {
    const approval = makeApproval({ liveUntilLedger: 500_000 });
    expect(evaluateApprovalExpiry(approval, 100_000, 200)).toBeNull();
  });

  it('does not flag an already-expired allowance (nothing left to renew)', () => {
    const approval = makeApproval({ liveUntilLedger: 99_000 });
    expect(evaluateApprovalExpiry(approval, 100_000, 200)).toBeNull();
  });

  it('does not flag a revoked allowance (rawAmount 0)', () => {
    const approval = makeApproval({ rawAmount: 0n, liveUntilLedger: 100_050 });
    expect(evaluateApprovalExpiry(approval, 100_000, 200)).toBeNull();
  });
});

describe('detectAllowanceAlertsFromEventBatch (#422)', () => {
  it('emits both a high-value and an expiry alert for the same qualifying event', () => {
    const events = [
      {
        contractId: 'CCONTRACT1',
        topic: ['approve', 'GAOWNER1', 'GASPENDER1'],
        value: { amount: '2000000000000', live_until_ledger: 100_100 },
        ledgerSeq: 50_000,
      },
    ];

    const alerts = detectAllowanceAlertsFromEventBatch(events, 100_000);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.alertType).sort()).toEqual(['APPROACHING_EXPIRY', 'HIGH_VALUE_GRANTED']);
  });

  it('ignores non-approve events in the batch', () => {
    const events = [{ contractId: 'C1', topic: ['transfer'], value: { amount: '1' } }];
    expect(detectAllowanceAlertsFromEventBatch(events, 100_000)).toEqual([]);
  });
});

import { vi } from 'vitest';
import {
  evaluateRevocationOrClawback,
  processOperation,
  type StellarOperation,
} from '../trustline-revocation-clawback-watcher.worker';

describe('Trustline Revocation and Clawback Event Watcher (#426)', () => {
  it('detects trustline authorization revocation when clearFlags includes AUTHORIZED_FLAG', () => {
    const op: StellarOperation = {
      id: 'op_1001',
      type: 'set_trust_line_flags',
      sourceAccount: 'GAAISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      targetAccount: 'GBUSERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      assetCode: 'USDC',
      clearFlags: [1], // AUTHORIZED_FLAG
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
    };

    const alert = evaluateRevocationOrClawback(op);
    expect(alert).not.toBeNull();
    expect(alert?.eventType).toBe('REVOCATION');
    expect(alert?.issuer).toBe(op.sourceAccount);
    expect(alert?.targetAccount).toBe(op.targetAccount);
    expect(alert?.assetCode).toBe('USDC');
    expect(alert?.reason).toMatch(/revoked AUTHORIZED_FLAG/);
  });

  it('detects asset clawback operations and formats amount details', async () => {
    const op: StellarOperation = {
      id: 'op_1002',
      type: 'clawback',
      sourceAccount: 'GAAISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      targetAccount: 'GBUSERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      assetCode: 'EURC',
      amount: '500.0000000',
      createdAt: '2026-09-27T10:05:00.000Z',
    };

    const notifyMock = vi.fn();
    const alert = await processOperation(op, notifyMock);

    expect(alert).not.toBeNull();
    expect(alert?.eventType).toBe('CLAWBACK');
    expect(alert?.amount).toBe('500.0000000');
    expect(notifyMock).toHaveBeenCalledWith(alert);
  });

  it('returns null for standard payment operations', () => {
    const op: StellarOperation = {
      id: 'op_1003',
      type: 'payment',
      sourceAccount: 'GAALICE',
      targetAccount: 'GABOB',
      assetCode: 'XLM',
      amount: '100.0000000',
      createdAt: new Date(),
    };

    expect(evaluateRevocationOrClawback(op)).toBeNull();
  });
});

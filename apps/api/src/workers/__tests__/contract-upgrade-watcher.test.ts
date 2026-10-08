import { describe, expect, it, vi } from 'vitest';
import {
  evaluateContractUpgradeEvent,
  processContractUpgradeEvent,
  type SorobanContractEvent,
} from '../contract-upgrade-watcher.worker';

describe('Contract Upgrade and Migration Event Watcher (#420)', () => {
  it('detects WASM upgrade events and formats WASM hash migration summary', () => {
    const event: SorobanContractEvent = {
      id: 'evt_201',
      contractId: 'CCONTRACTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      topic: 'update_wasm',
      oldWasmHash: '1111111111111111111111111111111111111111111111111111111111111111',
      newWasmHash: '2222222222222222222222222222222222222222222222222222222222222222',
      txHash: 'tx_abc123',
      ledgerSeq: 543210,
      timestamp: new Date('2026-09-27T14:00:00.000Z'),
    };

    const alert = evaluateContractUpgradeEvent(event);
    expect(alert).not.toBeNull();
    expect(alert?.eventType).toBe('UPGRADE_WASM');
    expect(alert?.oldWasmHash).toBe(event.oldWasmHash);
    expect(alert?.newWasmHash).toBe(event.newWasmHash);
    expect(alert?.summary).toMatch(/upgraded to 2222/);
  });

  it('detects admin authorization changes for proxy contracts', async () => {
    const event: SorobanContractEvent = {
      id: 'evt_202',
      contractId: 'CCONTRACTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      topic: 'change_admin',
      oldAdmin: 'GADMINOLDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      newAdmin: 'GADMINNEWXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      txHash: 'tx_def456',
      ledgerSeq: 543211,
      timestamp: '2026-09-27T14:10:00.000Z',
    };

    const notifyMock = vi.fn();
    const alert = await processContractUpgradeEvent(event, notifyMock);

    expect(alert).not.toBeNull();
    expect(alert?.eventType).toBe('ADMIN_CHANGE');
    expect(alert?.newAdmin).toBe(event.newAdmin);
    expect(notifyMock).toHaveBeenCalledWith(alert);
  });

  it('returns null for unrelated contract events (e.g. transfer)', () => {
    const event: SorobanContractEvent = {
      id: 'evt_203',
      contractId: 'CCONTRACT',
      topic: 'transfer',
      txHash: 'tx_789',
      ledgerSeq: 100,
      timestamp: new Date(),
    };

    expect(evaluateContractUpgradeEvent(event)).toBeNull();
  });
});

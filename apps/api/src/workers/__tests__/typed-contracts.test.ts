/**
 * Tests for the typed ingestion and notification contracts introduced by
 * issue #301 to replace `any`-casts at Prisma, Horizon, and notification
 * boundaries.
 *
 * Coverage:
 *  - src/types/horizon.ts  — discriminated union, type guards, adapters
 *  - src/types/ipc.ts      — IPC message type guards
 *  - src/types/soroban-event.ts — SorobanRpcEvent, EnrichedSorobanEvent
 *  - src/types/notification-preference.ts — extractFilterRules narrower
 */

import { describe, it, expect } from 'vitest';

// ── Horizon types ──────────────────────────────────────────────────────────
import {
  isHorizonPayment,
  isHorizonCreateAccount,
  getHorizonPagingToken,
  getHorizonTxHash,
  type HorizonPaymentRecord,
  type HorizonCreateAccountRecord,
  type HorizonSacTransferRecord,
  type HorizonOperationRecord,
} from '../../types/horizon';

// ── IPC types ──────────────────────────────────────────────────────────────
import {
  isSupervisorIpcMessage,
  isPingMessage,
  isPongMessage,
} from '../../types/ipc';

// ── Soroban event types ────────────────────────────────────────────────────
import {
  isEnrichedSorobanEvent,
  type SorobanRpcEvent,
  type EnrichedSorobanEvent,
} from '../../types/soroban-event';

// ── Notification preference types ──────────────────────────────────────────
import { extractFilterRules } from '../../types/notification-preference';

// ── Fixture helpers ────────────────────────────────────────────────────────

const makePaymentRecord = (overrides: Partial<HorizonPaymentRecord> = {}): HorizonPaymentRecord => ({
  type: 'payment',
  paging_token: '5000',
  created_at: '2026-09-25T00:00:00Z',
  transaction_hash: 'abc123',
  amount: '10.5',
  asset_type: 'native',
  from: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSFMG4BVI',
  to: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
  ...overrides,
});

const makeCreateAccountRecord = (overrides: Partial<HorizonCreateAccountRecord> = {}): HorizonCreateAccountRecord => ({
  type: 'create_account',
  paging_token: '6000',
  created_at: '2026-09-25T00:00:00Z',
  transaction_hash: 'def456',
  starting_balance: '1.0',
  funder: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSFMG4BVI',
  account: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
  ...overrides,
});

const makeSacRecord = (overrides: Partial<HorizonSacTransferRecord> = {}): HorizonSacTransferRecord => ({
  type: 'invoke_host_function',
  paging_token: '7000',
  created_at: '2026-09-25T00:00:00Z',
  transaction_hash: 'ghi789',
  contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  topic: [{ symbol: 'transfer' }, 'GDQP...', 'GBPDX...'],
  ...overrides,
});

// ── Horizon type tests ─────────────────────────────────────────────────────

describe('HorizonOperationRecord type guards', () => {
  it('isHorizonPayment narrows payment records correctly', () => {
    const record = makePaymentRecord();
    expect(isHorizonPayment(record)).toBe(true);
    // TypeScript narrowing: after the guard, `record.amount` is accessible
    if (isHorizonPayment(record)) {
      expect(record.amount).toBe('10.5');
    }
  });

  it('isHorizonPayment returns false for non-payment types', () => {
    expect(isHorizonPayment(makeCreateAccountRecord())).toBe(false);
    expect(isHorizonPayment(makeSacRecord())).toBe(false);
  });

  it('isHorizonCreateAccount narrows create_account records correctly', () => {
    const record = makeCreateAccountRecord();
    expect(isHorizonCreateAccount(record)).toBe(true);
    if (isHorizonCreateAccount(record)) {
      expect(record.starting_balance).toBe('1.0');
      expect(record.funder).toBeTruthy();
    }
  });

  it('isHorizonCreateAccount returns false for payment and SAC records', () => {
    expect(isHorizonCreateAccount(makePaymentRecord())).toBe(false);
    expect(isHorizonCreateAccount(makeSacRecord())).toBe(false);
  });

  it('getHorizonPagingToken returns the paging_token string', () => {
    expect(getHorizonPagingToken(makePaymentRecord({ paging_token: '9999' }))).toBe('9999');
    expect(getHorizonPagingToken(makeCreateAccountRecord({ paging_token: '1111' }))).toBe('1111');
  });

  it('getHorizonPagingToken returns undefined when paging_token is empty string', () => {
    // Edge case: an empty string paging token is falsy, so the adapter returns undefined.
    expect(getHorizonPagingToken(makePaymentRecord({ paging_token: '' }))).toBeUndefined();
  });

  it('getHorizonTxHash prefers transaction_hash over hash alias', () => {
    const record = makePaymentRecord({ transaction_hash: 'primary', hash: 'alias' });
    expect(getHorizonTxHash(record)).toBe('primary');
  });

  it('getHorizonTxHash falls back to hash alias when transaction_hash is empty', () => {
    // Simulate SDK versions that only surface `hash`
    const record = makePaymentRecord({ transaction_hash: '', hash: 'fallback' });
    expect(getHorizonTxHash(record)).toBe('fallback');
  });

  it('getHorizonTxHash returns empty string when neither field is present', () => {
    const record = makePaymentRecord({ transaction_hash: '', hash: undefined });
    expect(getHorizonTxHash(record)).toBe('');
  });
});

// ── IPC message type guard tests ───────────────────────────────────────────

describe('Supervisor IPC message type guards', () => {
  it('isSupervisorIpcMessage accepts objects with a string type field', () => {
    expect(isSupervisorIpcMessage({ type: 'ping' })).toBe(true);
    expect(isSupervisorIpcMessage({ type: 'pong' })).toBe(true);
    expect(isSupervisorIpcMessage({ type: 'unknown' })).toBe(true);
  });

  it('isSupervisorIpcMessage rejects non-objects and objects without type', () => {
    expect(isSupervisorIpcMessage(null)).toBe(false);
    expect(isSupervisorIpcMessage(undefined)).toBe(false);
    expect(isSupervisorIpcMessage('ping')).toBe(false);
    expect(isSupervisorIpcMessage(42)).toBe(false);
    expect(isSupervisorIpcMessage({ message: 'ping' })).toBe(false);
  });

  it('isPingMessage narrows to SupervisorPingMessage', () => {
    expect(isPingMessage({ type: 'ping' })).toBe(true);
    expect(isPingMessage({ type: 'pong' })).toBe(false);
    expect(isPingMessage(null)).toBe(false);
    expect(isPingMessage('ping')).toBe(false);
  });

  it('isPongMessage narrows to WorkerPongMessage', () => {
    expect(isPongMessage({ type: 'pong' })).toBe(true);
    expect(isPongMessage({ type: 'ping' })).toBe(false);
    expect(isPongMessage(null)).toBe(false);
  });

  it('isPingMessage rejects extra fields that do not match ping', () => {
    // An object that has a type field but is not ping
    expect(isPingMessage({ type: 'exit', pid: 1234 })).toBe(false);
  });
});

// ── Soroban event type tests ───────────────────────────────────────────────

describe('SorobanRpcEvent / EnrichedSorobanEvent contracts', () => {
  const rawEvent: SorobanRpcEvent = {
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ledger: 5000,
    topic: [{ symbol: 'transfer' }],
    value: { from: 'G...', to: 'G...', amount: '1000000000' },
  };

  it('isEnrichedSorobanEvent returns false for raw events without ledgerSeq', () => {
    expect(isEnrichedSorobanEvent(rawEvent)).toBe(false);
  });

  it('isEnrichedSorobanEvent returns true once ledgerSeq is set', () => {
    const enriched: EnrichedSorobanEvent = { ...rawEvent, ledgerSeq: 5000 };
    expect(isEnrichedSorobanEvent(enriched)).toBe(true);
  });

  it('enriched event carries both ledger and ledgerSeq fields', () => {
    const enriched: EnrichedSorobanEvent = { ...rawEvent, ledgerSeq: rawEvent.ledger ?? 0 };
    expect(enriched.ledgerSeq).toBe(5000);
    expect(enriched.ledger).toBe(5000);
  });
});

// ── extractFilterRules narrower tests ─────────────────────────────────────

describe('extractFilterRules notification preference narrower', () => {
  it('returns null when prefs is null', () => {
    expect(extractFilterRules(null)).toBeNull();
  });

  it('returns null when prefs is undefined', () => {
    expect(extractFilterRules(undefined)).toBeNull();
  });

  it('returns null when filterRules is null', () => {
    const prefs = {
      id: '1', userId: 'u1', telegramEnabled: false,
      emailEnabled: true, whatsappEnabled: false, language: 'EN',
      filterRules: null,
    };
    expect(extractFilterRules(prefs)).toBeNull();
  });

  it('returns null when filterRules is missing (undefined)', () => {
    const prefs = {
      id: '1', userId: 'u1', telegramEnabled: false,
      emailEnabled: true, whatsappEnabled: false, language: 'EN',
    };
    expect(extractFilterRules(prefs)).toBeNull();
  });

  it('returns null when filterRules is a primitive (malformed JSON)', () => {
    const prefs = {
      id: '1', userId: 'u1', telegramEnabled: false,
      emailEnabled: true, whatsappEnabled: false, language: 'EN',
      filterRules: 'not-an-object',
    };
    expect(extractFilterRules(prefs)).toBeNull();
  });

  it('returns null when filterRules is an array (malformed JSON)', () => {
    const prefs = {
      id: '1', userId: 'u1', telegramEnabled: false,
      emailEnabled: true, whatsappEnabled: false, language: 'EN',
      filterRules: [{ field: 'amount', operator: 'gt', value: 10 }],
    };
    expect(extractFilterRules(prefs)).toBeNull();
  });

  it('returns null when filterRules is an object without a `rules` array', () => {
    const prefs = {
      id: '1', userId: 'u1', telegramEnabled: false,
      emailEnabled: true, whatsappEnabled: false, language: 'EN',
      filterRules: { operator: 'AND' }, // missing `rules`
    };
    expect(extractFilterRules(prefs)).toBeNull();
  });

  it('returns the FilterRuleGroup when filterRules is a well-formed object', () => {
    const filterRules = {
      operator: 'AND',
      rules: [{ field: 'amount', operator: 'gte', value: 10 }],
    };
    const prefs = {
      id: '1', userId: 'u1', telegramEnabled: false,
      emailEnabled: true, whatsappEnabled: false, language: 'EN',
      filterRules,
    };
    const result = extractFilterRules(prefs);
    expect(result).not.toBeNull();
    expect(result?.operator).toBe('AND');
    expect(Array.isArray(result?.rules)).toBe(true);
  });

  it('returns a FilterRuleGroup for an empty rules array (no-op filter)', () => {
    const filterRules = { operator: 'AND', rules: [] };
    const prefs = {
      id: '1', userId: 'u1', telegramEnabled: false,
      emailEnabled: true, whatsappEnabled: false, language: 'EN',
      filterRules,
    };
    const result = extractFilterRules(prefs);
    expect(result).not.toBeNull();
    expect(result?.rules).toHaveLength(0);
  });

  it('handles nested OR groups correctly', () => {
    const filterRules = {
      operator: 'OR',
      rules: [
        { field: 'asset', operator: 'eq', value: 'XLM' },
        { field: 'asset', operator: 'eq', value: 'USDC' },
      ],
    };
    const prefs = {
      id: '1', userId: 'u1', telegramEnabled: false,
      emailEnabled: true, whatsappEnabled: false, language: 'EN',
      filterRules,
    };
    const result = extractFilterRules(prefs);
    expect(result?.operator).toBe('OR');
    expect(result?.rules).toHaveLength(2);
  });
});

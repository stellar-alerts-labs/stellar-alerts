import { describe, expect, it } from 'vitest';
import { xdr, Keypair } from 'stellar-sdk';
import {
  buildMockSorobanEvent,
  buildMockTransferEvent,
  buildMockSwapEvent,
  buildMockUpgradeEvent,
  buildMockSorobanEvents,
  buildMockTopics,
  encodeScValToBase64,
  generateMockContractId,
} from '../soroban-event.factory';
import { scValToJs } from '../../../../../packages/shared/src/soroban/scval-parser';

describe('Soroban Event Factory', () => {
  describe('encodeScValToBase64', () => {
    it('encodes a string value to base64 XDR', () => {
      const encoded = encodeScValToBase64('hello');
      expect(encoded).toBeTruthy();
      expect(typeof encoded).toBe('string');

      // Verify it decodes back correctly
      const decoded = scValToJs(encoded);
      expect(decoded).toBe('hello');
    });

    it('encodes numeric values with type hints', () => {
      const encoded = encodeScValToBase64(42, 'u32');
      const scVal = xdr.ScVal.fromXDR(encoded, 'base64');
      expect(scVal.switch()).toEqual(xdr.ScValType.scvU32());
    });

    it('encodes complex nested objects', () => {
      const data = {
        amount: 1000000n,
        enabled: true,
        tags: ['a', 'b'],
      };
      const encoded = encodeScValToBase64(data);
      const decoded = scValToJs(encoded);
      expect(decoded).toEqual(data);
    });
  });

  describe('buildMockTopics', () => {
    it('converts topic strings to XDR-encoded Symbol array', () => {
      const topics = buildMockTopics(['transfer', 'from', 'to']);
      expect(topics).toHaveLength(3);

      // Verify each topic is valid XDR
      topics.forEach((topic, index) => {
        const scVal = xdr.ScVal.fromXDR(topic, 'base64');
        expect(scVal.switch()).toEqual(xdr.ScValType.scvSymbol());
      });
    });

    it('handles empty topic array', () => {
      const topics = buildMockTopics([]);
      expect(topics).toEqual([]);
    });
  });

  describe('generateMockContractId', () => {
    it('generates a valid contract ID starting with C', () => {
      const contractId = generateMockContractId();
      expect(contractId).toMatch(/^C[A-Z0-9]{55}$/);
    });

    it('generates unique contract IDs', () => {
      const id1 = generateMockContractId();
      const id2 = generateMockContractId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('buildMockSorobanEvent', () => {
    it('generates a valid event with default values', () => {
      const event = buildMockSorobanEvent();

      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('contractId');
      expect(event).toHaveProperty('topics');
      expect(event).toHaveProperty('value');
      expect(event).toHaveProperty('txHash');
      expect(event).toHaveProperty('ledgerSeq');
      expect(event).toHaveProperty('timestamp');

      expect(event.contractId).toMatch(/^C/);
      expect(Array.isArray(event.topics)).toBe(true);
      expect(event.ledgerSeq).toBeGreaterThan(0);
    });

    it('accepts custom contractId override', () => {
      const customContractId = 'CCONTRACTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const event = buildMockSorobanEvent({ contractId: customContractId });
      expect(event.contractId).toBe(customContractId);
    });

    it('accepts custom topics array', () => {
      const event = buildMockSorobanEvent({ topics: ['swap', 'pool'] });
      expect(event.topics).toHaveLength(2);

      // Verify topics are XDR-encoded
      event.topics.forEach((topic) => {
        const scVal = xdr.ScVal.fromXDR(topic, 'base64');
        expect(scVal.switch()).toEqual(xdr.ScValType.scvSymbol());
      });
    });

    it('encodes data object to XDR base64', () => {
      const data = { amount: '5000000', from: 'GABC', to: 'GDEF' };
      const event = buildMockSorobanEvent({ data });

      // Verify value is base64 string
      expect(typeof event.value).toBe('string');

      // Verify it decodes back to original data
      const decoded = scValToJs(event.value);
      expect(decoded).toEqual(data);
    });

    it('accepts custom ledgerSeq and txHash', () => {
      const event = buildMockSorobanEvent({
        ledgerSeq: 500000,
        txHash: 'custom_tx_hash_123',
      });
      expect(event.ledgerSeq).toBe(500000);
      expect(event.txHash).toBe('custom_tx_hash_123');
    });

    it('accepts Date or string timestamp', () => {
      const date = new Date('2026-01-01T00:00:00Z');
      const event1 = buildMockSorobanEvent({ timestamp: date });
      expect(event1.timestamp).toEqual(date);

      const isoString = '2026-06-15T12:30:00Z';
      const event2 = buildMockSorobanEvent({ timestamp: isoString });
      expect(event2.timestamp).toBe(isoString);
    });
  });

  describe('buildMockTransferEvent', () => {
    it('creates a transfer event with default addresses', () => {
      const event = buildMockTransferEvent();

      expect(event.topics).toHaveLength(1);
      const topicDecoded = xdr.ScVal.fromXDR(event.topics[0], 'base64');
      expect(scValToJs(topicDecoded)).toBe('transfer');

      const data = scValToJs(event.value);
      expect(data).toHaveProperty('from');
      expect(data).toHaveProperty('to');
      expect(data).toHaveProperty('amount');
      expect(data.amount).toBe('1000000');
    });

    it('accepts custom transfer addresses and amount', () => {
      const from = Keypair.random().publicKey();
      const to = Keypair.random().publicKey();
      const event = buildMockTransferEvent({
        data: { from, to, amount: '9999999' },
      });

      const data = scValToJs(event.value);
      expect(data.from).toBe(from);
      expect(data.to).toBe(to);
      expect(data.amount).toBe('9999999');
    });

    it('allows partial data overrides', () => {
      const customTo = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const event = buildMockTransferEvent({
        data: { to: customTo },
      });

      const data = scValToJs(event.value);
      expect(data.to).toBe(customTo);
      expect(data).toHaveProperty('from'); // Should still have default from
      expect(data).toHaveProperty('amount');
    });
  });

  describe('buildMockSwapEvent', () => {
    it('creates a swap event with DEX fields', () => {
      const event = buildMockSwapEvent();

      const topicDecoded = xdr.ScVal.fromXDR(event.topics[0], 'base64');
      expect(scValToJs(topicDecoded)).toBe('swap');

      const data = scValToJs(event.value);
      expect(data).toHaveProperty('sender');
      expect(data).toHaveProperty('amountIn');
      expect(data).toHaveProperty('amountOut');
      expect(data).toHaveProperty('tokenIn');
      expect(data).toHaveProperty('tokenOut');

      expect(data.amountIn).toBe('5000000');
      expect(data.amountOut).toBe('4950000');
    });

    it('accepts custom swap amounts', () => {
      const event = buildMockSwapEvent({
        data: { amountIn: '10000000', amountOut: '9800000' },
      });

      const data = scValToJs(event.value);
      expect(data.amountIn).toBe('10000000');
      expect(data.amountOut).toBe('9800000');
    });
  });

  describe('buildMockUpgradeEvent', () => {
    it('creates an upgrade event with WASM hashes', () => {
      const event = buildMockUpgradeEvent();

      const topicDecoded = xdr.ScVal.fromXDR(event.topics[0], 'base64');
      expect(scValToJs(topicDecoded)).toBe('update_wasm');

      const data = scValToJs(event.value);
      expect(data).toHaveProperty('oldWasmHash');
      expect(data).toHaveProperty('newWasmHash');
      expect(data.oldWasmHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.newWasmHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('accepts custom WASM hashes', () => {
      const oldHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const newHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      const event = buildMockUpgradeEvent({
        data: { oldWasmHash: oldHash, newWasmHash: newHash },
      });

      const data = scValToJs(event.value);
      expect(data.oldWasmHash).toBe(oldHash);
      expect(data.newWasmHash).toBe(newHash);
    });
  });

  describe('buildMockSorobanEvents', () => {
    it('generates multiple events with incrementing ledger sequences', () => {
      const events = buildMockSorobanEvents(5, { ledgerSeq: 1000 });

      expect(events).toHaveLength(5);
      events.forEach((event, index) => {
        expect(event.ledgerSeq).toBe(1000 + index);
      });
    });

    it('generates unique IDs for each event', () => {
      const events = buildMockSorobanEvents(3);
      const ids = events.map((e) => e.id);

      expect(new Set(ids).size).toBe(3); // All unique
    });

    it('applies base options to all generated events', () => {
      const contractId = 'CSHAREDCONTRACT123XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const events = buildMockSorobanEvents(3, {
        contractId,
        topics: ['payment'],
      });

      events.forEach((event) => {
        expect(event.contractId).toBe(contractId);
        expect(event.topics).toHaveLength(1);
      });
    });

    it('handles generating zero events', () => {
      const events = buildMockSorobanEvents(0);
      expect(events).toEqual([]);
    });
  });

  describe('XDR decodability validation', () => {
    it('produces valid XDR that stellar-sdk can decode', () => {
      const event = buildMockSorobanEvent({
        topics: ['transfer', 'payment'],
        data: {
          from: Keypair.random().publicKey(),
          to: Keypair.random().publicKey(),
          amount: 1000000n,
        },
      });

      // Verify all topics are decodable
      event.topics.forEach((topic) => {
        expect(() => xdr.ScVal.fromXDR(topic, 'base64')).not.toThrow();
      });

      // Verify value is decodable
      expect(() => xdr.ScVal.fromXDR(event.value, 'base64')).not.toThrow();
    });

    it('roundtrips complex nested data structures', () => {
      const complexData = {
        user: Keypair.random().publicKey(),
        amounts: [100n, 200n, 300n],
        metadata: {
          version: 1,
          active: true,
        },
      };

      const event = buildMockSorobanEvent({ data: complexData });
      const decoded = scValToJs(event.value);

      expect(decoded).toEqual(complexData);
    });
  });
});

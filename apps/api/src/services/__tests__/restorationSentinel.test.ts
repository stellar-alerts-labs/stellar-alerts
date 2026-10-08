import { describe, expect, it } from 'vitest';
import {
  RestorationSentinelEngine,
  stroopsToXlm,
} from '../restorationSentinel';

// #1005: Soroban contract instance & code restoration sentinel.
describe('RestorationSentinelEngine (#1005)', () => {
  const engine = new RestorationSentinelEngine({
    warningThresholdLedgers: 17_280,
    criticalThresholdLedgers: 1_000,
    minRestoreLedgers: 4_096,
    rentFeePerBytePerLedgerStroops: 100n,
    writeFeePerByteStroops: 1_000n,
  });

  describe('stroopsToXlm', () => {
    it('formats stroops as a fixed 7-dp XLM string', () => {
      expect(stroopsToXlm(0n)).toBe('0.0000000');
      expect(stroopsToXlm(10_000_000n)).toBe('1.0000000');
      expect(stroopsToXlm(12_345_678n)).toBe('1.2345678');
      expect(stroopsToXlm(-5_000_000n)).toBe('-0.5000000');
    });
  });

  describe('assessEntry', () => {
    it('classifies a healthy entry as OK with no restoration', () => {
      const result = engine.assessEntry(
        { keyHash: '0xinstance', kind: 'INSTANCE', byteSize: 512, liveUntilLedgerSeq: 100_000 },
        1_000,
      );
      expect(result.severity).toBe('OK');
      expect(result.isEvicted).toBe(false);
      expect(result.restoration).toBeNull();
      expect(result.remainingLedgers).toBe(99_000);
    });

    it('warns when an entry is approaching archival', () => {
      const result = engine.assessEntry(
        { keyHash: '0xcode', kind: 'CODE', byteSize: 4096, liveUntilLedgerSeq: 10_000 },
        1_000,
      );
      expect(result.severity).toBe('WARNING');
      expect(result.isEvicted).toBe(false);
    });

    it('escalates to CRITICAL within the critical threshold', () => {
      const result = engine.assessEntry(
        { keyHash: '0xinstance', kind: 'INSTANCE', byteSize: 256, liveUntilLedgerSeq: 1_500 },
        1_000,
      );
      expect(result.severity).toBe('CRITICAL');
      expect(result.remainingLedgers).toBe(500);
    });

    it('detects eviction and computes the exact restoration fee', () => {
      const result = engine.assessEntry(
        { keyHash: '0xcode', kind: 'CODE', byteSize: 1_000, liveUntilLedgerSeq: 900 },
        1_000,
      );
      expect(result.severity).toBe('EVICTED');
      expect(result.isEvicted).toBe(true);
      expect(result.remainingLedgers).toBe(-100);
      // write = 1000 * 1000 = 1_000_000 ; rent = 1000 * 4096 * 100 = 409_600_000
      expect(result.restoration).not.toBeNull();
      expect(result.restoration!.writeFeeStroops).toBe(1_000_000n);
      expect(result.restoration!.rentFeeStroops).toBe(409_600_000n);
      expect(result.restoration!.totalFeeStroops).toBe(410_600_000n);
      expect(result.restoration!.ledgersToRestore).toBe(4_096);
    });
  });

  describe('assessContractFootprint', () => {
    it('aggregates evicted instance + code keys into a single restoration bundle', () => {
      const alert = engine.assessContractFootprint(
        'CCONTRACTXYZ',
        [
          { keyHash: '0xinstance', kind: 'INSTANCE', byteSize: 500, liveUntilLedgerSeq: 900 },
          { keyHash: '0xcode', kind: 'CODE', byteSize: 1_000, liveUntilLedgerSeq: 950 },
        ],
        1_000,
      );

      expect(alert.severity).toBe('EVICTED');
      expect(alert.requiresRestoration).toBe(true);
      expect(alert.keysToRestore).toEqual(['0xinstance', '0xcode']);
      // instance: 500*1000 + 500*4096*100 = 500_000 + 204_800_000 = 205_300_000
      // code:    1000*1000 + 1000*4096*100 = 1_000_000 + 409_600_000 = 410_600_000
      expect(alert.totalRestorationFeeStroops).toBe(615_900_000n);
      expect(alert.totalRestorationFeeXlm).toBe('61.5900000');
    });

    it('does not require restoration when the footprint is only approaching TTL', () => {
      const alert = engine.assessContractFootprint(
        'CCONTRACTXYZ',
        [
          { keyHash: '0xinstance', kind: 'INSTANCE', byteSize: 500, liveUntilLedgerSeq: 5_000 },
          { keyHash: '0xcode', kind: 'CODE', byteSize: 1_000, liveUntilLedgerSeq: 200_000 },
        ],
        1_000,
      );

      expect(alert.requiresRestoration).toBe(false);
      expect(alert.severity).toBe('WARNING');
      expect(alert.keysToRestore).toHaveLength(0);
      expect(alert.totalRestorationFeeStroops).toBe(0n);
    });

    it('rolls up to the worst entry severity', () => {
      const alert = engine.assessContractFootprint(
        'CCONTRACTXYZ',
        [
          { keyHash: '0xinstance', kind: 'INSTANCE', byteSize: 500, liveUntilLedgerSeq: 200_000 },
          { keyHash: '0xcode', kind: 'CODE', byteSize: 1_000, liveUntilLedgerSeq: 1_200 },
        ],
        1_000,
      );
      expect(alert.severity).toBe('CRITICAL');
      expect(alert.requiresRestoration).toBe(false);
    });
  });
});

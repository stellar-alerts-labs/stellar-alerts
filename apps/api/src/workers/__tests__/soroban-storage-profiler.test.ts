import {
  estimateTtlExtensionCost,
  profileContractStorage,
  type SorobanStorageEntry,
} from '../soroban-storage-profiler.worker';

describe('Soroban Storage Key Footprint Profiler & TTL Extension Estimator (#419)', () => {
  const mockEntries: SorobanStorageEntry[] = [
    { key: 'user_bal_1', tier: 'Persistent', byteSize: 200 },
    { key: 'user_bal_2', tier: 'Persistent', byteSize: 300 },
    { key: 'contract_config', tier: 'Instance', byteSize: 500 },
    { key: 'temp_nonce_1', tier: 'Temporary', byteSize: 100 },
  ];

  it('categorizes storage footprint by Persistent, Instance, and Temporary tiers', () => {
    const profile = profileContractStorage('CCONTRACT_123', mockEntries);

    expect(profile.contractId).toBe('CCONTRACT_123');
    expect(profile.totalEntries).toBe(4);
    expect(profile.totalBytes).toBe(1100);

    expect(profile.byTier.Persistent.entryCount).toBe(2);
    expect(profile.byTier.Persistent.totalBytes).toBe(500);
    expect(profile.byTier.Persistent.avgBytesPerEntry).toBe(250);

    expect(profile.byTier.Instance.totalBytes).toBe(500);
    expect(profile.byTier.Temporary.totalBytes).toBe(100);
  });

  it('computes exact TTL extension rent costs in stroops and XLM', () => {
    const profile = profileContractStorage('CCONTRACT_123', mockEntries);
    // 1100 total bytes * 10000 ledgers * 100 stroops/byte/ledger = 1,100,000,000 stroops = 110 XLM
    const estimation = estimateTtlExtensionCost(profile, 10000, 100n);

    expect(estimation.ledgersToExtend).toBe(10000);
    expect(estimation.totalRentFeeStroops).toBe(1100000000n);
    expect(estimation.totalRentFeeXlm).toBe('110.0000000');
    expect(estimation.tierBreakdownStroops.Persistent).toBe(500000000n);
  });
});

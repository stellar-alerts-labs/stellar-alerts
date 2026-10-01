import { describe, expect, it } from 'vitest';
import { ClaimableBalanceWatcher } from '../claimableBalanceWatcher';
import { StateArchivalWatcherEngine } from '../stateArchivalWatcher';
import { HorizonLagSentinel } from '../horizonLagSentinel';
import { BlendHealthFactorWatcher } from '../blendHealthFactorWatcher';

describe('Stellar Alerts Watcher Services (#425, #427, #428, #429)', () => {
  it('#425: ClaimableBalanceWatcher creates expiration alerts', () => {
    const watcher = new ClaimableBalanceWatcher(['GAAAAAAA']);
    const alerts = watcher.processBalance(
      {
        id: 'bal1',
        asset: 'XLM',
        amount: '100',
        sponsor: 'GSPONSOR',
        claimants: [{ destination: 'GAAAAAAA', predicate: { absBeforeLedger: 1050 } }],
        lastModifiedLedger: 1000,
      },
      1000,
    );

    expect(alerts.length).toBe(2); // CREATED + EXPIRING_SOON
    expect(alerts[0]!.type).toBe('CREATED');
    expect(alerts[1]!.type).toBe('EXPIRING_SOON');
  });

  it('#427: StateArchivalWatcherEngine detects eviction and critical TTL', () => {
    const engine = new StateArchivalWatcherEngine();
    const evicted = engine.checkEntryTTL(
      { keyHash: '0x123', contractId: 'CCONTR', durability: 'PERSISTENT', liveUntilLedger: 1000 },
      1000,
    );
    expect(evicted?.status).toBe('EVICTED');

    // remaining <= 1000 ledgers is the CRITICAL band
    const critical = engine.checkEntryTTL(
      { keyHash: '0x789', contractId: 'CCONTR', durability: 'PERSISTENT', liveUntilLedger: 1500 },
      1000,
    );
    expect(critical?.status).toBe('CRITICAL');

    // remaining above the CRITICAL band but under the ~1 day minLive threshold
    const warning = engine.checkEntryTTL(
      { keyHash: '0x456', contractId: 'CCONTR', durability: 'PERSISTENT', liveUntilLedger: 5000 },
      1000,
    );
    expect(warning?.status).toBe('WARNING');
  });

  it('#428: HorizonLagSentinel rotates node on ingestion lag drift', () => {
    const sentinel = new HorizonLagSentinel(['https://node1.org', 'https://node2.org'], 3);
    const result = sentinel.evaluateNodes(
      [
        { url: 'https://node1.org', latestIngestedLedger: 1000, healthy: true, responseTimeMs: 50 },
        { url: 'https://node2.org', latestIngestedLedger: 1010, healthy: true, responseTimeMs: 40 },
      ],
      1010,
    );

    expect(result.rotated).toBe(true);
    expect(result.activeNodeUrl).toBe('https://node2.org');
  });

  it('#429: BlendHealthFactorWatcher calculates health factor and identifies liquidation risk', () => {
    const watcher = new BlendHealthFactorWatcher();
    const alert = watcher.evaluatePosition({
      userAddress: 'GUSER',
      poolId: 'POOL1',
      collateralValueUsd: 1000,
      liquidationThresholdRatio: 0.8, // Collateral value = 800
      borrowValueUsd: 800, // HF = 1.0 (below liquidation threshold 1.05)
    });

    expect(alert).not.toBeNull();
    expect(alert?.severity).toBe('CRITICAL_LIQUIDATION_RISK');
    expect(alert?.healthFactor).toBe(1.0);
  });
});

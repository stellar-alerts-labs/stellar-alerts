import { describe, expect, it } from 'vitest';
import { analyzeEnvelopeIntegrity } from '../envelope-integrity';
import type { SimulatedOperation } from '../types';

describe('envelope-integrity', () => {
  it('detects missing time bounds', () => {
    const result = analyzeEnvelopeIntegrity({
      sourceAccount: 'GABC',
      operations: [],
      resources: { hasTimeBounds: false },
      outcome: undefined,
      hasInvocation: false,
      simulated: false,
    });
    const noTime = result.find((i) => i.code === 'MISSING_TIME_BOUNDS');
    expect(noTime).toBeDefined();
  });

  it('detects no simulation result', () => {
    const result = analyzeEnvelopeIntegrity({
      sourceAccount: 'GABC',
      operations: [],
      resources: { hasTimeBounds: true },
      outcome: undefined,
      hasInvocation: true,
      simulated: false,
    });
    const noSim = result.find((i) => i.code === 'NO_SIMULATION_RESULT');
    expect(noSim).toBeDefined();
  });
});

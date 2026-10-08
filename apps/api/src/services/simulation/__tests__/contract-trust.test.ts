import { describe, expect, it } from 'vitest';
import { analyzeContractInteractions, isPrivilegedFunction } from '../contract-trust';
import type { SimulatedOperation, ContractTrustRegistry, ContractStateSnapshot } from '../types';

const invoke = (contractId: string, fn = 'transfer', source = 'GABC'): SimulatedOperation => ({
  kind: 'invokeContract',
  contractId,
  function: fn,
  source,
});

describe('contract-trust', () => {
  it('detects privileged function without auth', () => {
    const { indicators } = analyzeContractInteractions('GABC', [invoke('C1', 'set_admin')], [], undefined, [], {
      maxInvocationsPerContract: 5,
    });
    const priv = indicators.find((i) => i.code === 'PRIVILEGED_FUNCTION_WITHOUT_AUTH');
    expect(priv).toBeDefined();
  });

  it('detects unverified contract invocation', () => {
    const { indicators } = analyzeContractInteractions('GABC', [invoke('C1', 'transfer')], [], undefined, [], {
      maxInvocationsPerContract: 5,
    });
    const unverified = indicators.find((i) => i.code === 'UNVERIFIED_CONTRACT_INVOCATION' || i.code === 'UNVERIFIED_CONTRACT_INVOKED');
    expect(unverified).toBeDefined();
  });

  it('treats allowlisted contract as verified', () => {
    const trust: ContractTrustRegistry = { allowlist: new Set(['C1']) };
    const { indicators, analysis } = analyzeContractInteractions('GABC', [invoke('C1')], [], trust, [], {
      maxInvocationsPerContract: 5,
    });
    const unverified = indicators.find((i) => i.code === 'UNVERIFIED_CONTRACT_INVOCATION' || i.code === 'UNVERIFIED_CONTRACT_INVOKED');
    expect(unverified).toBeUndefined();
    expect(analysis.interactions[0]!.verified).toBe(true);
  });

  it('detects code hash mismatch', () => {
    const trust: ContractTrustRegistry = {
      byContractId: new Map([
        ['C1', { contractId: 'C1', verified: true, wasmHash: 'abc123' }],
      ]),
    };
    const contracts: ContractStateSnapshot[] = [{ contractId: 'C1', wasmHash: 'def456' }];
    const { indicators } = analyzeContractInteractions('GABC', [invoke('C1')], contracts, trust, [], {
      maxInvocationsPerContract: 5,
    });
    const mismatch = indicators.find((i) => i.code === 'CONTRACT_CODE_HASH_MISMATCH');
    expect(mismatch).toBeDefined();
  });

  it('detects invocation fan out', () => {
    const ops = [invoke('C1'), invoke('C1'), invoke('C1'), invoke('C1'), invoke('C1'), invoke('C1')];
    const { indicators } = analyzeContractInteractions('GABC', ops, [], undefined, [], {
      maxInvocationsPerContract: 5,
    });
    const fanOut = indicators.find((i) => i.code === 'INVOCATION_FAN_OUT');
    expect(fanOut).toBeDefined();
  });

  it('detects newly deployed contract invoked', () => {
    const ops = [
      { kind: 'createContract' as const, contractId: 'C1', source: 'GABC' },
      invoke('C1'),
    ];
    const { indicators } = analyzeContractInteractions('GABC', ops, [], undefined, [], {
      maxInvocationsPerContract: 5,
    });
    const deployed = indicators.find((i) => i.code === 'NEWLY_DEPLOYED_CONTRACT_INVOKED');
    expect(deployed).toBeDefined();
  });

  it('identifies privileged functions', () => {
    expect(isPrivilegedFunction('set_admin')).toBe(true);
    expect(isPrivilegedFunction('upgrade_contract')).toBe(true);
    expect(isPrivilegedFunction('transfer')).toBe(false);
  });
});

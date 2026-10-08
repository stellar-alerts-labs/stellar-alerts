import { describe, expect, it } from 'vitest';
import {
  diffFootprints,
  normalizeFootprint,
  indexFootprint,
  isDeclaredWritable,
  declaredAccessFor,
} from '../footprint-diff';
import type { TransactionFootprint, FootprintKey } from '../types';

const contractKey = (contractId: string, readOnly = false): FootprintKey => ({
  key: `contractData:${contractId}:00000000:00000001`,
  entryType: 'contractData',
  contractId,
  access: readOnly ? 'readOnly' : 'readWrite',
});

const accountKey = (accountId: string): FootprintKey => ({
  key: `account:${accountId}`,
  entryType: 'account',
  access: 'readOnly',
});

describe('footprint-diff', () => {
  it('normalizes partial footprints', () => {
    expect(normalizeFootprint(null)).toEqual({ readOnly: [], readWrite: [], archived: [] });
    expect(normalizeFootprint(undefined)).toEqual({ readOnly: [], readWrite: [], archived: [] });
    expect(normalizeFootprint({ readOnly: [accountKey('G1')] })).toEqual({
      readOnly: [accountKey('G1')],
      readWrite: [],
      archived: [],
    });
  });

  it('indexes footprints and collapses duplicates', () => {
    const footprint: TransactionFootprint = {
      readOnly: [accountKey('G1'), accountKey('G1')],
      readWrite: [contractKey('C1')],
      archived: [],
    };
    const index = indexFootprint(footprint);
    expect(index.size).toBe(2);
  });

  it('diffs identical footprints', () => {
    const fp: TransactionFootprint = {
      readOnly: [accountKey('G1')],
      readWrite: [contractKey('C1')],
      archived: [],
    };
    const diff = diffFootprints(fp, fp);
    expect(diff.summary.missingCount).toBe(0);
    expect(diff.summary.unusedCount).toBe(0);
    expect(diff.summary.modeChangedCount).toBe(0);
    expect(diff.entries.every((e) => e.change === 'unchanged')).toBe(true);
  });

  it('detects missing keys', () => {
    const declared: TransactionFootprint = { readOnly: [], readWrite: [], archived: [] };
    const required: TransactionFootprint = { readOnly: [accountKey('G1')], readWrite: [], archived: [] };
    const diff = diffFootprints(declared, required);
    expect(diff.summary.missingCount).toBe(1);
    expect(diff.entries[0]!.change).toBe('missing');
  });

  it('detects unused keys', () => {
    const declared: TransactionFootprint = { readOnly: [accountKey('G1')], readWrite: [], archived: [] };
    const required: TransactionFootprint = { readOnly: [], readWrite: [], archived: [] };
    const diff = diffFootprints(declared, required);
    expect(diff.summary.unusedCount).toBe(1);
    expect(diff.entries[0]!.change).toBe('unused');
  });

  it('detects mode changes', () => {
    const declared: TransactionFootprint = {
      readOnly: [contractKey('C1', true)],
      readWrite: [],
      archived: [],
    };
    const required: TransactionFootprint = {
      readOnly: [],
      readWrite: [contractKey('C1', false)],
      archived: [],
    };
    const diff = diffFootprints(declared, required);
    expect(diff.summary.modeChangedCount).toBe(1);
    expect(diff.entries[0]!.change).toBe('mode_changed');
    expect(diff.entries[0]!.declaredAccess).toBe('readOnly');
    expect(diff.entries[0]!.requiredAccess).toBe('readWrite');
  });

  it('checks if key is declared writable', () => {
    const fp: TransactionFootprint = { readOnly: [], readWrite: [contractKey('C1')], archived: [] };
    expect(isDeclaredWritable(fp, contractKey('C1').key)).toBe(true);
    expect(isDeclaredWritable(fp, 'other')).toBe(false);
  });

  it('gets declared access for key', () => {
    const fp: TransactionFootprint = { readOnly: [accountKey('G1')], readWrite: [], archived: [] };
    expect(declaredAccessFor(fp, accountKey('G1').key)).toBe('readOnly');
    expect(declaredAccessFor(fp, 'missing')).toBeUndefined();
  });
});

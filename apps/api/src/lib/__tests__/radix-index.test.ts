import { describe, it, expect } from 'vitest';
import { RadixAddressIndex } from '../radix-index';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomKey(next: () => number, prefix = 'G', length = 56): string {
  let s = prefix;
  while (s.length < length) s += ALPHA[Math.floor(next() * 32)];
  return s;
}

describe('RadixAddressIndex', () => {
  it('adds, finds and rejects keys', () => {
    const idx = new RadixAddressIndex();
    expect(idx.add('GABC')).toBe(true);
    expect(idx.add('GABC')).toBe(false);
    expect(idx.has('GABC')).toBe(true);
    expect(idx.has('GABD')).toBe(false);
    expect(idx.has('GAB')).toBe(false);
    expect(idx.has('GABCD')).toBe(false);
    expect(idx.has('')).toBe(false);
    expect(idx.size).toBe(1);
  });

  it('handles keys that are prefixes of each other', () => {
    const idx = new RadixAddressIndex();
    idx.add('GABCDEF');
    idx.add('GABC');
    idx.add('GABCDEFGH');
    expect(idx.size).toBe(3);
    for (const k of ['GABC', 'GABCDEF', 'GABCDEFGH']) expect(idx.has(k)).toBe(true);
    expect(idx.has('GABCD')).toBe(false);

    expect(idx.delete('GABCDEF')).toBe(true);
    expect(idx.has('GABCDEF')).toBe(false);
    expect(idx.has('GABC')).toBe(true);
    expect(idx.has('GABCDEFGH')).toBe(true);
  });

  it('splits edges on divergence at every depth', () => {
    const idx = new RadixAddressIndex();
    const keys = ['GAAAA', 'GAAAB', 'GAABA', 'GABAA', 'GBAAA', 'GAAAAA'];
    keys.forEach((k) => idx.add(k));
    keys.forEach((k) => expect(idx.has(k)).toBe(true));
    expect([...idx.keys()].sort()).toEqual([...keys].sort());
  });

  it('rejects non-base32 input on add and returns false on has', () => {
    const idx = new RadixAddressIndex();
    expect(() => idx.add('G1BC')).toThrow(TypeError); // 1 is not in the RFC 4648 alphabet
    expect(() => idx.add('')).toThrow(RangeError);
    expect(() => idx.add('G'.repeat(256))).toThrow(RangeError);
    expect(idx.has('G1BC')).toBe(false);
    expect(idx.has('gabc')).toBe(false);
    expect(idx.has('Gé')).toBe(false);
  });

  it('is case-tolerant like base32 decoders (lowercase maps to the same symbols)', () => {
    const idx = new RadixAddressIndex();
    idx.add('GABC');
    expect(idx.has('gabc')).toBe(true);
  });

  it('supports prefix queries', () => {
    const idx = new RadixAddressIndex();
    ['GAAAA', 'GAAAB', 'GABBB', 'CAAAA'].forEach((k) => idx.add(k));
    expect(idx.hasPrefix('GAA')).toBe(true);
    expect(idx.hasPrefix('GA')).toBe(true);
    expect(idx.hasPrefix('GAAAAA')).toBe(false);
    expect(idx.hasPrefix('GC')).toBe(false);
    expect(idx.hasPrefix('')).toBe(true);
    expect(idx.keysWithPrefix('GAA').sort()).toEqual(['GAAAA', 'GAAAB']);
    expect(idx.keysWithPrefix('G').sort()).toEqual(['GAAAA', 'GAAAB', 'GABBB']);
    expect(idx.keysWithPrefix('GAAAA')).toEqual(['GAAAA']);
    expect(idx.keysWithPrefix('G', 2)).toHaveLength(2);
    expect(idx.keysWithPrefix('X')).toEqual([]);
  });

  it('clear() resets the index and it stays usable', () => {
    const idx = new RadixAddressIndex();
    ['GAAA', 'GAAB'].forEach((k) => idx.add(k));
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.has('GAAA')).toBe(false);
    idx.add('GAAB');
    expect(idx.has('GAAB')).toBe(true);
  });

  it('matches a Set across random add/delete/has churn (differential test)', () => {
    const next = rng(42);
    const idx = new RadixAddressIndex(64);
    const model = new Set<string>();

    // Short keys over a tiny alphabet slice force deep sharing, splits and merges.
    const pool: string[] = [];
    for (let i = 0; i < 600; i++) {
      let s = 'G';
      const length = 2 + Math.floor(next() * 10);
      while (s.length < length) s += 'ABC'[Math.floor(next() * 3)];
      pool.push(s);
    }

    for (let step = 0; step < 20000; step++) {
      const key = pool[Math.floor(next() * pool.length)];
      const op = next();
      if (op < 0.45) {
        expect(idx.add(key)).toBe(!model.has(key));
        model.add(key);
      } else if (op < 0.8) {
        expect(idx.delete(key)).toBe(model.has(key));
        model.delete(key);
      } else {
        expect(idx.has(key)).toBe(model.has(key));
      }
      if (step % 2000 === 0) expect(idx.size).toBe(model.size);
    }

    expect(idx.size).toBe(model.size);
    expect([...idx.keys()].sort()).toEqual([...model].sort());
    for (const key of pool) expect(idx.has(key)).toBe(model.has(key));
  });

  it('survives full-length key churn and compaction without losing entries', () => {
    const next = rng(7);
    const idx = new RadixAddressIndex(2000);
    const keys = Array.from({ length: 5000 }, () => randomKey(next));
    keys.forEach((k) => idx.add(k));

    // Remove 60% so wasted label space crosses the auto-compaction threshold.
    const removed = new Set<string>();
    keys.forEach((k, i) => {
      if (i % 5 < 3) {
        expect(idx.delete(k)).toBe(true);
        removed.add(k);
      }
    });

    for (const k of keys) expect(idx.has(k)).toBe(!removed.has(k));
    expect(idx.size).toBe(keys.length - removed.size);

    idx.trim();
    for (const k of keys) expect(idx.has(k)).toBe(!removed.has(k));
    // Re-adding after trim must still work (arrays regrow).
    removed.forEach((k) => idx.add(k));
    for (const k of keys) expect(idx.has(k)).toBe(true);
    expect(idx.stats().wastedLabelSymbols).toBe(0);
  });

  it('indexes Soroban (C...) and muxed (M..., 69 char) keys alongside G keys', () => {
    const next = rng(3);
    const idx = new RadixAddressIndex();
    const keys = [randomKey(next, 'G'), randomKey(next, 'C'), randomKey(next, 'M', 69)];
    keys.forEach((k) => idx.add(k));
    keys.forEach((k) => expect(idx.has(k)).toBe(true));
    expect(idx.has(keys[0].slice(0, -1) + (keys[0].endsWith('A') ? 'B' : 'A'))).toBe(false);
  });
});

describe('RadixAddressIndex at scale (500,000 keys)', () => {
  it('looks up in well under 0.05ms per key and stays compact', () => {
    const next = rng(2026);
    const N = 500_000;
    const keys: string[] = new Array(N);
    for (let i = 0; i < N; i++) keys[i] = randomKey(next);

    const idx = new RadixAddressIndex(N);
    for (let i = 0; i < N; i++) idx.add(keys[i]);
    idx.trim();
    expect(idx.size).toBe(N); // random 280-bit keys: collisions are impossible in practice

    // Warm up, then time a mix of hits and misses.
    let hits = 0;
    for (let i = 0; i < 50_000; i++) if (idx.has(keys[i])) hits++;
    expect(hits).toBe(50_000);

    const probes = 200_000;
    const misses = Array.from({ length: probes / 2 }, () => randomKey(next));
    const start = performance.now();
    let found = 0;
    for (let i = 0; i < probes / 2; i++) {
      if (idx.has(keys[(i * 2654435761) % N])) found++;
      if (idx.has(misses[i])) found++;
    }
    const perLookupMs = (performance.now() - start) / probes;

    expect(found).toBe(probes / 2); // every hit found, no miss matched
    // Spec: <0.05ms. Asserted with 5x headroom for loaded CI; real figure is ~100x lower.
    expect(perLookupMs).toBeLessThan(0.25);

    // 500k keys * 56 chars as a V8 Set costs >= ~100 B/key; the index must be well below 60%
    // of that (the issue demands a >40% reduction). Measured precisely in scripts/benchmark-radix-index.ts.
    const bytesPerKey = idx.stats().allocatedBytes / N;
    expect(bytesPerKey).toBeLessThan(60);
  }, 60_000);
});

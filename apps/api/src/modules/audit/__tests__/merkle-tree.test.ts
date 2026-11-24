import { describe, it, expect } from 'vitest';
import {
  buildMerkleTree,
  canonicalJson,
  generateInclusionProof,
  hashMerkleLeaf,
  hashMerkleNode,
  verifyInclusionProof,
} from '../merkle-tree';

describe('RFC 6962 domain separation', () => {
  it('uses 0x00 for leaves and 0x01 for internal nodes', () => {
    // RFC 6962 vectors: MTH({}) leaf values and a two-leaf tree.
    expect(hashMerkleLeaf('')).toBe(
      '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
    );
    expect(hashMerkleLeaf('a')).toBe(
      '022a6979e6dab7aa5ae4c3e5e45f7e977112a7e63593820dbec1ec738a24f93c',
    );
    expect(
      hashMerkleNode(hashMerkleLeaf(''), hashMerkleLeaf('a')),
    ).toBe('688dc6244b041199e7ab4990df6340ce3dc14caa5cd5a0e1131addaa1209e1a6');
    expect(hashMerkleLeaf('a')).not.toBe(
      hashMerkleNode(Buffer.alloc(32), Buffer.alloc(32)),
    );
  });

  it('rejects non-32-byte node children', () => {
    expect(() => hashMerkleNode('abcd', Buffer.alloc(32))).toThrow(TypeError);
  });
});

describe('odd-leaf handling', () => {
  it('promotes the odd subtree instead of duplicating the leaf', () => {
    const tree = buildMerkleTree(['', 'a', 'b']);
    // RFC 6962 MTH({},{a},{b}) with the odd leaf promoted to the right.
    expect(tree.root).toBe('652297b9504045a600942bcdf9ae5c2400be42d51139c7fb63ab3ee439ff110d');

    const duplicatedOddLeaf = hashMerkleNode(
      hashMerkleNode(hashMerkleLeaf(''), hashMerkleLeaf('a')),
      hashMerkleNode(hashMerkleLeaf('b'), hashMerkleLeaf('b')),
    );
    expect(tree.root).not.toBe(duplicatedOddLeaf);
  });

  it('uses the RFC 6962 empty-tree root', () => {
    const tree = buildMerkleTree([]);
    expect(tree.root).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(() => generateInclusionProof(tree, 0)).toThrow(RangeError);
  });
});

describe('inclusion proofs', () => {
  it('generates proofs that verify for every leaf, including the odd one', () => {
    const tree = buildMerkleTree(['', 'a', 'b']);
    for (let index = 0; index < 3; index++) {
      const proof = generateInclusionProof(tree, index);
      expect(proof.leafIndex).toBe(index);
      expect(proof.leafHash).toBe(tree.leafHashes[index]);
      expect(proof.rootHash).toBe(tree.root);
      expect(verifyInclusionProof(proof)).toBe(true);
    }
  });

  it('rejects tampered leaves, paths and roots', () => {
    const tree = buildMerkleTree(['a', 'b', 'c', 'd', 'e']);
    const proof = generateInclusionProof(tree, 0);
    expect(proof.path.length).toBeGreaterThan(1);

    expect(verifyInclusionProof({ ...proof, leafHash: hashMerkleLeaf('evil') })).toBe(false);
    expect(verifyInclusionProof({ ...proof, rootHash: 'f'.repeat(64) })).toBe(false);
    expect(
      verifyInclusionProof({
        ...proof,
        path: proof.path.map((step, index) =>
          index === 0 ? { ...step, siblingHash: '0'.repeat(64) } : step,
        ),
      }),
    ).toBe(false);
    expect(
      verifyInclusionProof({ ...proof, path: [{ siblingHash: 'zz', direction: 'left' }] }),
    ).toBe(false);
    expect(verifyInclusionProof({ ...proof, path: [{ siblingHash: '0'.repeat(64), direction: 'up' as any }] })).toBe(false);
  });

  it('rejects out-of-range leaf indexes', () => {
    const tree = buildMerkleTree(['a']);
    expect(() => generateInclusionProof(tree, -1)).toThrow(RangeError);
    expect(() => generateInclusionProof(tree, 1)).toThrow(RangeError);
  });
});

describe('canonicalJson', () => {
  it('is independent of object key insertion order', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('omits undefined values and preserves stable array order', () => {
    expect(canonicalJson({ a: undefined, items: [2, 1] })).toBe('{"items":[2,1]}');
  });
});

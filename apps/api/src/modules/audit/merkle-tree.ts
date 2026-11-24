/**
 * RFC 6962 Merkle tree for audit-log anchoring.
 *
 * Leaf hashes are SHA256(0x00 || leaf) and internal nodes are
 * SHA256(0x01 || left || right), so a leaf hash can never be reinterpreted as
 * an internal node hash. Odd nodes at any level are *promoted* (not
 * duplicated): the largest power-of-two left subtree is hashed independently
 * and the remaining right subtree is hashed as-is. This is the RFC 6962
 * `MTH` rule and makes proofs agree with other RFC 6962 implementations.
 */

import { createHash } from 'node:crypto';

const HEX_64 = /^[0-9a-f]{64}$/i;

export type MerkleProofDirection = 'left' | 'right';

export interface MerkleProofStep {
  /** Hex-encoded sibling hash at this level. */
  siblingHash: string;
  /** Side the sibling sits on relative to the node being proven. */
  direction: MerkleProofDirection;
}

export interface InclusionProof {
  leafIndex: number;
  leafHash: string;
  path: MerkleProofStep[];
  rootHash: string;
}

interface MerkleNode {
  hash: string;
  start: number;
  end: number;
  left?: MerkleNode;
  right?: MerkleNode;
}

export interface MerkleTreeSnapshot {
  root: string;
  leafHashes: string[];
  /** Internal representation; do not serialize into API responses. */
  rootNode: MerkleNode | null;
}

function toBuffer(value: string | Buffer): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}

function sha256(...parts: Buffer[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

/** SHA256(0x00 || leaf). */
export function hashMerkleLeaf(leaf: string | Buffer): string {
  return sha256(Buffer.from([0x00]), toBuffer(leaf));
}

/** SHA256(0x01 || left || right), with both children as 32-byte hashes. */
export function hashMerkleNode(
  left: string | Buffer,
  right: string | Buffer,
): string {
  const leftBuffer = typeof left === 'string' ? Buffer.from(left, 'hex') : left;
  const rightBuffer = typeof right === 'string' ? Buffer.from(right, 'hex') : right;
  if (leftBuffer.length !== 32 || rightBuffer.length !== 32) {
    throw new TypeError('Merkle node children must be 32-byte hashes');
  }
  return sha256(Buffer.from([0x01]), leftBuffer, rightBuffer);
}

/** Deterministic JSON: object keys sorted recursively, no incidental whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Largest power of two strictly smaller than `n` (n must be > 1). */
function splitPoint(n: number): number {
  let power = 1;
  while (power * 2 < n) power *= 2;
  return power;
}

function buildNode(leafHashes: string[], start: number, end: number): MerkleNode {
  if (end - start === 1) {
    return { hash: leafHashes[start], start, end };
  }
  const middle = start + splitPoint(end - start);
  const left = buildNode(leafHashes, start, middle);
  const right = buildNode(leafHashes, middle, end);
  return { hash: hashMerkleNode(left.hash, right.hash), start, end, left, right };
}

/**
 * Builds a tree over raw leaf payloads. An empty tree has the RFC 6962 empty
 * root SHA256() and no proof-able leaves.
 */
export function buildMerkleTree(leaves: ReadonlyArray<string | Buffer>): MerkleTreeSnapshot {
  const leafHashes = leaves.map((leaf) => hashMerkleLeaf(leaf));
  if (leafHashes.length === 0) {
    return { root: sha256(Buffer.alloc(0)), leafHashes, rootNode: null };
  }
  const rootNode = buildNode(leafHashes, 0, leafHashes.length);
  return { root: rootNode.hash, leafHashes, rootNode };
}

/** Generates a verifiable inclusion proof for a leaf index. */
export function generateInclusionProof(tree: MerkleTreeSnapshot, leafIndex: number): InclusionProof {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= tree.leafHashes.length) {
    throw new RangeError(`Leaf index ${leafIndex} out of range for ${tree.leafHashes.length} leaves`);
  }

  const path: MerkleProofStep[] = [];
  let node = tree.rootNode;
  while (node && node.end - node.start > 1) {
    const left = node.left!;
    const right = node.right!;
    const inLeft = leafIndex >= left.start && leafIndex < left.end;
    path.push({
      siblingHash: inLeft ? right.hash : left.hash,
      direction: inLeft ? 'right' : 'left',
    });
    node = inLeft ? left : right;
  }

  // The walk above is top-down; verifiers fold the path from the leaf up.
  return {
    leafIndex,
    leafHash: tree.leafHashes[leafIndex],
    path: path.reverse(),
    rootHash: tree.root,
  };
}

/**
 * Recomputes the root from a leaf hash and sibling path. Returns false for
 * any structurally invalid proof — a malformed proof is not "verified".
 */
export function verifyInclusionProof(
  proof: Pick<InclusionProof, 'leafHash' | 'path' | 'rootHash'>,
): boolean {
  if (!HEX_64.test(proof?.rootHash ?? '') || !HEX_64.test(proof?.leafHash ?? '')) return false;
  if (!Array.isArray(proof.path)) return false;

  try {
    let current = proof.leafHash;
    for (const step of proof.path) {
      if (!HEX_64.test(step.siblingHash)) return false;
      if (step.direction !== 'left' && step.direction !== 'right') return false;
      current =
        step.direction === 'left'
          ? hashMerkleNode(step.siblingHash, current)
          : hashMerkleNode(current, step.siblingHash);
    }
    return current.toLowerCase() === proof.rootHash.toLowerCase();
  } catch {
    return false;
  }
}

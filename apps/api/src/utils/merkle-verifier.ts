/**
 * Re-exports this monorepo's shared Merkle primitives.
 *
 * The actual implementation (domain-separated SHA-256 leaf/node hashing,
 * tree construction, proof generation and proof verification) now lives in
 * `packages/shared/src/merkle.ts` so it has a single source of truth shared
 * with `packages/cli` (which uses it for the `verify-ledger` command's
 * verification certificates). This file is kept so existing imports from
 * `../utils/merkle-verifier` (e.g. `apps/api/src/lib/soroban.ts`) don't need
 * to change. See `packages/shared/src/merkle.ts` for full documentation,
 * including the Soroban bucket-list-proof scope note.
 */
export type {
  MerkleProofDirection,
  MerkleProofStep,
  MerkleProof,
  MerkleTree,
} from '@stellar-alerts/shared';
export {
  hashMerkleLeaf,
  hashMerkleNode,
  computeMerkleRoot,
  verifyMerkleProof,
  buildMerkleTree,
  generateMerkleProof,
} from '@stellar-alerts/shared';

import { z } from 'zod';

/**
 * Request schema for the pre-execution simulation engine.
 *
 * The shape mirrors the engine's input model (`services/simulation/types.ts`)
 * one-for-one, so a caller that already has an envelope description can post it
 * directly. Everything is optional except `sourceAccount` and `operations`:
 * the engine is explicitly designed to produce a *lower bound* score from
 * partial evidence rather than refusing to analyze, and reporting
 * `NO_SIMULATION_RESULT` as an indicator is more useful to a signer than a 400.
 *
 * Amounts are validated as decimal strings rather than numbers: JavaScript
 * numbers cannot represent 7-decimal Stellar amounts exactly, and silently
 * rounding a user's balance before comparing it pre/post would corrupt the drain
 * detection this engine exists to perform.
 */

export const SIMULATION_NETWORKS = ['PUBLIC', 'TESTNET', 'FUTURENET'] as const;
export type SimulationNetwork = (typeof SIMULATION_NETWORKS)[number];

export const ASSET_TYPES = ['native', 'credit_alphanumeric', 'liquidity_pool'] as const;

export const OPERATION_KINDS = [
  'pay',
  'pathPaymentStrictReceive',
  'pathPaymentStrictSend',
  'accountMerge',
  'clawback',
  'changeTrust',
  'setTrustlineFlags',
  'createAccount',
  'createContract',
  'uploadWasm',
  'invokeContract',
  'extendFootprintTtl',
  'restoreFootprint',
  'bumpSequence',
  'setOptions',
  'manageSellOffer',
  'liquidityPoolWithdraw',
  'unknown',
] as const;

/** Max Stellar amount precision. Amounts with more decimals are rejected. */
const STELLAR_AMOUNT_PATTERN = /^\d+(?:\.\d{1,7})?$/;

const amountSchema = z
  .string()
  .regex(STELLAR_AMOUNT_PATTERN, 'Amount must be a non-negative decimal with at most 7 decimal places');

const accountIdSchema = z
  .string()
  .min(1)
  .max(64)
  // G… public keys (accounts) and C… contract ids, both Base32, 56 chars.
  // Validated structurally here rather than with StrKey because the envelope may
  // legitimately be under construction; the checksum guard lives at the wallet
  // registration boundary, and a wrong key simply yields no balance data.
  .regex(/^[A-Z0-9]{56}$/, 'Must be a 56-character Base32 Stellar account or contract id');

const assetSchema = z
  .object({
    type: z.enum(ASSET_TYPES),
    code: z.string().min(1).max(12).optional(),
    issuer: z.string().min(1).max(56).optional(),
    poolId: z.string().min(1).max(120).optional(),
  })
  .refine(
    (asset) => asset.type !== 'credit_alphanumeric' || Boolean(asset.code && asset.issuer),
    { message: 'credit_alphanumeric assets require both code and issuer', path: ['code'] },
  );

const footprintKeySchema = z.object({
  key: z.string().min(1).max(512),
  entryType: z.string().min(1).max(64),
  contractId: z.string().min(1).max(56).optional(),
  access: z.enum(['readOnly', 'readWrite', 'archived']),
});

const footprintSchema = z.object({
  readOnly: z.array(footprintKeySchema).max(4096).optional(),
  readWrite: z.array(footprintKeySchema).max(4096).optional(),
  archived: z.array(footprintKeySchema).max(4096).optional(),
});

const balanceSchema = z.object({
  asset: assetSchema,
  balance: amountSchema,
  limit: amountSchema.optional(),
  revocable: z.boolean().optional(),
});

const accountStateSchema = z.object({
  accountId: accountIdSchema,
  nativeBalance: amountSchema.optional(),
  balances: z.array(balanceSchema).max(256).optional(),
});

const operationSchema = z.object({
  kind: z.enum(OPERATION_KINDS),
  source: accountIdSchema.optional(),
  destination: accountIdSchema.optional(),
  asset: assetSchema.optional(),
  amount: amountSchema.optional(),
  contractId: accountIdSchema.optional(),
  function: z.string().min(1).max(128).optional(),
  args: z.array(z.unknown()).max(64).optional(),
  trustlineAsset: assetSchema.optional(),
  trustlineFlagMask: z.number().int().min(0).max(0xffffffff).optional(),
});

const resourcesSchema = z.object({
  footprint: footprintSchema.optional(),
  requiredFootprint: footprintSchema.optional(),
  // `.nullable()` is meaningful here: it is how a caller states "the envelope
  // declares NO ledger bounds", which is a distinct (and reportable) condition
  // from "the caller didn't tell us".
  ledgerBounds: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }).nullable().optional(),
  auth: z
    .array(
      z.object({
        credentialsAddress: z.string().min(1).max(56).optional(),
        contractId: z.string().min(1).max(56).optional(),
        function: z.string().min(1).max(128).optional(),
      }),
    )
    .max(128)
    .optional(),
  hasTimeBounds: z.boolean().optional(),
  feeStroops: amountSchema.optional(),
  operationCount: z.number().int().min(0).max(1000).optional(),
});

const simulatedErrorSchema = z.object({
  type: z.enum(['custom_error', 'panic', 'host_error', 'invocation_error']),
  code: z.number().int().optional(),
  message: z.string().max(512),
  contractId: z.string().min(1).max(56).optional(),
  function: z.string().min(1).max(128).optional(),
});

const outcomeSchema = z.object({
  ledger: z.number().int().min(0).optional(),
  success: z.boolean().optional(),
  errors: z.array(simulatedErrorSchema).max(64).optional(),
  resultingBalances: z.array(accountStateSchema).max(256).optional(),
  events: z
    .array(
      z.object({
        contractId: z.string().min(1).max(56).optional(),
        type: z.string().max(128).optional(),
        value: z.unknown().optional(),
      }),
    )
    .max(256)
    .optional(),
  feeStroops: amountSchema.optional(),
});

const contractStateSchema = z.object({
  contractId: accountIdSchema,
  wasmHash: z.string().max(128).optional(),
  deployed: z.boolean().optional(),
  codeArchived: z.boolean().optional(),
});

const trustRegistrySchema = z.object({
  // `Record` rather than a list of { contractId, … } so a caller can post the
  // same shape they hold as a lookup map.
  byContractId: z
    .record(
      z.string(),
      z.object({
        contractId: z.string().min(1).max(56),
        verified: z.boolean().optional(),
        wasmHash: z.string().max(128).optional(),
        deployer: z.string().max(56).optional(),
        verifiedAt: z.string().max(64).optional(),
      }),
    )
    .optional(),
  allowlist: z.array(z.string().min(1).max(56)).max(1000).optional(),
  trustedDeployers: z.array(z.string().min(1).max(56)).max(1000).optional(),
});

export const analyzeSimulationSchema = z.object({
  sourceAccount: accountIdSchema,
  network: z.enum(SIMULATION_NETWORKS).optional(),
  label: z.string().min(1).max(200).optional(),
  envelopeXdr: z.string().min(1).max(256 * 1024).optional(),
  operations: z.array(operationSchema).max(1000),
  resources: resourcesSchema.optional(),
  preState: z.array(accountStateSchema).max(256).default([]),
  postState: z.array(accountStateSchema).max(256).optional(),
  outcome: outcomeSchema.optional(),
  contracts: z.array(contractStateSchema).max(256).optional(),
  trustRegistry: trustRegistrySchema.optional(),
});

export type AnalyzeSimulationInput = z.infer<typeof analyzeSimulationSchema>;

export const simulationIdSchema = z.object({
  id: z.string().min(1).max(64),
});

export const listSimulationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  // Optional filter so an operator can scope to the concerning results.
  band: z.enum(['SAFE', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL']).optional(),
  sourceAccount: z.string().min(1).max(56).optional(),
});
export type ListSimulationsQuery = z.infer<typeof listSimulationsQuerySchema>;

import { z } from 'zod';

export const flashLoanAlertSchema = z.object({
  id: z.string().optional(),
  type: z.literal('FLASH_LOAN_DETECTED'),
  priority: z.literal('HIGH'),
  txHash: z.string(),
  ledgerSeq: z.number().int().nonnegative(),
  protocolContractId: z.string(),
  borrowedAsset: z.string(),
  borrowedAmount: z.string(),
  repaidAmount: z.string(),
  feeAmount: z.string(),
  netArbitrageProfit: z.string(),
  targetArbitrageContracts: z.array(z.string()).default([]),
  timestamp: z.string(),
  durationMs: z.number().optional(),
});

export type FlashLoanAlert = z.infer<typeof flashLoanAlertSchema>;

export const alertNotificationSchema = z.object({
  alertType: z.string(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  txHash: z.string().optional(),
  contractId: z.string().optional(),
  message: z.string(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string(),
});

export type AlertNotification = z.infer<typeof alertNotificationSchema>;

/**
 * Soroban network protocol resource limits (#972).
 */
export const sorobanResourceLimitsSchema = z.object({
  cpuInstructions: z.number().nonnegative(),
  ramBytes: z.number().nonnegative(),
  readLedgerEntries: z.number().nonnegative(),
  writeLedgerEntries: z.number().nonnegative(),
  readLedgerBytes: z.number().nonnegative(),
  writeLedgerBytes: z.number().nonnegative(),
});
export type SorobanResourceLimits = z.infer<typeof sorobanResourceLimitsSchema>;

/**
 * Single resource saturation dimension metrics (#972).
 */
export const resourceDimensionSaturationSchema = z.object({
  used: z.number().nonnegative(),
  limit: z.number().positive(),
  saturationPercent: z.number().nonnegative(),
  isExceeded: z.boolean(),
});
export type ResourceDimensionSaturation = z.infer<typeof resourceDimensionSaturationSchema>;

/**
 * Per-invocation Soroban host function resource consumption metrics (#972).
 */
export interface SorobanInvocationMetrics {
  invocationId?: string;
  contractId: string;
  functionName: string;
  cpuInstructions: number;
  ramBytes: number;
  readLedgerEntries?: number;
  writeLedgerEntries?: number;
  readLedgerBytes?: number;
  writeLedgerBytes?: number;
  subInvocations?: SorobanInvocationMetrics[];
}

export const sorobanInvocationMetricsSchema: z.ZodType<SorobanInvocationMetrics> = z.lazy(() =>
  z.object({
    invocationId: z.string().optional(),
    contractId: z.string(),
    functionName: z.string(),
    cpuInstructions: z.number().nonnegative(),
    ramBytes: z.number().nonnegative(),
    readLedgerEntries: z.number().nonnegative().optional(),
    writeLedgerEntries: z.number().nonnegative().optional(),
    readLedgerBytes: z.number().nonnegative().optional(),
    writeLedgerBytes: z.number().nonnegative().optional(),
    subInvocations: z.array(sorobanInvocationMetricsSchema).optional(),
  }),
);

/**
 * Soroban Host Function Resource Saturation Alert event payload (#972).
 */
export const sorobanSaturationAlertSchema = z.object({
  id: z.string().optional(),
  type: z.literal('SOROBAN_RESOURCE_SATURATION'),
  severity: z.enum(['HEALTHY', 'WARNING', 'CRITICAL']),
  txHash: z.string().optional(),
  ledgerSeq: z.number().int().nonnegative().optional(),
  contractId: z.string(),
  functionName: z.string().optional(),
  threshold: z.number(),
  overallSaturationPercent: z.number(),
  saturatedDimensions: z.array(z.string()),
  dimensions: z.object({
    cpu: resourceDimensionSaturationSchema,
    ram: resourceDimensionSaturationSchema,
    readEntries: resourceDimensionSaturationSchema,
    writeEntries: resourceDimensionSaturationSchema,
    readBytes: resourceDimensionSaturationSchema,
    writeBytes: resourceDimensionSaturationSchema,
  }),
  telemetry: z.object({
    recommendations: z.array(z.string()),
    traceDepth: z.number(),
    totalInvocations: z.number(),
  }),
  timestamp: z.string(),
});
export type SorobanSaturationAlert = z.infer<typeof sorobanSaturationAlertSchema>;

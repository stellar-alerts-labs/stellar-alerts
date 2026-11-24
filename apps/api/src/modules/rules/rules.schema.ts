import { z } from 'zod';

export const backtestRuleSchema = z.object({
  ruleId: z.string().optional().describe('Optional ID of an existing persisted AlertRule to backtest'),
  rule: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      walletId: z.string().nullable().optional(),
      assets: z.array(z.string()).optional(),
      minAmount: z.union([z.number(), z.string()]).nullable().optional(),
      maxAmount: z.union([z.number(), z.string()]).nullable().optional(),
      memo: z.string().nullable().optional(),
      channels: z.array(z.string()).optional(),
      conditions: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional()
    .describe('Draft alert rule configuration to evaluate in sandbox'),
  startLedger: z.number().int().positive().optional().describe('Starting Stellar ledger sequence (inclusive)'),
  endLedger: z.number().int().positive().optional().describe('Ending Stellar ledger sequence (inclusive)'),
  startDate: z.string().optional().describe('ISO-8601 start date for historical time-travel range'),
  endDate: z.string().optional().describe('ISO-8601 end date for historical time-travel range'),
  walletId: z.string().optional().describe('Optional wallet ID filter override'),
  baselineRuleId: z.string().optional().describe('Optional persisted rule ID to use as precision/noise baseline'),
  baselineRule: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      walletId: z.string().nullable().optional(),
      assets: z.array(z.string()).optional(),
      minAmount: z.union([z.number(), z.string()]).nullable().optional(),
      maxAmount: z.union([z.number(), z.string()]).nullable().optional(),
      memo: z.string().nullable().optional(),
      channels: z.array(z.string()).optional(),
      conditions: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional()
    .describe('Baseline rule to compare false positives and trigger deltas against'),
  maxEventsLimit: z.number().int().positive().max(100000).optional().default(25000),
  maxLedgersLimit: z.number().int().positive().max(200000).optional().default(50000),
  sampleSizeLimit: z.number().int().positive().max(200).optional().default(50),
  seededEvents: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('In-memory historical ledger events fixture for deterministic simulation'),
});

export type BacktestRuleSchemaInput = z.infer<typeof backtestRuleSchema>;

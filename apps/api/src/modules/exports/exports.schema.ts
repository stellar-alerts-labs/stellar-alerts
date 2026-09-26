import { z } from 'zod';

export const EXPORT_TYPES = ['ledger_csv', 'ledger_pdf', 'tax_csv'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export const EXPORT_STATUSES = ['queued', 'running', 'completed', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

// ISO date (`2026-01-31`) or date-time with offset (`2026-01-31T00:00:00Z`).
const isoDateOrDateTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const createExportSchema = z
  .object({
    type: z.enum(EXPORT_TYPES),
    walletId: z.string().min(1).max(64).optional(),
    periodStart: isoDateOrDateTime.optional(),
    periodEnd: isoDateOrDateTime.optional(),
    // Only used by `tax_csv`.
    format: z.enum(['cointracker', 'koinly', 'irs8949']).optional(),
  })
  .refine(
    (input) =>
      !input.periodStart ||
      !input.periodEnd ||
      new Date(input.periodStart).getTime() <= new Date(input.periodEnd).getTime(),
    { message: 'periodStart must be on or before periodEnd', path: ['periodStart'] },
  );
export type CreateExportInput = z.infer<typeof createExportSchema>;

export const exportIdSchema = z.object({
  id: z.string().min(1).max(64),
});

export const listExportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListExportsQuery = z.infer<typeof listExportsQuerySchema>;

export const downloadExportQuerySchema = z.object({
  expires: z.coerce.number().int().positive(),
  sig: z.string().min(1).max(128),
});

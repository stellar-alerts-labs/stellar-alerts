import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { createLogger } from '../../lib/logger';
import { enqueueExportJob } from '../../lib/export-queue';
import {
  deleteExportFile,
  exportFileExists,
  resolveExportFilePath,
  sweepStaleTempFiles,
  writeExportFile,
} from '../../lib/export-storage';
import { generateLedgerStatementCsv } from '../../utils/csv-generator';
import { generateLedgerStatementPdf, LedgerStatementPayment } from '../../utils/pdf-generator';
import { generateTaxExportCsv, TaxExportFormat } from '../../utils/tax-exporter';
import { signDownload, verifyDownloadSignature } from '../../utils/download-signer';
import type { CreateExportInput, ExportStatus, ExportType, ListExportsQuery } from './exports.schema';

const log = createLogger({ module: 'ExportsService' });

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ERROR_LENGTH = 500;
const CLEANUP_BATCH = 500;
const GENERIC_FAILURE = 'Export generation failed. Please try again.';

/** Stored in ExportJob.params. Dates are ISO strings, resolved at creation. */
export interface ExportJobParams {
  walletId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  format: TaxExportFormat | null;
}

/** An error whose message is safe to show to the job's owner. */
export class ExportError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code: string = 'EXPORT_ERROR',
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface ResolvedDownload {
  filePath: string;
  fileSize: number | null;
  contentType: string;
  downloadName: string;
}

export interface CleanupReport {
  expired: number;
  filesDeleted: number;
  staleFailed: number;
  tempFilesRemoved: number;
}

function toDate(value: string, endOfDay: boolean): Date {
  if (DATE_ONLY.test(value)) {
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  return new Date(value);
}

/**
 * Resolves request input into the params the worker will use. Ledger
 * statements default to the trailing 365 days (matching the synchronous PDF
 * export); tax exports default to the full history.
 */
export function resolveExportParams(input: CreateExportInput, now: Date = new Date()): ExportJobParams {
  let periodEnd = input.periodEnd ? toDate(input.periodEnd, true) : null;
  let periodStart = input.periodStart ? toDate(input.periodStart, false) : null;

  if (input.type !== 'tax_csv') {
    periodEnd = periodEnd ?? now;
    periodStart = periodStart ?? new Date(periodEnd.getTime() - 365 * DAY_MS);
  }

  return {
    walletId: input.walletId ?? null,
    periodStart: periodStart ? periodStart.toISOString() : null,
    periodEnd: periodEnd ? periodEnd.toISOString() : null,
    format: input.type === 'tax_csv' ? (input.format ?? 'cointracker') : null,
  };
}

function buildPaymentWhere(userId: string, params: ExportJobParams) {
  const where: any = params.walletId
    ? { walletId: params.walletId, wallet: { userId } }
    : { wallet: { userId } };
  if (params.periodStart || params.periodEnd) {
    where.receivedAt = {
      ...(params.periodStart ? { gte: new Date(params.periodStart) } : {}),
      ...(params.periodEnd ? { lte: new Date(params.periodEnd) } : {}),
    };
  }
  return where;
}

function truncateError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}

export class ExportsService {
  async createExport(userId: string, input: CreateExportInput) {
    const params = resolveExportParams(input);

    if (params.walletId) {
      const wallet = await prisma.wallet.findFirst({
        where: { id: params.walletId, userId },
        select: { id: true },
      });
      if (!wallet) {
        throw new ExportError('Wallet not found', 404, 'WALLET_NOT_FOUND');
      }
    }

    const active = await prisma.exportJob.count({
      where: { userId, status: { in: ['queued', 'running'] } },
    });
    if (active >= env.EXPORT_MAX_ACTIVE_JOBS_PER_USER) {
      throw new ExportError(
        `You already have ${active} export(s) in progress. Wait for one to finish before starting another.`,
        429,
        'TOO_MANY_ACTIVE_EXPORTS',
      );
    }

    const job = await prisma.exportJob.create({
      data: { userId, type: input.type, params: params as any, status: 'queued' },
    });

    const dispatch = await enqueueExportJob(job.id, (id) => this.processExportJob(id));
    log.info({ exportJobId: job.id, type: job.type, dispatch }, 'Export job created');

    return this.serialize(job);
  }

  async getExport(id: string, userId: string) {
    const job = await prisma.exportJob.findFirst({ where: { id, userId } });
    if (!job) {
      throw new ExportError('Export not found', 404, 'EXPORT_NOT_FOUND');
    }
    return this.serialize(job);
  }

  async listExports(userId: string, query: ListExportsQuery) {
    const where = { userId };
    const [jobs, total] = await Promise.all([
      prisma.exportJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.exportJob.count({ where }),
    ]);
    return {
      exports: jobs.map((job) => this.serialize(job)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /**
   * Shapes a job for API responses. A completed, unexpired job carries a
   * freshly signed download URL that lives for EXPORT_DOWNLOAD_URL_TTL_SECONDS
   * (never past the file's own expiry).
   */
  serialize(job: any, now: number = Date.now()) {
    let download: { url: string; expiresAt: string } | null = null;
    const fileExpiresAt = job.expiresAt ? new Date(job.expiresAt).getTime() : null;

    if (job.status === 'completed' && job.fileName && fileExpiresAt && fileExpiresAt > now) {
      const ttlSeconds = Math.max(
        1,
        Math.min(env.EXPORT_DOWNLOAD_URL_TTL_SECONDS, Math.floor((fileExpiresAt - now) / 1000)),
      );
      const signed = signDownload(env.JWT_SECRET, job.id, job.userId, ttlSeconds, now);
      download = {
        url: `/exports/${encodeURIComponent(job.id)}/download?expires=${signed.expires}&sig=${signed.sig}`,
        expiresAt: signed.expiresAt.toISOString(),
      };
    }

    return {
      id: job.id,
      type: job.type as ExportType,
      status: job.status as ExportStatus,
      progress: job.progress,
      rowsTotal: job.rowsTotal,
      rowsProcessed: job.rowsProcessed,
      params: job.params,
      error: job.error,
      contentType: job.contentType,
      fileSize: job.fileSize,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
      download,
    };
  }

  /**
   * Validates a signed download link and returns the file to stream.
   * Unknown jobs and bad signatures produce the same 403 so job ids cannot be
   * probed without a valid link.
   */
  async resolveDownload(id: string, expires: number, sig: string, now: number = Date.now()): Promise<ResolvedDownload> {
    const job = await prisma.exportJob.findUnique({ where: { id } });
    const verification = job
      ? verifyDownloadSignature(env.JWT_SECRET, job.id, job.userId, expires, sig, now)
      : 'invalid';

    if (!job || verification === 'invalid') {
      throw new ExportError('Invalid download link', 403, 'INVALID_DOWNLOAD_LINK');
    }
    if (verification === 'expired') {
      throw new ExportError('Download link has expired. Request a new one from the export status endpoint.', 403, 'DOWNLOAD_LINK_EXPIRED');
    }

    const fileExpired = job.expiresAt ? job.expiresAt.getTime() <= now : false;
    if (job.status === 'expired' || (job.status === 'completed' && fileExpired)) {
      throw new ExportError('This export has expired and its file was removed.', 410, 'EXPORT_EXPIRED');
    }
    if (job.status !== 'completed' || !job.fileName) {
      throw new ExportError(`Export is not ready (status: ${job.status}).`, 409, 'EXPORT_NOT_READY');
    }
    if (!(await exportFileExists(job.fileName))) {
      throw new ExportError('This export has expired and its file was removed.', 410, 'EXPORT_EXPIRED');
    }

    return {
      filePath: resolveExportFilePath(job.fileName),
      fileSize: job.fileSize,
      contentType: job.contentType ?? 'application/octet-stream',
      downloadName: job.downloadName ?? job.fileName,
    };
  }

  /**
   * Generates the file for one export job. Only a `queued` row can be
   * claimed, so concurrent or duplicate deliveries are no-ops. Progress is
   * written after every batch: 0–90% while reading payments, 100% once the
   * file is stored. Never throws; failures are recorded on the row.
   */
  async processExportJob(jobId: string): Promise<{ status: 'completed' | 'failed' | 'skipped' }> {
    const claimed = await prisma.exportJob.updateMany({
      where: { id: jobId, status: 'queued' },
      data: { status: 'running', startedAt: new Date(), progress: 0, rowsProcessed: 0 },
    });
    if (claimed.count === 0) {
      return { status: 'skipped' };
    }

    let fileName: string | null = null;
    try {
      const job = await prisma.exportJob.findUnique({
        where: { id: jobId },
        include: { user: { select: { email: true } } },
      });
      if (!job) {
        return { status: 'skipped' };
      }

      const params = job.params as unknown as ExportJobParams;
      const where = buildPaymentWhere(job.userId, params);

      const rowsTotal = await prisma.payment.count({ where });
      if (rowsTotal > env.EXPORT_MAX_ROWS) {
        throw new ExportError(
          `This export matches ${rowsTotal} payments, above the ${env.EXPORT_MAX_ROWS} row limit. Narrow the date range or select a single wallet.`,
        );
      }
      await prisma.exportJob.update({ where: { id: jobId }, data: { rowsTotal } });

      const payments = await this.fetchPayments(jobId, where, rowsTotal);
      const rendered = await this.render(job.type as ExportType, params, payments, job.user?.email ?? '', job.userId);

      fileName = `${job.id}.${rendered.extension}`;
      const fileSize = await writeExportFile(fileName, rendered.data);
      const completedAt = new Date();

      await prisma.exportJob.update({
        where: { id: jobId },
        data: {
          status: 'completed',
          progress: 100,
          rowsTotal: payments.length,
          rowsProcessed: payments.length,
          fileName,
          downloadName: rendered.downloadName,
          contentType: rendered.contentType,
          fileSize,
          completedAt,
          expiresAt: new Date(completedAt.getTime() + env.EXPORT_TTL_SECONDS * 1000),
        },
      });
      log.info({ exportJobId: jobId, rows: payments.length, fileSize }, 'Export job completed');
      return { status: 'completed' };
    } catch (err: any) {
      const userMessage = err instanceof ExportError ? err.message : GENERIC_FAILURE;
      log.error({ exportJobId: jobId, err: err?.message }, 'Export job failed');

      if (fileName) {
        await deleteExportFile(fileName).catch(() => {});
      }
      await prisma.exportJob
        .update({
          where: { id: jobId },
          data: { status: 'failed', error: truncateError(userMessage), fileName: null, completedAt: new Date() },
        })
        .catch((updateErr: any) => {
          log.error({ exportJobId: jobId, err: updateErr?.message }, 'Could not record export failure');
        });
      return { status: 'failed' };
    }
  }

  private async fetchPayments(jobId: string, where: any, rowsTotal: number): Promise<LedgerStatementPayment[]> {
    const batchSize = env.EXPORT_BATCH_SIZE;
    const rows: LedgerStatementPayment[] = [];
    let cursor: string | null = null;

    // Keyset pagination on (receivedAt desc, id desc); capped at the row limit
    // in case payments arrive between the count and the reads.
    while (rows.length < env.EXPORT_MAX_ROWS) {
      const batch: Array<{ id: string; txHash: string; fromAddress: string; amount: any; asset: string; receivedAt: Date }> =
        await prisma.payment.findMany({
          where,
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          take: Math.min(batchSize, env.EXPORT_MAX_ROWS - rows.length),
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: { id: true, txHash: true, fromAddress: true, amount: true, asset: true, receivedAt: true },
        });

      for (const payment of batch) {
        rows.push({
          txHash: payment.txHash,
          fromAddress: payment.fromAddress,
          amount: payment.amount.toString(),
          asset: payment.asset,
          receivedAt: payment.receivedAt,
        });
      }

      if (batch.length > 0) {
        const progress = rowsTotal > 0 ? Math.min(90, Math.floor((rows.length / rowsTotal) * 90)) : 90;
        await prisma.exportJob.update({
          where: { id: jobId },
          data: { rowsProcessed: rows.length, progress },
        });
      }

      if (batch.length < batchSize) break;
      cursor = batch[batch.length - 1].id;
    }

    return rows;
  }

  private async render(
    type: ExportType,
    params: ExportJobParams,
    payments: LedgerStatementPayment[],
    userEmail: string,
    userId: string,
  ): Promise<{ data: Buffer | string; extension: 'csv' | 'pdf'; contentType: string; downloadName: string }> {
    const periodLabel = (params.periodStart ?? '').slice(0, 10);

    switch (type) {
      case 'ledger_csv':
        return {
          data: generateLedgerStatementCsv(payments),
          extension: 'csv',
          contentType: 'text/csv; charset=utf-8',
          downloadName: `ledger-statement-${periodLabel}.csv`,
        };
      case 'tax_csv': {
        const format = params.format ?? 'cointracker';
        return {
          data: generateTaxExportCsv(
            payments.map((payment) => ({
              date: payment.receivedAt,
              asset: payment.asset,
              quantity: payment.amount,
              usdValue: payment.amount,
              type: 'receive' as const,
              txHash: payment.txHash,
              fromAddress: payment.fromAddress,
            })),
            format,
          ),
          extension: 'csv',
          contentType: 'text/csv; charset=utf-8',
          downloadName: `tax-export-${format}.csv`,
        };
      }
      case 'ledger_pdf': {
        const walletMeta = params.walletId
          ? await prisma.wallet.findFirst({
              where: { id: params.walletId, userId },
              select: { publicKey: true, label: true },
            })
          : null;
        return {
          data: await generateLedgerStatementPdf({
            userEmail,
            walletLabel: walletMeta?.label ?? null,
            publicKey: walletMeta?.publicKey ?? 'All linked wallets',
            periodStart: new Date(params.periodStart!),
            periodEnd: new Date(params.periodEnd!),
            payments,
          }),
          extension: 'pdf',
          contentType: 'application/pdf',
          downloadName: `ledger-statement-${periodLabel}.pdf`,
        };
      }
      default:
        throw new ExportError(`Unsupported export type: ${type}`);
    }
  }

  /**
   * Periodic maintenance, run by the export worker:
   *  - deletes files of completed jobs past `expiresAt` and marks them `expired`;
   *  - fails jobs stuck in `queued`/`running` longer than EXPORT_STALE_JOB_MS
   *    (e.g. the process running them crashed);
   *  - removes `.tmp` leftovers from interrupted writes.
   */
  async cleanupExpiredExports(now: Date = new Date()): Promise<CleanupReport> {
    const report: CleanupReport = { expired: 0, filesDeleted: 0, staleFailed: 0, tempFilesRemoved: 0 };

    const expiredJobs = await prisma.exportJob.findMany({
      where: { status: 'completed', expiresAt: { lte: now } },
      select: { id: true, fileName: true },
      take: CLEANUP_BATCH,
    });

    for (const job of expiredJobs) {
      try {
        if (job.fileName && (await deleteExportFile(job.fileName))) {
          report.filesDeleted += 1;
        }
        const updated = await prisma.exportJob.updateMany({
          where: { id: job.id, status: 'completed' },
          data: { status: 'expired', fileName: null },
        });
        report.expired += updated.count;
      } catch (err: any) {
        log.error({ exportJobId: job.id, err: err?.message }, 'Could not expire export job');
      }
    }

    const stale = await prisma.exportJob.updateMany({
      where: {
        status: { in: ['queued', 'running'] },
        updatedAt: { lt: new Date(now.getTime() - env.EXPORT_STALE_JOB_MS) },
      },
      data: {
        status: 'failed',
        error: 'Export timed out before it finished. Please try again.',
        completedAt: now,
      },
    });
    report.staleFailed = stale.count;

    report.tempFilesRemoved = await sweepStaleTempFiles(env.EXPORT_STALE_JOB_MS, now.getTime());

    if (report.expired || report.staleFailed || report.tempFilesRemoved) {
      log.info(report, 'Export cleanup pass finished');
    }
    return report;
  }
}

export const exportsService = new ExportsService();

import { createReadStream } from 'fs';
import { FastifyRequest, FastifyReply } from 'fastify';
import {
  createExportSchema,
  downloadExportQuerySchema,
  exportIdSchema,
  listExportsQuerySchema,
} from './exports.schema';
import { ExportError, exportsService } from './exports.service';

function sendExportError(reply: FastifyReply, error: unknown) {
  if (error instanceof ExportError) {
    return reply.status(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export class ExportsController {
  async create(request: FastifyRequest, reply: FastifyReply) {
    const parsed = createExportSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parsed.error.format() });
    }

    try {
      const userId = (request as any).user.id;
      const job = await exportsService.createExport(userId, parsed.data);
      return reply
        .status(202)
        .header('Location', `/exports/${job.id}`)
        .send({ success: true, export: job });
    } catch (error) {
      return sendExportError(reply, error);
    }
  }

  async list(request: FastifyRequest, reply: FastifyReply) {
    const parsed = listExportsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.format() });
    }

    const userId = (request as any).user.id;
    const result = await exportsService.listExports(userId, parsed.data);
    return reply.send({ success: true, ...result });
  }

  async get(request: FastifyRequest, reply: FastifyReply) {
    const parsed = exportIdSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid parameters', details: parsed.error.format() });
    }

    try {
      const userId = (request as any).user.id;
      const job = await exportsService.getExport(parsed.data.id, userId);
      return reply.header('Cache-Control', 'no-store').send({ success: true, export: job });
    } catch (error) {
      return sendExportError(reply, error);
    }
  }

  /**
   * Unauthenticated on purpose: the signed `expires`/`sig` query pair is the
   * credential, so the link works from a plain browser navigation.
   */
  async download(request: FastifyRequest, reply: FastifyReply) {
    const params = exportIdSchema.safeParse(request.params);
    const query = downloadExportQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.status(403).send({ error: 'INVALID_DOWNLOAD_LINK', message: 'Invalid download link' });
    }

    try {
      const file = await exportsService.resolveDownload(params.data.id, query.data.expires, query.data.sig);
      const safeName = file.downloadName.replace(/[^A-Za-z0-9._-]/g, '_');
      reply
        .header('Content-Type', file.contentType)
        .header('Content-Disposition', `attachment; filename="${safeName}"`)
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff');
      if (file.fileSize !== null) {
        reply.header('Content-Length', String(file.fileSize));
      }
      return reply.send(createReadStream(file.filePath));
    } catch (error) {
      return sendExportError(reply, error);
    }
  }
}

export const exportsController = new ExportsController();

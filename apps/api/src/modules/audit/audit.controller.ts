import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFoundError, zodValidationError } from '../../lib/errors';
import { onChainNotaryService } from './onchain-notary.service';

const auditProofParamsSchema = z.object({
  id: z.string().min(1),
});

export class AuditController {
  /**
   * GET /audit/:id/proof — returns a verifiable RFC 6962 inclusion proof for
   * the audit log, the Merkle root and the Stellar transaction that anchored
   * it (null until the hourly anchor job has published the root).
   */
  async getProof(request: FastifyRequest, reply: FastifyReply) {
    const parsed = auditProofParamsSchema.safeParse(request.params);
    if (!parsed.success) throw zodValidationError(parsed, 'Invalid parameters');

    const proof = await onChainNotaryService.getProof(parsed.data.id);
    if (!proof) throw new NotFoundError('Audit log not found');

    return reply.header('Cache-Control', 'no-store').send({ success: true, proof });
  }
}

export const auditController = new AuditController();

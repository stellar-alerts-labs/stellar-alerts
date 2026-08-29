import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { paymentsService } from './payments.service';

const getPaymentsSchema = z.object({
  walletId: z.string(),
  limit: z.coerce.number().optional().default(20),
});

const getSummarySchema = z.object({
  walletId: z.string(),
  fiat: z.string().optional(),
});

export class PaymentsController {
  async getPayments(request: FastifyRequest, reply: FastifyReply) {
    const parsed = getPaymentsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.format() });
    }

    const payments = await paymentsService.getPayments(parsed.data.walletId, parsed.data.limit);
    return reply.send({ success: true, payments });
  }

  async getPaymentsSummary(request: FastifyRequest, reply: FastifyReply) {
    const parsed = getSummarySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.format() });
    }

    const summary = await paymentsService.getPaymentsSummary(parsed.data.walletId, parsed.data.fiat);
    return reply.send({ success: true, summary });
  }
}

export const paymentsController = new PaymentsController();

import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { paymentsService } from './payments.service';

const getPaymentsSchema = z.object({
  walletId: z.string(),
  limit: z.coerce.number().optional().default(20),
});

const getSummarySchema = z.object({
  walletId: z.string(),
});

const estimateFeeBodySchema = z.object({
  /** Base64-encoded XDR TransactionEnvelope of the Soroban transaction to simulate */
  xdrEnvelope: z.string().min(1, 'xdrEnvelope is required'),
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

    const summary = await paymentsService.getPaymentsSummary(parsed.data.walletId);
    return reply.send({ success: true, summary });
  }

  /**
   * POST /payments/estimate-fee
   *
   * Accepts a base64-encoded XDR TransactionEnvelope and returns a simulated
   * fee breakdown including:
   *  - inclusion fee (classic base fee in stroops)
   *  - resource fee (execution + state rent in stroops)
   *  - rent fee component in stroops
   *  - total fee in stroops and XLM
   *  - read/write ledger entry footprints
   *  - CPU instructions and memory bytes estimates
   */
  async estimateFee(request: FastifyRequest, reply: FastifyReply) {
    const parsed = estimateFeeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.format() });
    }

    const estimate = await paymentsService.estimateFee(parsed.data.xdrEnvelope);

    if (!estimate.success) {
      return reply.status(422).send({
        success: false,
        error: 'Simulation failed',
        details: estimate.error,
      });
    }

    return reply.send({ success: true, estimate });
  }
}

export const paymentsController = new PaymentsController();

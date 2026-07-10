import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paymentsService } from './payments.service';

const getPaymentsSchema = z.object({
  walletId: z.string(),
  limit: z.coerce.number().optional().default(20),
});

const getSummarySchema = z.object({
  walletId: z.string(),
});

export async function paymentsRoutes(app: FastifyInstance) {
  app.get('/payments', async (request, reply) => {
    const parsed = getPaymentsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.format() });
    }

    const payments = await paymentsService.getPayments(parsed.data.walletId, parsed.data.limit);
    return reply.send({ success: true, payments });
  });

  app.get('/payments/summary', async (request, reply) => {
    const parsed = getSummarySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.format() });
    }

    const summary = await paymentsService.getPaymentsSummary(parsed.data.walletId);
    return reply.send({ success: true, summary });
  });
  app.post('/payments/watch', async (request, reply) => {
    const addWatchSchema = z.object({
      address: z.string(),
    });
    
    const parsed = addWatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', details: parsed.error.format() });
    }

    const watch = await paymentsService.addWatch(parsed.data.address);
    return reply.send({ success: true, watch });
  });

  app.get('/payments/watches', async (request, reply) => {
    const watches = await paymentsService.getWatches();
    return reply.send({ success: true, watches });
  });
}

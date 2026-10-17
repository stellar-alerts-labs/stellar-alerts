import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { paymentsController } from './payments.controller';

export async function paymentsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  app.get('/payments', { schema: { tags: ['payments'], summary: 'List payments', description: 'Returns paginated incoming payment history for all of the user\'s watched wallets.' } }, paymentsController.getPayments.bind(paymentsController));
  app.get('/payments/summary', { schema: { tags: ['payments'], summary: 'Get payments summary', description: 'Returns aggregated statistics (total received, asset breakdown) for the user\'s wallets.' } }, paymentsController.getPaymentsSummary.bind(paymentsController));

  /**
   * POST /payments/estimate-fee
   * Simulate a Soroban transaction and return fee breakdown + ledger footprints.
   * Body: { xdrEnvelope: string }  (base64-encoded XDR TransactionEnvelope)
   */
  app.post('/payments/estimate-fee', { schema: { tags: ['payments'], summary: 'Estimate Soroban transaction fee', description: 'Simulates a Soroban transaction envelope and returns fee breakdown and ledger footprints.' } }, paymentsController.estimateFee.bind(paymentsController));
}

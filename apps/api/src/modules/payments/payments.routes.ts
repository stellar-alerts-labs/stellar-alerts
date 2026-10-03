import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { paymentsController } from './payments.controller';

export async function paymentsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  app.get('/payments', paymentsController.getPayments.bind(paymentsController));
  app.get('/payments/summary', paymentsController.getPaymentsSummary.bind(paymentsController));

  /**
   * POST /payments/estimate-fee
   * Simulate a Soroban transaction and return fee breakdown + ledger footprints.
   * Body: { xdrEnvelope: string }  (base64-encoded XDR TransactionEnvelope)
   */
  app.post('/payments/estimate-fee', paymentsController.estimateFee.bind(paymentsController));
}

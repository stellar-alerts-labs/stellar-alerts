import { prisma } from '../../lib/prisma';
import { simulateTransaction, SorobanFeeEstimate } from '../../lib/soroban';

export class PaymentsService {
  async getPayments(walletId: string, limit: number = 20) {
    console.log(`[PaymentsService] Fetching up to ${limit} payments for wallet ${walletId}`);
    return prisma.payment.findMany({
      where: { walletId },
      orderBy: { receivedAt: 'desc' },
      take: limit,
    });
  }

  async getPaymentsSummary(walletId: string) {
    console.log(`[PaymentsService] Fetching summary for wallet ${walletId}`);
    const result = await prisma.payment.aggregate({
      where: { walletId },
      _sum: { amount: true },
      _count: { id: true },
    });

    return {
      totalReceived: result._sum.amount || 0,
      paymentCount: result._count.id || 0,
    };
  }

  /**
   * Estimates Soroban transaction fees including storage rent and read/write
   * ledger footprints by delegating to the Soroban RPC `simulateTransaction`
   * method.
   *
   * @param xdrEnvelope - Base64-encoded XDR TransactionEnvelope to simulate.
   * @returns A {@link SorobanFeeEstimate} with full fee breakdown and footprint.
   */
  async estimateFee(xdrEnvelope: string): Promise<SorobanFeeEstimate> {
    console.log('[PaymentsService] Estimating Soroban transaction fee via RPC simulation');
    return simulateTransaction(xdrEnvelope);
  }
}

export const paymentsService = new PaymentsService();

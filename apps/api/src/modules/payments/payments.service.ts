import { prismaRead } from '../../lib/prisma';

export class PaymentsService {
  async getPayments(walletId: string, limit: number = 20) {
    console.log(`[PaymentsService] Fetching up to ${limit} payments for wallet ${walletId}`);
    return prismaRead.payment.findMany({
      where: { walletId },
      orderBy: { receivedAt: 'desc' },
      take: limit,
    });
  }

  async getPaymentsSummary(walletId: string) {
    console.log(`[PaymentsService] Fetching summary for wallet ${walletId}`);
    const result = await prismaRead.payment.aggregate({
      where: { walletId },
      _sum: { amount: true },
      _count: { id: true },
    });
    
    return {
      totalReceived: result._sum.amount || 0,
      paymentCount: result._count.id || 0,
    };
  }
}

export const paymentsService = new PaymentsService();

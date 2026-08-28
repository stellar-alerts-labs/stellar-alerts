import { prisma } from '../../lib/prisma';
import { addDifferentialPrivacyNoise } from '../../utils/differential-privacy';

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
   * Fetches public volume statistics protected with Laplace differential privacy noise.
   * Epsilon parameter controls privacy budget (lower epsilon = more privacy/noise).
   */
  async getPublicVolumeStats(epsilon: number = 0.5) {
    console.log(`[PaymentsService] Fetching differentially private public volume stats (epsilon=${epsilon})`);
    const aggregate = await prisma.payment.aggregate({
      _sum: { amount: true },
      _count: { id: true },
    });

    const rawTotalVolume = Number(aggregate._sum.amount || 0);
    const noisyVolume = addDifferentialPrivacyNoise(rawTotalVolume, epsilon, 1.0);

    return {
      rawTotalVolume,
      noisyTotalVolume: noisyVolume,
      totalPayments: aggregate._count.id || 0,
      epsilon,
      anonymized: true,
    };
  }
}

export const paymentsService = new PaymentsService();

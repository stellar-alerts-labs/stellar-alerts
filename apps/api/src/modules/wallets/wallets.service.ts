import { prisma } from '../../lib/prisma';

export class WalletsService {
  async addWallet(userId: string, publicKey: string, label?: string) {
    console.log(`[WalletsService] Adding wallet ${publicKey} for user ${userId}`);
    const wallet = await prisma.wallet.create({
      data: {
        userId,
        publicKey,
        label,
      },
    });
    return wallet;
  }

  async removeWallet(id: string) {
    console.log(`[WalletsService] Removing wallet ${id}`);
    try {
      await prisma.wallet.delete({
        where: { id },
      });
      return { success: true };
    } catch (error: any) {
      if (error.code === 'P2025') {
        throw new Error('Wallet not found');
      }
      throw error;
    }
  }
}

export const walletsService = new WalletsService();

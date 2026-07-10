export class WalletsService {
  async addWallet(userId: string, publicKey: string, label?: string) {
    // TODO: Actually insert into DB using Prisma
    console.log(`[WalletsService] Added wallet ${publicKey} for user ${userId}`);
    return { id: 'fake-wallet-id', userId, publicKey, label };
  }

  async removeWallet(id: string) {
    // TODO: Actually remove from DB
    console.log(`[WalletsService] Removed wallet ${id}`);
    return { success: true };
  }
}

export const walletsService = new WalletsService();

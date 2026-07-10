export class NotificationsService {
  async getPreferences(userId: string) {
    // TODO: Fetch user notification preferences from DB using Prisma
    console.log(`[NotificationsService] Fetching preferences for user ${userId}`);
    return {
      telegramEnabled: false,
      telegramChatId: null,
      emailEnabled: true,
      whatsappEnabled: false,
      whatsappNumber: null,
    };
  }

  async updatePreferences(userId: string, prefs: any) {
    // TODO: Update preferences in DB using Prisma
    console.log(`[NotificationsService] Updating preferences for user ${userId}`, prefs);
    return { success: true, prefs };
  }
}

export const notificationsService = new NotificationsService();

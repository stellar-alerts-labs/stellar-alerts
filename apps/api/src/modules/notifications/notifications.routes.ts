/**
 * Notifications Routes
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { notificationsController } from './notifications.controller';
import { telegramMiniAppController } from './telegram-miniapp.controller';
import { authenticateHook } from '../../middleware/auth.middleware';
import { whatsappInteractiveController } from './whatsapp-interactive.controller';

export async function notificationsRoutes(app: FastifyInstance) {
  // Meta signs the exact request bytes. Capture those bytes in this encapsulated
  // route plugin before JSON parsing so the webhook can verify X-Hub-Signature-256.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body as Buffer;
    (request as FastifyRequest & { rawBody?: Buffer }).rawBody = raw;
    try { done(null, JSON.parse(raw.toString('utf8'))); }
    catch {
      const error = new Error("Body is not valid JSON but content-type is set to 'application/json'") as Error & { statusCode: number; code: string };
      error.statusCode = 400;
      error.code = 'FST_ERR_CTP_INVALID_JSON_BODY';
      done(error, undefined);
    }
  });

  app.get('/notifications/whatsapp/webhook', whatsappInteractiveController.verify.bind(whatsappInteractiveController));
  app.post('/notifications/whatsapp/webhook', whatsappInteractiveController.receive.bind(whatsappInteractiveController));

  // Notification Preferences (MFA protected update)
  app.post(
    '/notifications/preferences',
    { preHandler: [authenticateHook] },
    notificationsController.updatePreferences.bind(notificationsController)
  );

  app.get(
    '/notifications/preferences',
    { preHandler: [authenticateHook] },
    notificationsController.getPreferences.bind(notificationsController)
  );

  // Freelancer Channel Preferences setup flow (#259)
  app.post(
    '/freelancer/preferences',
    { preHandler: [authenticateHook] },
    notificationsController.updateFreelancerPreferences.bind(notificationsController)
  );

  app.get(
    '/freelancer/preferences',
    { preHandler: [authenticateHook] },
    notificationsController.getFreelancerPreferences.bind(notificationsController)
  );

  // Telegram Account Linking with expiring one-time sync codes (#260)
  app.post(
    '/notifications/telegram/sync-code',
    { preHandler: [authenticateHook] },
    notificationsController.generateTelegramSyncCode.bind(notificationsController)
  );

  app.post(
    '/notifications/telegram/confirm-sync',
    notificationsController.confirmTelegramSync.bind(notificationsController)
  );

  app.get(
    '/notifications/telegram/sync-status/:code',
    notificationsController.getTelegramSyncStatus.bind(notificationsController)
  );

  app.post(
    '/notifications/telegram/unlink',
    { preHandler: [authenticateHook] },
    notificationsController.unlinkTelegram.bind(notificationsController)
  );

  // Test Ping (supports telegram and push protocol)
  app.post(
    '/notifications/test-ping',
    { preHandler: [authenticateHook] },
    notificationsController.sendTestPing.bind(notificationsController)
  );

  // Telegram Mini App — real-time alert triage & filter tuning (#1006).
  // These endpoints authenticate per-request via the signed `initData` passed
  // in the `X-Telegram-Init-Data` header, so they intentionally do NOT use the
  // bearer-token authenticateHook.
  app.get(
    '/notifications/telegram/miniapp/state',
    telegramMiniAppController.getState.bind(telegramMiniAppController)
  );

  app.get(
    '/notifications/telegram/miniapp/feed',
    telegramMiniAppController.getFeed.bind(telegramMiniAppController)
  );

  app.post(
    '/notifications/telegram/miniapp/routes',
    telegramMiniAppController.toggleRoute.bind(telegramMiniAppController)
  );

  app.post(
    '/notifications/telegram/miniapp/thresholds',
    telegramMiniAppController.setThreshold.bind(telegramMiniAppController)
  );
}

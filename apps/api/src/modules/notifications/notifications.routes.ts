import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notificationsService } from './notifications.service';

const getPrefsSchema = z.object({
  userId: z.string(),
});

const updatePrefsSchema = z.object({
  userId: z.string(),
  telegramEnabled: z.boolean().optional(),
  telegramChatId: z.string().nullable().optional(),
  emailEnabled: z.boolean().optional(),
  whatsappEnabled: z.boolean().optional(),
  whatsappNumber: z.string().nullable().optional(),
});

export async function notificationsRoutes(app: FastifyInstance) {
  app.get('/notifications/preferences', async (request, reply) => {
    const parsed = getPrefsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.format() });
    }

    const prefs = await notificationsService.getPreferences(parsed.data.userId);
    return reply.send({ success: true, preferences: prefs });
  });

  app.put('/notifications/preferences', async (request, reply) => {
    const parsed = updatePrefsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid payload', details: parsed.error.format() });
    }

    const { userId, ...updates } = parsed.data;
    const result = await notificationsService.updatePreferences(userId, updates);
    return reply.send(result);
  });
}

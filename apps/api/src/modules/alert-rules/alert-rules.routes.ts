import { FastifyInstance } from 'fastify';
import { alertRulesController } from './alert-rules.controller';
import { authenticateHook } from '../../middleware/auth.middleware';

export async function alertRulesRoutes(app: FastifyInstance) {
  app.post(
    '/alert-rules',
    { preHandler: [authenticateHook] },
    alertRulesController.createRule.bind(alertRulesController)
  );

  app.get(
    '/alert-rules',
    { preHandler: [authenticateHook] },
    alertRulesController.getRules.bind(alertRulesController)
  );

  app.get(
    '/alert-rules/:id',
    { preHandler: [authenticateHook] },
    alertRulesController.getRule.bind(alertRulesController)
  );

  app.put(
    '/alert-rules/:id',
    { preHandler: [authenticateHook] },
    alertRulesController.updateRule.bind(alertRulesController)
  );

  app.delete(
    '/alert-rules/:id',
    { preHandler: [authenticateHook] },
    alertRulesController.deleteRule.bind(alertRulesController)
  );

  app.post(
    '/alert-rules/:id/toggle',
    { preHandler: [authenticateHook] },
    alertRulesController.toggleRuleActive.bind(alertRulesController)
  );

  app.post(
    '/alert-rules/migrate-legacy',
    { preHandler: [authenticateHook] },
    alertRulesController.migrateLegacy.bind(alertRulesController)
  );
}

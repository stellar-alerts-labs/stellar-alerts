import { FastifyRequest, FastifyReply } from 'fastify';
import { alertRuleRepository } from '../../repositories/alert-rule.repository';
import { AuthenticationError, NotFoundError, ValidationError } from '../../lib/errors';

export class AlertRulesController {
  async createRule(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const body = request.body as any;
    if (!body) {
      throw new ValidationError('Request body is required');
    }

    const rule = await alertRuleRepository.createRule({
      userId: request.user.id,
      walletId: body.walletId,
      name: body.name,
      assets: body.assets,
      minAmount: body.minAmount,
      maxAmount: body.maxAmount,
      memo: body.memo,
      channels: body.channels,
      conditions: body.conditions,
      isActive: body.isActive,
    });

    return reply.status(201).send({
      success: true,
      rule,
    });
  }

  async getRules(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const query = request.query as { isActive?: string; walletId?: string };
    const filter: { isActive?: boolean; walletId?: string } = {};
    if (query?.isActive !== undefined) {
      filter.isActive = query.isActive === 'true';
    }
    if (query?.walletId) {
      filter.walletId = query.walletId;
    }

    const rules = await alertRuleRepository.findRulesByUserId(request.user.id, filter);
    return reply.send({
      success: true,
      rules,
    });
  }

  async getRule(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const { id } = request.params as { id: string };
    const rule = await alertRuleRepository.findRuleById(id, request.user.id);

    if (!rule) {
      throw new NotFoundError('Alert rule not found');
    }

    return reply.send({
      success: true,
      rule,
    });
  }

  async updateRule(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const { id } = request.params as { id: string };
    const body = request.body as any;

    try {
      const updated = await alertRuleRepository.updateRule(id, request.user.id, body);
      return reply.send({
        success: true,
        rule: updated,
      });
    } catch (err: any) {
      if (err.message.includes('not found')) {
        throw new NotFoundError(err.message);
      }
      if (err.message.includes('Concurrency conflict')) {
        throw new ValidationError(err.message, undefined, 'CONCURRENCY_CONFLICT');
      }
      throw err;
    }
  }

  async deleteRule(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const { id } = request.params as { id: string };
    try {
      await alertRuleRepository.deleteRule(id, request.user.id);
      return reply.send({
        success: true,
        message: 'Alert rule deleted successfully',
      });
    } catch (err: any) {
      if (err.message.includes('not found')) {
        throw new NotFoundError(err.message);
      }
      throw err;
    }
  }

  async toggleRuleActive(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const { id } = request.params as { id: string };
    const { isActive } = (request.body as { isActive: boolean }) || {};

    const updated = await alertRuleRepository.toggleRuleActive(id, request.user.id, Boolean(isActive));
    return reply.send({
      success: true,
      rule: updated,
    });
  }

  async migrateLegacy(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const rule = await alertRuleRepository.migrateLegacyFilterRulesToAlertRules(request.user.id);
    return reply.send({
      success: true,
      migrated: Boolean(rule),
      rule: rule ?? null,
    });
  }
}

export const alertRulesController = new AlertRulesController();

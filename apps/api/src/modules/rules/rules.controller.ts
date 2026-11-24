import { FastifyRequest, FastifyReply } from 'fastify';
import {
  backtestReplayEngine,
  type DraftAlertRule,
  type HistoricalLedgerEvent,
} from './backtest-engine';
import { type FilterRuleGroup } from '../../lib/rules-engine';
import { alertRuleRepository } from '../../repositories/alert-rule.repository';
import { rulesService, type ListRulePresetsQuery } from './rules.service';
import { AuthenticationError, NotFoundError, ValidationError } from '../../lib/errors';
import { backtestRuleSchema } from './rules.schema';
import type { AmmNetwork, AmmProtocol, AmmRulePreset } from './presets/amm-presets';

const PROTOCOLS: readonly AmmProtocol[] = ['soroswap', 'phoenix', 'aqua'];
const NETWORKS: readonly AmmNetwork[] = ['mainnet', 'testnet'];
const EVENT_KINDS: readonly AmmRulePreset['eventKind'][] = [
  'swap',
  'liquidityDeposit',
  'liquidityWithdrawal',
  'poolCreated',
];

export class RulesController {
  /**
   * Returns pre-configured AMM alert rule templates.
   */
  async getPresets(request: FastifyRequest, reply: FastifyReply) {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const filter: ListRulePresetsQuery = {};

    if (query.protocol !== undefined) {
      if (typeof query.protocol !== 'string' || !PROTOCOLS.includes(query.protocol as AmmProtocol)) {
        throw new ValidationError('Invalid protocol filter');
      }
      filter.protocol = query.protocol as AmmProtocol;
    }

    if (query.network !== undefined) {
      if (typeof query.network !== 'string' || !NETWORKS.includes(query.network as AmmNetwork)) {
        throw new ValidationError('Invalid network filter');
      }
      filter.network = query.network as AmmNetwork;
    }

    if (query.eventKind !== undefined) {
      if (typeof query.eventKind !== 'string' || !EVENT_KINDS.includes(query.eventKind as AmmRulePreset['eventKind'])) {
        throw new ValidationError('Invalid eventKind filter');
      }
      filter.eventKind = query.eventKind as AmmRulePreset['eventKind'];
    }

    return reply.send({
      success: true,
      presets: rulesService.listPresets(filter),
    });
  }

  /**
   * Replays historical ledger sequence ranges against a candidate alert rule in dry-run mode.
   * Guarantees zero side effects (never dispatches webhooks, notifications, or emails).
   */
  async backtest(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const parseResult = backtestRuleSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      throw new ValidationError('Invalid backtest request parameters', parseResult.error.format());
    }

    const body = parseResult.data;
    let rule: DraftAlertRule | undefined = body.rule as DraftAlertRule | undefined;

    // Load persisted rule if ruleId was specified
    if (body.ruleId) {
      const persisted = await alertRuleRepository.findRuleById(body.ruleId, request.user.id);
      if (!persisted) {
        throw new NotFoundError(`Alert rule with id "${body.ruleId}" not found`);
      }
      rule = {
        id: persisted.id,
        name: persisted.name ?? undefined,
        walletId: persisted.walletId,
        assets: persisted.assets,
        minAmount: persisted.minAmount,
        maxAmount: persisted.maxAmount,
        memo: persisted.memo,
        channels: persisted.channels,
        conditions: (persisted.conditions as unknown as FilterRuleGroup) ?? null,
      };
    }

    if (!rule) {
      throw new ValidationError('Either rule or ruleId must be specified for backtesting');
    }

    // Load baseline rule if baselineRuleId was specified
    let baselineRule: DraftAlertRule | undefined = body.baselineRule as DraftAlertRule | undefined;
    if (body.baselineRuleId) {
      const persistedBaseline = await alertRuleRepository.findRuleById(body.baselineRuleId, request.user.id);
      if (persistedBaseline) {
        baselineRule = {
          id: persistedBaseline.id,
          name: persistedBaseline.name ?? undefined,
          walletId: persistedBaseline.walletId,
          assets: persistedBaseline.assets,
          minAmount: persistedBaseline.minAmount,
          maxAmount: persistedBaseline.maxAmount,
          memo: persistedBaseline.memo,
          channels: persistedBaseline.channels,
          conditions: (persistedBaseline.conditions as unknown as FilterRuleGroup) ?? null,
        };
      }
    }

    const report = await backtestReplayEngine.runBacktest(rule, {
      startLedger: body.startLedger,
      endLedger: body.endLedger,
      startDate: body.startDate,
      endDate: body.endDate,
      walletId: body.walletId || rule.walletId,
      maxEventsLimit: body.maxEventsLimit,
      maxLedgersLimit: body.maxLedgersLimit,
      sampleSizeLimit: body.sampleSizeLimit,
      baselineRule,
      seededEvents: body.seededEvents as unknown as HistoricalLedgerEvent[] | undefined,
    });

    return reply.status(200).send({
      success: true,
      report,
    });
  }

  /**
   * POST /alert-rules/:id/backtest - Convenience route using a persisted rule as candidate.
   */
  async backtestWithRuleId(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }
    const { id } = request.params as { id: string };
    const body = ((request.body as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    body.ruleId = id;
    request.body = body;
    return this.backtest(request, reply);
  }
}

export const rulesController = new RulesController();

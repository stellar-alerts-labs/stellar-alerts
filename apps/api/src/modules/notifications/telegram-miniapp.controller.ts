/**
 * Telegram Mini App Controller (#1006)
 *
 * Endpoints backing the in-bot alert-triage Mini App. Each handler re-verifies
 * the Telegram `initData` (passed via the `X-Telegram-Init-Data` header) before
 * touching the user's notification routing.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import {
  telegramMiniAppService,
  isMiniAppRoute,
  MiniAppSession,
} from './telegram-miniapp.service';
import { TelegramInitDataError } from '../../utils/telegram';
import { AuthenticationError, ValidationError } from '../../lib/errors';

const INIT_DATA_HEADER = 'x-telegram-init-data';

function extractInitData(request: FastifyRequest): string {
  const headerValue = request.headers[INIT_DATA_HEADER];
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const bodyInitData = (request.body as any)?.initData;
  const initData = (raw || bodyInitData || '').toString().trim();

  if (!initData) {
    throw new ValidationError(
      'Missing Telegram initData. Launch this Mini App from inside Telegram.',
      undefined,
      'MISSING_INIT_DATA',
    );
  }
  if (!initData.includes('hash=')) {
    throw new ValidationError(
      'initData is missing the HMAC hash field required for WebApp validation.',
      undefined,
      'MISSING_HASH',
    );
  }
  return initData;
}

async function authenticate(request: FastifyRequest): Promise<MiniAppSession> {
  const initData = extractInitData(request);
  try {
    return await telegramMiniAppService.authenticate(initData);
  } catch (error: any) {
    if (error instanceof TelegramInitDataError) {
      if (error.code === 'INVALID_SIGNATURE' || error.code === 'EXPIRED') {
        throw new AuthenticationError(error.message, error.code);
      }
      throw new ValidationError(error.message, undefined, error.code);
    }
    throw error;
  }
}

export class TelegramMiniAppController {
  /** Bootstrap payload: routes + thresholds + live feed. */
  async getState(request: FastifyRequest, reply: FastifyReply) {
    const session = await authenticate(request);
    const feedLimit = (request.query as any)?.feedLimit;
    const state = await telegramMiniAppService.getState(session, feedLimit);
    return reply.send({ success: true, ...state });
  }

  /** Live alert feed only. */
  async getFeed(request: FastifyRequest, reply: FastifyReply) {
    const session = await authenticate(request);
    const feedLimit = (request.query as any)?.feedLimit;
    const feed = await telegramMiniAppService.getAlertFeed(session.userId, feedLimit);
    return reply.send({ success: true, feed });
  }

  /** Toggle a notification route on/off. */
  async toggleRoute(request: FastifyRequest, reply: FastifyReply) {
    const session = await authenticate(request);
    const body = (request.body as any) ?? {};
    const { route, enabled } = body;

    if (!isMiniAppRoute(route)) {
      throw new ValidationError('Unknown notification route.', undefined, 'INVALID_ROUTE');
    }
    if (typeof enabled !== 'boolean') {
      throw new ValidationError('`enabled` must be a boolean.', undefined, 'INVALID_ENABLED');
    }

    const result = await telegramMiniAppService.toggleRoute(session.userId, route, enabled);
    return reply.send({ success: true, ...result });
  }

  /** Set or clear a per-asset alert threshold. */
  async setThreshold(request: FastifyRequest, reply: FastifyReply) {
    const session = await authenticate(request);
    const body = (request.body as any) ?? {};
    const asset = typeof body.asset === 'string' ? body.asset.trim() : '';

    if (!asset) {
      throw new ValidationError('`asset` is required.', undefined, 'INVALID_ASSET');
    }

    let minAmount: number | null = null;
    if (body.minAmount !== null && body.minAmount !== undefined) {
      const parsed = Number(body.minAmount);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new ValidationError(
          '`minAmount` must be a non-negative number or null to clear.',
          undefined,
          'INVALID_MIN_AMOUNT',
        );
      }
      minAmount = parsed;
    }

    const thresholds = await telegramMiniAppService.setAssetThreshold(session.userId, asset, minAmount);
    return reply.send({ success: true, thresholds });
  }
}

export const telegramMiniAppController = new TelegramMiniAppController();

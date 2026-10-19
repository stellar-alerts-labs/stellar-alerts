import { prisma } from '../../lib/prisma';
import { createLogger } from '../../lib/logger';
import {
  ssrfFilter,
  SsrfFilter,
  SsrfFilterOptions,
  SsrfValidationResult,
  SsrfBlockedError,
} from './ssrf-filter';

const log = createLogger({ module: 'WebhookValidator' });

export interface WebhookValidationContext {
  userId?: string;
  clientIp?: string;
  userAgent?: string;
  options?: SsrfFilterOptions;
}

/**
 * Validates a webhook destination URL against SSRF policy.
 * If blocked, persists a security audit log in Prisma and throws an HTTP 400 error.
 */
export async function validateWebhookUrl(
  url: string,
  context: WebhookValidationContext = {},
  filter: SsrfFilter = ssrfFilter
): Promise<SsrfValidationResult> {
  const result = await filter.validate(url, context.options);

  if (!result.valid) {
    log.warn(
      {
        url,
        userId: context.userId,
        clientIp: context.clientIp,
        reason: result.reason,
        blockedIp: result.blockedIp,
      },
      '🚨 SSRF security violation: webhook URL rejected'
    );

    // Persist security audit log
    try {
      await prisma.securityAuditLog.create({
        data: {
          userId: context.userId ?? null,
          action: 'SSRF_ATTEMPT_BLOCKED',
          ipAddress: context.clientIp ?? null,
          userAgent: context.userAgent ?? null,
          details: {
            targetUrl: url,
            reason: result.reason,
            blockedIp: result.blockedIp,
            resolvedIps: result.resolvedIps,
            timestamp: new Date().toISOString(),
          },
        },
      });
    } catch (auditErr: any) {
      log.error({ auditErr }, 'Failed to record SSRF security audit log');
    }

    throw new SsrfBlockedError(
      result.reason || 'Webhook target URL is restricted by the egress firewall.',
      url,
      result.blockedIp
    );
  }

  return result;
}

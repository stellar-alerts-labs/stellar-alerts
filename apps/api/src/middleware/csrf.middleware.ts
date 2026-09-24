import { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function configuredOrigins(): Set<string> {
  return new Set(
    env.CSRF_ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
}

function requestOrigin(request: FastifyRequest): string | undefined {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin) return origin;

  const referer = request.headers.referer;
  if (typeof referer !== 'string' || !referer) return undefined;

  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

export function requiresCsrfProtection(request: FastifyRequest): boolean {
  if (!STATE_CHANGING_METHODS.has(request.method)) return false;
  if (request.headers.authorization?.startsWith('Bearer ')) return false;
  return Boolean(request.headers.cookie);
}

export function isAllowedCsrfOrigin(request: FastifyRequest): boolean {
  const origin = requestOrigin(request)?.replace(/\/$/, '');
  return Boolean(origin && configuredOrigins().has(origin));
}

export async function csrfProtectionHook(request: FastifyRequest, reply: FastifyReply) {
  if (!requiresCsrfProtection(request) || isAllowedCsrfOrigin(request)) return;

  return reply.status(403).send({
    error: 'Forbidden',
    message: 'A valid origin is required for cookie-authenticated state changes.',
    code: 'CSRF_ORIGIN_INVALID',
  });
}
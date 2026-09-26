import crypto from 'crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
  correlationId: string;
  requestId: string;
}

export interface SLOMetricsSnapshot {
  ingestionCount: number;
  ingestionTotalLatencyMs: number;
  ingestionP95LatencyMs: number;
  deliverySuccessCount: number;
  deliveryFailureCount: number;
  totalRequestsCount: number;
  successfulRequestsCount: number;
}

/**
 * Generate a W3C traceparent compliant context.
 * Format: 00-{32 hex traceId}-{16 hex spanId}-01
 */
export function generateTraceContext(
  existingCorrelationId?: string,
  existingTraceparent?: string
): TraceContext {
  let traceId = crypto.randomBytes(16).toString('hex');
  let spanId = crypto.randomBytes(8).toString('hex');

  if (existingTraceparent) {
    const parts = existingTraceparent.split('-');
    if (parts.length >= 4 && parts[1] && parts[1].length === 32) {
      traceId = parts[1];
    }
  }

  const traceparent = `00-${traceId}-${spanId}-01`;
  const correlationId = existingCorrelationId || traceId;
  const requestId = existingCorrelationId || `req_${crypto.randomBytes(8).toString('hex')}`;

  return {
    traceId,
    spanId,
    traceparent,
    correlationId,
    requestId,
  };
}

/**
 * Extract or initialize trace headers for outgoing HTTP requests & queue jobs.
 */
export function extractTraceHeaders(
  headers: Record<string, string | string[] | undefined> = {}
): TraceContext {
  const getHeader = (key: string): string | undefined => {
    const val = headers[key] || headers[key.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val;
  };

  const traceparent = getHeader('traceparent');
  const correlationId =
    getHeader('x-correlation-id') ||
    getHeader('x-request-id') ||
    getHeader('x-trace-id');

  return generateTraceContext(correlationId, traceparent);
}

/**
 * Privacy Sanitization & Redaction helper.
 * Redacts sensitive fields (auth, tokens, secrets, private keys, emails, chat IDs)
 * from trace logs and OpenTelemetry spans.
 */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'auth',
  'token',
  'secret',
  'password',
  'apikey',
  'api_key',
  'mfatoken',
  'privatekey',
  'private_key',
  'email',
  'telegramchatid',
  'phonenumber',
  'bearer',
]);

export function sanitizePayloadForTrace<T>(payload: T): T {
  if (payload === null || payload === undefined) {
    return payload;
  }

  if (typeof payload === 'string') {
    // Redact bearer tokens or hex secrets if accidentally passed
    if (payload.toLowerCase().startsWith('bearer ')) {
      return 'Bearer [REDACTED]' as unknown as T;
    }
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizePayloadForTrace(item)) as unknown as T;
  }

  if (typeof payload === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(normalizedKey)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizePayloadForTrace(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized as T;
  }

  return payload;
}

/**
 * Service Level Objective (SLO) Metrics Tracker & Dashboard Status
 */
export class SLODashboardTracker {
  private latencies: number[] = [];
  private deliverySuccess = 0;
  private deliveryFailure = 0;
  private totalRequests = 0;
  private successfulRequests = 0;

  public recordIngestionLatency(latencyMs: number): void {
    this.latencies.push(latencyMs);
    // Maintain rolling buffer of last 10,000 latencies
    if (this.latencies.length > 10000) {
      this.latencies.shift();
    }
  }

  public recordDeliveryResult(success: boolean): void {
    if (success) {
      this.deliverySuccess += 1;
    } else {
      this.deliveryFailure += 1;
    }
  }

  public recordApiRequest(success: boolean): void {
    this.totalRequests += 1;
    if (success) {
      this.successfulRequests += 1;
    }
  }

  public getSnapshot(): SLOMetricsSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const count = sorted.length;
    const totalLatency = sorted.reduce((acc, curr) => acc + curr, 0);
    const p95Index = Math.floor(count * 0.95);
    const p95Latency = count > 0 ? sorted[p95Index] || sorted[count - 1] || 0 : 0;

    return {
      ingestionCount: count,
      ingestionTotalLatencyMs: totalLatency,
      ingestionP95LatencyMs: p95Latency,
      deliverySuccessCount: this.deliverySuccess,
      deliveryFailureCount: this.deliveryFailure,
      totalRequestsCount: this.totalRequests,
      successfulRequestsCount: this.successfulRequests,
    };
  }

  public evaluateSLOStatus(): {
    ingestionLatencySlo: { targetMs: number; actualP95Ms: number; meetsSlo: boolean };
    deliverySuccessRateSlo: { targetPercent: number; actualPercent: number; meetsSlo: boolean };
    apiAvailabilitySlo: { targetPercent: number; actualPercent: number; meetsSlo: boolean };
    overallStatus: 'HEALTHY' | 'DEGRADED' | 'VIOLATING';
  } {
    const snapshot = this.getSnapshot();

    const actualP95 = snapshot.ingestionP95LatencyMs;
    const ingestionMeets = snapshot.ingestionCount === 0 || actualP95 <= 200;

    const totalDeliveries = snapshot.deliverySuccessCount + snapshot.deliveryFailureCount;
    const deliveryRate = totalDeliveries > 0 ? (snapshot.deliverySuccessCount / totalDeliveries) * 100 : 100;
    const deliveryMeets = deliveryRate >= 99.9;

    const totalReqs = snapshot.totalRequestsCount;
    const availabilityRate = totalReqs > 0 ? (snapshot.successfulRequestsCount / totalReqs) * 100 : 100;
    const availabilityMeets = availabilityRate >= 99.9;

    const allPass = ingestionMeets && deliveryMeets && availabilityMeets;
    const anyPass = ingestionMeets || deliveryMeets || availabilityMeets;

    return {
      ingestionLatencySlo: { targetMs: 200, actualP95Ms: actualP95, meetsSlo: ingestionMeets },
      deliverySuccessRateSlo: { targetPercent: 99.9, actualPercent: Number(deliveryRate.toFixed(2)), meetsSlo: deliveryMeets },
      apiAvailabilitySlo: { targetPercent: 99.9, actualPercent: Number(availabilityRate.toFixed(2)), meetsSlo: availabilityMeets },
      overallStatus: allPass ? 'HEALTHY' : anyPass ? 'DEGRADED' : 'VIOLATING',
    };
  }
}

export const globalSloTracker = new SLODashboardTracker();

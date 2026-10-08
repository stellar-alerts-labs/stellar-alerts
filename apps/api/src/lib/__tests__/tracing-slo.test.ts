import { describe, it, expect } from 'vitest';
import {
  generateTraceContext,
  extractTraceHeaders,
  sanitizePayloadForTrace,
  SLODashboardTracker,
} from '../tracing';

describe('End-to-End Tracing & Privacy Sanitization (#275)', () => {
  describe('W3C Trace Context & Correlation ID Propagation', () => {
    it('generates valid W3C traceparent and correlation IDs', () => {
      const traceCtx = generateTraceContext();
      expect(traceCtx.traceId).toHaveLength(32);
      expect(traceCtx.spanId).toHaveLength(16);
      expect(traceCtx.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      expect(traceCtx.correlationId).toBeDefined();
    });

    it('extracts existing correlation-id and traceparent from request headers', () => {
      const existingCorrelationId = 'corr_test_999';
      const existingTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

      const traceCtx = extractTraceHeaders({
        'x-correlation-id': existingCorrelationId,
        'traceparent': existingTraceparent,
      });

      expect(traceCtx.correlationId).toBe(existingCorrelationId);
      expect(traceCtx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(traceCtx.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[a-f0-9]{16}-01$/);
    });

    it('falls back gracefully to x-request-id when x-correlation-id is missing', () => {
      const existingRequestId = 'req_abc_123';
      const traceCtx = extractTraceHeaders({
        'x-request-id': existingRequestId,
      });

      expect(traceCtx.correlationId).toBe(existingRequestId);
    });
  });

  describe('Privacy Sanitization & Credential Redaction', () => {
    it('redacts authorization headers, secret keys, passwords, and tokens', () => {
      const payload = {
        authorization: 'Bearer secret_jwt_token_123',
        apiKey: 'sk_live_xyz987',
        mfaToken: '123456',
        privateKey: 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        telegramChatId: '12345678',
        email: 'user@example.com',
        publicField: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        nested: {
          secret: 'nested_secret_value',
          amount: 100,
        },
      };

      const sanitized = sanitizePayloadForTrace(payload);

      expect(sanitized.authorization).toBe('[REDACTED]');
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.mfaToken).toBe('[REDACTED]');
      expect(sanitized.privateKey).toBe('[REDACTED]');
      expect(sanitized.telegramChatId).toBe('[REDACTED]');
      expect(sanitized.email).toBe('[REDACTED]');
      expect(sanitized.publicField).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
      expect(sanitized.nested.secret).toBe('[REDACTED]');
      expect(sanitized.nested.amount).toBe(100);
    });

    it('redacts bearer tokens in string payloads', () => {
      const rawBearer = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.secret';
      const sanitized = sanitizePayloadForTrace(rawBearer);
      expect(sanitized).toBe('Bearer [REDACTED]');
    });
  });

  describe('SLO Metrics Tracker & Dashboard Calculations', () => {
    it('calculates p95 ingestion latency and delivery success rate correctly', () => {
      const tracker = new SLODashboardTracker();

      // Record 100 ingestion latencies: 1ms .. 100ms
      for (let i = 1; i <= 100; i++) {
        tracker.recordIngestionLatency(i);
      }

      // Record 1000 delivery attempts: 999 success, 1 failure
      for (let i = 0; i < 999; i++) {
        tracker.recordDeliveryResult(true);
      }
      tracker.recordDeliveryResult(false);

      // Record 1000 API requests: all successful
      for (let i = 0; i < 1000; i++) {
        tracker.recordApiRequest(true);
      }

      const snapshot = tracker.getSnapshot();
      expect(snapshot.ingestionCount).toBe(100);
      expect(snapshot.ingestionP95LatencyMs).toBe(96);
      expect(snapshot.deliverySuccessCount).toBe(999);
      expect(snapshot.deliveryFailureCount).toBe(1);

      const sloEvaluation = tracker.evaluateSLOStatus();
      expect(sloEvaluation.ingestionLatencySlo.meetsSlo).toBe(true);
      expect(sloEvaluation.deliverySuccessRateSlo.actualPercent).toBe(99.9);
      expect(sloEvaluation.deliverySuccessRateSlo.meetsSlo).toBe(true);
      expect(sloEvaluation.apiAvailabilitySlo.meetsSlo).toBe(true);
      expect(sloEvaluation.overallStatus).toBe('HEALTHY');
    });

    it('reports DEGRADED or VIOLATING when latency exceeds 200ms target', () => {
      const tracker = new SLODashboardTracker();

      // Record latencies exceeding 200ms
      for (let i = 1; i <= 100; i++) {
        tracker.recordIngestionLatency(250);
      }

      const sloEvaluation = tracker.evaluateSLOStatus();
      expect(sloEvaluation.ingestionLatencySlo.meetsSlo).toBe(false);
      expect(sloEvaluation.overallStatus).toBe('DEGRADED');
    });
  });
});

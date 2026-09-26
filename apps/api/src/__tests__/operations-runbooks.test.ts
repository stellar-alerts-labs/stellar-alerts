import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// The runbooks document lives at the repo root so on-call engineers can find
// it without digging into a workspace package.
const runbookPath = path.resolve(__dirname, '../../../../docs/OPERATIONS_RUNBOOKS.md');
const runbook = readFileSync(runbookPath, 'utf8');

describe('Operations Runbooks documentation (#340)', () => {
  it('documents a provider outage response runbook', () => {
    expect(runbook).toMatch(/Provider Outage/i);
    expect(runbook).toContain('CircuitBreaker');
    expect(runbook).toContain('WebhookLog');
  });

  it('documents a Redis / BullMQ outage response runbook', () => {
    expect(runbook).toMatch(/Redis.*Outage/i);
    expect(runbook).toContain('payment-alerts');
    expect(runbook).toMatch(/Sentinel/i);
  });

  it('documents a stuck-worker response runbook', () => {
    expect(runbook).toMatch(/Stuck or Crash-Looping Workers/i);
    expect(runbook).toContain('WorkerSupervisor');
    expect(runbook).toContain('heartbeat');
  });

  it('documents a migration rollback runbook', () => {
    expect(runbook).toMatch(/Migration Rollback/i);
    expect(runbook).toContain('prisma migrate');
  });

  it('documents a duplicate-alert repair runbook', () => {
    expect(runbook).toMatch(/Duplicate-Alert Repair/i);
    expect(runbook).toContain('deliverWithIdempotency');
    expect(runbook).toContain('NotificationDelivery');
  });

  it('keeps the standard runbook structure (symptoms, mitigation, recovery, verification)', () => {
    for (const section of ['Symptoms', 'Detection', 'Immediate Mitigation', 'Recovery', 'Verification']) {
      expect(runbook).toContain(section);
    }
  });
});

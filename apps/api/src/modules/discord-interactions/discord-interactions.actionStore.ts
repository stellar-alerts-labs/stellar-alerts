/**
 * actionStore.ts — persistence boundary for Discord alert action state.
 *
 * The interactions service depends on `DiscordAlertActionStore`; the in-memory
 * implementation backs tests/dev and a Redis/Prisma-backed store can be dropped
 * in for multi-instance deployments without touching the service.
 */
import type { DiscordAlertAction } from '../../utils/discord';

export type DiscordAlertActionStatus = 'acknowledged' | 'snoozed' | 'rerouted';

export interface DiscordAlertActionEvent {
  action: DiscordAlertAction;
  actorId: string;
  at: string;
  /** Snooze duration in seconds or re-route target, depending on the action. */
  param?: string | null;
}

export interface DiscordAlertActionState {
  alertId: string;
  status: DiscordAlertActionStatus;
  actorId: string;
  updatedAt: string;
  /** ISO-8601 timestamp the snooze expires, when snoozed. */
  snoozedUntil?: string | null;
  /** Re-route destination, when re-routed. */
  routedTo?: string | null;
  history: DiscordAlertActionEvent[];
}

export interface ApplyAlertActionInput {
  action: DiscordAlertAction;
  alertId: string;
  actorId: string;
  /** Snooze duration in seconds (required for `snooze`). */
  snoozeSeconds?: number;
  /** Re-route destination (optional for `reroute`). */
  routedTo?: string;
}

export interface DiscordAlertActionStore {
  apply(input: ApplyAlertActionInput): Promise<DiscordAlertActionState>;
  get(alertId: string): Promise<DiscordAlertActionState | null>;
}

function clone(state: DiscordAlertActionState): DiscordAlertActionState {
  return { ...state, history: state.history.map((entry) => ({ ...entry })) };
}

export class InMemoryDiscordAlertActionStore implements DiscordAlertActionStore {
  private readonly states = new Map<string, DiscordAlertActionState>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async apply(input: ApplyAlertActionInput): Promise<DiscordAlertActionState> {
    const occurredAt = this.now().toISOString();
    const existing = this.states.get(input.alertId);

    const next: DiscordAlertActionState = existing
      ? clone(existing)
      : {
          alertId: input.alertId,
          status: 'acknowledged',
          actorId: input.actorId,
          updatedAt: occurredAt,
          snoozedUntil: null,
          routedTo: null,
          history: [],
        };

    next.actorId = input.actorId;
    next.updatedAt = occurredAt;

    if (input.action === 'ack') {
      next.status = 'acknowledged';
      next.snoozedUntil = null;
    } else if (input.action === 'snooze') {
      const seconds = input.snoozeSeconds ?? 0;
      next.status = 'snoozed';
      next.snoozedUntil = new Date(this.now().getTime() + seconds * 1000).toISOString();
    } else {
      next.status = 'rerouted';
      next.routedTo = input.routedTo ?? 'default';
    }

    next.history.push({
      action: input.action,
      actorId: input.actorId,
      at: occurredAt,
      param:
        input.action === 'snooze'
          ? String(input.snoozeSeconds ?? '')
          : input.action === 'reroute'
            ? next.routedTo
            : null,
    });

    this.states.set(input.alertId, next);
    return clone(next);
  }

  async get(alertId: string): Promise<DiscordAlertActionState | null> {
    const found = this.states.get(alertId);
    return found ? clone(found) : null;
  }
}

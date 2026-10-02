/**
 * IPC message contracts for the supervisor ↔ worker heartbeat protocol.
 *
 * The WorkerSupervisor (workers/supervisor.ts) sends `ping` messages to each
 * forked child process at a regular interval; the worker is expected to reply
 * with a `pong` message.  Missing the pong within the timeout causes the
 * supervisor to SIGKILL the frozen worker and respawn it.
 *
 * Previously both sides used `message: any`, which concealed typos and made
 * it easy to accidentally break the protocol.  This module narrows the
 * message to the two shapes the protocol actually uses, and exports a
 * type guard so callers can check the message type without casting.
 */

// ── Outbound (supervisor → worker) ────────────────────────────────────────

export interface SupervisorPingMessage {
  type: 'ping';
}

// ── Inbound (worker → supervisor) ─────────────────────────────────────────

export interface WorkerPongMessage {
  type: 'pong';
}

// ── Union ──────────────────────────────────────────────────────────────────

export type SupervisorIpcMessage = SupervisorPingMessage | WorkerPongMessage;

// ── Narrowing helpers ──────────────────────────────────────────────────────

/**
 * Returns `true` when `msg` is a well-formed object with a `type` field,
 * which is the minimum required to safely inspect it as an IPC message.
 * Use before narrowing to a specific message type.
 */
export function isSupervisorIpcMessage(msg: unknown): msg is SupervisorIpcMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof (msg as Record<string, unknown>).type === 'string'
  );
}

export function isPingMessage(msg: unknown): msg is SupervisorPingMessage {
  return isSupervisorIpcMessage(msg) && msg.type === 'ping';
}

export function isPongMessage(msg: unknown): msg is WorkerPongMessage {
  return isSupervisorIpcMessage(msg) && msg.type === 'pong';
}

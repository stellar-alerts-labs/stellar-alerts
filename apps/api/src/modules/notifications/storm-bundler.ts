/**
 * Alert Storm Bundler
 *
 * Clusters similar alerts from the same rule within a 30-second sliding window
 * into a single summary digest to prevent notification fatigue during batch payouts.
 *
 * - First K alerts (default 3) dispatch immediately for zero-latency responsiveness
 * - Subsequent alerts coalesce into a rolled-up summary card
 * - CRITICAL severity alerts are never suppressed or delayed
 */

import { createLogger } from "../../lib/logger";

const log = createLogger({ module: "AlertStormBundler" });

export interface AlertStormMetadata {
  ruleId: string;
  severity: "critical" | "high" | "standard" | "bulk" | string;
  alert: Record<string, any>;
}

export interface BundledAlert {
  type: "bundled";
  ruleId: string;
  totalCount: number;
  totalVolume?: string;
  topCounterparties: string[];
  window: { startMs: number; endMs: number };
  alerts: Record<string, any>[];
}

interface StormWindow {
  ruleId: string;
  severity: string;
  count: number;
  startMs: number;
  endMs: number;
  totalVolume: string;
  counterparties: Set<string>;
  alerts: Record<string, any>[];
}

export class AlertStormBundler {
  private windows: Map<string, StormWindow> = new Map();
  private windowTimeout: Map<string, NodeJS.Timeout> = new Map();
  private readonly WINDOW_DURATION_MS = 30_000; // 30-second sliding window
  private readonly DEFAULT_THRESHOLD = 3; // Allow first K through immediately

  constructor(private threshold: number = 3) {}

  /**
   * Decides whether to dispatch immediately or defer for bundling.
   *
   * Returns:
   * - { dispatch: true, bundle?: undefined } → send immediately
   * - { dispatch: false, bundle: BundledAlert } → defer and accumulate
   * - { dispatch: true, bundle: BundledAlert } → send summary (if window closing)
   */
  public processAlert(metadata: AlertStormMetadata): {
    dispatch: boolean;
    bundle?: BundledAlert;
  } {
    const { ruleId, severity, alert } = metadata;

    // CRITICAL alerts always dispatch immediately, never bundled
    if (severity === "critical") {
      log.debug({ ruleId, severity }, "CRITICAL alert bypasses storm bundler");
      return { dispatch: true };
    }

    const key = ruleId;
    const now = Date.now();
    let window = this.windows.get(key);

    // Initialize or refresh window
    if (!window || now > window.endMs) {
      window = {
        ruleId,
        severity,
        count: 0,
        startMs: now,
        endMs: now + this.WINDOW_DURATION_MS,
        totalVolume: "0",
        counterparties: new Set(),
        alerts: [],
      };
      this.windows.set(key, window);
      this.resetWindowTimeout(key);
    }

    // Extract metadata for aggregation
    const amount = alert.amount ? String(alert.amount) : "0";
    const counterparty = alert.fromAddress || alert.to || "unknown";

    // Accumulate metrics
    window.count += 1;
    window.totalVolume = this.addAmounts(window.totalVolume, amount);
    window.counterparties.add(counterparty);
    window.alerts.push(alert);

    // First K alerts dispatch immediately
    if (window.count <= this.threshold) {
      log.debug(
        { ruleId, count: window.count, threshold: this.threshold },
        `Alert #${window.count} within threshold, dispatching immediately`,
      );
      return { dispatch: true };
    }

    // Beyond threshold: bundle
    log.debug(
      { ruleId, count: window.count, threshold: this.threshold },
      `Alert #${window.count} exceeds threshold, bundling into digest`,
    );

    return {
      dispatch: false,
      bundle: {
        type: "bundled",
        ruleId,
        totalCount: window.count,
        totalVolume: window.totalVolume,
        topCounterparties: Array.from(window.counterparties).slice(0, 5),
        window: {
          startMs: window.startMs,
          endMs: window.endMs,
        },
        alerts: window.alerts,
      },
    };
  }

  /**
   * Finalizes a bundle and clears its window (called when the 30s window expires).
   * Returns the final bundled alert if there were deferred alerts, otherwise null.
   */
  public finalizeBundle(ruleId: string): BundledAlert | null {
    const window = this.windows.get(ruleId);
    if (!window || window.count <= this.threshold) {
      return null; // No bundling occurred
    }

    const bundle: BundledAlert = {
      type: "bundled",
      ruleId,
      totalCount: window.count,
      totalVolume: window.totalVolume,
      topCounterparties: Array.from(window.counterparties).slice(0, 5),
      window: {
        startMs: window.startMs,
        endMs: window.endMs,
      },
      alerts: window.alerts,
    };

    // Clean up
    this.windows.delete(ruleId);
    const timeout = this.windowTimeout.get(ruleId);
    if (timeout) clearTimeout(timeout);
    this.windowTimeout.delete(ruleId);

    log.info(
      {
        ruleId,
        totalCount: bundle.totalCount,
        totalVolume: bundle.totalVolume,
      },
      "Alert storm bundle finalized",
    );

    return bundle;
  }

  /**
   * Reset the auto-finalization timeout for a rule's window.
   */
  private resetWindowTimeout(ruleId: string): void {
    const existing = this.windowTimeout.get(ruleId);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(() => {
      const bundle = this.finalizeBundle(ruleId);
      if (bundle && bundle.totalCount > this.threshold) {
        log.info(
          { ruleId, bundledCount: bundle.totalCount },
          "Window expired, bundle ready for dispatch",
        );
      }
    }, this.WINDOW_DURATION_MS);

    this.windowTimeout.set(ruleId, timeout);
  }

  /**
   * Simple amount addition (assumes string representations of numbers).
   */
  private addAmounts(a: string, b: string): string {
    try {
      const sum = (parseFloat(a) || 0) + (parseFloat(b) || 0);
      return sum.toFixed(7); // Prevent floating-point creep
    } catch {
      return "0";
    }
  }

  /**
   * Get current window status (for testing/debugging).
   */
  public getWindowStatus(ruleId: string): StormWindow | null {
    return this.windows.get(ruleId) ?? null;
  }

  /**
   * Reset all windows (for testing).
   */
  public reset(): void {
    Array.from(this.windowTimeout.values()).forEach((t) => clearTimeout(t));
    this.windows.clear();
    this.windowTimeout.clear();
  }
}

// Singleton instance
export const alertStormBundler = new AlertStormBundler();

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AlertStormBundler } from "../storm-bundler";

describe("AlertStormBundler", () => {
  let bundler: AlertStormBundler;

  beforeEach(() => {
    bundler = new AlertStormBundler(3); // threshold = 3
  });

  afterEach(() => {
    bundler.reset();
  });

  describe("First K alerts dispatch immediately", () => {
    it("allows first alert through immediately", () => {
      const result = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });
      expect(result.dispatch).toBe(true);
      expect(result.bundle).toBeUndefined();
    });

    it("allows second and third alerts through immediately", () => {
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });

      const result2 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "150", fromAddress: "Bob", txHash: "tx2" },
      });
      expect(result2.dispatch).toBe(true);
      expect(result2.bundle).toBeUndefined();

      const result3 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "200", fromAddress: "Charlie", txHash: "tx3" },
      });
      expect(result3.dispatch).toBe(true);
      expect(result3.bundle).toBeUndefined();
    });
  });

  describe("Bundling after threshold exceeded", () => {
    it("bundles 4th alert and subsequent alerts", () => {
      // First 3 dispatch immediately
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "150", fromAddress: "Bob", txHash: "tx2" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "200", fromAddress: "Charlie", txHash: "tx3" },
      });

      // 4th alert bundles
      const result4 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "250", fromAddress: "Diana", txHash: "tx4" },
      });
      expect(result4.dispatch).toBe(false);
      expect(result4.bundle).toBeDefined();
      expect(result4.bundle?.totalCount).toBe(4);
      expect(result4.bundle?.totalVolume).toContain("700"); // 100+150+200+250
    });

    it("aggregates counterparties correctly", () => {
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "150", fromAddress: "Bob", txHash: "tx2" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "200", fromAddress: "Charlie", txHash: "tx3" },
      });

      const result4 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "250", fromAddress: "Alice", txHash: "tx4" },
      });

      expect(result4.bundle?.topCounterparties).toContain("Alice");
      expect(result4.bundle?.topCounterparties).toContain("Bob");
      expect(result4.bundle?.topCounterparties).toContain("Charlie");
    });
  });

  describe("Window reset after 30 seconds", () => {
    it("resets window after 30 seconds", async () => {
      // Send first alert
      const result1 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });
      expect(result1.dispatch).toBe(true);

      // Send 2 more within threshold
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "150", fromAddress: "Bob", txHash: "tx2" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "200", fromAddress: "Charlie", txHash: "tx3" },
      });

      // 4th bundles
      const result4 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "250", fromAddress: "Diana", txHash: "tx4" },
      });
      expect(result4.dispatch).toBe(false);

      // Manually finalize the bundle (simulates window expiry)
      const bundle = bundler.finalizeBundle("rule-1");
      expect(bundle).toBeDefined();
      expect(bundle?.totalCount).toBe(4);

      // After window expires, new alerts start fresh
      const resultFresh = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "50", fromAddress: "Eve", txHash: "tx5" },
      });
      expect(resultFresh.dispatch).toBe(true);
      expect(resultFresh.bundle).toBeUndefined();
    });
  });

  describe("CRITICAL severity alerts bypass bundler", () => {
    it("never suppresses CRITICAL severity alerts", () => {
      // Fill up the threshold with standard alerts
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "150", fromAddress: "Bob", txHash: "tx2" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "200", fromAddress: "Charlie", txHash: "tx3" },
      });

      // 4th standard alert would be bundled
      const result4 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "250", fromAddress: "Diana", txHash: "tx4" },
      });
      expect(result4.dispatch).toBe(false);

      // But a CRITICAL alert always dispatches immediately
      const resultCritical = bundler.processAlert({
        ruleId: "rule-1",
        severity: "critical",
        alert: {
          amount: "0",
          fromAddress: "Signer",
          txHash: "tx-signer",
          event: "signer_change",
        },
      });
      expect(resultCritical.dispatch).toBe(true);
      expect(resultCritical.bundle).toBeUndefined();
    });
  });

  describe("Different rules have separate windows", () => {
    it("maintains independent windows per rule", () => {
      // Fill rule-1 to threshold
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "150", fromAddress: "Bob", txHash: "tx2" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "200", fromAddress: "Charlie", txHash: "tx3" },
      });

      // rule-2 starts fresh
      const result1 = bundler.processAlert({
        ruleId: "rule-2",
        severity: "standard",
        alert: { amount: "50", fromAddress: "Eve", txHash: "tx10" },
      });
      expect(result1.dispatch).toBe(true);

      const result2 = bundler.processAlert({
        ruleId: "rule-2",
        severity: "standard",
        alert: { amount: "75", fromAddress: "Frank", txHash: "tx11" },
      });
      expect(result2.dispatch).toBe(true);

      // 4th alert on rule-1 bundles
      const rule1_4th = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "250", fromAddress: "Diana", txHash: "tx4" },
      });
      expect(rule1_4th.dispatch).toBe(false);

      // But 3rd alert on rule-2 still dispatches
      const rule2_3rd = bundler.processAlert({
        ruleId: "rule-2",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Grace", txHash: "tx12" },
      });
      expect(rule2_3rd.dispatch).toBe(true);
    });
  });

  describe("Finalize bundle", () => {
    it("returns null if no bundling occurred", () => {
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });
      const bundle = bundler.finalizeBundle("rule-1");
      expect(bundle).toBeNull();
    });

    it("returns bundled alert with correct structure", () => {
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "150", fromAddress: "Bob", txHash: "tx2" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "200", fromAddress: "Charlie", txHash: "tx3" },
      });
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "250", fromAddress: "Diana", txHash: "tx4" },
      });

      const bundle = bundler.finalizeBundle("rule-1");
      expect(bundle?.type).toBe("bundled");
      expect(bundle?.ruleId).toBe("rule-1");
      expect(bundle?.totalCount).toBe(4);
      expect(bundle?.totalVolume).toContain("700");
      expect(bundle?.topCounterparties.length).toBeGreaterThan(0);
      expect(bundle?.window.startMs).toBeDefined();
      expect(bundle?.window.endMs).toBeDefined();
      expect(bundle?.alerts.length).toBe(4);
    });
  });

  describe("Window status tracking", () => {
    it("tracks window state correctly", () => {
      bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100", fromAddress: "Alice", txHash: "tx1" },
      });

      const status = bundler.getWindowStatus("rule-1");
      expect(status).toBeDefined();
      expect(status?.ruleId).toBe("rule-1");
      expect(status?.count).toBe(1);
    });

    it("returns null for non-existent rule", () => {
      const status = bundler.getWindowStatus("non-existent-rule");
      expect(status).toBeNull();
    });
  });

  describe("Edge cases", () => {
    it("handles empty fromAddress", () => {
      const result = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { amount: "100" },
      });
      expect(result.dispatch).toBe(true);

      const status = bundler.getWindowStatus("rule-1");
      expect(status?.counterparties.has("unknown")).toBe(true);
    });

    it("handles missing amount", () => {
      const result1 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { fromAddress: "Alice" },
      });
      expect(result1.dispatch).toBe(true);

      const result2 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { fromAddress: "Bob" },
      });
      expect(result2.dispatch).toBe(true);

      const result3 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { fromAddress: "Charlie" },
      });
      expect(result3.dispatch).toBe(true);

      const result4 = bundler.processAlert({
        ruleId: "rule-1",
        severity: "standard",
        alert: { fromAddress: "Diana" },
      });
      expect(result4.dispatch).toBe(false);
      expect(result4.bundle?.totalVolume).toMatch(/^0(\.\d+)?$/);
    });
  });
});

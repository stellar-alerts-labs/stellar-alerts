import { describe, it, expect, beforeEach } from "vitest";
import { parseSorobanTransferEvent } from "./soroban";

describe("Soroban Event Parsing", () => {
  beforeEach(() => {
    // No setup needed
  });

  it("should parse soroban transfer events correctly", () => {
    const mockEvent = {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      topic: ["AAAADwAAAAZ0cmFuc2Zlcg=="],
      value: {
        from: "GAAA",
        to: "GBBB",
        amount: "1000000",
      },
      ledger: 123456,
    };

    const parsed = parseSorobanTransferEvent(mockEvent);

    expect(parsed).not.toBeNull();
    expect(parsed?.contractId).toBe(mockEvent.contractId);
    expect(parsed?.from).toBe("GAAA");
    expect(parsed?.to).toBe("GBBB");
    expect(parsed?.amount).toBe("1000000");
    expect(parsed?.ledgerSeq).toBe(123456);
  });

  it("should return null for events without topic", () => {
    const mockEvent = {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      topic: [],
      value: { from: "GAAA", to: "GBBB" },
    };

    const parsed = parseSorobanTransferEvent(mockEvent);
    expect(parsed).toBeNull();
  });

  it("should handle events with missing ledger sequence", () => {
    const mockEvent = {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      topic: ["transfer"],
      value: {
        from: "GAAA",
        to: "GBBB",
        amount: "500000",
      },
    };

    const parsed = parseSorobanTransferEvent(mockEvent);

    expect(parsed).not.toBeNull();
    expect(parsed?.ledgerSeq).toBeUndefined();
  });

  it("should handle nested transfer event structure", () => {
    const mockEvent = {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      topic: ["transfer"],
      value: {
        transfer: {
          from: "GAAA",
          to: "GBBB",
        },
        amount: "750000",
      },
      ledger: 200000,
    };

    const parsed = parseSorobanTransferEvent(mockEvent);

    expect(parsed).not.toBeNull();
    expect(parsed?.from).toBe("GAAA");
    expect(parsed?.to).toBe("GBBB");
    expect(parsed?.amount).toBe("750000");
    expect(parsed?.ledgerSeq).toBe(200000);
  });

  it("should handle events with null values", () => {
    const mockEvent = {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      topic: ["transfer"],
      value: null,
    };

    const parsed = parseSorobanTransferEvent(mockEvent);

    expect(parsed).not.toBeNull();
    expect(parsed?.from).toBe("");
    expect(parsed?.to).toBe("");
    expect(parsed?.amount).toBe("0");
  });

  it("should convert amount to string", () => {
    const mockEvent = {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      topic: ["transfer"],
      value: {
        from: "GAAA",
        to: "GBBB",
        amount: 999999,
      },
    };

    const parsed = parseSorobanTransferEvent(mockEvent);

    expect(parsed).not.toBeNull();
    expect(parsed?.amount).toBe("999999");
    expect(typeof parsed?.amount).toBe("string");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseSorobanTransferEvent,
  hashSorobanLedgerEntry,
  verifySorobanContractStateProof,
} from "./soroban";
import { buildMerkleTree, generateMerkleProof, hashMerkleLeaf } from "../utils/merkle-verifier";

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

describe("Soroban contract state proof verification", () => {
  // Simulated Soroban LedgerKey / LedgerEntryData XDR — real XDR is opaque
  // binary, but the verifier only needs *some* stable bytes to hash, so a
  // base64-encoded fixture stands in for the real xdr.LedgerKey /
  // xdr.LedgerEntryData bytes without needing a live RPC round trip.
  function fakeEntryXdr(label: string) {
    return {
      ledgerKeyXdr: Buffer.from(`key:${label}`).toString("base64"),
      ledgerEntryXdr: Buffer.from(`value:${label}`).toString("base64"),
    };
  }

  it("hashSorobanLedgerEntry is deterministic and binds both key and value", () => {
    const entry = fakeEntryXdr("counter");
    const a = hashSorobanLedgerEntry(entry.ledgerKeyXdr, entry.ledgerEntryXdr);
    const b = hashSorobanLedgerEntry(entry.ledgerKeyXdr, entry.ledgerEntryXdr);
    expect(a).toBe(b);

    // Same key, different value -> different leaf hash (the proof commits
    // to the exact stored value, not just key presence).
    const changedValue = hashSorobanLedgerEntry(
      entry.ledgerKeyXdr,
      Buffer.from("value:counter-changed").toString("base64"),
    );
    expect(changedValue).not.toBe(a);
  });

  it("verifies a genuine contract storage entry against its ledger's state root", () => {
    const entries = ["balance:alice", "balance:bob", "balance:carol", "admin"].map((label) =>
      fakeEntryXdr(label),
    );
    // Build the tree the same way hashSorobanLedgerEntry does (key||value bytes).
    const rawLeaves = entries.map((e) =>
      Buffer.concat([Buffer.from(e.ledgerKeyXdr, "base64"), Buffer.from(e.ledgerEntryXdr, "base64")]),
    );
    const tree = buildMerkleTree(rawLeaves);

    const targetIndex = 1; // balance:bob
    const proof = generateMerkleProof(tree, targetIndex);

    const result = verifySorobanContractStateProof({
      ledgerKeyXdr: entries[targetIndex].ledgerKeyXdr,
      ledgerEntryXdr: entries[targetIndex].ledgerEntryXdr,
      proof,
      ledgerStateRoot: tree.root,
    });

    expect(result).toBe(true);
  });

  it("rejects the proof if the claimed entry value doesn't match what was actually committed", () => {
    const entries = ["balance:alice", "balance:bob"].map((label) => fakeEntryXdr(label));
    const rawLeaves = entries.map((e) =>
      Buffer.concat([Buffer.from(e.ledgerKeyXdr, "base64"), Buffer.from(e.ledgerEntryXdr, "base64")]),
    );
    const tree = buildMerkleTree(rawLeaves);
    const proof = generateMerkleProof(tree, 0);

    // Same key, but an attacker-claimed (higher) balance value.
    const forgedEntry = fakeEntryXdr("balance:alice-but-richer");
    const result = verifySorobanContractStateProof({
      ledgerKeyXdr: entries[0].ledgerKeyXdr,
      ledgerEntryXdr: forgedEntry.ledgerEntryXdr,
      proof,
      ledgerStateRoot: tree.root,
    });

    expect(result).toBe(false);
  });

  it("rejects a proof presented against the wrong ledger's state root", () => {
    const entries = ["balance:alice", "balance:bob"].map((label) => fakeEntryXdr(label));
    const rawLeaves = entries.map((e) =>
      Buffer.concat([Buffer.from(e.ledgerKeyXdr, "base64"), Buffer.from(e.ledgerEntryXdr, "base64")]),
    );
    const tree = buildMerkleTree(rawLeaves);
    const proof = generateMerkleProof(tree, 0);

    const staleRoot = hashMerkleLeaf(Buffer.from("some-other-ledgers-root"));

    const result = verifySorobanContractStateProof({
      ledgerKeyXdr: entries[0].ledgerKeyXdr,
      ledgerEntryXdr: entries[0].ledgerEntryXdr,
      proof,
      ledgerStateRoot: staleRoot,
    });

    expect(result).toBe(false);
  });

  it("returns false (never throws) for malformed base64 XDR input", () => {
    const result = verifySorobanContractStateProof({
      ledgerKeyXdr: "%%%not-base64%%%",
      ledgerEntryXdr: "also-not-valid",
      proof: [],
      ledgerStateRoot: "not-a-hex-root",
    });
    expect(result).toBe(false);
  });
});

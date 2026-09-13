import { describe, expect, it, beforeEach } from "vitest";
import { MockProviderStore } from "../../src/adapters/mock/mock.store.js";
import { ProviderError } from "../../src/shared/errors.js";

const input = {
  reference: "REF-93821",
  amount: "2500.00",
  currency: "DZD",
  returnUrl: "https://merchant.dz/payment/return",
  metadata: { channel: "web" },
};

describe("MockProviderStore", () => {
  let store: MockProviderStore;

  beforeEach(() => {
    store = new MockProviderStore();
  });

  it("creates a pending transaction with a unique provider reference", () => {
    const a = store.createTransaction(input);
    const b = store.createTransaction(input);
    expect(a.providerReference).toMatch(/^mock_/);
    expect(a.providerReference).not.toBe(b.providerReference);
    expect(a.status).toBe("pending");
    expect(a.amount).toBe(input.amount);
    expect(a.currency).toBe(input.currency);
    expect(a.reference).toBe(input.reference);
  });

  it("returns undefined for an unknown reference", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  it("throws ProviderError on getOrThrow for an unknown reference", () => {
    expect(() => store.getOrThrow("nope")).toThrow(ProviderError);
  });

  it("moves a pending transaction to paid/failed/expired on confirm", () => {
    const transaction = store.createTransaction(input);
    expect(store.confirm(transaction.providerReference, "paid").status).toBe("paid");
  });

  it("is idempotent under repeated confirms", () => {
    const transaction = store.createTransaction(input);
    store.confirm(transaction.providerReference, "failed");
    const again = store.confirm(transaction.providerReference, "paid");
    expect(again.status).toBe("failed");
  });

  it("throws for a confirm on an unknown transaction", () => {
    expect(() => store.confirm("nope", "paid")).toThrow(ProviderError);
  });

  it("resets all transactions", () => {
    const transaction = store.createTransaction(input);
    store.reset();
    expect(store.get(transaction.providerReference)).toBeUndefined();
  });
});

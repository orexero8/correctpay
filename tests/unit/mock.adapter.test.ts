import { describe, expect, it } from "vitest";
import { MockAdapter } from "../../src/adapters/mock/mock.adapter.js";
import { MockProviderStore } from "../../src/adapters/mock/mock.store.js";
import { ProviderError } from "../../src/shared/errors.js";
import type { CreatePaymentInput } from "../../src/adapters/provider.interface.js";

const BASE_URL = "http://localhost:3957";
const input: CreatePaymentInput = {
  reference: "REF-93821",
  amount: "2500.00",
  currency: "DZD",
  returnUrl: "https://merchant.dz/payment/return",
};

function setup(): { adapter: MockAdapter; store: MockProviderStore } {
  const store = new MockProviderStore();
  const adapter = new MockAdapter(store, { baseUrl: BASE_URL });
  return { adapter, store };
}

describe("MockAdapter.createPayment", () => {
  it("returns a provider reference and a checkout redirect URL", async () => {
    const { adapter, store } = setup();
    const result = await adapter.createPayment(input);
    expect(result.providerReference).toMatch(/^mock_/);
    expect(result.redirectUrl).toBe(`${BASE_URL}/mock/checkout/${result.providerReference}`);
    expect(store.get(result.providerReference)?.status).toBe("pending");
  });

  it("persists merchant metadata on the provider side", async () => {
    const { adapter, store } = setup();
    const result = await adapter.createPayment({ ...input, metadata: { channel: "web" } });
    expect(store.get(result.providerReference)?.metadata).toEqual({ channel: "web" });
  });
});

describe("MockAdapter.getPaymentStatus", () => {
  it("reports pending, then paid after a PAID confirm", async () => {
    const { adapter, store } = setup();
    const created = await adapter.createPayment(input);
    const before = await adapter.getPaymentStatus({ providerReference: created.providerReference });
    expect(before.status).toBe("pending");
    store.confirm(created.providerReference, "paid");
    const after = await adapter.getPaymentStatus({
      providerReference: created.providerReference,
    });
    expect(after.status).toBe("paid");
  });

  it("throws ProviderError for an unknown provider reference", async () => {
    const { adapter } = setup();
    await expect(
      adapter.getPaymentStatus({ providerReference: "mock_unknown" })
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("MockAdapter.refundPayment", () => {
  it("returns a succeeded refund for a paid transaction", async () => {
    const { adapter, store } = setup();
    const created = await adapter.createPayment(input);
    store.confirm(created.providerReference, "paid");
    const result = await adapter.refundPayment({
      providerReference: created.providerReference,
      amount: "2500.00",
    });
    expect(result.status).toBe("succeeded");
    expect(result.providerRefundReference).toContain(created.providerReference);
  });

  it("throws ProviderError for an unknown provider reference", async () => {
    const { adapter } = setup();
    await expect(
      adapter.refundPayment({ providerReference: "mock_unknown", amount: "1.00" })
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

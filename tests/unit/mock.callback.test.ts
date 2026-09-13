import { describe, expect, it } from "vitest";
import {
  buildMockWebhookPayload,
  emitSignedWebhook,
} from "../../src/adapters/mock/mock.callback.js";
import { MockProviderStore } from "../../src/adapters/mock/mock.store.js";
import { verifySignature } from "../../src/adapters/mock/mock.signature.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const TARGET_URL = "http://localhost:3999/v1/webhooks/mock";

function storeWithStatus(status: "paid" | "failed" | "expired") {
  const store = new MockProviderStore();
  const transaction = store.createTransaction({
    reference: "REF-93821",
    amount: "2500.00",
    currency: "DZD",
    returnUrl: "https://merchant.dz/payment/return",
    metadata: null,
  });
  store.confirm(transaction.providerReference, status);
  return { store, transaction: store.get(transaction.providerReference)! };
}

describe("buildMockWebhookPayload", () => {
  it("maps paid -> payment.completed", () => {
    const { transaction } = storeWithStatus("paid");
    const payload = buildMockWebhookPayload(transaction);
    expect(payload.event).toBe("payment.completed");
    expect(payload.status).toBe("paid");
    expect(payload.providerReference).toBe(transaction.providerReference);
    expect(payload.reference).toBe("REF-93821");
    expect(payload.amount).toBe("2500.00");
    expect(payload.currency).toBe("DZD");
  });

  it("maps failed -> payment.failed", () => {
    const { transaction } = storeWithStatus("failed");
    expect(buildMockWebhookPayload(transaction).event).toBe("payment.failed");
  });

  it("maps expired -> payment.cancelled", () => {
    const { transaction } = storeWithStatus("expired");
    expect(buildMockWebhookPayload(transaction).event).toBe("payment.cancelled");
  });
});

describe("emitSignedWebhook", () => {
  it("POSTs the raw body with a valid HMAC signature header", async () => {
    const { transaction } = storeWithStatus("paid");
    let capturedBody = "";
    let capturedSignature = "";
    const fetchImpl = async (
      _url: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const rawBody = init?.body;
      capturedBody = typeof rawBody === "string" ? rawBody : "";
      capturedSignature = String((init?.headers as Record<string, string>)?.["x-mock-signature"]);
      return new Response(null, { status: 200 });
    };

    const ok = await emitSignedWebhook({
      targetUrl: TARGET_URL,
      secret: SECRET,
      transaction,
      fetchImpl,
    });

    expect(ok).toBe(true);
    expect(JSON.parse(capturedBody)).toMatchObject({
      event: "payment.completed",
      providerReference: transaction.providerReference,
    });
    expect(verifySignature(capturedBody, SECRET, capturedSignature)).toBe(true);
  });

  it("returns false when the target responds non-successfully", async () => {
    const { transaction } = storeWithStatus("failed");
    const fetchImpl = async (): Promise<Response> => new Response(null, { status: 500 });
    const ok = await emitSignedWebhook({
      targetUrl: TARGET_URL,
      secret: SECRET,
      transaction,
      fetchImpl,
    });
    expect(ok).toBe(false);
  });

  it("returns false without throwing when dispatch fails", async () => {
    const { transaction } = storeWithStatus("paid");
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    const ok = await emitSignedWebhook({
      targetUrl: TARGET_URL,
      secret: SECRET,
      transaction,
      fetchImpl,
    });
    expect(ok).toBe(false);
  });
});

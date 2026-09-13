import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildE2EApp, parseResponse, type E2EApp } from "./helpers.js";

type CreateResponse = { id: string; status: string; redirectUrl: string; reference: string };
type PaymentView = {
  id: string;
  reference: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};
type RefundResponse = {
  id: string;
  paymentId: string;
  amount: string;
  status: string;
  providerReference: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

const PAYMENT_AMOUNT = "1250.00";

async function createPayment(e2e: E2EApp): Promise<CreateResponse> {
  const response = await fetch(`${e2e.baseUrl}/v1/payments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `idem-${randomUUID()}`,
    },
    body: JSON.stringify({
      reference: `REF-E2E-${randomUUID()}`,
      amount: PAYMENT_AMOUNT,
      currency: "DZD",
      returnUrl: "https://merchant.example/return?ref=cb",
      metadata: { flow: "e2e" },
    }),
  });
  expect(response.status).toBe(201);
  return parseResponse<CreateResponse>(response);
}

async function getPayment(e2e: E2EApp, paymentId: string): Promise<PaymentView> {
  const response = await fetch(`${e2e.baseUrl}/v1/payments/${paymentId}`);
  expect(response.status).toBe(200);
  return parseResponse<PaymentView>(response);
}

async function confirmCheckout(
  redirectUrl: string,
  action: "PAY" | "FAIL" | "CANCEL"
): Promise<Response> {
  return fetch(redirectUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `action=${action}`,
  });
}

async function refundPayment(
  e2e: E2EApp,
  paymentId: string,
  amount: string,
  reason?: string
): Promise<Response> {
  return fetch(`${e2e.baseUrl}/v1/payments/${paymentId}/refund`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `rf-${randomUUID()}`,
    },
    body: JSON.stringify({ amount, ...(reason !== undefined ? { reason } : {}) }),
  });
}

describe("end-to-end mock payment flow over real HTTP", () => {
  let e2e: E2EApp;

  beforeAll(async () => {
    e2e = await buildE2EApp();
  });

  afterAll(async () => {
    await e2e.app.close();
  });

  it("creates a payment, pays at the mock checkout, receives the signed webhook, then refunds", async () => {
    const created = await createPayment(e2e);
    expect(created.status).toBe("PENDING");
    expect(created.redirectUrl).toMatch(/\/mock\/checkout\/[^/]+$/);

    const checkoutPage = await fetch(created.redirectUrl);
    expect(checkoutPage.status).toBe(200);
    const page = await checkoutPage.text();
    expect(page).toContain("Mock provider checkout");
    expect(page).not.toMatch(/card|cvv|pan/i);

    const payResponse = await confirmCheckout(created.redirectUrl, "PAY");
    expect(payResponse.status).toBe(200);

    const paid = await getPayment(e2e, created.id);
    expect(paid.status).toBe("PAID");

    const toStatuses = e2e.paymentDb.events
      .filter((event) => event.paymentId === created.id)
      .map((event) => event.toStatus);
    expect(toStatuses).toEqual(["PENDING", "PROCESSING", "PAID"]);
    expect(
      e2e.paymentDb.events.filter(
        (event) => event.paymentId === created.id && event.toStatus === "PAID"
      )
    ).toHaveLength(1);

    const partial = await refundPayment(e2e, created.id, "500.00", "partial");
    expect(partial.status).toBe(201);
    const partialBody = await parseResponse<RefundResponse>(partial);
    expect(partialBody.status).toBe("SUCCEEDED");
    expect(partialBody.paymentId).toBe(created.id);
    expect(await getPayment(e2e, created.id)).toMatchObject({ status: "PARTIALLY_REFUNDED" });

    const full = await refundPayment(e2e, created.id, "750.00");
    expect(full.status).toBe(201);
    expect(await getPayment(e2e, created.id)).toMatchObject({ status: "FULLY_REFUNDED" });

    const overRefund = await refundPayment(e2e, created.id, "10.00");
    expect(overRefund.status).toBe(409);
    const overBody = await parseResponse<{ error: { code: string } }>(overRefund);
    expect(overBody.error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("marks a payment EXPIRED via the webhook when the checkout is cancelled", async () => {
    const created = await createPayment(e2e);

    const cancelResponse = await confirmCheckout(created.redirectUrl, "CANCEL");
    expect(cancelResponse.status).toBe(200);

    expect(await getPayment(e2e, created.id)).toMatchObject({ status: "EXPIRED" });
    const toStatuses = e2e.paymentDb.events
      .filter((event) => event.paymentId === created.id)
      .map((event) => event.toStatus);
    expect(toStatuses).toEqual(["PENDING", "EXPIRED"]);
  });

  it("marks a payment FAILED via the webhook when the checkout fails", async () => {
    const created = await createPayment(e2e);

    const failResponse = await confirmCheckout(created.redirectUrl, "FAIL");
    expect(failResponse.status).toBe(200);

    expect(await getPayment(e2e, created.id)).toMatchObject({ status: "FAILED" });
  });

  it("never treats a checkout redirect alone as proof of payment", async () => {
    const created = await createPayment(e2e);

    expect(await getPayment(e2e, created.id)).toMatchObject({ status: "PENDING" });

    const checkoutPage = await fetch(created.redirectUrl);
    expect(checkoutPage.status).toBe(200);

    expect(await getPayment(e2e, created.id)).toMatchObject({ status: "PENDING" });
    expect(
      e2e.paymentDb.events.filter(
        (event) => event.paymentId === created.id && event.toStatus === "PAID"
      )
    ).toHaveLength(0);
  });

  it("reports healthy dependencies on /v1/health", async () => {
    const response = await fetch(`${e2e.baseUrl}/v1/health`);
    expect(response.status).toBe(200);
    const body = await parseResponse<{
      status: string;
      checks: { database: object; redis: object };
    }>(response);
    expect(body.status).toBe("ok");
    expect(body.checks.database).toMatchObject({ status: "ok" });
    expect(body.checks.redis).toMatchObject({ status: "ok" });
  });
});

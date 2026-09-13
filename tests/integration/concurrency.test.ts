import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MOCK_SIGNATURE_HEADER, signBody } from "../../src/adapters/mock/mock.signature.js";
import {
  buildE2EApp,
  MOCK_SECRET,
  parseResponse,
  providerReferenceFromRedirect,
  type E2EApp,
} from "./helpers.js";

type CreateResponse = { id: string; status: string; redirectUrl: string; reference: string };
type WebhookResponse = { received: boolean; outcome: "applied" | "duplicate" };

function webhookPayload(
  providerReference: string,
  reference: string,
  amount: string
): Record<string, unknown> {
  return {
    event: "payment.completed",
    status: "paid",
    providerReference,
    reference,
    amount,
    currency: "DZD",
    timestamp: new Date().toISOString(),
    signatureVersion: "v1",
  };
}

async function createPayment(e2e: E2EApp): Promise<CreateResponse> {
  return parseResponse<CreateResponse>(
    await fetch(`${e2e.baseUrl}/v1/payments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `idem-${randomUUID()}`,
      },
      body: JSON.stringify({
        reference: `REF-CONC-${randomUUID()}`,
        amount: "1250.00",
        currency: "DZD",
        returnUrl: "https://merchant.example/return",
      }),
    })
  );
}

async function postWebhook(e2e: E2EApp, raw: string, signature: string): Promise<Response> {
  return fetch(`${e2e.baseUrl}/v1/webhooks/mock`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [MOCK_SIGNATURE_HEADER]: signature,
    },
    body: raw,
  });
}

describe("concurrency semantics", () => {
  let e2e: E2EApp;

  beforeAll(async () => {
    e2e = await buildE2EApp();
  });

  afterAll(async () => {
    await e2e.app.close();
  });

  it("parallel creates sharing an Idempotency-Key collapse to a single payment", async () => {
    const key = `idem-race-${randomUUID()}`;
    const body = JSON.stringify({
      reference: `REF-RACE-${randomUUID()}`,
      amount: "99.00",
      currency: "DZD",
      returnUrl: "https://merchant.example/return",
    });

    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        fetch(`${e2e.baseUrl}/v1/payments`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body,
        })
      )
    );

    for (const response of responses) {
      expect([201, 409]).toContain(response.status);
    }
    const rows = [...e2e.paymentDb.payments.values()].filter((p) => p.idempotencyKey === key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.providerReference).not.toBeNull();
  });

  it("regarding a different body with the same Idempotency-Key as a conflict", async () => {
    const key = `idem-conflict-${randomUUID()}`;
    const firstBody = JSON.stringify({
      reference: `REF-CONFLICT-A-${randomUUID()}`,
      amount: "10.00",
      currency: "DZD",
      returnUrl: "https://merchant.example/return",
    });

    const first = await fetch(`${e2e.baseUrl}/v1/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: firstBody,
    });
    expect(first.status).toBe(201);

    const secondBody = JSON.stringify({
      reference: `REF-CONFLICT-B-${randomUUID()}`,
      amount: "9999.00",
      currency: "DZD",
      returnUrl: "https://merchant.example/return",
    });
    const second = await fetch(`${e2e.baseUrl}/v1/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: secondBody,
    });
    expect(second.status).toBe(409);
    const body = await parseResponse<{ error: { code: string } }>(second);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("parallel identical webhooks apply exactly once", async () => {
    const created = await createPayment(e2e);
    const providerReference = providerReferenceFromRedirect(created.redirectUrl);
    const raw = JSON.stringify(webhookPayload(providerReference, created.reference, "1250.00"));
    const signature = signBody(raw, MOCK_SECRET);

    const responses = await Promise.all([1, 2, 3].map(() => postWebhook(e2e, raw, signature)));

    let applied = 0;
    let duplicates = 0;
    let conflicts = 0;
    for (const response of responses) {
      if (response.status === 409) {
        conflicts += 1;
        continue;
      }
      expect(response.status).toBe(200);
      const body = await parseResponse<WebhookResponse>(response);
      if (body.outcome === "applied") {
        applied += 1;
      } else {
        duplicates += 1;
      }
    }

    expect(applied).toBe(1);
    expect(applied + duplicates + conflicts).toBe(responses.length);
    expect(
      e2e.paymentDb.events.filter(
        (event) => event.paymentId === created.id && event.toStatus === "PAID"
      )
    ).toHaveLength(1);
  });

  it("an exact sequential replay is acknowledged as a duplicate with no extra audit", async () => {
    const created = await createPayment(e2e);
    const providerReference = providerReferenceFromRedirect(created.redirectUrl);
    const raw = JSON.stringify(webhookPayload(providerReference, created.reference, "1250.00"));
    const signature = signBody(raw, MOCK_SECRET);

    const first = await postWebhook(e2e, raw, signature);
    expect(first.status).toBe(200);
    expect((await parseResponse<WebhookResponse>(first)).outcome).toBe("applied");

    const second = await postWebhook(e2e, raw, signature);
    expect(second.status).toBe(200);
    expect((await parseResponse<WebhookResponse>(second)).outcome).toBe("duplicate");

    expect(
      e2e.paymentDb.events.filter(
        (event) => event.paymentId === created.id && event.toStatus === "PAID"
      )
    ).toHaveLength(1);
  });

  it("parallel refunds sharing an Idempotency-Key create a single refund", async () => {
    const created = await createPayment(e2e);
    const providerReference = providerReferenceFromRedirect(created.redirectUrl);
    const raw = JSON.stringify(webhookPayload(providerReference, created.reference, "1250.00"));
    const signature = signBody(raw, MOCK_SECRET);
    const applied = await postWebhook(e2e, raw, signature);
    expect(applied.status).toBe(200);

    const key = `rf-race-${randomUUID()}`;
    const responses = await Promise.all(
      [1, 2].map(() =>
        fetch(`${e2e.baseUrl}/v1/payments/${created.id}/refund`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ amount: "200.00", reason: "concurrent" }),
        })
      )
    );

    for (const response of responses) {
      expect([201, 409]).toContain(response.status);
    }
    const rows = [...e2e.paymentDb.refunds.values()].filter((r) => r.idempotencyKey === key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("SUCCEEDED");
  });
});

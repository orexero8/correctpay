import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { MOCK_SIGNATURE_HEADER, signBody } from "../../src/adapters/mock/mock.signature.js";
import { fakePrisma } from "../helpers/fake-prisma.js";
import {
  buildE2EApp,
  MOCK_SECRET,
  parseResponse,
  providerReferenceFromRedirect,
} from "./helpers.js";

type ErrorResponse = { error: { code: string; message: string; details?: unknown } };
type CreateResponse = { id: string; status: string; redirectUrl: string; reference: string };

function webhookPayload(
  providerReference: string,
  reference: string,
  amount: string,
  overrides: Record<string, unknown> = {}
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
    ...overrides,
  };
}

async function createPayment(e2e: { baseUrl: string }): Promise<CreateResponse> {
  const response = await fetch(`${e2e.baseUrl}/v1/payments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `idem-${randomUUID()}`,
    },
    body: JSON.stringify({
      reference: `REF-FAIL-${randomUUID()}`,
      amount: "100.00",
      currency: "DZD",
      returnUrl: "https://merchant.example/return",
    }),
  });
  expect(response.status).toBe(201);
  return parseResponse<CreateResponse>(response);
}

async function postWebhook(baseUrl: string, raw: string, signature: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/webhooks/mock`, {
    method: "POST",
    headers: { "content-type": "application/json", [MOCK_SIGNATURE_HEADER]: signature },
    body: raw,
  });
}

describe("failure handling", () => {
  it("returns 500 and rolls back idempotency when the payment insert fails", async () => {
    const fake = fakePrisma();
    const broken = {
      ...fake.client,
      payment: {
        ...fake.client.payment,
        create: async (): Promise<never> => {
          throw new Error("database unavailable");
        },
      },
    } as unknown as PrismaClient;

    const e2e = await buildE2EApp({ prisma: broken });
    try {
      const response = await fetch(`${e2e.baseUrl}/v1/payments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `idem-fail-${randomUUID()}`,
        },
        body: JSON.stringify({
          reference: `REF-BROKEN-${randomUUID()}`,
          amount: "100.00",
          currency: "DZD",
          returnUrl: "https://merchant.example/return",
        }),
      });
      expect(response.status).toBe(500);
      const body = await parseResponse<ErrorResponse>(response);
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(fake.store.payments.size).toBe(0);
      expect(fake.store.idempotency.size).toBe(0);
    } finally {
      await e2e.app.close();
    }
  });

  it("reports the database as down on /v1/health when it cannot be reached", async () => {
    const fake = fakePrisma();
    const broken = {
      ...fake.client,
      $queryRaw: async (): Promise<never> => {
        throw new Error("connection refused");
      },
    } as unknown as PrismaClient;

    const e2e = await buildE2EApp({ prisma: broken });
    try {
      const response = await fetch(`${e2e.baseUrl}/v1/health`);
      expect(response.status).toBe(503);
      const body = await parseResponse<{
        status: string;
        checks: { database: { status: string }; redis: { status: string } };
      }>(response);
      expect(body.status).toBe("degraded");
      expect(body.checks.database.status).toBe("down");
      expect(body.checks.redis.status).toBe("ok");
    } finally {
      await e2e.app.close();
    }
  });

  it("reports redis as down on /v1/health when it cannot be reached", async () => {
    const base = await buildE2EApp();
    const brokenCache = {
      ...base.cache,
      ping: async (): Promise<never> => {
        throw new Error("redis unavailable");
      },
    } as unknown as Redis;

    const e2e = await buildE2EApp({ prisma: base.client, redis: brokenCache });
    try {
      const response = await fetch(`${e2e.baseUrl}/v1/health`);
      expect(response.status).toBe(503);
      const body = await parseResponse<{
        checks: { redis: { status: string }; database: { status: string } };
      }>(response);
      expect(body.checks.redis.status).toBe("down");
      expect(body.checks.database.status).toBe("ok");
    } finally {
      await e2e.app.close();
      await base.app.close();
    }
  });

  it("rejects a webhook whose amount does not match the payment", async () => {
    const e2e = await buildE2EApp();
    try {
      const created = await createPayment({ baseUrl: e2e.baseUrl });
      const providerReference = providerReferenceFromRedirect(created.redirectUrl);
      const raw = JSON.stringify(webhookPayload(providerReference, created.reference, "9999.00"));

      const response = await postWebhook(e2e.baseUrl, raw, signBody(raw, MOCK_SECRET));
      expect(response.status).toBe(400);
      const body = await parseResponse<ErrorResponse>(response);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const stored = [...e2e.paymentDb.payments.values()].find((p) => p.id === created.id);
      expect(stored?.status).toBe("PENDING");
    } finally {
      await e2e.app.close();
    }
  });

  it("returns 404 for a webhook whose provider reference is unknown", async () => {
    const e2e = await buildE2EApp();
    try {
      const raw = JSON.stringify(webhookPayload("mock_does_not_exist", "REF-GHOST", "100.00"));
      const response = await postWebhook(e2e.baseUrl, raw, signBody(raw, MOCK_SECRET));
      expect(response.status).toBe(404);
      const body = await parseResponse<ErrorResponse>(response);
      expect(body.error.code).toBe("NOT_FOUND");
    } finally {
      await e2e.app.close();
    }
  });

  it("rejects a webhook with a missing signature", async () => {
    const e2e = await buildE2EApp();
    try {
      const raw = JSON.stringify(webhookPayload("mock_any", "REF-ANY", "100.00"));
      const response = await fetch(`${e2e.baseUrl}/v1/webhooks/mock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(response.status).toBe(401);
      const body = await parseResponse<ErrorResponse>(response);
      expect(body.error.code).toBe("WEBHOOK_VERIFICATION_FAILED");
    } finally {
      await e2e.app.close();
    }
  });

  it("rejects a webhook with a malformed JSON body", async () => {
    const e2e = await buildE2EApp();
    try {
      const raw = "this is not json";
      const response = await postWebhook(e2e.baseUrl, raw, signBody(raw, MOCK_SECRET));
      expect(response.status).toBe(400);
      const body = await parseResponse<ErrorResponse>(response);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await e2e.app.close();
    }
  });

  it("rejects an unknown webhook event value", async () => {
    const e2e = await buildE2EApp();
    try {
      const raw = JSON.stringify(
        webhookPayload("mock_any", "REF-ANY", "100.00", { event: "payment.refunded" })
      );
      const response = await postWebhook(e2e.baseUrl, raw, signBody(raw, MOCK_SECRET));
      expect(response.status).toBe(400);
      const body = await parseResponse<ErrorResponse>(response);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await e2e.app.close();
    }
  });

  it("rejects an inconsistent webhook event/status pair", async () => {
    const e2e = await buildE2EApp();
    try {
      const raw = JSON.stringify(
        webhookPayload("mock_any", "REF-ANY", "100.00", { status: "failed" })
      );
      const response = await postWebhook(e2e.baseUrl, raw, signBody(raw, MOCK_SECRET));
      expect(response.status).toBe(400);
      const body = await parseResponse<ErrorResponse>(response);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await e2e.app.close();
    }
  });

  it("refuses a refund while the payment is still pending", async () => {
    const e2e = await buildE2EApp();
    try {
      const created = await createPayment({ baseUrl: e2e.baseUrl });
      const response = await fetch(`${e2e.baseUrl}/v1/payments/${created.id}/refund`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `rf-${randomUUID()}` },
        body: JSON.stringify({ amount: "10.00" }),
      });
      expect(response.status).toBe(409);
      const body = await parseResponse<ErrorResponse>(response);
      expect(body.error.code).toBe("INVALID_STATE_TRANSITION");
    } finally {
      await e2e.app.close();
    }
  });

  it("validates payment ids on the read path", async () => {
    const e2e = await buildE2EApp();
    try {
      const response = await fetch(`${e2e.baseUrl}/v1/payments/not-a-uuid`);
      expect(response.status).toBe(400);
      const body = await parseResponse<ErrorResponse>(response);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await e2e.app.close();
    }
  });
});

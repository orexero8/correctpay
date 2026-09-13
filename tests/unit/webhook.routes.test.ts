import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import type { MockWebhookPayload } from "../../src/adapters/mock/mock.callback.js";
import { MOCK_SIGNATURE_HEADER, signBody } from "../../src/adapters/mock/mock.signature.js";
import { registerMockWebhookRoutes } from "../../src/api/routes/webhooks.routes.js";
import { registerErrorHandler } from "../../src/api/error-handler.js";
import { WebhookProcessor } from "../../src/core/webhook.service.js";
import { fakePrisma, makePayment } from "../helpers/fake-prisma.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const PROVIDER_REFERENCE = "mock_provider_ref";
const REFERENCE = "REF-WEBHOOK-1";
const AMOUNT = "2500.00";

type WebhookResponse = { received: boolean; outcome: "applied" | "duplicate" };
type ErrorResponse = { error: { code: string; message: string } };

function parseBody<T = Record<string, unknown>>(response: { json(): unknown }): T {
  return response.json() as T;
}

function build(): { app: FastifyInstance; prismaStore: ReturnType<typeof fakePrisma>["store"] } {
  const { client, store } = fakePrisma();
  const app = Fastify();
  registerMockWebhookRoutes(app, { secret: SECRET, processor: new WebhookProcessor(client) });
  registerErrorHandler(app);
  return { app, prismaStore: store };
}

function seedPendingPayment(
  store: ReturnType<typeof fakePrisma>["store"],
  overrides?: { providerReference?: string; reference?: string; amount?: string }
): string {
  const id = randomUUID();
  store.addPayment(
    makePayment({
      id,
      reference: overrides?.reference ?? REFERENCE,
      amount: new Prisma.Decimal(overrides?.amount ?? AMOUNT),
      currency: "DZD",
      status: "PENDING",
      provider: "mock",
      providerReference: overrides?.providerReference ?? PROVIDER_REFERENCE,
      idempotencyKey: randomUUID(),
    })
  );
  return id;
}

function makePayload(overrides: Partial<MockWebhookPayload>): MockWebhookPayload {
  return {
    event: "payment.completed",
    status: "paid",
    providerReference: PROVIDER_REFERENCE,
    reference: REFERENCE,
    amount: AMOUNT,
    currency: "DZD",
    timestamp: new Date().toISOString(),
    signatureVersion: "v1",
    ...overrides,
  };
}

describe("mock webhook route", () => {
  let app: FastifyInstance;
  let prismaStore: ReturnType<typeof build>["prismaStore"];

  beforeEach(() => {
    const built = build();
    app = built.app;
    prismaStore = built.prismaStore;
  });

  afterEach(async () => {
    await app.close();
  });

  async function postWebhook(payload: MockWebhookPayload | string): Promise<{
    statusCode: number;
    json(): unknown;
  }> {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/v1/webhooks/mock",
      payload: raw,
      headers: {
        "content-type": "application/json",
        [MOCK_SIGNATURE_HEADER]: signBody(raw, SECRET),
      },
    });
  }

  it("applies a completed event: PENDING -> PROCESSING -> PAID with audit events", async () => {
    seedPendingPayment(prismaStore);
    const response = await postWebhook(makePayload({}));

    expect(response.statusCode).toBe(200);
    expect(parseBody<WebhookResponse>(response).outcome).toBe("applied");

    const payment = [...prismaStore.payments.values()][0];
    expect(payment?.status).toBe("PAID");
    const transitions = prismaStore.events
      .filter((event) => event.source === "webhook")
      .map((event) => `${event.fromStatus}->${event.toStatus}`);
    expect(transitions).toEqual(["PENDING->PROCESSING", "PROCESSING->PAID"]);
    const applied = prismaStore.events.find((event) => event.toStatus === "PAID");
    expect(applied?.payloadHash).not.toBeNull();
    expect(applied?.payloadHash).not.toBe("");
  });

  it("acknowledges an exact replays as duplicate without a second audit event", async () => {
    seedPendingPayment(prismaStore);
    const raw = JSON.stringify(makePayload({}));
    const first = await postWebhook(raw);
    const second = await postWebhook(raw);

    expect(parseBody<WebhookResponse>(first).outcome).toBe("applied");
    expect(parseBody<WebhookResponse>(second).outcome).toBe("duplicate");
    expect(prismaStore.events.filter((event) => event.toStatus === "PAID")).toHaveLength(1);
  });

  it("acknowledges a re-sent completed event once the payment is already PAID", async () => {
    seedPendingPayment(prismaStore);
    await postWebhook(makePayload({}));
    const resend = await postWebhook(
      makePayload({ timestamp: new Date(Date.now() + 1_000).toISOString() })
    );
    expect(parseBody<WebhookResponse>(resend).outcome).toBe("duplicate");
    expect([...prismaStore.payments.values()][0]?.status).toBe("PAID");
  });

  it("applies a failed event through PROCESSING", async () => {
    seedPendingPayment(prismaStore);
    const response = await postWebhook(makePayload({ event: "payment.failed", status: "failed" }));
    expect(parseBody<WebhookResponse>(response).outcome).toBe("applied");
    expect([...prismaStore.payments.values()][0]?.status).toBe("FAILED");
  });

  it("applies a cancelled event directly to EXPIRED", async () => {
    seedPendingPayment(prismaStore);
    const response = await postWebhook(
      makePayload({ event: "payment.cancelled", status: "expired" })
    );
    expect(parseBody<WebhookResponse>(response).outcome).toBe("applied");
    expect([...prismaStore.payments.values()][0]?.status).toBe("EXPIRED");
    const transitions = prismaStore.events
      .filter((event) => event.source === "webhook")
      .map((event) => `${event.fromStatus}->${event.toStatus}`);
    expect(transitions).toEqual(["PENDING->EXPIRED"]);
  });

  it("rejects a missing signature", async () => {
    seedPendingPayment(prismaStore);
    const raw = JSON.stringify(makePayload({}));
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/mock",
      payload: raw,
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(401);
    expect(parseBody<ErrorResponse>(response).error.code).toBe("WEBHOOK_VERIFICATION_FAILED");
    expect([...prismaStore.payments.values()][0]?.status).toBe("PENDING");
  });

  it("rejects an invalid signature", async () => {
    seedPendingPayment(prismaStore);
    const raw = JSON.stringify(makePayload({}));
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/mock",
      payload: raw,
      headers: {
        "content-type": "application/json",
        [MOCK_SIGNATURE_HEADER]: signBody(raw, "deadbeefdeadbeefdeadbeefdeadbeef"),
      },
    });
    expect(response.statusCode).toBe(401);
    expect(parseBody<ErrorResponse>(response).error.code).toBe("WEBHOOK_VERIFICATION_FAILED");
  });

  it("rejects an amount mismatch", async () => {
    seedPendingPayment(prismaStore);
    const response = await postWebhook(makePayload({ amount: "999.00" }));
    expect(response.statusCode).toBe(400);
    expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
    expect([...prismaStore.payments.values()][0]?.status).toBe("PENDING");
  });

  it("rejects a currency mismatch", async () => {
    seedPendingPayment(prismaStore);
    const response = await postWebhook(makePayload({ currency: "EUR" }));
    expect(response.statusCode).toBe(400);
    expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a reference mismatch", async () => {
    seedPendingPayment(prismaStore);
    const response = await postWebhook(makePayload({ reference: "REF-OTHER" }));
    expect(response.statusCode).toBe(400);
    expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the provider reference is unknown", async () => {
    const response = await postWebhook(makePayload({ providerReference: "mock_unknown" }));
    expect(response.statusCode).toBe(404);
    expect(parseBody<ErrorResponse>(response).error.code).toBe("NOT_FOUND");
  });

  it("rejects a non-JSON body with 400", async () => {
    seedPendingPayment(prismaStore);
    const response = await postWebhook("this is not json");
    expect(response.statusCode).toBe(400);
    expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
    expect([...prismaStore.payments.values()][0]?.status).toBe("PENDING");
  });

  it("rejects an unknown event value", async () => {
    seedPendingPayment(prismaStore);
    const response = await postWebhook(
      makePayload({ event: "payment.charged" as MockWebhookPayload["event"] })
    );
    expect(response.statusCode).toBe(400);
    expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an inconsistent event/status pair", async () => {
    seedPendingPayment(prismaStore);
    const response = await postWebhook(
      makePayload({ event: "payment.completed", status: "failed" })
    );
    expect(response.statusCode).toBe(400);
    expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a late conflicting cancelled event after the payment was PAID", async () => {
    seedPendingPayment(prismaStore);
    await postWebhook(makePayload({}));
    const late = await postWebhook(
      makePayload({
        event: "payment.cancelled",
        status: "expired",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      })
    );
    expect(late.statusCode).toBe(409);
    expect(parseBody<ErrorResponse>(late).error.code).toBe("INVALID_STATE_TRANSITION");
    expect([...prismaStore.payments.values()][0]?.status).toBe("PAID");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";
import type { PaymentProviderAdapter } from "../../src/adapters/provider.interface.js";
import { MockAdapter, MockProviderStore } from "../../src/adapters/mock/index.js";
import { IdempotencyService } from "../../src/core/idempotency.service.js";
import { PaymentService } from "../../src/core/payment.service.js";
import { RefundService } from "../../src/core/refund.service.js";
import { registerPaymentRoutes } from "../../src/api/routes/payments.routes.js";
import { registerErrorHandler } from "../../src/api/error-handler.js";
import { fakePrisma, makePayment } from "../helpers/fake-prisma.js";
import { createFakeRedis } from "../helpers/fake-redis.js";

const BASE_URL = "http://localhost:3957";

const createBody = {
  reference: "REF-93821",
  amount: "2500.00",
  currency: "DZD",
  returnUrl: "https://example.dz/payment/return",
};

type CreatePaymentResponse = {
  id: string;
  status: string;
  redirectUrl: string;
  reference: string;
};

type PaymentResponse = {
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
};

type ErrorResponse = { error: { code: string; message: string } };

function parseBody<T = Record<string, unknown>>(response: { json(): unknown }): T {
  return response.json() as T;
}

function build(): {
  app: FastifyInstance;
  prismaStore: ReturnType<typeof fakePrisma>["store"];
  providerStore: MockProviderStore;
} {
  const { client, store } = fakePrisma();
  const redisClient = createFakeRedis();
  const idempotency = new IdempotencyService(client, redisClient as unknown as Redis);
  const providerStore = new MockProviderStore();
  const providers = new Map<string, PaymentProviderAdapter>([
    ["mock", new MockAdapter(providerStore, { baseUrl: BASE_URL })],
  ]);

  const app = Fastify();
  registerPaymentRoutes(app, {
    paymentService: new PaymentService(client, idempotency, providers, "mock"),
    refundService: new RefundService(client, idempotency, providers),
  });
  registerErrorHandler(app);
  return { app, prismaStore: store, providerStore };
}

function idempotent(headers: Record<string, string>): Record<string, string> {
  return { "content-type": "application/json", ...headers };
}

describe("payment API routes", () => {
  let app: FastifyInstance;
  let prismaStore: ReturnType<typeof build>["prismaStore"];
  let providerStore: MockProviderStore;

  beforeEach(() => {
    const built = build();
    app = built.app;
    prismaStore = built.prismaStore;
    providerStore = built.providerStore;
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /v1/payments", () => {
    it("creates a PENDING payment and returns a checkout redirect", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: createBody,
        headers: idempotent({ "Idempotency-Key": "idem-create-1" }),
      });

      expect(response.statusCode).toBe(201);
      const body = parseBody<CreatePaymentResponse>(response);
      expect(body.status).toBe("PENDING");
      expect(body.reference).toBe("REF-93821");
      expect(body.redirectUrl).toContain("/mock/checkout/");
      expect(body.id).toBeDefined();

      const payment = [...prismaStore.payments.values()][0];
      expect(payment?.status).toBe("PENDING");
      expect(payment?.providerReference).toMatch(/^mock_/);
      expect(prismaStore.idempotency.get("idem-create-1")?.status).toBe("completed");
      expect(providerStore.get(payment?.providerReference ?? "")?.status).toBe("pending");
    });

    it("requires an Idempotency-Key header", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: createBody,
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
      expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an invalid amount", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: { ...createBody, amount: "-5.00" },
        headers: idempotent({ "Idempotency-Key": "idem-create-2" }),
      });
      expect(response.statusCode).toBe(400);
      expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an invalid currency", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: { ...createBody, currency: "dz" },
        headers: idempotent({ "Idempotency-Key": "idem-create-3" }),
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a non-http return URL", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: { ...createBody, returnUrl: "ftp://example.dz/x" },
        headers: idempotent({ "Idempotency-Key": "idem-create-4" }),
      });
      expect(response.statusCode).toBe(400);
    });

    it("replays the same Idempotency-Key with the original result", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: createBody,
        headers: idempotent({ "Idempotency-Key": "idem-create-5" }),
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: createBody,
        headers: idempotent({ "Idempotency-Key": "idem-create-5" }),
      });

      expect(second.statusCode).toBe(201);
      expect(parseBody<CreatePaymentResponse>(second)).toEqual(
        parseBody<CreatePaymentResponse>(first)
      );
      expect(prismaStore.payments.size).toBe(1);
    });

    it("rejects the same Idempotency-Key reused with a different body", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: createBody,
        headers: idempotent({ "Idempotency-Key": "idem-create-6" }),
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: { ...createBody, amount: "999.00" },
        headers: idempotent({ "Idempotency-Key": "idem-create-6" }),
      });
      expect(second.statusCode).toBe(409);
      expect(parseBody<ErrorResponse>(second).error.code).toBe("CONFLICT");
    });

    it("rejects a reused reference even with a fresh key", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: createBody,
        headers: idempotent({ "Idempotency-Key": "idem-create-7" }),
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: createBody,
        headers: idempotent({ "Idempotency-Key": "idem-create-8" }),
      });
      expect(second.statusCode).toBe(409);
      expect(parseBody<ErrorResponse>(second).error.code).toBe("CONFLICT");
    });
  });

  describe("GET /v1/payments/:id", () => {
    it("returns the payment without provider internals", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/v1/payments",
        payload: createBody,
        headers: idempotent({ "Idempotency-Key": "idem-get-1" }),
      });
      const id = parseBody<CreatePaymentResponse>(created).id;

      const response = await app.inject({ method: "GET", url: `/v1/payments/${id}` });
      expect(response.statusCode).toBe(200);
      const body = parseBody<PaymentResponse>(response);
      expect(body.id).toBe(id);
      expect(body.reference).toBe("REF-93821");
      expect(body.amount).toBe("2500.00");
      expect(body.currency).toBe("DZD");
      expect(body.status).toBe("PENDING");
      expect(typeof body.createdAt).toBe("string");
      expect(typeof body.updatedAt).toBe("string");
      expect("providerReference" in body).toBe(false);
      expect("provider" in body).toBe(false);
    });

    it("returns 404 for an unknown payment", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/payments/00000000-0000-4000-8000-000000000000",
      });
      expect(response.statusCode).toBe(404);
      expect(parseBody<ErrorResponse>(response).error.code).toBe("NOT_FOUND");
    });

    it("returns 400 for a malformed payment id", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/payments/not-a-uuid" });
      expect(response.statusCode).toBe(400);
      expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /v1/payments/:id/refund", () => {
    async function seedPaidPayment(refId: string, amount: string): Promise<string> {
      const transaction = providerStore.createTransaction({
        reference: `REF-${refId}`,
        amount,
        currency: "DZD",
        returnUrl: "https://example.dz/payment/return",
        metadata: null,
      });
      providerStore.confirm(transaction.providerReference, "paid");
      const paymentId = `00000000-0000-4000-8000-00000000000${refId.slice(-1)}`;
      prismaStore.addPayment(
        makePayment({
          id: paymentId,
          reference: `REF-${refId}`,
          amount: new Prisma.Decimal(amount),
          status: "PAID",
          provider: "mock",
          providerReference: transaction.providerReference,
          idempotencyKey: "seed-key",
        })
      );
      return paymentId;
    }

    it("refunds a paid payment and marks it partially refunded", async () => {
      const paymentId = await seedPaidPayment("R1", "1000.00");

      const response = await app.inject({
        method: "POST",
        url: `/v1/payments/${paymentId}/refund`,
        payload: { amount: "400.00", reason: "customer cancellation" },
        headers: idempotent({ "Idempotency-Key": "idem-refund-1" }),
      });

      expect(response.statusCode).toBe(201);
      const body = parseBody<RefundResponse>(response);
      expect(body.paymentId).toBe(paymentId);
      expect(body.amount).toBe("400.00");
      expect(body.status).toBe("SUCCEEDED");
      expect(body.providerReference).toMatch(/^mock_refund_/);

      const get = await app.inject({ method: "GET", url: `/v1/payments/${paymentId}` });
      expect(parseBody<PaymentResponse>(get).status).toBe("PARTIALLY_REFUNDED");
    });

    it("marks the payment fully refunded once the balance is exhausted", async () => {
      const paymentId = await seedPaidPayment("R2", "1000.00");
      await app.inject({
        method: "POST",
        url: `/v1/payments/${paymentId}/refund`,
        payload: { amount: "400.00" },
        headers: idempotent({ "Idempotency-Key": "idem-refund-2" }),
      });
      const full = await app.inject({
        method: "POST",
        url: `/v1/payments/${paymentId}/refund`,
        payload: { amount: "600.00" },
        headers: idempotent({ "Idempotency-Key": "idem-refund-3" }),
      });
      expect(full.statusCode).toBe(201);
      expect(parseBody<RefundResponse>(full).status).toBe("SUCCEEDED");

      const get = await app.inject({ method: "GET", url: `/v1/payments/${paymentId}` });
      expect(parseBody<PaymentResponse>(get).status).toBe("FULLY_REFUNDED");
    });

    it("rejects a refund that exceeds the remaining balance", async () => {
      const paymentId = await seedPaidPayment("R3", "1000.00");
      const response = await app.inject({
        method: "POST",
        url: `/v1/payments/${paymentId}/refund`,
        payload: { amount: "2000.00" },
        headers: idempotent({ "Idempotency-Key": "idem-refund-4" }),
      });
      expect(response.statusCode).toBe(400);
      expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects refunding a non-paid payment", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/payments/00000000-0000-4000-8000-000000000000/refund",
        payload: { amount: "100.00" },
        headers: idempotent({ "Idempotency-Key": "idem-refund-5" }),
      });
      expect(response.statusCode).toBe(404);
    });

    it("requires an Idempotency-Key header", async () => {
      const paymentId = await seedPaidPayment("R4", "1000.00");
      const response = await app.inject({
        method: "POST",
        url: `/v1/payments/${paymentId}/refund`,
        payload: { amount: "100.00" },
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
      expect(parseBody<ErrorResponse>(response).error.code).toBe("VALIDATION_ERROR");
    });

    it("replays the same refund Idempotency-Key", async () => {
      const paymentId = await seedPaidPayment("R5", "1000.00");
      const first = await app.inject({
        method: "POST",
        url: `/v1/payments/${paymentId}/refund`,
        payload: { amount: "100.00" },
        headers: idempotent({ "Idempotency-Key": "idem-refund-6" }),
      });
      const second = await app.inject({
        method: "POST",
        url: `/v1/payments/${paymentId}/refund`,
        payload: { amount: "100.00" },
        headers: idempotent({ "Idempotency-Key": "idem-refund-6" }),
      });
      expect(second.statusCode).toBe(201);
      expect(parseBody<RefundResponse>(second)).toEqual(parseBody<RefundResponse>(first));
      expect(prismaStore.refunds.size).toBe(1);
    });
  });
});

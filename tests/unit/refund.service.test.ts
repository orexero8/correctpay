import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";
import type {
  PaymentProviderAdapter,
  RefundResult,
} from "../../src/adapters/provider.interface.js";
import { RefundService, type RefundDto } from "../../src/core/refund.service.js";
import { IdempotencyService } from "../../src/core/idempotency.service.js";
import {
  AppError,
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from "../../src/shared/errors.js";
import { fakePrisma, makePayment, type PaymentStore } from "../helpers/fake-prisma.js";
import { createFakeRedis } from "../helpers/fake-redis.js";

const DEFAULT_PAYMENT_AMOUNT = "1000.00";
const REFUND_AMOUNT = "500.00";

function makeProvider(overrides?: Partial<PaymentProviderAdapter>): PaymentProviderAdapter {
  return {
    async createPayment() {
      return { providerReference: "mock-ref", redirectUrl: "https://checkout.mock/1", raw: {} };
    },
    async getPaymentStatus() {
      return { status: "pending", raw: {} };
    },
    async refundPayment(): Promise<RefundResult> {
      return {
        providerRefundReference: "mock-refund-1",
        status: "succeeded",
        raw: {},
      };
    },
    ...overrides,
  };
}

function setup(opts?: { paymentStatus?: string; paymentAmount?: string }): {
  service: RefundService;
  store: PaymentStore;
  paymentId: string;
} {
  const paymentId = "pay-1";
  const { client, store } = fakePrisma();
  store.addPayment(
    makePayment({
      id: paymentId,
      status: opts?.paymentStatus ?? "PAID",
      amount: new Prisma.Decimal(opts?.paymentAmount ?? DEFAULT_PAYMENT_AMOUNT),
      providerReference: "provider-ref-1",
      provider: "mock",
    })
  );
  const redis = createFakeRedis();
  const idempotency = new IdempotencyService(client, redis as unknown as Redis);
  const providers = new Map<string, PaymentProviderAdapter>([["mock", makeProvider()]]);
  const service = new RefundService(client, idempotency, providers);
  return { service, store, paymentId };
}

function setupFailed(opts?: { providerStatus?: string }): {
  service: RefundService;
  store: PaymentStore;
  paymentId: string;
} {
  const providerStatus = opts?.providerStatus ?? "failed";
  const failingProvider: PaymentProviderAdapter = {
    async createPayment() {
      throw new Error("unexpected");
    },
    async getPaymentStatus() {
      return { status: "pending", raw: {} };
    },
    async refundPayment(): Promise<RefundResult> {
      return {
        providerRefundReference: "ref",
        status: providerStatus as RefundResult["status"],
        raw: {},
      };
    },
  };
  const paymentId = "pay-1";
  const { client, store } = fakePrisma();
  store.addPayment(
    makePayment({
      id: paymentId,
      status: "PAID",
      amount: new Prisma.Decimal(DEFAULT_PAYMENT_AMOUNT),
      providerReference: "provider-ref-1",
      provider: "mock",
    })
  );
  const redis = createFakeRedis();
  const idempotency = new IdempotencyService(client, redis as unknown as Redis);
  const providers = new Map<string, PaymentProviderAdapter>([["mock", failingProvider]]);
  const service = new RefundService(client, idempotency, providers);
  return { service, store, paymentId };
}

function expectSucceeded(dto: RefundDto, overrides?: Partial<RefundDto>): void {
  expect(dto.status).toBe("SUCCEEDED");
  expect(dto.paymentId).toBe("pay-1");
  expect(dto.providerReference).toBeDefined();
  expect(dto.id).toBeDefined();
  if (overrides?.amount !== undefined) {
    expect(dto.amount).toBe(overrides.amount);
  }
  if (overrides?.reason !== undefined) {
    expect(dto.reason).toBe(overrides.reason);
  }
}

describe("RefundService.createRefund", () => {
  it("marks a full refund SUCCEEDED and transitions PAID → FULLY_REFUNDED", async () => {
    const { service, store, paymentId } = setup();
    const dto = await service.createRefund(
      paymentId,
      { amount: DEFAULT_PAYMENT_AMOUNT, reason: "full" },
      "idem-refund-1"
    );
    expectSucceeded(dto, { amount: DEFAULT_PAYMENT_AMOUNT, reason: "full" });
    expect(store.payments.get(paymentId)?.status).toBe("FULLY_REFUNDED");
    expect(store.refunds.size).toBe(1);
    expect(store.events.some((e) => e.toStatus === "FULLY_REFUNDED")).toBe(true);
  });

  it("marks a partial refund SUCCEEDED and transitions PAID → PARTIALLY_REFUNDED", async () => {
    const { service, store, paymentId } = setup();
    const dto = await service.createRefund(paymentId, { amount: REFUND_AMOUNT }, "idem-refund-1");
    expectSucceeded(dto, { amount: REFUND_AMOUNT });
    expect(store.payments.get(paymentId)?.status).toBe("PARTIALLY_REFUNDED");
  });

  it("completes from PARTIALLY_REFUNDED → FULLY_REFUNDED when the remaining balance is exhausted", async () => {
    const { service, store, paymentId } = setup({ paymentStatus: "PARTIALLY_REFUNDED" });
    // A prior partial refund already reduced the balance by half.
    store.refunds.set("prior-refund", {
      id: "prior-refund",
      paymentId,
      amount: new Prisma.Decimal("500.00"),
      status: "SUCCEEDED",
      providerReference: "prior-ref",
      reason: "prior",
      idempotencyKey: "idem-prior",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const dto = await service.createRefund(paymentId, { amount: "500.00" }, "idem-refund-1");
    expectSucceeded(dto);
    expect(store.payments.get(paymentId)?.status).toBe("FULLY_REFUNDED");
  });

  it("leaves PARTIALLY_REFUNDED when a second refund does not exhaust the balance", async () => {
    const { service, store, paymentId } = setup({
      paymentStatus: "PARTIALLY_REFUNDED",
      paymentAmount: "2000.00",
    });
    const dto = await service.createRefund(paymentId, { amount: "500.00" }, "idem-refund-1");
    expectSucceeded(dto, { amount: "500.00" });
    expect(store.payments.get(paymentId)?.status).toBe("PARTIALLY_REFUNDED");
  });

  it("rejects a refund amount exceeding the remaining refundable balance", async () => {
    const { service, store, paymentId } = setup();
    // Pre-existing partial refund reduces balance to 500.
    store.refunds.set("existing-refund", {
      id: "existing-refund",
      paymentId,
      amount: new Prisma.Decimal("600.00"),
      status: "SUCCEEDED",
      providerReference: "existing-ref",
      reason: "prior",
      idempotencyKey: "idem-existing",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      service.createRefund(paymentId, { amount: "500.00" }, "idem-refund-1")
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects refund on a PENDING payment", async () => {
    const { service, paymentId } = setup({ paymentStatus: "PENDING" });
    await expect(
      service.createRefund(paymentId, { amount: REFUND_AMOUNT }, "idem-refund-1")
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("rejects refund on a FAILED payment", async () => {
    const { service, paymentId } = setup({ paymentStatus: "FAILED" });
    await expect(
      service.createRefund(paymentId, { amount: REFUND_AMOUNT }, "idem-refund-1")
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("throws NotFoundError for an unknown payment", async () => {
    const { service } = setup();
    await expect(
      service.createRefund("missing", { amount: REFUND_AMOUNT }, "idem-refund-1")
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("validates the amount format before any provider or database calls", async () => {
    const { service, paymentId } = setup();
    await expect(
      service.createRefund(paymentId, { amount: "not-a-number" }, "idem-refund-1")
    ).rejects.toThrow(/amount/);
  });

  it("validates the amount is above zero", async () => {
    const { service, paymentId } = setup();
    await expect(
      service.createRefund(paymentId, { amount: "0" }, "idem-refund-1")
    ).rejects.toThrow();
  });
});

describe("RefundService idempotency", () => {
  it("returns the same DTO for an identical key and payload", async () => {
    const { service, paymentId } = setup();
    const first = await service.createRefund(paymentId, { amount: REFUND_AMOUNT }, "idem-1");
    const second = await service.createRefund(paymentId, { amount: REFUND_AMOUNT }, "idem-1");
    expect(second).toEqual(first);
  });

  it("rejects the same key with a different payload via ConflictError", async () => {
    const { service, paymentId } = setup();
    await service.createRefund(paymentId, { amount: "100.00" }, "idem-1");
    await expect(
      service.createRefund(paymentId, { amount: "200.00" }, "idem-1")
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("RefundService provider failures", () => {
  it("marks the refund row FAILED and abandons the idempotency key on provider error", async () => {
    const { service, store, paymentId } = setupFailed({ providerStatus: "failed" });
    await expect(
      service.createRefund(paymentId, { amount: REFUND_AMOUNT }, "idem-1")
    ).rejects.toBeInstanceOf(AppError);
    const refund = Array.from(store.refunds.values())[0];
    expect(refund?.status).toBe("FAILED");
    expect(store.idempotency.has("idem-1")).toBe(false);
    expect(store.payments.get(paymentId)?.status).toBe("PAID");
  });

  it("propagates a generic provider error as PROVIDER_ERROR on the refund path", async () => {
    const throwingProvider: PaymentProviderAdapter = {
      async createPayment() {
        throw new Error("unexpected");
      },
      async getPaymentStatus() {
        return { status: "pending", raw: {} };
      },
      async refundPayment(): Promise<RefundResult> {
        throw new Error("provider refund outage");
      },
    };
    const paymentId = "pay-1";
    const { client, store } = fakePrisma();
    store.addPayment(
      makePayment({ id: paymentId, status: "PAID", providerReference: "ref-1", provider: "mock" })
    );
    const redis = createFakeRedis();
    const idempotency = new IdempotencyService(client, redis as unknown as Redis);
    const providers = new Map([["mock", throwingProvider]]);
    const service = new RefundService(client, idempotency, providers);
    const error = await service.createRefund(paymentId, { amount: REFUND_AMOUNT }, "idem-1").then(
      () => null,
      (e: unknown) => e
    );
    expect((error as { code: string }).code).toBe("PROVIDER_ERROR");
    expect((error as { message: string }).message).toContain("provider refund outage");
    expect(store.payments.get(paymentId)?.status).toBe("PAID");
  });

  it("preserves the original AppError when the provider throws one", async () => {
    const customErrorProvider: PaymentProviderAdapter = {
      async createPayment() {
        throw new Error("unexpected");
      },
      async getPaymentStatus() {
        return { status: "pending", raw: {} };
      },
      async refundPayment(): Promise<RefundResult> {
        throw new ConflictError("CIB duplicate refund");
      },
    };
    const paymentId = "pay-1";
    const { client, store } = fakePrisma();
    store.addPayment(
      makePayment({ id: paymentId, status: "PAID", providerReference: "ref-1", provider: "mock" })
    );
    const redis = createFakeRedis();
    const idempotency = new IdempotencyService(client, redis as unknown as Redis);
    const providers = new Map([["mock", customErrorProvider]]);
    const service = new RefundService(client, idempotency, providers);
    await expect(
      service.createRefund(paymentId, { amount: REFUND_AMOUNT }, "idem-1")
    ).rejects.toThrow("CIB duplicate refund");
  });
});

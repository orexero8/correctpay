import { beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";
import type {
  CreatePaymentResult,
  PaymentProviderAdapter,
} from "../../src/adapters/provider.interface.js";
import { PaymentService, type CreatePaymentResultDto } from "../../src/core/payment.service.js";
import { ConflictError, NotFoundError } from "../../src/shared/errors.js";
import { fakePrisma } from "../helpers/fake-prisma.js";
import { createFakeRedis } from "../helpers/fake-redis.js";
import { IdempotencyService } from "../../src/core/idempotency.service.js";

const createInput = {
  reference: "REF-93821",
  amount: "2500.00",
  currency: "DZD",
  returnUrl: "https://example.dz/payment/return",
};

function makeProvider(overrides?: Partial<PaymentProviderAdapter>): PaymentProviderAdapter {
  return {
    async createPayment(): Promise<CreatePaymentResult> {
      return { providerReference: "mock-ref-1", redirectUrl: "https://checkout.mock/1", raw: {} };
    },
    async getPaymentStatus() {
      return { status: "pending", raw: {} };
    },
    async refundPayment() {
      return {
        providerRefundReference: "mock-refund-1",
        status: "succeeded",
        raw: {},
      };
    },
    ...overrides,
  };
}

function build(): {
  service: PaymentService;
  store: ReturnType<typeof fakePrisma>["store"];
} {
  const { client, store } = fakePrisma();
  const redis = createFakeRedis();
  const idempotency = new IdempotencyService(client, redis as unknown as Redis);
  const providers = new Map<string, PaymentProviderAdapter>([["mock", makeProvider()]]);
  const service = new PaymentService(client, idempotency, providers, "mock");
  return { service, store };
}

function expectPending(result: CreatePaymentResultDto): void {
  expect(result.status).toBe("PENDING");
  expect(result.redirectUrl).toBe("https://checkout.mock/1");
  expect(result.reference).toBe(createInput.reference);
  expect(result.id).toBeDefined();
}

describe("PaymentService.createPayment", () => {
  let setup: ReturnType<typeof build>;

  beforeEach(() => {
    setup = build();
  });

  it("creates the payment, stores the provider reference and transitions CREATED -> PENDING", async () => {
    const result = await setup.service.createPayment(createInput, "idem-key-1");
    expectPending(result);

    const payment = storePayment(setup, result.id);
    expect(payment.status).toBe("PENDING");
    expect(payment.providerReference).toBe("mock-ref-1");
    expect(payment.currency).toBe("DZD");
    expect(payment.amount.toFixed(2)).toBe("2500.00");
    expect(payment.provider).toBe("mock");

    expect(setup.store.events.some((e) => e.toStatus === "PENDING" && e.source === "api")).toBe(
      true
    );
    expect(setup.store.idempotency.get("idem-key-1")?.status).toBe("completed");
  });

  it("is idempotent: same key + same request returns the original result", async () => {
    const first = await setup.service.createPayment(createInput, "idem-key-1");
    const second = await setup.service.createPayment(createInput, "idem-key-1");
    expect(second).toEqual(first);
    expect(storeCount(setup, "payments")).toBe(1);
  });

  it("rejects the same key used with a different request", async () => {
    await setup.service.createPayment(createInput, "idem-key-1");
    await expect(
      setup.service.createPayment({ ...createInput, amount: "999.00" }, "idem-key-1")
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a reused reference", async () => {
    await setup.service.createPayment(createInput, "idem-key-1");
    await expect(setup.service.createPayment(createInput, "idem-key-2")).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(storeCount(setup, "idempotency")).toBe(1);
  });

  it("cleans up on provider failure so the key can be retried", async () => {
    const failing = makeProvider({
      async createPayment() {
        throw new Error("provider down");
      },
    });
    const { client, store } = fakePrisma();
    const redis = createFakeRedis();
    const idempotency = new IdempotencyService(client, redis as unknown as Redis);
    const providers = new Map<string, PaymentProviderAdapter>([["mock", failing]]);
    const service = new PaymentService(client, idempotency, providers, "mock");

    await expect(service.createPayment(createInput, "idem-key-1")).rejects.toThrow(/provider down/);
    expect(store.payments.size).toBe(0);
    expect(store.idempotency.has("idem-key-1")).toBe(false);
    expect(redis.store.has("idem:lock:idem-key-1")).toBe(false);
  });

  it("maps a thrown provider error to PROVIDER_ERROR (502)", async () => {
    const failing = makeProvider({
      async createPayment() {
        throw new Error("checkout unavailable");
      },
    });
    const { client, store } = fakePrisma();
    const redis = createFakeRedis();
    const idempotency = new IdempotencyService(client, redis as unknown as Redis);
    const service = new PaymentService(client, idempotency, new Map([["mock", failing]]), "mock");

    const error = await service.createPayment(createInput, "idem-key-1").then(
      () => null,
      (e: unknown) => e
    );
    expect((error as { code: string }).code).toBe("PROVIDER_ERROR");
    expect((error as { statusCode: number }).statusCode).toBe(502);
    expect((error as { message: string }).message).toContain("checkout unavailable");
    expect(store.payments.size).toBe(0);
    expect(store.idempotency.has("idem-key-1")).toBe(false);
  });

  it("validates amount before contacting the provider", async () => {
    await expect(
      setup.service.createPayment({ ...createInput, amount: "-5.00" }, "idem-key-1")
    ).rejects.toThrow();
    expect(storeCount(setup, "payments")).toBe(0);
  });
});

describe("PaymentService.getPayment", () => {
  it("returns a normalized payment DTO", async () => {
    const { service, store } = setupWithOutstanding();
    const dto = await service.getPayment("p1");
    expect(dto.reference).toBe("REF-1");
    expect(dto.amount).toBe("1000.00");
    expect(dto.status).toBe("PENDING");
    expect(typeof dto.createdAt).toBe("string");
    void store;
  });

  it("throws NotFound for an unknown payment", async () => {
    const { service } = setupWithOutstanding();
    await expect(service.getPayment("nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});

function storePayment(
  setup: ReturnType<typeof build>,
  id: string
): NonNullable<ReturnType<typeof setup.store.payments.get>> {
  const payment = setup.store.payments.get(id);
  if (payment === undefined) throw new Error(`missing payment ${id}`);
  return payment;
}

function storeCount(setup: ReturnType<typeof build>, kind: "payments" | "idempotency"): number {
  return kind === "payments" ? setup.store.payments.size : setup.store.idempotency.size;
}

function setupWithOutstanding(): {
  service: PaymentService;
  store: ReturnType<typeof fakePrisma>["store"];
} {
  const { client, store } = fakePrisma();
  store.addPayment({
    id: "p1",
    reference: "REF-1",
    amount: new Prisma.Decimal("1000.00"),
    currency: "DZD",
    status: "PENDING",
    provider: "mock",
    providerReference: "mref-1",
    idempotencyKey: "idem-1",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
  });
  const redis = createFakeRedis();
  const idempotency = new IdempotencyService(client, redis as unknown as Redis);
  const providers = new Map<string, PaymentProviderAdapter>([["mock", makeProvider()]]);
  const service = new PaymentService(client, idempotency, providers, "mock");
  return { service, store };
}

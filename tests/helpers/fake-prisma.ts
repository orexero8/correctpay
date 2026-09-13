import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

export type StoredPayment = {
  id: string;
  reference: string;
  amount: Prisma.Decimal;
  currency: string;
  status: string;
  provider: string;
  providerReference: string | null;
  idempotencyKey: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
};

export type StoredIdempotencyRecord = {
  id: string;
  key: string;
  requestHash: string;
  responseBody: unknown;
  status: string;
  createdAt: Date;
  expiresAt: Date;
};

export type StoredRefund = {
  id: string;
  paymentId: string;
  amount: Prisma.Decimal;
  status: string;
  providerReference: string | null;
  reason: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredPaymentEvent = {
  id: string;
  paymentId: string;
  fromStatus: string;
  toStatus: string;
  source: string;
  payloadHash: string | null;
  createdAt: Date;
};

export class PaymentStore {
  public readonly payments = new Map<string, StoredPayment>();
  public readonly idempotency = new Map<string, StoredIdempotencyRecord>();
  public readonly refunds = new Map<string, StoredRefund>();
  public readonly events: StoredPaymentEvent[] = [];
  public interfereNextIdempotencyCreate = false;

  public reset(): void {
    this.payments.clear();
    this.idempotency.clear();
    this.refunds.clear();
    this.events.length = 0;
    this.interfereNextIdempotencyCreate = false;
  }

  public addPayment(payment: StoredPayment): void {
    this.payments.set(payment.id, payment);
  }
}

function nextId(): string {
  return randomUUID();
}

function uniqueViolation(): never {
  const error = new Error("Unique constraint failed");
  (error as unknown as { code: string }).code = "P2002";
  throw error;
}

function findPaymentByReference(store: PaymentStore, reference: string): StoredPayment | null {
  for (const payment of store.payments.values()) {
    if (payment.reference === reference) return payment;
  }
  return null;
}

function findPaymentByProviderReference(
  store: PaymentStore,
  providerReference: string
): StoredPayment | null {
  for (const payment of store.payments.values()) {
    if (payment.providerReference === providerReference) return payment;
  }
  return null;
}

function findPaymentByIdempotencyKey(store: PaymentStore, key: string): StoredPayment | null {
  for (const payment of store.payments.values()) {
    if (payment.idempotencyKey === key) return payment;
  }
  return null;
}

function findRefundByIdempotencyKey(store: PaymentStore, key: string): StoredRefund | null {
  for (const refund of store.refunds.values()) {
    if (refund.idempotencyKey === key) return refund;
  }
  return null;
}

function now(): Date {
  return new Date();
}

export function buildFakePrisma(): {
  client: PrismaClient;
  store: PaymentStore;
} {
  const store = new PaymentStore();

  const paymentDelegate = {
    async create(args: {
      data: {
        reference: string;
        amount: Prisma.Decimal;
        currency: string;
        status: string;
        provider: string;
        idempotencyKey: string;
        metadata?: unknown;
      };
    }): Promise<StoredPayment> {
      const d = args.data;
      if (findPaymentByReference(store, d.reference) !== null) uniqueViolation();
      if (findPaymentByIdempotencyKey(store, d.idempotencyKey) !== null) uniqueViolation();
      if (d.amount.isNaN()) throw new Error("Invalid decimal");
      const payment: StoredPayment = {
        id: nextId(),
        reference: d.reference,
        amount: d.amount,
        currency: d.currency,
        status: d.status,
        provider: d.provider,
        providerReference: null,
        idempotencyKey: d.idempotencyKey,
        metadata: d.metadata ?? null,
        createdAt: now(),
        updatedAt: now(),
        expiresAt: null,
      };
      store.payments.set(payment.id, payment);
      return payment;
    },

    async findUnique(args: {
      where: {
        id?: string;
        reference?: string;
        providerReference?: string;
        idempotencyKey?: string;
      };
      select?: Record<string, unknown>;
    }): Promise<StoredPayment | null> {
      const w = args.where;
      if (w.id !== undefined) return store.payments.get(w.id) ?? null;
      if (w.reference !== undefined) return findPaymentByReference(store, w.reference);
      if (w.providerReference !== undefined)
        return findPaymentByProviderReference(store, w.providerReference);
      if (w.idempotencyKey !== undefined)
        return findPaymentByIdempotencyKey(store, w.idempotencyKey);
      return null;
    },

    async update(args: {
      where: { id: string };
      data: Partial<Pick<StoredPayment, "status" | "providerReference" | "metadata">>;
    }): Promise<StoredPayment> {
      const payment = store.payments.get(args.where.id);
      if (payment === undefined) throw new Error("P2025: record not found");
      const updated: StoredPayment = { ...payment, ...args.data, updatedAt: now() };
      store.payments.set(payment.id, updated);
      return updated;
    },

    async updateMany(args: {
      where: Partial<Pick<StoredPayment, "id" | "status">>;
      data: { status: string };
    }): Promise<{ count: number }> {
      let count = 0;
      for (const [id, payment] of store.payments) {
        if (args.where.id !== undefined && payment.id !== args.where.id) continue;
        if (args.where.status !== undefined && payment.status !== args.where.status) continue;
        store.payments.set(id, { ...payment, status: args.data.status, updatedAt: now() });
        count += 1;
      }
      return { count };
    },

    async delete(args: { where: { id: string } }): Promise<void> {
      store.payments.delete(args.where.id);
    },
  };

  const refundDelegate = {
    async create(args: {
      data: {
        paymentId: string;
        amount: Prisma.Decimal;
        reason: string | null;
        status: string;
        idempotencyKey: string;
      };
    }): Promise<StoredRefund> {
      const d = args.data;
      if (findRefundByIdempotencyKey(store, d.idempotencyKey) !== null) uniqueViolation();
      const refund: StoredRefund = {
        id: nextId(),
        paymentId: d.paymentId,
        amount: d.amount,
        status: d.status,
        providerReference: null,
        reason: d.reason,
        idempotencyKey: d.idempotencyKey,
        createdAt: now(),
        updatedAt: now(),
      };
      store.refunds.set(refund.id, refund);
      return refund;
    },

    async findFirst(args: {
      where: { paymentId?: string; idempotencyKey?: string; status?: string };
      select?: Record<string, unknown>;
    }): Promise<StoredRefund | null> {
      const w = args.where;
      for (const refund of store.refunds.values()) {
        if (w.paymentId !== undefined && refund.paymentId !== w.paymentId) continue;
        if (w.idempotencyKey !== undefined && refund.idempotencyKey !== w.idempotencyKey) continue;
        if (w.status !== undefined && refund.status !== w.status) continue;
        return refund;
      }
      return null;
    },

    async updateMany(args: {
      where: { paymentId?: string; idempotencyKey?: string; status?: string };
      data: Partial<Pick<StoredRefund, "status" | "providerReference">>;
    }): Promise<{ count: number }> {
      let count = 0;
      for (const [id, refund] of store.refunds) {
        if (args.where.paymentId !== undefined && refund.paymentId !== args.where.paymentId)
          continue;
        if (
          args.where.idempotencyKey !== undefined &&
          refund.idempotencyKey !== args.where.idempotencyKey
        )
          continue;
        if (args.where.status !== undefined && refund.status !== args.where.status) continue;
        store.refunds.set(id, { ...refund, ...args.data, updatedAt: now() });
        count += 1;
      }
      return { count };
    },

    async aggregate(args: {
      where: { paymentId: string; status?: { in: string[] } };
      _sum: { amount: true };
    }): Promise<{ _sum: { amount: Prisma.Decimal | null } }> {
      const allowed = args.where.status?.in ?? null;
      let sum: Prisma.Decimal | null = null;
      for (const refund of store.refunds.values()) {
        if (refund.paymentId !== args.where.paymentId) continue;
        if (allowed !== null && !allowed.includes(refund.status)) continue;
        sum = (sum ?? new Prisma.Decimal(0)).add(refund.amount);
      }
      return { _sum: { amount: sum } };
    },
  };

  const idempotencyDelegate = {
    async findUnique(args: { where: { key: string } }): Promise<StoredIdempotencyRecord | null> {
      return store.idempotency.get(args.where.key) ?? null;
    },

    async create(args: {
      data: {
        key: string;
        requestHash: string;
        status: string;
        expiresAt: Date;
      };
    }): Promise<StoredIdempotencyRecord> {
      const d = args.data;
      if (store.interfereNextIdempotencyCreate) {
        store.interfereNextIdempotencyCreate = false;
        uniqueViolation();
      }
      if (store.idempotency.has(d.key)) uniqueViolation();
      const record: StoredIdempotencyRecord = {
        id: nextId(),
        key: d.key,
        requestHash: d.requestHash,
        responseBody: null,
        status: d.status,
        createdAt: now(),
        expiresAt: d.expiresAt,
      };
      store.idempotency.set(record.key, record);
      return record;
    },

    async update(args: {
      where: { key: string };
      data: { status: string; responseBody?: unknown };
    }): Promise<StoredIdempotencyRecord> {
      const record = store.idempotency.get(args.where.key);
      if (record === undefined) throw new Error("P2025: record not found");
      const updated: StoredIdempotencyRecord = {
        ...record,
        status: args.data.status,
        ...(args.data.responseBody !== undefined ? { responseBody: args.data.responseBody } : {}),
      };
      store.idempotency.set(updated.key, updated);
      return updated;
    },

    async delete(args: { where: { key: string } }): Promise<void> {
      store.idempotency.delete(args.where.key);
    },
  };

  const paymentEventDelegate = {
    async create(args: {
      data: {
        paymentId: string;
        fromStatus: string;
        toStatus: string;
        source: string;
        payloadHash?: string;
      };
    }): Promise<StoredPaymentEvent> {
      const d = args.data;
      const event: StoredPaymentEvent = {
        id: nextId(),
        paymentId: d.paymentId,
        fromStatus: d.fromStatus,
        toStatus: d.toStatus,
        source: d.source,
        payloadHash: d.payloadHash ?? null,
        createdAt: now(),
      };
      store.events.push(event);
      return event;
    },

    async findFirst(args: {
      where: { paymentId?: string; source?: string; payloadHash?: string };
    }): Promise<StoredPaymentEvent | null> {
      const w = args.where;
      for (const event of store.events) {
        if (w.paymentId !== undefined && event.paymentId !== w.paymentId) continue;
        if (w.source !== undefined && event.source !== w.source) continue;
        if (w.payloadHash !== undefined && event.payloadHash !== w.payloadHash) continue;
        return event;
      }
      return null;
    },
  };

  interface FakeClient {
    payment: typeof paymentDelegate;
    refund: typeof refundDelegate;
    idempotencyRecord: typeof idempotencyDelegate;
    paymentEvent: typeof paymentEventDelegate;
    $transaction: <T>(fn: (tx: FakeClient) => Promise<T>) => Promise<T>;
    $queryRaw: () => Promise<unknown[]>;
  }

  const fake: FakeClient = {
    payment: paymentDelegate,
    refund: refundDelegate,
    idempotencyRecord: idempotencyDelegate,
    paymentEvent: paymentEventDelegate,

    async $transaction<T>(fn: (tx: FakeClient) => Promise<T>): Promise<T> {
      return fn(fake);
    },

    async $queryRaw(): Promise<unknown[]> {
      return [];
    },
  };

  return { client: fake as unknown as PrismaClient, store };
}

export function fakePrisma(): { client: PrismaClient; store: PaymentStore } {
  return buildFakePrisma();
}

export function decimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

export function makePayment(overrides: Partial<StoredPayment>): StoredPayment {
  const base: StoredPayment = {
    id: "payment-1",
    reference: "REF-1",
    amount: new Prisma.Decimal("1000.00"),
    currency: "DZD",
    status: "CREATED",
    provider: "mock",
    providerReference: null,
    idempotencyKey: "idem-1",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
  };
  return { ...base, ...overrides };
}

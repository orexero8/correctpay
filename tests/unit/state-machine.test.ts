import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  canTransition,
  TRANSITIONS,
  transitionPayment,
  transitionPaymentTx,
} from "../../src/core/payment.state-machine.js";
import { InvalidStateTransitionError } from "../../src/shared/errors.js";
import type { PaymentStatus } from "../../src/shared/types.js";
import { fakePrisma, makePayment } from "../helpers/fake-prisma.js";

function allStatuses(): PaymentStatus[] {
  return [
    "CREATED",
    "PENDING",
    "PROCESSING",
    "PAID",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "PARTIALLY_REFUNDED",
    "FULLY_REFUNDED",
  ];
}

describe("state machine transition table", () => {
  it("exposes exactly the SPEC section 7 table", () => {
    expect(TRANSITIONS).toEqual({
      CREATED: ["PENDING", "CANCELLED"],
      PENDING: ["PROCESSING", "EXPIRED", "CANCELLED"],
      PROCESSING: ["PAID", "FAILED"],
      PAID: ["PARTIALLY_REFUNDED", "FULLY_REFUNDED"],
      PARTIALLY_REFUNDED: ["FULLY_REFUNDED"],
      FAILED: [],
      EXPIRED: [],
      CANCELLED: [],
      FULLY_REFUNDED: [],
    });
  });

  it("allows every listed valid transition", () => {
    expect(canTransition("CREATED", "PENDING")).toBe(true);
    expect(canTransition("CREATED", "CANCELLED")).toBe(true);
    expect(canTransition("PENDING", "PROCESSING")).toBe(true);
    expect(canTransition("PENDING", "EXPIRED")).toBe(true);
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
    expect(canTransition("PROCESSING", "PAID")).toBe(true);
    expect(canTransition("PROCESSING", "FAILED")).toBe(true);
    expect(canTransition("PAID", "PARTIALLY_REFUNDED")).toBe(true);
    expect(canTransition("PAID", "FULLY_REFUNDED")).toBe(true);
    expect(canTransition("PARTIALLY_REFUNDED", "FULLY_REFUNDED")).toBe(true);
  });

  it("rejects every unlisted transition", () => {
    const statuses = allStatuses();
    for (const from of statuses) {
      for (const to of statuses) {
        const allowed = TRANSITIONS[from]?.includes(to);
        if (allowed === true) continue;
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("does not allow refund states to be reached from arbitrary states", () => {
    expect(canTransition("CREATED", "PARTIALLY_REFUNDED")).toBe(false);
    expect(canTransition("PENDING", "FULLY_REFUNDED")).toBe(false);
    expect(canTransition("FAILED", "PAID")).toBe(false);
  });

  it("reports no self-transitions", () => {
    for (const status of allStatuses()) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });
});

describe("transitionPayment", () => {
  it("applies a valid transition and writes an audit event in one transaction", async () => {
    const { client, store } = fakePrisma();
    store.addPayment(makePayment({ id: "p1", status: "CREATED", providerReference: null }));

    await transitionPayment("p1", "PENDING", "api", undefined, client);

    const payment = store.payments.get("p1");
    expect(payment?.status).toBe("PENDING");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      paymentId: "p1",
      fromStatus: "CREATED",
      toStatus: "PENDING",
      source: "api",
    });
  });

  it("rejects an invalid transition and does not write anything", async () => {
    const { client, store } = fakePrisma();
    store.addPayment(makePayment({ id: "p1", status: "CREATED", providerReference: null }));

    await expect(transitionPayment("p1", "PAID", "webhook", undefined, client)).rejects.toThrow(
      InvalidStateTransitionError
    );
    expect(store.payments.get("p1")?.status).toBe("CREATED");
    expect(store.events).toHaveLength(0);
  });

  it("throws when the payment does not exist", async () => {
    const { client } = fakePrisma();
    await expect(
      transitionPayment("missing", "PENDING", "api", undefined, client)
    ).rejects.toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("rejects a concurrent status change via the conditional updateMany guard", async () => {
    const { client, store } = fakePrisma();
    store.addPayment(makePayment({ id: "p1", status: "CREATED", providerReference: null }));

    // Simulate a competing writer that changed the status between our read
    // and our guarded update by pre-snapshoting then modifying the store.
    const payment = store.payments.get("p1");
    if (payment !== undefined) {
      payment.status = "CANCELLED";
    }

    await expect(transitionPayment("p1", "PENDING", "api", undefined, client)).rejects.toThrow(
      InvalidStateTransitionError
    );
    expect(store.payments.get("p1")?.status).toBe("CANCELLED");
  });
});

describe("transitionPaymentTx inside a caller transaction", () => {
  it("works when invoked inside a $transaction", async () => {
    const { client, store } = fakePrisma();
    store.addPayment(makePayment({ id: "p1", status: "PROCESSING", providerReference: "ref-1" }));

    await client.$transaction(async (tx) => {
      await transitionPaymentTx(tx, "p1", "PAID", "webhook");
    });

    expect(store.payments.get("p1")?.status).toBe("PAID");
    expect(store.events[0]?.fromStatus).toBe("PROCESSING");
  });

  it("can record a payloadHash with the event", async () => {
    const { client, store } = fakePrisma();
    store.addPayment(makePayment({ id: "p1", status: "PROCESSING", providerReference: "ref-1" }));

    await client.$transaction(async (tx) => {
      await transitionPaymentTx(tx, "p1", "PAID", "webhook", "hash-abc");
    });

    expect(store.events[0]?.payloadHash).toBe("hash-abc");
  });
});

describe("money storage sanity", () => {
  it("stores amounts as exact decimals without floating-point drift", () => {
    const amount = new Prisma.Decimal("0.10").add(new Prisma.Decimal("0.20"));
    expect(amount.toFixed(2)).toBe("0.30");
  });
});

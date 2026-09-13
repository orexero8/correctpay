import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db/client.js";
import { InvalidStateTransitionError, NotFoundError } from "../shared/errors.js";
import type { PaymentStatus, PaymentTransitionSource } from "../shared/types.js";

// Exact transition table from SPEC.md section 7. Do not add, remove, or
// reinterpret any transition. If a path is not listed below, it is not allowed.
export const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED: ["PENDING", "CANCELLED"],
  PENDING: ["PROCESSING", "EXPIRED", "CANCELLED"],
  PROCESSING: ["PAID", "FAILED"],
  PAID: ["PARTIALLY_REFUNDED", "FULLY_REFUNDED"],
  PARTIALLY_REFUNDED: ["FULLY_REFUNDED"],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
  FULLY_REFUNDED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCanTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(`Invalid state transition: ${from} -> ${to}`);
  }
}

/**
 * Applies a payment state transition inside a transaction.
 *
 * - Re-reads the current state inside the transaction (SPEC 18B).
 * - Guards the update conditionally on the current status so that two
 *   concurrent workers cannot both apply a conflicting transition.
 * - Writes the audit PaymentEvent atomically with the transition.
 *
 * This is the ONLY function permitted to write Payment.status.
 */
export async function transitionPaymentTx(
  tx: Prisma.TransactionClient,
  paymentId: string,
  toStatus: PaymentStatus,
  source: PaymentTransitionSource,
  payloadHash?: string
): Promise<void> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, status: true },
  });

  if (payment === null) {
    throw new NotFoundError(`Payment not found: ${paymentId}`);
  }

  assertCanTransition(payment.status, toStatus);

  const updated = await tx.payment.updateMany({
    where: { id: paymentId, status: payment.status },
    data: { status: toStatus },
  });

  if (updated.count !== 1) {
    throw new InvalidStateTransitionError(
      `Concurrent status change detected for payment ${paymentId} (${payment.status} -> ${toStatus})`
    );
  }

  await tx.paymentEvent.create({
    data: {
      paymentId,
      fromStatus: payment.status,
      toStatus,
      source,
      ...(payloadHash !== undefined ? { payloadHash } : {}),
    },
  });
}

export async function transitionPayment(
  paymentId: string,
  toStatus: PaymentStatus,
  source: PaymentTransitionSource,
  payloadHash?: string,
  db: PrismaClient = defaultPrisma
): Promise<void> {
  await db.$transaction((tx) => transitionPaymentTx(tx, paymentId, toStatus, source, payloadHash));
}

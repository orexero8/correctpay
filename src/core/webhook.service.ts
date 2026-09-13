import type { PrismaClient } from "@prisma/client";
import { InvalidStateTransitionError, NotFoundError, ValidationError } from "../shared/errors.js";
import type { PaymentStatus } from "../shared/types.js";
import { assertAmountsEqual, formatPrismaDecimal } from "./payment.entity.js";
import { transitionPaymentTx } from "./payment.state-machine.js";

export type WebhookOutcome = "completed" | "failed" | "expired";

export interface VerifiedWebhookEvent {
  event: WebhookOutcome;
  providerReference: string;
  reference: string;
  amount: string;
  currency: string;
  /** Stable fingerprint of the verified raw payload for duplicate detection. */
  payloadHash: string;
}

export interface WebhookProcessResult {
  outcome: "applied" | "duplicate";
  paymentId: string;
}

function outcomeToStatus(event: WebhookOutcome): PaymentStatus {
  switch (event) {
    case "completed":
      return "PAID";
    case "failed":
      return "FAILED";
    case "expired":
      return "EXPIRED";
  }
}

/**
 * Provider-neutral webhook processing pipeline (SPEC section 10).
 *
 * Responsibilities: find the payment, verify reference/amount/currency,
 * check for previously applied events, apply the state transition and write
 * the audit PaymentEvent atomically.
 *
 * The exact SPEC transition table only allows PENDING -> PAID/FAILED through
 * PROCESSING. When a terminal outcome is reported while the payment is still
 * PENDING, the processor records the required PROCESSING hop first so the
 * transition table is honored literally.
 *
 * A replayed event (identical payloadHash already applied, or a payment that
 * is already in the reported terminal status) is acknowledged as
 * `duplicate` without writing a second audit event.
 */
export class WebhookProcessor {
  public constructor(private readonly prisma: PrismaClient) {}

  public async process(event: VerifiedWebhookEvent): Promise<WebhookProcessResult> {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { providerReference: event.providerReference },
        select: {
          id: true,
          reference: true,
          amount: true,
          currency: true,
          status: true,
        },
      });

      if (payment === null) {
        throw new NotFoundError(
          `No payment found for provider reference: ${event.providerReference}`
        );
      }

      if (payment.reference !== event.reference) {
        throw new ValidationError("Webhook reference does not match the payment", {
          paymentReference: payment.reference,
          webhookReference: event.reference,
        });
      }

      assertAmountsEqual(event.amount, formatPrismaDecimal(payment.amount));

      if (payment.currency !== event.currency) {
        throw new ValidationError("Webhook currency does not match the payment", {
          paymentCurrency: payment.currency,
          webhookCurrency: event.currency,
        });
      }

      const previouslyApplied = await tx.paymentEvent.findFirst({
        where: {
          paymentId: payment.id,
          payloadHash: event.payloadHash,
          source: "webhook",
        },
        select: { id: true },
      });
      if (previouslyApplied !== null) {
        return { outcome: "duplicate", paymentId: payment.id };
      }

      const target = outcomeToStatus(event.event);

      if (payment.status === target) {
        return { outcome: "duplicate", paymentId: payment.id };
      }

      try {
        if (payment.status === "PENDING" && (target === "PAID" || target === "FAILED")) {
          await transitionPaymentTx(tx, payment.id, "PROCESSING", "webhook");
        }
        await transitionPaymentTx(tx, payment.id, target, "webhook", event.payloadHash);
        return { outcome: "applied", paymentId: payment.id };
      } catch (error) {
        if (error instanceof InvalidStateTransitionError) {
          const current = await tx.payment.findUnique({
            where: { id: payment.id },
            select: { status: true },
          });
          if (current?.status === target) {
            return { outcome: "duplicate", paymentId: payment.id };
          }
        }
        throw error;
      }
    });
  }
}

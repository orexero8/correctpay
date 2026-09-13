import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { PaymentProviderAdapter } from "../adapters/provider.interface.js";
import {
  AppError,
  ConflictError,
  ErrorCode,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from "../shared/errors.js";
import { retry, withTimeout } from "../shared/promise.js";
import { assertAmountAboveZero, assertMoneyString, formatPrismaDecimal } from "./payment.entity.js";
import { IdempotencyService } from "./idempotency.service.js";
import { transitionPaymentTx } from "./payment.state-machine.js";
import type { PaymentStatus } from "../shared/types.js";

const EXTERNAL_TIMEOUT_MS = 15_000;
const FINALIZE_ATTEMPTS = 3;
const FINALIZE_DELAY_MS = 200;

export interface RefundRequest {
  amount: string;
  reason?: string;
}

export interface RefundDto {
  id: string;
  paymentId: string;
  amount: string;
  status: string;
  providerReference: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapProviderError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError(
    ErrorCode.PROVIDER_ERROR,
    error instanceof Error ? error.message : "Provider refund operation failed",
    502
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function refundToDto(refund: {
  id: string;
  paymentId: string;
  amount: Prisma.Decimal;
  status: string;
  providerReference: string | null;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RefundDto {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    amount: formatPrismaDecimal(refund.amount),
    status: refund.status,
    providerReference: refund.providerReference,
    reason: refund.reason,
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
  };
}

export class RefundService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyService,
    private readonly providers: ReadonlyMap<string, PaymentProviderAdapter>
  ) {}

  public async createRefund(
    paymentId: string,
    input: RefundRequest,
    idempotencyKey: string
  ): Promise<RefundDto> {
    assertMoneyString(input.amount);
    assertAmountAboveZero(input.amount);

    const requestHash = IdempotencyService.computeRequestHash({ paymentId, ...input });
    const outcome = await this.idempotency.begin(idempotencyKey, requestHash);

    if (outcome.kind === "cached") {
      return outcome.body as RefundDto;
    }

    let reservation: {
      paymentId: string;
      paymentProvider: string;
      providerReference: string;
    };

    try {
      reservation = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;

        const payment = await tx.payment.findUnique({ where: { id: paymentId } });
        if (payment === null) {
          throw new NotFoundError(`Payment not found: ${paymentId}`);
        }
        if (payment.status !== "PAID" && payment.status !== "PARTIALLY_REFUNDED") {
          throw new InvalidStateTransitionError(
            `Refunds are only allowed for payments with status PAID or PARTIALLY_REFUNDED (current: ${payment.status})`
          );
        }
        if (payment.providerReference === null) {
          throw new AppError(
            ErrorCode.PROVIDER_ERROR,
            "Payment has no provider reference; refund is not possible",
            422
          );
        }

        // Refund limits: PENDING rows are reserved balances too, so two
        // concurrent refunds cannot jointly over-refund a payment.
        const aggregate = await tx.refund.aggregate({
          where: {
            paymentId,
            status: { in: ["SUCCEEDED", "PENDING"] },
          },
          _sum: { amount: true },
        });

        const refundedSoFar = aggregate._sum.amount ?? new Prisma.Decimal(0);
        const remaining = payment.amount.sub(refundedSoFar);
        const requestedDecimal = new Prisma.Decimal(input.amount);

        if (requestedDecimal.greaterThan(remaining)) {
          throw new ValidationError(
            `Refund amount exceeds refundable balance (remaining: ${formatPrismaDecimal(remaining)})`
          );
        }

        // The refund idempotency key MUST be persisted before the provider
        // operation is started (SPEC 18A).
        await tx.refund.create({
          data: {
            paymentId,
            amount: requestedDecimal,
            reason: input.reason ?? null,
            status: "PENDING",
            idempotencyKey,
          },
        });

        return {
          paymentId: payment.id,
          paymentProvider: payment.provider,
          providerReference: payment.providerReference,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.idempotency.abandon(idempotencyKey);
        throw new ConflictError("Idempotency-Key already used for a refund");
      }
      await this.idempotency.abandon(idempotencyKey);
      throw error;
    }

    const adapter = this.providers.get(reservation.paymentProvider);
    if (adapter === undefined) {
      await this.markRefundFailed(paymentId, idempotencyKey);
      await this.idempotency.abandon(idempotencyKey);
      throw new AppError(
        ErrorCode.PROVIDER_ERROR,
        `Provider adapter not found: ${reservation.paymentProvider}`,
        500
      );
    }

    let providerResult;
    try {
      providerResult = await withTimeout(
        adapter.refundPayment({
          providerReference: reservation.providerReference,
          amount: input.amount,
          reason: input.reason,
        }),
        EXTERNAL_TIMEOUT_MS,
        "refundPayment"
      );
    } catch (error) {
      await this.markRefundFailed(paymentId, idempotencyKey);
      await this.idempotency.abandon(idempotencyKey);
      throw mapProviderError(error);
    }

    if (providerResult.status === "failed") {
      await this.markRefundFailed(paymentId, idempotencyKey);
      await this.idempotency.abandon(idempotencyKey);
      throw mapProviderError(new Error("Provider rejected the refund"));
    }

    return this.finalizeRefundSuccess(
      paymentId,
      idempotencyKey,
      providerResult.providerRefundReference
    );
  }

  /**
   * Marks the refund SUCCEEDED and applies the payment state transition.
   *
   * The transition target is recomputed inside the finalize transaction by
   * re-reading the refunded total, so concurrent refunds cannot incorrectly
   * decide between PARTIALLY_REFUNDED and FULLY_REFUNDED. Idempotency is
   * completed atomically with the finalization.
   */
  private async finalizeRefundSuccess(
    paymentId: string,
    idempotencyKey: string,
    providerRefundReference: string
  ): Promise<RefundDto> {
    return retry(
      async () => {
        let dto: RefundDto | undefined;

        await this.prisma.$transaction(async (tx) => {
          await tx.refund.updateMany({
            where: { paymentId, idempotencyKey, status: "PENDING" },
            data: { status: "SUCCEEDED", providerReference: providerRefundReference },
          });

          const refund = await tx.refund.findFirst({
            where: { paymentId, idempotencyKey },
          });
          if (refund !== null) {
            dto = refundToDto(refund);
          }

          const payment = await tx.payment.findUnique({
            where: { id: paymentId },
            select: { id: true, amount: true, status: true },
          });
          if (payment === null) {
            throw new NotFoundError(`Payment not found: ${paymentId}`);
          }

          const aggregate = await tx.refund.aggregate({
            where: {
              paymentId,
              status: { in: ["SUCCEEDED", "PENDING"] },
            },
            _sum: { amount: true },
          });
          const totalRefunded = aggregate._sum.amount ?? new Prisma.Decimal(0);
          const isFull = totalRefunded.equals(payment.amount);

          const target = refundTransitionTarget(payment.status, isFull);
          if (target !== null) {
            await transitionPaymentTx(tx, paymentId, target, "api");
          }

          await this.idempotency.completeTx(tx, idempotencyKey, dto);
        });

        await this.idempotency.releaseLock(idempotencyKey);
        if (dto === undefined) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "Refund finalized but record could not be read",
            500
          );
        }
        return dto;
      },
      FINALIZE_ATTEMPTS,
      FINALIZE_DELAY_MS
    );
  }

  private async markRefundFailed(paymentId: string, idempotencyKey: string): Promise<void> {
    try {
      await this.prisma.refund.updateMany({
        where: { paymentId, idempotencyKey, status: "PENDING" },
        data: { status: "FAILED" },
      });
    } catch {
      // Best-effort; reconciliation will resolve orphaned PENDING rows.
    }
  }
}

function refundTransitionTarget(paymentStatus: string, isFull: boolean): PaymentStatus | null {
  if (paymentStatus === "PAID") {
    return isFull ? "FULLY_REFUNDED" : "PARTIALLY_REFUNDED";
  }
  if (paymentStatus === "PARTIALLY_REFUNDED" && isFull) {
    return "FULLY_REFUNDED";
  }
  return null;
}

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { PaymentProviderAdapter } from "../adapters/provider.interface.js";
import { AppError, ConflictError, ErrorCode, NotFoundError } from "../shared/errors.js";
import { withTimeout } from "../shared/promise.js";
import {
  formatPrismaDecimal,
  assertMoneyString,
  assertCurrencyCode,
  toJsonValue,
} from "./payment.entity.js";
import { IdempotencyService } from "./idempotency.service.js";
import { transitionPaymentTx } from "./payment.state-machine.js";

const EXTERNAL_TIMEOUT_MS = 15_000;

export interface CreatePaymentRequest {
  reference: string;
  amount: string;
  currency: string;
  returnUrl: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentResultDto {
  id: string;
  status: string;
  redirectUrl: string;
  reference: string;
}

export interface PaymentDto {
  id: string;
  reference: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  providerReference: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function mapProviderError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError(
    ErrorCode.PROVIDER_ERROR,
    error instanceof Error ? error.message : "Provider operation failed",
    502
  );
}

function paymentToDto(payment: {
  id: string;
  reference: string;
  amount: Prisma.Decimal;
  currency: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  providerReference: string | null;
}): PaymentDto {
  return {
    id: payment.id,
    reference: payment.reference,
    amount: formatPrismaDecimal(payment.amount),
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    providerReference: payment.providerReference,
  };
}

export class PaymentService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyService,
    private readonly providers: ReadonlyMap<string, PaymentProviderAdapter>,
    private readonly activeProvider: string
  ) {}

  public async createPayment(
    input: CreatePaymentRequest,
    idempotencyKey: string
  ): Promise<CreatePaymentResultDto> {
    assertMoneyString(input.amount);
    assertCurrencyCode(input.currency);

    const requestHash = IdempotencyService.computeRequestHash(input);
    const outcome = await this.idempotency.begin(idempotencyKey, requestHash);

    if (outcome.kind === "cached") {
      return outcome.body as CreatePaymentResultDto;
    }

    let paymentId: string;
    try {
      const payment = await this.prisma.payment.create({
        data: {
          reference: input.reference,
          amount: new Prisma.Decimal(input.amount),
          currency: input.currency,
          status: "CREATED",
          provider: this.activeProvider,
          idempotencyKey,
          metadata: input.metadata !== undefined ? toJsonValue(input.metadata) : undefined,
        },
      });
      paymentId = payment.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.idempotency.abandon(idempotencyKey);
        throw new ConflictError("A payment with this reference or idempotency key already exists");
      }
      await this.idempotency.abandon(idempotencyKey);
      throw error;
    }

    const adapter = this.providers.get(this.activeProvider);
    if (adapter === undefined) {
      await this.idempotency.abandon(idempotencyKey);
      throw new AppError(
        ErrorCode.PROVIDER_ERROR,
        `Provider adapter not found: ${this.activeProvider}`,
        500
      );
    }

    let providerResult: { providerReference: string; redirectUrl: string; raw: unknown };
    try {
      providerResult = await withTimeout(
        adapter.createPayment(input),
        EXTERNAL_TIMEOUT_MS,
        "createPayment"
      );
    } catch (error) {
      await this.cleanupAfterProviderFailure(paymentId, idempotencyKey);
      throw mapProviderError(error);
    }

    const dto: CreatePaymentResultDto = {
      id: paymentId,
      status: "PENDING",
      redirectUrl: providerResult.redirectUrl,
      reference: input.reference,
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        await transitionPaymentTx(tx, paymentId, "PENDING", "api");
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            providerReference: providerResult.providerReference,
            metadata: input.metadata !== undefined ? toJsonValue(input.metadata) : undefined,
          },
        });
        await this.idempotency.completeTx(tx, idempotencyKey, dto);
      });
    } catch {
      // Provider call succeeded but our DB write failed. The payment may
      // exist in a CREATED state with a dangling provider reference.
      // Reconciliation will resolve this. Do NOT re-call the provider.
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "Provider call succeeded but payment finalization failed; reconciliation required",
        500,
        { paymentId }
      );
    }

    return dto;
  }

  public async getPayment(id: string): Promise<PaymentDto> {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (payment === null) {
      throw new NotFoundError(`Payment not found: ${id}`);
    }
    return paymentToDto(payment);
  }

  private async cleanupAfterProviderFailure(
    paymentId: string,
    idempotencyKey: string
  ): Promise<void> {
    try {
      await this.prisma.payment.delete({ where: { id: paymentId } });
    } catch {
      // Payment row may already be gone; idempotency cleanup below suffices.
    }
    await this.idempotency.abandon(idempotencyKey);
  }
}

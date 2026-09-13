import type { FastifyInstance } from "fastify";
import type { CreatePaymentRequest } from "../../core/payment.service.js";
import type { PaymentService } from "../../core/payment.service.js";
import type { RefundService } from "../../core/refund.service.js";

export interface PaymentRoutesDeps {
  paymentService: PaymentService;
  refundService: RefundService;
}

const MONEY_PATTERN = "^(0|[1-9]\\d*)(\\.\\d{1,2})?$";
const CURRENCY_PATTERN = "^[A-Z]{3}$";
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const idempotencyHeaderSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

const paymentCreateResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["PENDING"] },
    redirectUrl: { type: "string" },
    reference: { type: "string" },
  },
  required: ["id", "status", "redirectUrl", "reference"],
} as const;

const paymentResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    reference: { type: "string" },
    amount: { type: "string" },
    currency: { type: "string" },
    status: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "reference", "amount", "currency", "status", "createdAt", "updatedAt"],
} as const;

const refundResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    paymentId: { type: "string" },
    amount: { type: "string" },
    status: { type: "string" },
    providerReference: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "id",
    "paymentId",
    "amount",
    "status",
    "providerReference",
    "reason",
    "createdAt",
    "updatedAt",
  ],
} as const;

export function registerPaymentRoutes(
  app: FastifyInstance,
  deps: PaymentRoutesDeps
): FastifyInstance {
  app.post(
    "/v1/payments",
    {
      schema: {
        headers: idempotencyHeaderSchema,
        body: {
          type: "object",
          required: ["reference", "amount", "currency", "returnUrl"],
          properties: {
            reference: { type: "string", minLength: 1, maxLength: 128 },
            amount: { type: "string", pattern: MONEY_PATTERN },
            currency: { type: "string", pattern: CURRENCY_PATTERN },
            returnUrl: { type: "string", pattern: "^https?://.+$", maxLength: 2048 },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        response: {
          201: paymentCreateResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as CreatePaymentRequest;
      const idempotencyKey = String(request.headers["idempotency-key"]);
      const result = await deps.paymentService.createPayment(body, idempotencyKey);
      return reply.code(201).send(result);
    }
  );

  app.get(
    "/v1/payments/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
          },
        },
        response: {
          200: paymentResponseSchema,
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const payment = await deps.paymentService.getPayment(id);
      return {
        id: payment.id,
        reference: payment.reference,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      };
    }
  );

  app.post(
    "/v1/payments/:id/refund",
    {
      schema: {
        headers: idempotencyHeaderSchema,
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
          },
        },
        body: {
          type: "object",
          required: ["amount"],
          properties: {
            amount: { type: "string", pattern: MONEY_PATTERN },
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        response: {
          201: refundResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { amount: string; reason?: string };
      const idempotencyKey = String(request.headers["idempotency-key"]);
      const result = await deps.refundService.createRefund(id, body, idempotencyKey);
      return reply.code(201).send(result);
    }
  );

  return app;
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { MOCK_SIGNATURE_HEADER, verifySignature } from "../../adapters/mock/mock.signature.js";
import type { MockWebhookEvent, MockWebhookPayload } from "../../adapters/mock/mock.callback.js";
import type { WebhookProcessor, WebhookOutcome } from "../../core/webhook.service.js";
import { IdempotencyService } from "../../core/idempotency.service.js";
import { MONEY_PATTERN } from "../../core/payment.entity.js";
import { ValidationError, WebhookVerificationError } from "../../shared/errors.js";

export interface MockWebhookRoutesDeps {
  secret: string;
  processor: WebhookProcessor;
}

/**
 * Request that received a scoped content-type parser preserving the raw bytes
 * before JSON parsing, so the signature can be verified over the exact body.
 */
type WebhookRequest = FastifyRequest & { rawBody?: Buffer };

const mockWebhookSchema = z.object({
  event: z.enum(["payment.completed", "payment.failed", "payment.cancelled"]),
  status: z.enum(["paid", "failed", "expired"]),
  providerReference: z.string().min(1),
  reference: z.string().min(1),
  amount: z.string().regex(MONEY_PATTERN),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timestamp: z.string().min(1),
  signatureVersion: z.literal("v1"),
});

const EVENT_TO_STATUS: Record<MockWebhookEvent, MockWebhookPayload["status"]> = {
  "payment.completed": "paid",
  "payment.failed": "failed",
  "payment.cancelled": "expired",
};

function mapMockEvent(event: MockWebhookEvent): WebhookOutcome {
  switch (event) {
    case "payment.completed":
      return "completed";
    case "payment.failed":
      return "failed";
    case "payment.cancelled":
      return "expired";
  }
}

function parsePayload(body: unknown): MockWebhookPayload {
  const parsed = mockWebhookSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid mock webhook payload", parsed.error.issues);
  }
  if (EVENT_TO_STATUS[parsed.data.event] !== parsed.data.status) {
    throw new ValidationError("Mock webhook event/status pair is inconsistent", {
      event: parsed.data.event,
      status: parsed.data.status,
    });
  }
  return parsed.data;
}

/**
 * Mock provider webhook receiver (SPEC section 10/11).
 *
 * The scoped JSON content-type parser captures the raw bytes so the HMAC
 * signature is verified over the exact body that was sent, then hands the
 * parsed object to the provider-neutral WebhookProcessor.
 *
 * Mock-only wire format; the real CIB callback/signature is unknown until the
 * official technical package arrives.
 */
export function registerMockWebhookRoutes(
  app: FastifyInstance,
  deps: MockWebhookRoutesDeps
): FastifyInstance {
  app.register((scope: FastifyInstance): void => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (request: FastifyRequest, body: Buffer): Promise<unknown> => {
        const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        (request as WebhookRequest).rawBody = raw;
        try {
          const parsed: unknown = JSON.parse(raw.toString("utf8"));
          return Promise.resolve(parsed);
        } catch {
          return Promise.reject(new ValidationError("Webhook body is not valid JSON"));
        }
      }
    );

    scope.post(
      "/v1/webhooks/mock",
      {
        schema: {
          response: {
            200: {
              type: "object",
              properties: {
                received: { type: "boolean", const: true },
                outcome: { type: "string", enum: ["applied", "duplicate"] },
              },
              required: ["received", "outcome"],
            },
          },
        },
      },
      async (request, reply) => {
        const rawBody = (request as WebhookRequest).rawBody;
        if (rawBody === undefined) {
          throw new WebhookVerificationError("Webhook raw body was not preserved");
        }

        const signature = request.headers[MOCK_SIGNATURE_HEADER];
        if (typeof signature !== "string" || signature.length === 0) {
          throw new WebhookVerificationError("Missing mock webhook signature");
        }
        if (!verifySignature(rawBody.toString("utf8"), deps.secret, signature)) {
          throw new WebhookVerificationError("Mock webhook signature verification failed");
        }

        const payload = parsePayload(request.body);
        const result = await deps.processor.process({
          event: mapMockEvent(payload.event),
          providerReference: payload.providerReference,
          reference: payload.reference,
          amount: payload.amount,
          currency: payload.currency,
          payloadHash: IdempotencyService.computeRequestHash(payload),
        });

        return reply.code(200).send({ received: true, outcome: result.outcome });
      }
    );
  });

  return app;
}

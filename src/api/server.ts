import "dotenv/config";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { getEnv } from "../config/env.js";
import { logger, pinoOptions } from "../shared/logger.js";
import { redis } from "../shared/redis.js";
import { prisma } from "../db/client.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerHealthRoutes } from "./routes/health.routes.js";
import { registerPaymentRoutes } from "./routes/payments.routes.js";
import { registerMockWebhookRoutes } from "./routes/webhooks.routes.js";
import { MockAdapter, MockProviderStore, registerMockRoutes } from "../adapters/mock/index.js";
import type { PaymentProviderAdapter } from "../adapters/provider.interface.js";
import { IdempotencyService } from "../core/idempotency.service.js";
import { PaymentService } from "../core/payment.service.js";
import { RefundService } from "../core/refund.service.js";
import { WebhookProcessor } from "../core/webhook.service.js";

const mockProviderStore = new MockProviderStore();

export interface BuildAppOptions {
  readonly prisma?: PrismaClient;
  readonly redis?: Redis;
  readonly mockStore?: MockProviderStore;
  readonly mockWebhookSecret?: string;
  readonly mockBaseUrl?: string;
  readonly mockWebhookTargetUrl?: string;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = getEnv();

  const db = options.prisma ?? prisma;
  const cache = options.redis ?? redis;
  const store = options.mockStore ?? mockProviderStore;
  const webhookSecret = options.mockWebhookSecret ?? env.MOCK_WEBHOOK_SECRET;
  const baseUrl = options.mockBaseUrl ?? env.MOCK_ADAPTER_BASE_URL;
  const webhookTargetUrl = options.mockWebhookTargetUrl ?? env.MOCK_WEBHOOK_TARGET_URL;

  const app = Fastify({
    logger: pinoOptions,
    bodyLimit: 1024 * 256,
    requestTimeout: 15_000,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: false,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });

  registerHealthRoutes(app, { prisma: db, redis: cache });

  if (env.MOCK_ADAPTER_ENABLED) {
    await registerMockRoutes(app, {
      store,
      secret: webhookSecret,
      baseUrl,
      webhookTargetUrl,
    });
    const webhookProcessor = new WebhookProcessor(db);
    registerMockWebhookRoutes(app, { secret: webhookSecret, processor: webhookProcessor });
  }

  const providers = new Map<string, PaymentProviderAdapter>([
    ["mock", new MockAdapter(store, { baseUrl })],
  ]);
  const idempotency = new IdempotencyService(db, cache);
  const paymentService = new PaymentService(db, idempotency, providers, env.ACTIVE_PROVIDER);
  const refundService = new RefundService(db, idempotency, providers);
  registerPaymentRoutes(app, { paymentService, refundService });

  registerErrorHandler(app);

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const env = getEnv();
  const app = await buildApp();

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (error) {
    logger.error({ event: "api.listen_failed", error }, "failed to start server");
    process.exit(1);
  }

  return app;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer();
}

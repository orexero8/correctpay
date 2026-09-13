/**
 * Local-dev HTTP server that requires NO Postgres or Redis.
 *
 * Uses the same in-memory fakes as the integration tests via the Phase 6
 * dependency injection, so the whole mock flow works on a machine without
 * Docker/databases. Data resets on process restart. V1 mock-only: do NOT use
 * this entrypoint beyond local development.
 */
import "dotenv/config";
import type { Redis } from "ioredis";
import { getEnv } from "../src/config/env.js";
import { buildApp } from "../src/api/server.js";
import { fakePrisma } from "../tests/helpers/fake-prisma.js";
import { createFakeRedis } from "../tests/helpers/fake-redis.js";

async function main(): Promise<void> {
  const env = getEnv();
  const port = env.PORT;
  const host = "127.0.0.1";
  const baseUrl = `http://localhost:${port}`;

  const app = await buildApp({
    prisma: fakePrisma().client,
    redis: createFakeRedis() as unknown as Redis,
    mockWebhookSecret: env.MOCK_WEBHOOK_SECRET,
    mockBaseUrl: baseUrl,
    mockWebhookTargetUrl: `${baseUrl}/v1/webhooks/mock`,
  });

  await app.listen({ host, port });

  console.log(`[dev:local] payments API listening on ${baseUrl}`);
  console.log(`[dev:local] health endpoint      : ${baseUrl}/v1/health`);
  console.log(`[dev:local] in-memory store only  : no Postgres/Redis required, data resets on restart`);
  console.log(`[dev:local] 1) create a payment   :`);
  console.log(`      curl -X POST ${baseUrl}/v1/payments \\`);
  console.log(`        -H "content-type: application/json" -H "idempotency-key: dev-demo-1" \\`);
  console.log(`        -d '{"reference":"REF-DEV-1","amount":"1250.00","currency":"DZD","returnUrl":"https://merchant.example/return"}'`);
  console.log(`[dev:local] 2) open the returned redirectUrl and press PAY / FAIL / CANCEL`);
  console.log(`[dev:local] 3) read the state     : curl ${baseUrl}/v1/payments/<paymentId>`);
  console.log(`[dev:local] press Ctrl+C to stop`);
}

void main();
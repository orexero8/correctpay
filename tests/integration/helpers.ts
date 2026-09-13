import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { buildApp, type BuildAppOptions } from "../../src/api/server.js";
import { MockProviderStore } from "../../src/adapters/mock/index.js";
import { fakePrisma } from "../helpers/fake-prisma.js";
import { createFakeRedis } from "../helpers/fake-redis.js";

export const MOCK_SECRET = "0123456789abcdef0123456789abcdef";

export function parseResponse<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

export function providerReferenceFromRedirect(redirectUrl: string): string {
  const part = redirectUrl.split("/mock/checkout/")[1];
  return part ?? "";
}

export async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

export interface E2EApp {
  app: FastifyInstance;
  baseUrl: string;
  mockStore: MockProviderStore;
  paymentDb: ReturnType<typeof fakePrisma>["store"];
  client: ReturnType<typeof fakePrisma>["client"];
  cache: ReturnType<typeof createFakeRedis>;
}

export async function buildE2EApp(overrides: BuildAppOptions = {}): Promise<E2EApp> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fake = fakePrisma();
  const cache = createFakeRedis();
  const mockStore = overrides.mockStore ?? new MockProviderStore();

  const app = await buildApp({
    prisma: fake.client,
    redis: cache as unknown as Redis,
    mockStore,
    mockWebhookSecret: MOCK_SECRET,
    mockBaseUrl: baseUrl,
    mockWebhookTargetUrl: `${baseUrl}/v1/webhooks/mock`,
    ...overrides,
  });

  await app.listen({ host: "127.0.0.1", port });

  return {
    app,
    baseUrl,
    mockStore,
    paymentDb: fake.store,
    client: fake.client,
    cache,
  };
}

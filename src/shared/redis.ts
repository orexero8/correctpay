import { Redis } from "ioredis";
import { getEnv } from "../config/env.js";
import { logger } from "./logger.js";

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });
  client.on("error", (error) => {
    logger.warn({ event: "redis.connection_error", error }, "redis connection error");
  });
  return client;
}

export const redis: Redis = globalForRedis.redis ?? createRedisClient(getEnv().REDIS_URL);

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

export async function closeRedis(): Promise<void> {
  if (redis.status === "ready" || redis.status === "connecting") {
    await redis.quit();
  }
}

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { logger } from "../../shared/logger.js";

export interface HealthRoutesDeps {
  prisma: PrismaClient;
  redis: Redis;
}

type HealthCheckResult = {
  status: "ok" | "down";
  latencyMs?: number;
  message?: string;
};

async function checkDatabase(db: PrismaClient): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error({ event: "health.db_down", error }, "database health check failed");
    return { status: "down", message: "database unreachable" };
  }
}

async function checkRedis(redisClient: Redis): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  try {
    await redisClient.ping();
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error({ event: "health.redis_down", error }, "redis health check failed");
    return { status: "down", message: "redis unreachable" };
  }
}

const checksSchema = {
  type: "object",
  properties: {
    api: { type: "string", enum: ["up", "down"] },
    database: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok", "down"] },
        latencyMs: { type: "number" },
        message: { type: "string" },
      },
    },
    redis: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok", "down"] },
        latencyMs: { type: "number" },
        message: { type: "string" },
      },
    },
  },
  required: ["api", "database", "redis"],
} as const;

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthRoutesDeps
): FastifyInstance {
  app.get(
    "/v1/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok", "degraded"] },
              checks: checksSchema,
            },
            required: ["status", "checks"],
          },
          503: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["degraded"] },
              checks: checksSchema,
            },
            required: ["status", "checks"],
          },
        },
      },
    },
    async (_request, reply) => {
      const database = await checkDatabase(deps.prisma);
      const redisStatus = await checkRedis(deps.redis);

      if (database.status === "ok" && redisStatus.status === "ok") {
        void reply.code(200);
        void reply.send({ status: "ok", checks: { api: "up", database, redis: redisStatus } });
        return;
      }

      void reply.code(503);
      void reply.send({
        status: "degraded",
        checks: { api: "up", database, redis: redisStatus },
      });
    }
  );

  return app;
}

import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { ConflictError, ValidationError } from "../shared/errors.js";
import { toJsonValue } from "./payment.entity.js";

export type IdempotencyOutcome = { kind: "cached"; body: unknown } | { kind: "accepted" };

const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_SECONDS = 120;
const LOCK_ACQUIRE_TIMEOUT_MS = 500;

const LOCK_RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Deterministic canonical serialization for request hashing.
 * Keys are sorted recursively so that semantically equal payloads hash
 * identically regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new ValidationError("value cannot be hashed", { type: typeof value });
}

/**
 * Durable idempotency (SPEC section 8 and 18A).
 *
 * - The IdempotencyRecord table is the durable source of truth.
 * - Redis is used ONLY for short-lived concurrency protection and is never
 *   treated as the durable correctness mechanism (SPEC 18B).
 * - A stale in_progress record is reclaimable after expiresAt so a failed /
 *   interrupted execution never leaves an unrecoverable lock.
 */
export class IdempotencyService {
  private readonly heldLocks = new Map<string, string>();

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis
  ) {}

  public static computeRequestHash(payload: unknown): string {
    return createHash("sha256").update(canonicalJson(payload)).digest("hex");
  }

  public async begin(key: string, requestHash: string): Promise<IdempotencyOutcome> {
    const existingBefore = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (existingBefore !== null && existingBefore.status === "completed") {
      return this.toOutcome(existingBefore, requestHash);
    }

    const lockAcquired = await this.acquireLock(key);
    if (!lockAcquired) {
      const current = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
      if (current !== null && current.status === "completed") {
        return this.toOutcome(current, requestHash);
      }
      throw new ConflictError("An operation with this Idempotency-Key is already in progress", {
        key,
      });
    }

    try {
      const existing = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
      if (existing !== null) {
        if (existing.status === "completed") {
          await this.releaseLock(key);
          return this.toOutcome(existing, requestHash);
        }
        if (existing.expiresAt > new Date()) {
          await this.releaseLock(key);
          throw new ConflictError("An operation with this Idempotency-Key is already in progress", {
            key,
          });
        }
        // Stale in_progress record: reclaim it so the key is usable again.
        await this.prisma.idempotencyRecord.delete({ where: { key } });
      }

      try {
        await this.prisma.idempotencyRecord.create({
          data: {
            key,
            requestHash,
            status: "in_progress",
            expiresAt: new Date(Date.now() + RECORD_TTL_MS),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Lost a race against a concurrent request.
          await this.releaseLock(key);
          const winner = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
          if (winner !== null) {
            return this.toOutcome(winner, requestHash);
          }
          throw new ConflictError("Idempotency-Key is already being processed", { key });
        }
        throw error;
      }

      return { kind: "accepted" };
    } catch (error) {
      await this.releaseLock(key);
      throw error;
    }
  }

  /**
   * Marks the idempotency record as completed inside an existing transaction
   * so that completion is atomic with the business state transition.
   */
  public async completeTx(
    tx: Prisma.TransactionClient,
    key: string,
    responseBody: unknown
  ): Promise<void> {
    await tx.idempotencyRecord.update({
      where: { key },
      data: { status: "completed", responseBody: toJsonValue(responseBody) },
    });
  }

  public async complete(key: string, responseBody: unknown): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.completeTx(tx, key, responseBody);
    });
    await this.releaseLock(key);
  }

  public async abandon(key: string): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.delete({ where: { key } });
    } catch {
      // Record already gone; nothing to roll back.
    }
    await this.releaseLock(key);
  }

  public async releaseLock(key: string): Promise<void> {
    const token = this.heldLocks.get(key);
    if (token === undefined) {
      return;
    }
    try {
      await this.redis.eval(LOCK_RELEASE_SCRIPT, 1, this.lockKey(key), token);
    } catch {
      // Redis lock is best-effort; the DB record remains the source of truth.
    } finally {
      this.heldLocks.delete(key);
    }
  }

  private async acquireLock(key: string): Promise<boolean> {
    try {
      const token = randomUUID();
      const result = await Promise.race([
        this.redis.set(this.lockKey(key), token, "EX", LOCK_TTL_SECONDS, "NX"),
        new Promise<"TIMEOUT">((resolve) =>
          setTimeout(() => resolve("TIMEOUT"), LOCK_ACQUIRE_TIMEOUT_MS)
        ),
      ]);
      if (result === "OK") {
        this.heldLocks.set(key, token);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private lockKey(key: string): string {
    return `idem:lock:${key}`;
  }

  private toOutcome(
    record: { requestHash: string; responseBody: unknown },
    requestHash: string
  ): IdempotencyOutcome {
    if (record.requestHash !== requestHash) {
      throw new ConflictError("Idempotency-Key was already used with a different request");
    }
    return { kind: "cached", body: record.responseBody };
  }
}

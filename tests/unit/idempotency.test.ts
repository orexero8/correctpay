import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../../src/shared/errors.js";
import { IdempotencyService } from "../../src/core/idempotency.service.js";
import { fakePrisma } from "../helpers/fake-prisma.js";
import { createFakeRedis } from "../helpers/fake-redis.js";
import type { Redis } from "ioredis";

function buildService(): {
  service: IdempotencyService;
  store: ReturnType<typeof fakePrisma>["store"];
  redisStore: Map<string, string>;
} {
  const { client, store } = fakePrisma();
  const redis = createFakeRedis();
  const service = new IdempotencyService(client, redis as unknown as Redis);
  return { service, store, redisStore: redis.store };
}

describe("request hashing", () => {
  it("hashes equal logical payloads identically regardless of key order", () => {
    const a = IdempotencyService.computeRequestHash({ amount: "1.00", currency: "DZD" });
    const b = IdempotencyService.computeRequestHash({ currency: "DZD", amount: "1.00" });
    expect(a).toBe(b);
  });

  it("hashes different payloads differently", () => {
    const a = IdempotencyService.computeRequestHash({ amount: "1.00" });
    const b = IdempotencyService.computeRequestHash({ amount: "2.00" });
    expect(a).not.toBe(b);
  });
});

describe("IdempotencyService.begin", () => {
  let setup: ReturnType<typeof buildService>;

  beforeEach(() => {
    setup = buildService();
  });

  it("accepts a fresh key", async () => {
    const outcome = await setup.service.begin("key-1", "hash-1");
    expect(outcome.kind).toBe("accepted");
    expect(setup.store.idempotency.get("key-1")?.status).toBe("in_progress");
  });

  it("returns a cached result for a completed key with the same hash", async () => {
    await setup.service.begin("key-1", "hash-1");
    await setup.service.complete("key-1", { ok: true });

    const outcome = await setup.service.begin("key-1", "hash-1");
    expect(outcome).toEqual({ kind: "cached", body: { ok: true } });
  });

  it("returns the conflict when completed with a different hash", async () => {
    await setup.service.begin("key-1", "hash-1");
    await setup.service.complete("key-1", { ok: true });

    await expect(setup.service.begin("key-1", "hash-2")).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects while an operation is in progress", async () => {
    await setup.service.begin("key-1", "hash-1");
    await expect(setup.service.begin("key-1", "hash-1")).rejects.toBeInstanceOf(ConflictError);
  });

  it("cross-worker conflict: second worker holding the Redis lock is rejected", async () => {
    // First worker accepts and holds the lock.
    const first = await setup.service.begin("key-1", "hash-1");
    expect(first.kind).toBe("accepted");
    expect(setup.redisStore.get("idem:lock:key-1")).toBeDefined();

    // Second worker (cannot acquire the lock) sees an in_progress record.
    await expect(setup.service.begin("key-1", "hash-1")).rejects.toBeInstanceOf(ConflictError);
  });

  it("recovers a stale in_progress record once the lock and record have expired", async () => {
    await setup.service.begin("key-1", "hash-1");
    const record = setup.store.idempotency.get("key-1");
    if (record !== undefined) {
      record.expiresAt = new Date(Date.now() - 1000);
    }
    // The Redis lock outlives nothing here: expire it to emulate Redis EX.
    setup.redisStore.delete("idem:lock:key-1");

    const outcome = await setup.service.begin("key-1", "hash-2");
    expect(outcome.kind).toBe("accepted");
    expect(setup.store.idempotency.get("key-1")?.requestHash).toBe("hash-2");
  });

  it("surfaces a conflict when it loses a concurrent unique-insert race", async () => {
    // Another worker created the record between our lock acquisition and our
    // insert (simulated via create failure), and the winner vanished.
    setup.store.interfereNextIdempotencyCreate = true;
    await expect(setup.service.begin("race-1", "hash-A")).rejects.toBeInstanceOf(ConflictError);
  });

  it("abandon removes the record and releases the lock", async () => {
    await setup.service.begin("key-1", "hash-1");
    await setup.service.abandon("key-1");
    expect(setup.store.idempotency.has("key-1")).toBe(false);
    expect(setup.redisStore.get("idem:lock:key-1")).toBeUndefined();

    const outcome = await setup.service.begin("key-1", "hash-1");
    expect(outcome.kind).toBe("accepted");
  });

  it("can retry a failed key after abandon", async () => {
    await setup.service.begin("key-1", "hash-1");
    await setup.service.abandon("key-1");
    await setup.service.begin("key-1", "hash-1");
    await setup.service.complete("key-1", { final: true });

    const outcome = await setup.service.begin("key-1", "hash-1");
    expect(outcome).toEqual({ kind: "cached", body: { final: true } });
  });
});

describe("canonicalJson determinism", () => {
  it("rejects non-serializable input types", () => {
    expect(() => IdempotencyService.computeRequestHash({ fn: () => 1 })).toThrow(ValidationError);
  });

  it("handles arrays and nested objects deterministically", () => {
    const a = IdempotencyService.computeRequestHash({ list: [1, { b: 2, a: 1 }] });
    const b = IdempotencyService.computeRequestHash({ list: [{ a: 1, b: 2 }, 1] });
    expect(a).not.toBe(b);
  });
});

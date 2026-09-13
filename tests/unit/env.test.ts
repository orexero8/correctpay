import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentValidationError, loadEnv, resetEnvCache } from "../../src/config/env.js";

const validEnv: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/payments",
  REDIS_URL: "redis://localhost:6379",
  MOCK_ADAPTER_ENABLED: "true",
  MOCK_WEBHOOK_SECRET: "0123456789abcdef0123456789abcdef",
};

describe("env validation", () => {
  afterEach(() => {
    resetEnvCache();
  });

  it("accepts a valid environment", () => {
    const env = loadEnv(validEnv);
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.REDIS_URL).toBe(validEnv.REDIS_URL);
    expect(env.MOCK_ADAPTER_ENABLED).toBe(true);
    expect(env.NODE_ENV).toBe("test");
  });

  it("accepts defaults for non-required fields", () => {
    const env = loadEnv({
      DATABASE_URL: validEnv.DATABASE_URL,
      REDIS_URL: validEnv.REDIS_URL,
      MOCK_WEBHOOK_SECRET: validEnv.MOCK_WEBHOOK_SECRET,
    });
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.CORS_ORIGIN).toBe("*");
  });

  it("rejects a missing required variable", () => {
    const { DATABASE_URL: _dropped, ...withoutDatabaseUrl } = validEnv;
    void _dropped;
    expect(() => loadEnv(withoutDatabaseUrl)).toThrow(EnvironmentValidationError);
  });

  it("rejects a too-short MOCK_WEBHOOK_SECRET", () => {
    expect(() => loadEnv({ ...validEnv, MOCK_WEBHOOK_SECRET: "too-short" })).toThrow(
      EnvironmentValidationError
    );
  });

  it("rejects an invalid NODE_ENV value", () => {
    expect(() => loadEnv({ ...validEnv, NODE_ENV: "unsupported" })).toThrow(
      EnvironmentValidationError
    );
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadEnv({ ...validEnv, PORT: "not-a-port" })).toThrow(EnvironmentValidationError);
  });
});

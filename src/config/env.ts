import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  CORS_ORIGIN: z.string().default("*"),
  MOCK_ADAPTER_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value === "true"),
  MOCK_ADAPTER_BASE_URL: z.string().default("http://localhost:3000"),
  MOCK_WEBHOOK_TARGET_URL: z.string().default("http://localhost:3000/v1/webhooks/mock"),
  MOCK_WEBHOOK_SECRET: z.string().min(32, "MOCK_WEBHOOK_SECRET must be at least 32 characters"),
  ACTIVE_PROVIDER: z.string().min(1, "ACTIVE_PROVIDER is required").default("mock"),
});

export type Env = z.infer<typeof envSchema>;

export class EnvironmentValidationError extends Error {
  public readonly issues: z.ZodIssue[];
  public readonly cause: Error;

  constructor(issues: z.ZodIssue[]) {
    super("Invalid environment configuration");
    this.name = "EnvironmentValidationError";
    this.issues = issues;
    this.cause = new Error("Zod environment validation failed");
  }
}

let cachedEnv: Env | null = null;

export function loadEnv(rawEnv: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv !== null) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(rawEnv);

  if (!parsed.success) {
    throw new EnvironmentValidationError(parsed.error.issues);
  }

  cachedEnv = parsed.data;
  return parsed.data;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}

export function getEnv(): Env {
  return loadEnv();
}

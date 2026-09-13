import { Prisma } from "@prisma/client";
import { ValidationError } from "../shared/errors.js";

export const MONEY_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function assertMoneyString(amount: string): void {
  if (typeof amount !== "string" || !MONEY_PATTERN.test(amount)) {
    throw new ValidationError(
      "amount must be a non-negative decimal string with up to 2 decimal places",
      { amount }
    );
  }
}

export function assertCurrencyCode(currency: string): void {
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    throw new ValidationError("currency must be a 3-letter ISO 4217 code", { currency });
  }
}

/** Converts a valid money string to integer minor units for exact comparison. */
export function amountToMinorUnits(amount: string): bigint {
  assertMoneyString(amount);
  const [whole = "0", fraction = ""] = amount.split(".");
  const normalized = (fraction + "00").slice(0, 2);
  return BigInt(whole) * 100n + BigInt(normalized);
}

export function assertAmountsEqual(actual: string, expected: string): void {
  if (amountToMinorUnits(actual) !== amountToMinorUnits(expected)) {
    throw new ValidationError("amount mismatch", { actual, expected });
  }
}

export function assertAmountAboveZero(amount: string): void {
  if (amountToMinorUnits(amount) <= 0n) {
    throw new ValidationError("amount must be greater than zero");
  }
}

export function formatPrismaDecimal(amount: Prisma.Decimal): string {
  return amount.toFixed(2);
}

/**
 * Recursively converts an arbitrary value into a Prisma JSON input value,
 * rejecting unsupported types. Top-level explicit null becomes Prisma.JsonNull
 * so it can be stored in a nullable JSON column.
 */
export function toJsonValue(
  value: unknown
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (value === null || value === undefined) {
    return Prisma.JsonNull;
  }
  return toJsonNested(value) as Prisma.InputJsonValue;
}

function toJsonNested(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonNested(entry));
  }
  if (typeof value === "object") {
    const record: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      record[key] = toJsonNested(entry);
    }
    return record;
  }
  throw new ValidationError("value is not JSON-serializable", { type: typeof value });
}

import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  amountToMinorUnits,
  assertAmountAboveZero,
  assertAmountsEqual,
  assertCurrencyCode,
  assertMoneyString,
  formatPrismaDecimal,
  toJsonValue,
} from "../../src/core/payment.entity.js";
import { ValidationError } from "../../src/shared/errors.js";

describe("money as decimal strings", () => {
  it("accepts valid money strings", () => {
    expect(() => assertMoneyString("0")).not.toThrow();
    expect(() => assertMoneyString("2500.00")).not.toThrow();
    expect(() => assertMoneyString("0.01")).not.toThrow();
    expect(() => assertMoneyString("123456789.99")).not.toThrow();
  });

  it("rejects invalid money strings", () => {
    for (const bad of [
      "-5",
      "1.234",
      "abc",
      "1,000",
      "",
      "1.2.3",
      " 1",
      "1 ",
      "1_000",
      "01.5",
      "001",
    ]) {
      expect(() => assertMoneyString(bad), `accepted ${bad}`).toThrow(ValidationError);
    }
  });

  it("compares money without floating point arithmetic", () => {
    expect(amountToMinorUnits("0.10") + amountToMinorUnits("0.20")).toBe(30n);
    expect(amountToMinorUnits("1000.00")).toBe(100000n);
    expect(amountToMinorUnits("0")).toBe(0n);
    expect(amountToMinorUnits("0.5")).toBe(50n);
    expect(amountToMinorUnits("999999999999.99")).toBe(99999999999999n);
  });

  it("asserts amount equality exactly", () => {
    expect(() => assertAmountsEqual("2500.00", "2500")).not.toThrow();
    expect(() => assertAmountsEqual("2500.01", "2500.00")).toThrow(ValidationError);
    expect(() => assertAmountsEqual("2500", "2500.10")).toThrow(ValidationError);
  });

  it("asserts amounts are above zero", () => {
    expect(() => assertAmountAboveZero("0.01")).not.toThrow();
    expect(() => assertAmountAboveZero("0")).toThrow(ValidationError);
  });

  it("formats Prisma decimals as fixed two-place strings", () => {
    expect(formatPrismaDecimal(new Prisma.Decimal("2500.00"))).toBe("2500.00");
    expect(formatPrismaDecimal(new Prisma.Decimal("0.10").add(new Prisma.Decimal("0.20")))).toBe(
      "0.30"
    );
  });
});

describe("currency validation", () => {
  it("accepts three-letter codes", () => {
    expect(() => assertCurrencyCode("DZD")).not.toThrow();
    expect(() => assertCurrencyCode("USD")).not.toThrow();
    expect(() => assertCurrencyCode("EUR")).not.toThrow();
  });

  it("rejects malformed codes", () => {
    for (const bad of ["DZ", "dzd", "DZD1", "123", "", "DZD-", "DZD2"]) {
      expect(() => assertCurrencyCode(bad), `accepted ${bad}`).toThrow(ValidationError);
    }
  });
});

describe("toJsonValue", () => {
  it("serializes nested structures deterministically", () => {
    const value = toJsonValue({
      customer: { id: "c1", tag: null },
      items: ["a", 1, true],
    });
    expect(JSON.stringify(value)).toBe('{"customer":{"id":"c1","tag":null},"items":["a",1,true]}');
  });

  it("maps explicit null to Prisma.JsonNull for nullable JSON columns", () => {
    expect(toJsonValue(null)).toBe(Prisma.JsonNull);
    expect(toJsonValue(undefined)).toBe(Prisma.JsonNull);
  });

  it("serializes dates to ISO strings", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(toJsonValue({ createdAt: date })).toEqual({ createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it("rejects unsupported types", () => {
    expect(() => toJsonValue({ fn: () => 1 })).toThrow(ValidationError);
  });

  it("nests null values as plain null inside objects", () => {
    expect(toJsonValue({ a: null, b: [null] })).toEqual({ a: null, b: [null] });
  });
});

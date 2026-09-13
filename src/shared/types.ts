import type { PaymentStatus as PrismaPaymentStatus } from "@prisma/client";

export type PaymentStatus = PrismaPaymentStatus;

export type MoneyDecimalString = string;

export type IsoCurrencyCode = string;

export type PaymentTransitionSource = "api" | "webhook" | "reconciliation" | "system";

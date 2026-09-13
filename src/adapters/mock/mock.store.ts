/**
 * In-memory stand-in for the provider's transaction ledger.
 *
 * This simulates the transactions that the real CIBWeb system would hold
 * server-side. It is DEV/TEST ONLY: state resets on process restart, and it
 * must never hold card data. The real provider ledger will come with the
 * official CIB package; nothing here is meant to mirror it.
 */
import { randomUUID } from "node:crypto";
import { ProviderError } from "../../shared/errors.js";

export type MockProviderStatus = "pending" | "paid" | "failed" | "expired";

export type MockConfirmOutcome = "paid" | "failed" | "expired";

export interface MockTransaction {
  providerReference: string;
  reference: string;
  amount: string;
  currency: string;
  returnUrl: string;
  metadata: Record<string, unknown> | null;
  status: MockProviderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMockTransactionInput {
  reference: string;
  amount: string;
  currency: string;
  returnUrl: string;
  metadata: Record<string, unknown> | null;
}

export class MockProviderStore {
  private readonly transactions = new Map<string, MockTransaction>();

  public createTransaction(input: CreateMockTransactionInput): MockTransaction {
    const nowIso = new Date().toISOString();
    const transaction: MockTransaction = {
      providerReference: this.nextReference(),
      reference: input.reference,
      amount: input.amount,
      currency: input.currency,
      returnUrl: input.returnUrl,
      metadata: input.metadata,
      status: "pending",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.transactions.set(transaction.providerReference, transaction);
    return transaction;
  }

  public get(providerReference: string): MockTransaction | undefined {
    return this.transactions.get(providerReference);
  }

  public getOrThrow(providerReference: string): MockTransaction {
    const transaction = this.transactions.get(providerReference);
    if (transaction === undefined) {
      throw new ProviderError(`Unknown mock provider transaction: ${providerReference}`);
    }
    return transaction;
  }

  /**
   * Moves a transaction to a terminal state. Repeating a confirm for an
   * already-terminal transaction returns the current state unchanged so the
   * mock behaves like a provider that tolerates duplicate callbacks.
   */
  public confirm(providerReference: string, outcome: MockConfirmOutcome): MockTransaction {
    const transaction = this.getOrThrow(providerReference);
    if (transaction.status === "pending") {
      transaction.status = outcome;
      transaction.updatedAt = new Date().toISOString();
    }
    return transaction;
  }

  public reset(): void {
    this.transactions.clear();
  }

  private nextReference(): string {
    return `mock_${randomUUID()}`;
  }
}

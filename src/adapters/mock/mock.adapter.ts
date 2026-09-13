import type {
  CreatePaymentInput,
  CreatePaymentResult,
  GetStatusInput,
  PaymentProviderAdapter,
  PaymentStatusResult,
  RefundInput,
  RefundResult,
} from "../provider.interface.js";
import type { MockProviderStore } from "./mock.store.js";

export interface MockAdapterOptions {
  /**
   * Public base URL of this service. Used to build the fake checkout
   * redirect URL, e.g. "http://localhost:3000".
   */
  readonly baseUrl: string;
}

/**
 * Fully in-memory stand-in for the CIB / SATIM provider (SPEC §11).
 *
 * Simulates: create -> redirect to fake checkout -> PAY/FAIL/CANCEL ->
 * signed callback -> (Phase 5 webhook) -> local state transition.
 * No card data is ever involved. The callback format and signature scheme are
 * mock-only placeholders, NOT an approximation of the real CIB protocol.
 */
export class MockAdapter implements PaymentProviderAdapter {
  public constructor(
    private readonly store: MockProviderStore,
    private readonly options: MockAdapterOptions
  ) {}

  public createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    try {
      const transaction = this.store.createTransaction({
        reference: input.reference,
        amount: input.amount,
        currency: input.currency,
        returnUrl: input.returnUrl,
        metadata: input.metadata ?? null,
      });

      return Promise.resolve({
        providerReference: transaction.providerReference,
        redirectUrl: this.checkoutUrl(transaction.providerReference),
        raw: {
          provider: "mock",
          status: "pending",
          amount: transaction.amount,
          currency: transaction.currency,
        },
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public getPaymentStatus(input: GetStatusInput): Promise<PaymentStatusResult> {
    try {
      const transaction = this.store.getOrThrow(input.providerReference);
      return Promise.resolve({
        status: transaction.status,
        raw: {
          provider: "mock",
          amount: transaction.amount,
          currency: transaction.currency,
        },
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public refundPayment(input: RefundInput): Promise<RefundResult> {
    try {
      const transaction = this.store.getOrThrow(input.providerReference);
      return Promise.resolve({
        providerRefundReference: `mock_refund_${transaction.providerReference}`,
        status: "succeeded",
        raw: {
          provider: "mock",
          amount: input.amount,
          status: transaction.status,
        },
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private checkoutUrl(providerReference: string): string {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    return `${base}/mock/checkout/${providerReference}`;
  }
}

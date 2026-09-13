export interface CreatePaymentInput {
  reference: string;
  amount: string;
  currency: string;
  returnUrl: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentResult {
  providerReference: string;
  redirectUrl: string;
  raw: unknown;
}

export interface GetStatusInput {
  providerReference: string;
}

export interface PaymentStatusResult {
  status: "pending" | "paid" | "failed" | "expired";
  raw: unknown;
}

export interface RefundInput {
  providerReference: string;
  amount: string;
  reason?: string;
}

export interface RefundResult {
  providerRefundReference: string;
  status: "succeeded" | "pending" | "failed";
  raw: unknown;
}

export interface PaymentProviderAdapter {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  getPaymentStatus(input: GetStatusInput): Promise<PaymentStatusResult>;
  refundPayment(input: RefundInput): Promise<RefundResult>;
}

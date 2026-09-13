import type {
  CreatePaymentInput,
  CreatePaymentResult,
  GetStatusInput,
  PaymentProviderAdapter,
  PaymentStatusResult,
  RefundInput,
  RefundResult,
} from "../provider.interface.js";

const NOT_IMPLEMENTED = "NOT_IMPLEMENTED: awaiting official CIB technical package";

/**
 * Placeholder adapter for the real CIB / SATIM provider.
 *
 * The CIB/SATIM protocol (endpoints, request/response fields, authentication,
 * signatures, encryption, callbacks, statuses, error codes) is NOT implemented
 * until the official CIB technical package is received. See SPEC.md section 12.
 *
 * TODO: CONFIRM WITH OFFICIAL CIB PACKAGE
 */
export class CibPaymentAdapter implements PaymentProviderAdapter {
  public createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  public getPaymentStatus(_input: GetStatusInput): Promise<PaymentStatusResult> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  public refundPayment(_input: RefundInput): Promise<RefundResult> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
}

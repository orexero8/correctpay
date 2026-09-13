/**
 * Fake signed callback emitted by the mock "provider".
 *
 * Mock-only webhook wire format. The real CIB callback format is unknown
 * until the official package arrives; the shape below exists so the full
 * pipeline (dispatch -> raw body -> signature -> verification -> transition)
 * is testable end-to-end locally. See SPEC.md section 10/11.
 */
import { withTimeout } from "../../shared/promise.js";
import type { MockConfirmOutcome, MockProviderStatus, MockTransaction } from "./mock.store.js";
import { MOCK_SIGNATURE_HEADER, signBody } from "./mock.signature.js";

export type MockWebhookEvent = "payment.completed" | "payment.failed" | "payment.cancelled";

export interface MockWebhookPayload {
  event: MockWebhookEvent;
  status: MockProviderStatus;
  providerReference: string;
  reference: string;
  amount: string;
  currency: string;
  timestamp: string;
  signatureVersion: "v1";
}

export const MOCK_WEBHOOK_DISPATCH_TIMEOUT_MS = 5_000;

function eventForRawStatus(status: MockConfirmOutcome): MockWebhookEvent {
  switch (status) {
    case "paid":
      return "payment.completed";
    case "failed":
      return "payment.failed";
    case "expired":
      return "payment.cancelled";
  }
}

export function buildMockWebhookPayload(transaction: MockTransaction): MockWebhookPayload {
  const status = transaction.status as MockConfirmOutcome;
  return {
    event: eventForRawStatus(status),
    status: transaction.status,
    providerReference: transaction.providerReference,
    reference: transaction.reference,
    amount: transaction.amount,
    currency: transaction.currency,
    timestamp: new Date().toISOString(),
    signatureVersion: "v1",
  };
}

export interface EmitSignedWebhookOptions {
  readonly targetUrl: string;
  readonly secret: string;
  readonly transaction: MockTransaction;
  readonly fetchImpl?: typeof fetch;
}

/**
 * POSTs the signed mock callback and awaits the HTTP result. Any failure to
 * dispatch is logged, not thrown, because the real provider callback is also
 * asynchronous and loss-tolerant; the callback can be re-sent from the mock
 * checkout directly.
 */
export async function emitSignedWebhook(options: EmitSignedWebhookOptions): Promise<boolean> {
  const body = JSON.stringify(buildMockWebhookPayload(options.transaction));
  const signature = signBody(body, options.secret);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await withTimeout(
      fetchImpl(options.targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [MOCK_SIGNATURE_HEADER]: signature,
        },
        body,
      }),
      MOCK_WEBHOOK_DISPATCH_TIMEOUT_MS,
      "mock webhook dispatch"
    );

    if (!response.ok) {
      console.warn(
        `mock webhook dispatch to ${options.targetUrl} returned ${String(response.status)}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `mock webhook dispatch to ${options.targetUrl} failed`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

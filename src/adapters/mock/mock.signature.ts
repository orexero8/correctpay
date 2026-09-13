/**
 * Mock-provider webhook signature (HMAC-SHA256).
 *
 * The real CIB signature scheme is unknown until the official package is
 * received; this is a placeholder so the full signed-callback pipeline can be
 * exercised locally. Phase 5's webhook verifier uses these same primitives.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifySignature(rawBody: string, secret: string, signature: string): boolean {
  const provided = Buffer.from(signature, "utf8");
  const expected = Buffer.from(signBody(rawBody, secret), "utf8");
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

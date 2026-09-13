import { describe, expect, it } from "vitest";
import {
  MOCK_SIGNATURE_HEADER,
  signBody,
  verifySignature,
} from "../../src/adapters/mock/mock.signature.js";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("mock signature", () => {
  it("produces a deterministic signature for the same body", () => {
    const body = JSON.stringify({ providerReference: "mock_1", status: "paid" });
    expect(signBody(body, SECRET)).toBe(signBody(body, SECRET));
  });

  it("verifies a correct signature", () => {
    const body = "raw-payload";
    expect(verifySignature(body, SECRET, signBody(body, SECRET))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ status: "paid" });
    const signature = signBody(body, SECRET);
    const tampered = JSON.stringify({ status: "failed" });
    expect(verifySignature(tampered, SECRET, signature)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const body = "raw-payload";
    const signature = signBody(body, "different-secret");
    expect(verifySignature(body, SECRET, signature)).toBe(false);
  });

  it("rejects a signature of a different length without crashing", () => {
    expect(verifySignature("raw-payload", SECRET, "short")).toBe(false);
  });

  it("exposes the header name used on the wire", () => {
    expect(MOCK_SIGNATURE_HEADER).toBe("x-mock-signature");
  });
});

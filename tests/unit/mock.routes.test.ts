import { afterEach, describe, expect, it, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { MockTransaction } from "../../src/adapters/mock/mock.store.js";
import { registerMockRoutes } from "../../src/adapters/mock/mock.routes.js";
import { MockProviderStore } from "../../src/adapters/mock/mock.store.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const BASE_URL = "http://localhost:3957";
const TARGET_URL = "http://localhost:3957/v1/webhooks/mock";

interface EmissionCapture {
  transaction: MockTransaction;
  targetUrl: string;
  secret: string;
}

function buildRoutes(emitProof: EmissionCapture[]): Promise<{
  app: FastifyInstance;
  store: MockProviderStore;
}> {
  return (async () => {
    const app = Fastify();
    const store = new MockProviderStore();

    await registerMockRoutes(app, {
      store,
      secret: SECRET,
      baseUrl: BASE_URL,
      webhookTargetUrl: TARGET_URL,
      emit: async (options) => {
        emitProof.push({
          transaction: options.transaction,
          targetUrl: options.targetUrl,
          secret: options.secret,
        });
        return true;
      },
    });

    return { app, store };
  })();
}

describe("mock checkout routes", () => {
  let app: FastifyInstance;
  let store: MockProviderStore;
  let emissions: EmissionCapture[];
  let providerReference: string;

  beforeEach(async () => {
    emissions = [];
    const built = await buildRoutes(emissions);
    app = built.app;
    store = built.store;
    await app.ready();
    const transaction = store.createTransaction({
      reference: "REF-93821",
      amount: "2500.00",
      currency: "DZD",
      returnUrl: "https://merchant.dz/payment/return",
      metadata: null,
    });
    providerReference = transaction.providerReference;
  });

  afterEach(async () => {
    await app.close();
  });

  async function confirm(action: string) {
    return app.inject({
      method: "POST",
      url: `/mock/checkout/${providerReference}`,
      payload: `action=${action}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  it("serves the checkout page with PAY/FAIL/CANCEL and no card fields", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/mock/checkout/${providerReference}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("2500.00");
    expect(response.body).toContain('value="PAY"');
    expect(response.body).toContain('value="FAIL"');
    expect(response.body).toContain('value="CANCEL"');
    expect(response.body).not.toMatch(/<input[^>]+name="(card|pan|cvv|pin|number)"/i);
  });

  it("returns 404 for an unknown provider reference on the checkout page", async () => {
    const response = await app.inject({ method: "GET", url: "/mock/checkout/unknown" });
    expect(response.statusCode).toBe(404);
  });

  it("marks the transaction paid on PAY and emits the callback", async () => {
    const response = await confirm("PAY");
    expect(response.statusCode).toBe(200);
    expect(store.get(providerReference)?.status).toBe("paid");
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.transaction.status).toBe("paid");
    expect(emissions[0]?.targetUrl).toBe(TARGET_URL);
    expect(emissions[0]?.secret).toBe(SECRET);
  });

  it("marks the transaction failed on FAIL", async () => {
    await confirm("FAIL");
    expect(store.get(providerReference)?.status).toBe("failed");
  });

  it("marks the transaction expired on CANCEL", async () => {
    await confirm("CANCEL");
    expect(store.get(providerReference)?.status).toBe("expired");
  });

  it("rejects an unknown action with 400 and leaves state pending", async () => {
    const response = await confirm("HACK");
    expect(response.statusCode).toBe(400);
    expect(store.get(providerReference)?.status).toBe("pending");
    expect(emissions).toHaveLength(0);
  });

  it("returns 404 for a confirm on an unknown provider reference", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mock/checkout/unknown",
      payload: "action=PAY",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.statusCode).toBe(404);
  });
});

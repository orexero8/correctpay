import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import { z } from "zod";
import { emitSignedWebhook } from "./mock.callback.js";
import type { MockConfirmOutcome, MockProviderStore } from "./mock.store.js";

export interface MockRoutesDeps {
  readonly store: MockProviderStore;
  readonly secret: string;
  readonly baseUrl: string;
  readonly webhookTargetUrl: string;
  readonly emit?: typeof emitSignedWebhook;
}

interface CheckoutRouteParams {
  providerReference: string;
}

const actionSchema = z.object({
  action: z.enum(["PAY", "FAIL", "CANCEL"]),
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const resultLabel: Record<MockConfirmOutcome, string> = {
  paid: "paid",
  failed: "failed",
  expired: "cancelled/expired",
};

function checkoutPage(transaction: {
  providerReference: string;
  reference: string;
  amount: string;
  currency: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Mock checkout</title>
</head>
<body>
<h1>Mock provider checkout</h1>
<p>This page simulates the provider hosted payment page for local end-to-end testing.</p>
<dl>
<dt>Reference</dt><dd>${escapeHtml(transaction.reference)}</dd>
<dt>Amount</dt><dd>${escapeHtml(transaction.amount)} ${escapeHtml(transaction.currency)}</dd>
<dt>Provider transaction</dt><dd>${escapeHtml(transaction.providerReference)}</dd>
</dl>
<form method="post" action="/mock/checkout/${escapeHtml(transaction.providerReference)}">
<button type="submit" name="action" value="PAY">Pay</button>
<button type="submit" name="action" value="FAIL">Fail</button>
<button type="submit" name="action" value="CANCEL">Cancel</button>
</form>
</body>
</html>`;
}

function resultPage(status: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Mock checkout result</title>
</head>
<body>
<h1>Mock checkout result</h1>
<p>Payment marked ${escapeHtml(status)}. The module processes this via its signed callback.</p>
</body>
</html>`;
}

function notFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Not found</title>
</head>
<body>
<h1>Unknown provider transaction</h1>
<p>No mock provider transaction exists for this reference.</p>
</body>
</html>`;
}

async function handleConfirm(
  deps: MockRoutesDeps,
  request: FastifyRequest<{ Params: CheckoutRouteParams; Body: unknown }>,
  reply: FastifyReply
): Promise<void> {
  const { providerReference } = request.params;
  const transaction = deps.store.get(providerReference);
  if (transaction === undefined) {
    return reply.code(404).type("text/html").send(notFoundPage());
  }

  const parsed = actionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "action must be one of: PAY, FAIL, CANCEL",
      },
    });
  }

  const outcome: MockConfirmOutcome = outcomeForAction(parsed.data.action);
  const updated = deps.store.confirm(providerReference, outcome);

  const eventEmitter = deps.emit ?? emitSignedWebhook;
  await eventEmitter({
    targetUrl: deps.webhookTargetUrl,
    secret: deps.secret,
    transaction: updated,
  });

  return reply.code(200).type("text/html").send(resultPage(resultLabel[outcome]));
}

function outcomeForAction(action: "PAY" | "FAIL" | "CANCEL"): MockConfirmOutcome {
  switch (action) {
    case "PAY":
      return "paid";
    case "FAIL":
      return "failed";
    case "CANCEL":
      return "expired";
  }
}

export async function registerMockRoutes(
  app: FastifyInstance,
  deps: MockRoutesDeps
): Promise<void> {
  await app.register(formbody);

  app.get("/mock/checkout/:providerReference", (request, reply) => {
    const { providerReference } = request.params as { providerReference: string };
    const transaction = deps.store.get(providerReference);
    if (transaction === undefined) {
      return reply.code(404).type("text/html").send(notFoundPage());
    }
    return reply
      .code(200)
      .type("text/html")
      .headers({ "content-security-policy": "default-src 'none'" })
      .send(checkoutPage(transaction));
  });

  app.post<{ Params: CheckoutRouteParams; Body: unknown }>(
    "/mock/checkout/:providerReference",
    (request, reply) => handleConfirm(deps, request, reply)
  );
}

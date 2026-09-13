# CIBWEB / SATIM PAYMENT MODULE — V1 BUILD SPEC
### Claude Code implementation specification
### Goal: lean, secure, testable, certification-ready — no guessed CIB protocol

---

## 0. NON-NEGOTIABLE RULE

Build a generic payment engine. Keep all CIB/SATIM-specific protocol code inside:

`src/adapters/cib/`

If an official CIB/SATIM technical document is not available for a protocol detail, DO NOT GUESS.

Use:

`// TODO: CONFIRM WITH OFFICIAL CIB PACKAGE`

Do not invent:
- endpoints
- request fields
- response fields
- signature algorithms
- encryption
- callback formats
- status mappings
- authentication methods
- certificates
- headers

The official CIB/SATIM package is the source of truth.

---

# 1. TARGET

The module must provide:

1. Create payment
2. Generate provider redirect/payment data
3. Receive provider callback/webhook
4. Verify provider callback
5. Verify amount + currency + reference
6. Move payment to PAID only after trusted server-side confirmation
7. Query payment status
8. Idempotent requests
9. Duplicate callback protection
10. Audit trail
11. Refund abstraction
12. Mock provider for complete local testing
13. Automated tests
14. Docker development environment
15. Clean deployment configuration

Do NOT build a custom card-entry form.

Do NOT store card numbers, PINs, CVV, or other sensitive card data.

---

# 2. IMPORTANT CERTIFICATION REALITY

The code can be made certification-ready, but certification itself is external.

Official CIBWeb states that module certification involves:
1. Application submission
2. Acceptability processing
3. API/test-slot access after acceptance
4. Certification appointment
5. Certification tests
6. Certification report
7. Certificate issuance
8. Referencing of the certified module

Therefore:

**Never promise zero certification issues or a fixed certification duration.**

The development team controls the code quality.
GIE Monétique / SATIM control the official test and certification process.

---

# 3. STACK

Use:

- Node.js LTS
- TypeScript 5.x
- strict TypeScript
- Fastify
- Zod
- Prisma
- PostgreSQL
- Redis
- ioredis
- BullMQ only where actually required
- Vitest
- ESLint
- Prettier
- Docker / Docker Compose

Rules:

- no `any`
- no `@ts-ignore` without documented reason
- no JavaScript floating-point money calculations
- money represented as decimal strings at API/provider boundaries
- environment secrets never committed

---

# 4. PROJECT STRUCTURE

```text
cib-payment-module/
├── src/
│   ├── core/
│   │   ├── payment.entity.ts
│   │   ├── payment.service.ts
│   │   ├── payment.state-machine.ts
│   │   ├── idempotency.service.ts
│   │   └── refund.service.ts
│   │
│   ├── adapters/
│   │   ├── provider.interface.ts
│   │   ├── mock/
│   │   │   └── mock.adapter.ts
│   │   └── cib/
│   │       ├── cib.adapter.ts
│   │       ├── cib.signature.ts
│   │       └── cib.types.ts
│   │
│   ├── webhook/
│   │   ├── webhook.controller.ts
│   │   ├── webhook.verifier.ts
│   │   └── webhook.processor.ts
│   │
│   ├── api/
│   │   ├── routes/
│   │   │   ├── payments.routes.ts
│   │   │   └── health.routes.ts
│   │   ├── schemas/
│   │   │   └── payment.schema.ts
│   │   └── server.ts
│   │
│   ├── db/
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   └── client.ts
│   │
│   ├── config/
│   │   └── env.ts
│   │
│   └── shared/
│       ├── errors.ts
│       ├── logger.ts
│       └── types.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── contract/
│
├── docs/
│   ├── certification/
│   └── deployment/
│       └── ROLLBACK.md
│
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
└── SPEC.md
```

---

# 5. GENERIC PROVIDER INTERFACE

Do not put CIB-specific fields in the generic interface.

```typescript
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
```

If the official CIB system does not support refunds or status queries, adapt the CIB implementation without contaminating the generic core.

---

# 6. PAYMENT DATABASE

Use this EXACT Prisma schema. Do not rename fields, do not change types, do not add business-domain tables.

```prisma
model Payment {
  id                String        @id @default(uuid())
  reference         String        @unique   // caller-provided external reference
  amount            Decimal       @db.Decimal(12, 2)
  currency          String        @default("DZD")
  status            PaymentStatus @default(CREATED)
  provider          String        @default("cib")
  providerReference String?       @unique
  idempotencyKey    String        @unique
  metadata          Json?
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt
  expiresAt         DateTime?

  events  PaymentEvent[]
  refunds Refund[]
}

model PaymentEvent {
  id          String        @id @default(uuid())
  paymentId   String
  payment     Payment       @relation(fields: [paymentId], references: [id])
  fromStatus  PaymentStatus?
  toStatus    PaymentStatus
  source      String        // "api" | "webhook" | "reconciliation" | "system"
  payloadHash String?
  createdAt   DateTime      @default(now())
}

model Refund {
  id                String       @id @default(uuid())
  paymentId         String
  payment           Payment      @relation(fields: [paymentId], references: [id])
  amount            Decimal      @db.Decimal(12, 2)
  status            RefundStatus @default(PENDING)
  providerReference String?
  reason            String?
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt
}

model WebhookDelivery {
  id           String   @id @default(uuid())
  eventId      String   @unique   // provider's event/notification id
  rawPayload   Json
  payloadHash  String
  status       String   @default("received")  // received|processed|failed|duplicate
  attemptCount Int      @default(1)
  createdAt    DateTime @default(now())
}

model IdempotencyRecord {
  id           String   @id @default(uuid())
  key          String   @unique
  requestHash  String
  responseBody Json?
  status       String   @default("in_progress") // in_progress|completed
  createdAt    DateTime @default(now())
  expiresAt    DateTime
}

enum PaymentStatus {
  CREATED
  PENDING
  PROCESSING
  PAID
  FAILED
  EXPIRED
  CANCELLED
  PARTIALLY_REFUNDED
  FULLY_REFUNDED
}

enum RefundStatus {
  PENDING
  SUCCEEDED
  FAILED
}
```

Do not add business-domain tables.

---

# 7. PAYMENT STATES

Use this EXACT transition table. Do not add, remove, or reinterpret any transition — if a path isn't listed below, it is not allowed.

```typescript
// src/core/payment.state-machine.ts
export const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED:            ['PENDING', 'CANCELLED'],
  PENDING:            ['PROCESSING', 'EXPIRED', 'CANCELLED'],
  PROCESSING:         ['PAID', 'FAILED'],
  PAID:               ['PARTIALLY_REFUNDED', 'FULLY_REFUNDED'],
  PARTIALLY_REFUNDED: ['FULLY_REFUNDED'],
  FAILED:             [],
  EXPIRED:            [],
  CANCELLED:          [],
  FULLY_REFUNDED:     [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
```

All payment status updates MUST call `transitionPayment(paymentId, toStatus, source)`, which internally calls `canTransition()` and rejects with `InvalidStateTransitionError` if the transition isn't in the table above. No other function in the codebase may write to `Payment.status` directly.

Every transition must go through one state-machine function.

Never directly update payment status from an API route.

`PAID` may only come from:

- verified provider callback/webhook
- trusted server-side provider status query/reconciliation

Never trust browser redirect as proof of payment.

---

# 8. IDEMPOTENCY

Every mutating payment endpoint requires:

`Idempotency-Key`

Behavior:

- same key + same request → return original result
- same key + different request → 409 conflict
- concurrent duplicate requests → only one provider operation
- failed/incomplete execution must not leave an unrecoverable lock
- database record is the durable source of truth
- Redis is used only for short-lived concurrency protection

Do not use `as any`.

If Prisma JSON typing requires conversion, create a properly typed JSON value instead.

---

# 9. API

## POST /v1/payments

Request:

```json
{
  "reference": "REF-93821",
  "amount": "2500.00",
  "currency": "DZD",
  "returnUrl": "https://example.dz/payment/return"
}
```

Response:

```json
{
  "id": "uuid",
  "status": "PENDING",
  "redirectUrl": "https://provider.example/...",
  "reference": "REF-93821"
}
```

## GET /v1/payments/:id

Returns:

- id
- reference
- amount
- currency
- status
- createdAt
- updatedAt

Never expose provider secrets or sensitive raw provider data.

## POST /v1/payments/:id/refund

Request:

```json
{
  "amount": "1000.00",
  "reason": "customer cancellation"
}
```

Require idempotency.

If the official provider does not support refund through the supplied API, return a controlled unsupported-provider error rather than inventing a flow.

## GET /v1/health

Return service health for:

- API
- database
- Redis

Do not expose secrets.

---

# 10. WEBHOOK / CALLBACK

The exact CIB callback behavior must come from the official package.

Generic processing pipeline:

```text
Receive request
      ↓
Preserve raw body
      ↓
Verify provider signature/authentication
      ↓
Parse provider payload
      ↓
Identify event
      ↓
Check duplicate event
      ↓
Find payment
      ↓
Verify amount
      ↓
Verify currency
      ↓
Verify reference/provider reference
      ↓
Map provider status
      ↓
Apply state transition
      ↓
Write audit event
      ↓
Acknowledge provider
```

Never mark a payment PAID because the browser returned to `returnUrl`.

---

# 11. MOCK ADAPTER

Build this BEFORE the real CIB adapter.

Mock checkout must allow:

- PAY
- FAIL
- CANCEL

It must simulate the complete flow:

```text
Create payment
→ redirect to fake checkout
→ choose result
→ signed fake callback
→ webhook verification
→ state transition
→ GET payment
```

This allows the entire architecture to be tested before receiving official CIB credentials/API documentation.

---

# 12. CIB ADAPTER

Initially:

```typescript
throw new Error(
  "NOT_IMPLEMENTED: awaiting official CIB technical package"
);
```

Do not fake an implementation.

After receiving the official package:

1. Copy official documentation into `docs/certification/`.
2. Identify exact endpoints.
3. Identify authentication.
4. Identify signatures.
5. Identify required request fields.
6. Identify response fields.
7. Identify callback format.
8. Identify statuses.
9. Identify error codes.
10. Implement only those requirements.
11. Add a contract test for every official certification case.

Every CIB-specific implementation should have a comment pointing to its official source section.

Example:

```typescript
// Source: docs/certification/<document>, section <X>
```

---

# 13. SECURITY

Mandatory:

- HTTPS in production
- secrets only in environment/secret manager
- no card-number storage
- no PIN storage
- no CVV storage
- raw provider payloads must be handled according to the official security requirements
- validate all input with Zod
- strict CORS
- rate limiting where appropriate
- request size limits
- structured logging
- no secrets in logs
- no provider credentials in frontend code
- explicit external-request timeouts
- safe error responses
- audit payment state transitions

Do not implement cryptography unless the official CIB documentation specifies it.

---

# 14. TESTS

## Unit

Test:

- every valid state transition
- every invalid transition
- amount validation
- currency validation
- idempotency
- concurrent idempotency
- refund limits
- error mapping
- provider status mapping

## Integration

Test:

```text
create
→ redirect
→ mock payment
→ webhook
→ PAID
→ GET
```

Also test:

- duplicate webhook
- invalid signature
- amount mismatch
- currency mismatch
- unknown payment
- provider failure
- timeout
- concurrent duplicate payment requests

## Contract

Once official CIB documentation arrives:

- one test per official certification scenario
- exact traceability to official test case IDs where provided

---

# 15. OBSERVABILITY

Use structured logs.

Example:

```typescript
logger.info({
  event: "payment.status_changed",
  paymentId,
  fromStatus,
  toStatus
});
```

Never log:

- card data
- PIN
- CVV
- secrets
- authentication credentials

Keep an audit trail for important payment events.

---

# 16. RECONCILIATION

Implement only if the official CIB flow supports/requires provider status querying.

For payments stuck in pending/processing:

```text
query provider
→ compare provider status
→ transition local payment
→ record reconciliation event
```

Do not build a complicated worker architecture unless needed.

BullMQ is optional for V1 if no asynchronous workload requires it.

---

# 17. WHAT NOT TO BUILD

Before certification, do NOT build:

- multiple payment providers
- microservices
- custom card forms
- card storage
- complex dashboards
- unnecessary queues
- unnecessary admin panels
- business-domain logic
- speculative CIB endpoints
- invented CIB cryptography
- unnecessary reconciliation complexity

Keep V1 small.

---

# 18. BUILD ORDER

Claude Code MUST work in this order:

### Phase 1 — Foundation
1. Scaffold repository
2. TypeScript strict configuration
3. Fastify
4. Zod
5. Prisma
6. PostgreSQL
7. Redis
8. Docker
9. Environment validation

### Phase 2 — Payment Core
10. Prisma schema
11. Payment entity
12. State machine
13. Payment service
14. Idempotency service
15. Refund abstraction

### Phase 3 — Mock Provider
16. Provider interface
17. Mock adapter
18. Fake checkout
19. Fake signed callback

### Phase 4 — API
20. Create payment
21. Get payment
22. Refund
23. Health
24. Error handling

### Phase 5 — Webhook
25. Raw-body handling
26. Signature abstraction
27. Duplicate protection
28. Amount/currency/reference validation
29. State transition
30. Audit event

### Phase 6 — Testing
31. Unit tests
32. Integration tests
33. Concurrency tests
34. Failure tests
35. Full end-to-end mock flow

### STOP

Do not implement real CIB behavior until the official technical package/API is available.

### Phase 7 — Official CIB
36. Add official documentation
37. Implement CIB adapter
38. Implement official authentication/signature
39. Implement official callback
40. Implement official status mapping
41. Add contract tests
42. Run certification test cases

### Phase 8 — Release and Deployment
43. Release checklist
44. Production database backup
45. Version/tag release
46. Production deployment
47. Database migrations
48. Health check
49. Smoke test
50. Monitoring
51. Rollback verification

### Phase 9 — Production
52. Security review
53. Production environment
54. Monitoring
55. Backup/recovery
56. Final certification corrections
57. Production deployment

---


# 18A. REFUND IDEMPOTENCY

Refund operations MUST have durable idempotency protection.

Add to `Refund`:

```prisma
idempotencyKey String @unique
```

Rules:

- Every refund request requires `Idempotency-Key`.
- Same key + same refund request → return the original refund result.
- Same key + different refund request → 409 conflict.
- Concurrent duplicate refund requests → only one provider refund operation.
- The database is the durable source of truth.
- Redis may be used only for short-lived concurrency protection.
- A refund must never be submitted twice because of an application retry.

The refund idempotency key must be persisted before the provider operation is started.

---

# 18B. DATABASE CONCURRENCY PROTECTION

Payment state transitions MUST be protected against concurrent updates.

Examples that must be handled safely:

```text
Webhook                    Reconciliation
   ↓                            ↓
   └──────────→ SAME PAYMENT ←──┘
```

Requirements:

- Use a database transaction for payment state transitions.
- Prevent two concurrent workers from applying conflicting transitions.
- Re-read the current payment state inside the transaction before changing it.
- The state machine remains the single authority for valid transitions.
- Audit events must be written atomically with the state transition where practical.
- A duplicate event must never cause a second financial operation.
- PostgreSQL transaction/locking mechanisms must be preferred over application-only locking.
- Redis locks MUST NOT be treated as the durable correctness mechanism.

Add concurrency integration tests for:

- webhook + webhook
- webhook + reconciliation
- refund + refund
- payment request + payment request

---

# 18C. DEPLOYMENT, RELEASES AND UPDATES

Every production update MUST follow this process:

```text
Developer / Claude Code
        ↓
Git feature branch
        ↓
Unit + integration tests
        ↓
Type-check + lint + build
        ↓
Staging VPS
        ↓
Full mock / integration testing
        ↓
Production database backup
        ↓
Deploy version
        ↓
Database migrations
        ↓
Health check
        ↓
Smoke test
        ↓
Monitor
        ↓
Rollback if required
```

Rules:

- Never develop directly on production.
- Never edit production source files manually.
- Never modify production database tables manually.
- Every database change must use a versioned Prisma migration.
- Every release must have a Git tag.
- Use semantic versions such as `v1.0.0`, `v1.1.0`, `v1.2.0`.
- Keep the previous application image/version available for rollback.
- Production secrets must be supplied by the production environment, never committed to Git.
- Run migrations in a controlled deployment step.
- Do not automatically deploy to production after a code change.
- A failed deployment must not silently continue.

Example:

```text
v1.0.0  → certified/production version
v1.1.0  → new feature
v1.1.1  → bug fix
v1.2.0  → larger compatible update
```

---

# 18D. ROLLBACK

Every production deployment MUST have a documented rollback procedure.

Application rollback:

```text
v1.1.1 ❌
   ↓
restore previous application version
   ↓
v1.1.0 ✅
```

Database rollback MUST be handled carefully.

Rules:

- Prefer backward-compatible migrations.
- Do not automatically destroy or reverse production data during rollback.
- For destructive schema changes, use an expand → migrate → contract approach.
- Database backups MUST exist before risky migrations.
- Test restoration of backups periodically.
- The rollback procedure must be documented in `docs/deployment/ROLLBACK.md`.

A successful rollback must restore application availability without creating duplicate payment/refund operations.

---

# 18E. RELEASE CHECKLIST

Before every production release:

```text
[ ] Git branch merged/reviewed
[ ] Tests pass
[ ] Type-check passes
[ ] Lint passes
[ ] Build passes
[ ] No `any`
[ ] Security checks pass
[ ] Database migration reviewed
[ ] Staging deployment passes
[ ] Mock payment flow passes
[ ] Webhook tests pass
[ ] Idempotency tests pass
[ ] Concurrency tests pass
[ ] Production backup completed
[ ] Release version tagged
[ ] Rollback version available
[ ] Production deployment completed
[ ] Health check passes
[ ] Smoke test passes
[ ] Logs/monitoring checked
```

---

# 18F. DEPLOYMENT STRUCTURE

V1 should use a simple, maintainable deployment architecture.

Recommended:

```text
Internet
   ↓
HTTPS / Reverse Proxy
   ↓
Fastify Payment API
   ↓
PostgreSQL
   ↓
Redis
```

Development:

```text
Developer PC
   ↓
Docker Compose
   ├── API
   ├── PostgreSQL
   └── Redis
```

Staging:

```text
Public HTTPS
   ↓
Staging VPS
   ├── API
   ├── PostgreSQL
   └── Redis
```

Production:

```text
Public HTTPS
   ↓
Production VPS / infrastructure
   ├── Payment API
   ├── PostgreSQL
   └── Redis
        ↓
   Off-server backups
```

Keep infrastructure simple for V1. Do not introduce Kubernetes, microservices, Kafka, or other distributed infrastructure unless an actual requirement appears.

---

# 19. CLAUDE CODE MASTER PROMPT

Paste this first:

> Read SPEC.md completely before writing code.
>
> Build the project sequentially according to the BUILD ORDER.
>
> Do not skip tests.
>
> Do not invent CIB/SATIM protocol details.
>
> Until official CIB documentation exists, implement MockAdapter only.
>
> Keep CIB-specific code isolated under `src/adapters/cib/`.
>
> Keep the payment core provider-neutral.
>
> Use strict TypeScript.
>
> Never use `any`.
>
> Never store card data.
>
> Never trust browser redirects as payment confirmation.
>
> Never mark PAID from a client-facing endpoint.
>
> After each phase:
> 1. run tests
> 2. run type-check
> 3. run lint
> 4. fix all errors
> 5. report exactly what changed
> 6. stop before starting the next phase
>
> If a requirement is ambiguous, do not guess. Mark it:
>
> `TODO: CONFIRM WITH OFFICIAL CIB PACKAGE`
>
> The final implementation must be clean, minimal, auditable, and suitable for CIB/SATIM certification testing.

---

# 20. DEFINITION OF DONE

The V1 implementation is complete when:

- `npm test` passes
- type-check passes
- lint passes
- zero `any`
- zero TypeScript errors
- zero skipped required tests
- concurrent idempotency test passes
- duplicate webhook is harmless
- invalid callback cannot mark payment PAID
- amount mismatch cannot mark payment PAID
- currency mismatch cannot mark payment PAID
- browser redirect cannot mark payment PAID
- no card data is stored
- no secrets are logged
- complete MockAdapter flow works
- Docker environment works
- CIB adapter contains no guessed protocol behavior
- refund idempotency is enforced
- concurrent state transitions are protected by database transactions/locking
- every production database change uses a versioned migration
- every release is versioned and rollback-capable
- official CIB contract tests can be added without changing the generic core

---

# 21. TIME ESTIMATE

These are development estimates, NOT certification promises.

### With a good AI coding agent + one developer supervising:

**Mock/generic payment module:**
- 1 focused day: skeleton + database + state machine
- 1 focused day: API + MockAdapter + webhook
- 1 focused day: tests + idempotency + hardening

Realistic: **2–4 working days**

### Real CIB implementation

This depends heavily on when you receive the official API/technical package.

If the documentation is complete and straightforward:

**1–3 additional working days** for implementation + contract tests.

If there are certificates, special signing, unusual callback behavior, or certification corrections:

**3–7+ working days** is safer.

### Certification

Do NOT promise a fixed number of days.

The official CIBWeb process includes external acceptance, test access, a certification appointment, certification testing, a certification report, certificate issuance, and referencing. The acceptance decision is stated as less than 24 hours, but that is NOT the total certification duration.

---

# 22. FINAL DEVELOPMENT TARGET

The target is NOT:

"100% guaranteed zero issues."

The target is:

**"Zero avoidable coding issues before entering certification."**

That means:

```text
CODE
 ↓
AUTOMATED TESTS
 ↓
INTEGRATION TESTS
 ↓
MOCK END-TO-END
 ↓
OFFICIAL CIB PACKAGE
 ↓
CIB ADAPTER
 ↓
OFFICIAL CONTRACT TESTS
 ↓
CERTIFICATION
 ↓
FIX ONLY OFFICIAL TEST FINDINGS
 ↓
PRODUCTION
```

This is the fastest safe path.

---

END OF SPEC

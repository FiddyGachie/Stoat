# Architecture (v2.1)

## 1. Shape

A **modular monolith** in TypeScript: one Express API process, one worker process from the same codebase, one React console and one PostgreSQL database. No microservices, queues, caches or second database.

```text
React console (Vite, AG Grid / AG Charts)        External agents (REST, MCP)
        |  /v1 REST (OpenAPI 3.1)                         |
        v                                                 v
Express API ── auth (JWT, scopes, human-only guards) ── PayPal-only guard
        |
        +-- identity, exchange, missions, quotes, agreements
        +-- negotiation (buyer model proposes; code validates)
        +-- agent runtime + LLM adapter (live / record / replay)
        +-- deliveries + deterministic grounded verifier
        +-- ledger, obligations, settlement
        +-- payments: funding (Orders collection), payouts (Payouts disbursement),
        |             recipients (encrypted), money flow, payment sweeps
        +-- paypal: gateway (only code that talks to PayPal), webhooks, capabilities
        +-- integrity, performance, events (hash chain), MCP server
        v
PostgreSQL (authoritative: agreements, journal, payments, payouts, proposals, audit, jobs)
        ^
        | worker: jobs with FOR UPDATE SKIP LOCKED + payment sweeps
        |
Fireworks AI                PayPal Orders v2 + Payouts (Sandbox or live)
```

## 2. Technology

- Backend: Node.js, Express, TypeScript (strict, no unused locals).
- Database: PostgreSQL via `pg`; embedded PGlite when `DATABASE_URL` is absent. Forward-only SQL migrations in `src/db/migrations`.
- Jobs: PostgreSQL `jobs` table and worker loop.
- Payments: `@paypal/paypal-server-sdk` (APIMatic) for Orders and refunds; PayPal REST for Payouts and webhook verification. PayPal is the only provider.
- Models: Fireworks AI (OpenAI-compatible) by default, Anthropic optional, through `LlmAdapter`.
- Frontend: React 19, Vite, AG Grid, AG Charts, lucide icons, glassmorphic light theme.
- Contract: `API_SPEC.yaml` (OpenAPI 3.1, v2.1); every path is checked against the server by `verify:ui`.

## 3. Module ownership

| Module                        | Owns                                                                                                   | Must not                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| auth                          | users, agent credentials, sessions, throttling                                                         | make financial decisions                                                                                                      |
| exchange                      | services, prices, the private negotiation floor                                                        | accept spend                                                                                                                  |
| missions / quotes             | budget intent, quotes and expiry                                                                       | change an accepted agreement                                                                                                  |
| negotiation                   | offer comparison, counteroffers, selection proposals                                                   | set payee, currency or payment state                                                                                          |
| agreements                    | immutable terms, negotiated price, policy decision                                                     | trust a proposal without re-checking                                                                                          |
| agent-runtime                 | runs, steps, proposals, provider review                                                                | verify its own work                                                                                                           |
| verification                  | deterministic checks and verdict                                                                       | change the price                                                                                                              |
| ledger                        | journal, accounts, obligations                                                                         | claim money moved                                                                                                             |
| settlement                    | batches and their human approval                                                                       | pay providers                                                                                                                 |
| payments/funding              | Orders collection per agreement, capture, refund                                                       | pay providers                                                                                                                 |
| payments/payout               | payout approval, send, item-level status                                                               | send without a valid bound approval                                                                                           |
| payments/recipient            | encrypted, masked, human-verified PayPal recipients                                                    | expose a recipient to an agent                                                                                                |
| paypal                        | gateway, webhooks, capability gates                                                                    | decide commercial policy                                                                                                      |
| integrity                     | invariants over the ledger and payment records                                                         | change state                                                                                                                  |
| mcp                           | external-agent tools                                                                                   | expose any payment, payout or recipient action (and no wallet tool exists)                                                    |
| wallet (`src/modules/wallet`) | wallets, deposits, reservations, charges, refunds, reconciliation, wallet analytics, `funding-mode.ts` | let an agent deposit, reserve, charge, refund, pay out or read a recipient; claim money moved without a PayPal-confirmed fact |
| wallet/budget-advisor         | display-only budget advice text                                                                        | act on its advice or carry money, payee or currency fields                                                                    |

## 4. Two independent PayPal legs

Collection (Orders v2) and disbursement (Payouts) are separate transactions with separate state machines, separate human approvals and separate records (`agreement_payments` and `payouts`). Either can succeed or fail on its own. Captured buyer money never implies the provider was paid. See `PAYPAL.md`.

### Funding mode and the holding-account model

Each tenant has a funding mode, `tenants.settings.funding_mode`: `direct` (default; one PayPal order per agreement, section 4) or `wallet` (Mission Budget Wallet). New tenants take `DEFAULT_FUNDING_MODE`. An operator or supervisor switches a tenant with `PUT /v1/admin/funding-mode`; the switch is refused with `FUNDING_MODE_BUSY` while any agreement is still live under the old mode. Direct mode behaves exactly as before.

In wallet mode the money is described as follows, and no stronger claim is made:

- **Holding Account** is the platform's own PayPal business account. Every Deposit is a real PayPal Orders v2 payment captured into it.
- **Wallet Balance** is Stoat's ledger record of how much of the Holding Account belongs to each user (liability account `2103`, tagged per wallet). It is not a PayPal balance and PayPal does not know about it.
- **Reservations** are Stoat bookkeeping holds on an already captured balance, not PayPal authorizations.
- Refunds go back through PayPal capture refunds against the original captures. Provider payouts still use PayPal Payouts and a human approval. PayPal-confirmed facts, never agent output, decide what was paid.
- **There is no escrow.** PayPal offers applications no escrow or custody API, and Stoat does not claim to be an escrow or a safe place for funds.
- **Regulation.** Holding customer funds in a business account may be regulated as stored value or money transmission in some jurisdictions. This design does not provide legal review; production use needs it.

Wallet tests and verifiers are listed in `TEST_PLAN.md` and the gates in `ACCEPTANCE.md`.

## 5. Transaction boundaries

One database transaction for: accepting a quote (policy, agreement, budget reservation, proposal binding); accruing the obligation with its balanced journal entry; creating and reserving a batch; recording an approval; applying a PayPal capture or payout item status with its journal entry.

**No network call inside a database transaction.** Payment intent and PayPal identifiers (order id, `sender_batch_id`, `sender_item_id`) are persisted first, PayPal is called outside the transaction, and the result is applied with a row lock and a state check. Ambiguous outcomes stay unknown and are resolved by querying PayPal or waiting for its webhook, never by a blind retry.

## 6. Background work

- `jobs` table, claimed with `FOR UPDATE SKIP LOCKED`, bounded backoff, dead-lettering, stale lock recovery (`src/jobs/runner.ts`). It runs in the worker and, unless `RUN_JOBS_IN_API=false`, in the API process too.
- `provider_review` job: queued once per agreement for **hosted** services (`services.execution_mode`), at acceptance or at PayPal capture when funding is required. It runs the provider model review with the verify-and-revise loop. Missing configuration parks the job as dead at once.
- Payment sweeps every 30 seconds (in both the API and the worker; overlap is safe because every step is idempotent): capture approved orders, expire lapsed ones, and follow submitted payouts to their final status.

## 7. Configuration guards

- `PAYMENT_PROVIDER` must be `PAYPAL`; anything else stops startup. Money routes reject a caller-supplied `provider` field. Database CHECK constraints reject non-PayPal payment rows.
- Payouts run only when `PAYPAL_PAYOUTS_ENABLED=true` and `PAYPAL_PAYOUTS_CAPABILITY_STATUS=enabled` (set after the capability spike). A runtime PayPal refusal marks the capability degraded.
- No model key means `LLM_NOT_CONFIGURED`; the adapter never substitutes canned output.

## 8. Environment boundaries

Secrets are server-only. The browser bundle holds no PayPal secret, model key, webhook id or recipient. The console's live/replay and PayPal badges are read from the server (`/v1/health`, `/v1/paypal/status`), never from build flags. Unversioned API paths are deprecated aliases served by the `/v1` handlers, so there is one implementation of every rule.

## 9. Mapping to the v2.1 architecture delta

| Pack module               | Stoat implementation                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paypal-collection`       | `payments/funding.service.ts` (per agreement) and `paypal/paypal.service.ts` (per unfunded batch)                                                                                           |
| `paypal-disbursement`     | `payments/payout.service.ts` and `payments/recipient.service.ts`                                                                                                                            |
| `money-flow-orchestrator` | Split across the funding and payout services (each step re-checks eligibility), `payments/sweep.ts` and the read model `payments/money-flow.service.ts`; there is no atomicity between legs |
| `commercial-negotiation`  | `negotiation/negotiation.service.ts` plus the proposal re-check in `agreements.service.ts`                                                                                                  |

Deviations: there is no separate `PAYPAL_ORDERS_ENABLED` flag (Orders are enabled exactly when PayPal credentials are set, and `/v1/paypal/status` reports Orders and Payouts separately). Test implementations of PayPal and the model live only under `tests/` and are injected explicitly; the application cannot load them, so no runtime `SIMULATED` label is needed.

# Architecture and System Boundaries

## 1. Deployment shape

Use a **modular monolith** with independently testable domain modules. One API process, one worker process (same codebase), one React application and one PostgreSQL database are sufficient. Do not split services during the hackathon.

```text
React Operator Console (AG Grid / AG Charts)
       | REST / OpenAPI
       v
NestJS API ── AuthN/AuthZ ── Policy Engine ── Domain Modules
       |                         |               |
       |                         |               +-- Missions / Exchange / Quotes
       |                         |               +-- Agreements / Deliveries / Verifier
       |                         |               +-- Agents / Traces / LLM adapter
       |                         |               +-- Journal / Obligations / Batches
       |                         |               +-- PayPal / Webhooks / Reconciliation
       |                         |               +-- MCP server
       v
PostgreSQL (authoritative records, jobs, journal, audit)
       ^
       | worker claims jobs with FOR UPDATE SKIP LOCKED
       |
LLM provider adapter                PayPal Orders v2 Sandbox
```

## 2. Technology baseline

- Frontend: React + TypeScript.
- Backend: NestJS + TypeScript.
- Database: PostgreSQL.
- Jobs: PostgreSQL `jobs` table and worker loop; no Redis/BullMQ.
- API: OpenAPI 3.1, versioned `/v1`.
- Payments: PayPal REST OAuth and Orders v2 Sandbox.
- Grid: AG Grid; charts: AG Charts.
- Contract tooling: APIMatic where account access is confirmed.
- Local: Docker Compose; deployment target may be Render.
- LLM: provider adapter; Anthropic default as stated in v0.2 configuration.
- MCP: P0-lite server authenticated as an agent principal.

## 3. Module ownership

| Module | Owns | Must not own |
|---|---|---|
| Identity | users, tenants, agent credentials, scopes | financial decisions |
| Exchange | service listings, capabilities, pricing | accepting a buyer's spend |
| Mission | mission state, budget intent, constraints | direct payment calls |
| Quote | quote requests/offers/expiry | changing accepted agreement |
| Agreement | immutable scope, price, acceptance criteria | LLM judgement |
| Agent runtime | run lifecycle, limits, trace, proposals | authority escalation |
| Provider execution | LLM request and artifact creation | self-verification |
| Verification | deterministic checks and verdict | changing agreement price |
| Policy | deterministic allow/deny/approval-required | model-based authorization |
| Ledger | journal, accounts, obligations, holds | provider bank payout |
| Settlement | batch proposal, approval, payment adapter | claiming payout not implemented |
| PayPal | Orders, capture, webhooks, reconciliation | ledger source of truth |
| Operator | API-backed views and read-only copilot | bypassing domain APIs |

## 4. Transaction boundaries

Use a single PostgreSQL transaction for:
- accepting a quote, creating agreement, recording policy decision and reserving budget;
- recording verified delivery, accruing the unique obligation and posting balanced journal entries;
- creating a settlement batch and reserving eligible obligations;
- recording a human approval;
- applying a verified webhook event and reconciliation result;
- placing or releasing holds (release requires human principal).

External network calls must not occur inside long-running database transactions. Persist intent/job first, call provider outside transaction, then persist result using idempotency and compare-and-set state transitions.

## 5. PostgreSQL job worker

Claim work in a short transaction:

```sql
WITH candidate AS (
  SELECT id
  FROM jobs
  WHERE status = 'queued'
    AND run_after <= now()
  ORDER BY priority DESC, created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE jobs
SET status = 'running',
    locked_at = now(),
    locked_by = $1,
    attempts = attempts + 1
WHERE id IN (SELECT id FROM candidate)
RETURNING *;
```

On completion, mark `succeeded`; on retryable failure, schedule bounded exponential backoff; on exhausted attempts, mark `dead` and emit an operational event. Stale locks are reclaimed after a configured timeout. Job handlers must be idempotent.

## 6. Consistency and reliability

- PostgreSQL is the source of truth.
- Use UUIDs, tenant scoping and server timestamps.
- Financial state transitions use row locks or optimistic version checks.
- Idempotency key uniqueness is scoped by tenant, principal, route and key.
- Store request hash and canonical response for replay; same key with different hash returns conflict.
- Event append and domain state update occur in one transaction.
- Never infer capture success from a browser redirect or client callback.
- Unknown provider outcome remains `unknown` until queried/reconciled.

## 7. Environment boundaries

Secrets are server-only. Browser bundle contains no PayPal secret, LLM key, webhook secret or database credential. Development, test and demo environments use separate credentials and databases. Production mode is not claimed by the hackathon build.

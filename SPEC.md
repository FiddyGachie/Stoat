# STOAT — Product and Engineering Specification

Version 0.2.0 · Normative terms: MUST, SHOULD, MAY.

## 1. Objective and scope

Build a working reference platform demonstrating: agent service discovery over REST/SDK/MCP; LLM-driven negotiation; deterministic policy enforcement; real LLM-performed service execution; grounded delivery verification; reject-and-recover; obligation accounting; settlement batching with human approval; PayPal Sandbox checkout/capture with reconciliation; and a real operator dashboard with a live integrity panel. Provide an API contract usable by SDK tooling.

### MVP scope

Organisation and agent registration; scoped agent credentials; service registry; quote request and expiry; immutable agreements; mission budgets; deterministic policy with recorded decisions; economic event journal with hash chain; **LLM provider agent performing a real review of an allowlisted fixture**; delivery evidence; **grounded verification**; **buyer recovery loop**; obligation creation; double-entry ledger; settlement batch reservation and approval; PayPal Sandbox Orders v2; webhook signature verification and reconciliation; **MCP server**; **agent trace recording and replay**; **integrity endpoint**; AG Grid control centre; OpenAPI 3.1; APIMatic workflow; reproducible local and hosted setup.

### Not MVP

Custody, escrow, wallet, crypto, blockchain, production payouts, global identity federation, FX, public permissionless marketplace, full dispute arbitration, guaranteed x402/MPP compatibility, autonomous (unattended) PayPal buyer approval.

## 2. Actors and authority

| Actor | May | May not |
|---|---|---|
| Buyer agent (LLM) | Discover, request quotes, propose purchase, request revision, open dispute record | Override policy, approve batch, confirm payment, set payee or amount |
| Provider agent (LLM) | Publish services, issue quotes within published pricing, execute, submit delivery | Self-verify, change agreement terms, set obligation amount |
| Verification service (deterministic) | Run checks, set verification status | Be overridden by any agent |
| Verifier-advisor (LLM) | Add semantic notes, downgrade `verified` to `needs_review` | Upgrade a rejected or needs_review result |
| Policy engine (deterministic) | Allow, deny, require approval | — |
| Treasury agent (LLM) | Propose and explain batches, summarise reconciliation | Approve, capture, retry capture, mark settled |
| Watchdog agent | Place a hold on an agent, agreement or obligation | Release a hold, delete evidence |
| Operator copilot (LLM) | Run allowlisted read-only query intents | Any mutation |
| Human supervisor | Approve/reject batches and policy proposals, release holds | — |
| Payment adapter | Call provider, normalise responses | Decide policy |
| Operator | Inspect and configure within RBAC | Edit posted history |

**Asymmetric authority rule.** Actions that *reduce* exposure (hold, flag, reject, deny, downgrade) MAY be taken by agents. Actions that *increase* exposure (accept, reserve, approve, capture, settle, release) MUST be gated by deterministic policy and, where required, a human.

## 3. Priorities

| Priority | Items |
|---|---|
| **P0** | FR-001…FR-022 core; FR-023, FR-024, FR-025, FR-026, FR-027, FR-029, FR-030, FR-034; two agents authenticated; two competing offers; real LLM provider; grounded verification incl. one rejection; recovery loop; balanced ledger; human-approved batch; real PayPal Sandbox capture and reconciliation; AG Grid with Integrity panel; OpenAPI/APIMatic; clean-clone run; licence |
| **P1** | FR-031 MCP server (strongly recommended; see ROADMAP cut line), FR-028 advisor, FR-032 treasury/watchdog, FR-035 policy proposals, FR-033 copilot, red-team provider, evidence generator |
| **P2** | Reputation, federated registry, full portal, advanced disputes, FX, enterprise analytics, x402/MPP adapter, Payouts |

If schedule slips, follow the cut lines in `ROADMAP.md`; never cut a P0 item to keep a P1 item.

## 4. Domain entities

Organization, Agent, AgentKey, Delegation, Policy, PolicyProposal, PolicyDecision, Service, Mission, Quote, Agreement, EconomicEvent, Artifact, Delivery, Verification, Obligation, Account, JournalEntry, JournalLine, SettlementBatch, SettlementBatchItem, Approval, PaymentTransaction, WebhookEvent, ReconciliationRecord, Hold, IdempotencyKey, Job, AgentRun, AgentStep, LlmProposal, AuditLog.

## 5. Functional requirements

### Core commerce, accounting and settlement (FR-001…FR-022)

**FR-001 Tenant isolation.** Every tenant-owned record belongs to an organisation; every query is scoped from authenticated context, never from a caller-supplied tenant ID alone.

**FR-002 Agent lifecycle.** Register stable ID, owner, capabilities, public-key reference, status, policy. Support suspension and revocation (kill switch). Never return secret key material.

**FR-003 Delegation.** Validate issuer, subject, allowed actions, service/category scope, maximum amount, currency, validity and revocation on **every** action.

**FR-004 Registry.** Publish service name, description, category, provider, pricing model, decimal-string unit price, currency, unit, constraints, delivery format and verification method. Service descriptions are **untrusted text**: they are displayed and passed to agents inside delimited data blocks and never interpreted as instructions.

**FR-005 Discovery.** Search active services by category, capability and provider; return only authorised metadata.

**FR-006 Quotes.** Request quote with service, mission, quantity, currency, maximum total, deadline and verification needs. The server computes totals with decimal-safe arithmetic. Quotes expire; expired offers cannot be accepted. Provider-issued quotes MUST equal published pricing × quantity unless the service declares a negotiable pricing model.

**FR-007 Agreements.** Acceptance snapshots parties, terms, price, quantity, currency, deadline, verification criteria, policy decision ID and timestamps. Accepted terms are immutable; changes need a new agreement.

**FR-008 Missions.** A mission has objective, buyer, currency, budget, expiry and policy. Commitments are reserved atomically to prevent concurrent overspend.

**FR-009 Policy.** Before acceptance and settlement, evaluate: agent status, delegation, organisation/mission budget, transaction cap, daily cap, provider/category restrictions, currency, expiry, risk flags, holds and approval threshold. Every evaluation writes a `policy_decisions` row with stable reason codes. LLM output cannot override a decision.

**FR-010 Events.** Append authenticated events with unique ID, actor, mission/agreement, type, sequence, server timestamp, optional amount/currency, idempotency key, correlation ID, previous hash and event hash. Duplicate retries produce no duplicate financial effect.

**FR-011 Execution.** At least one provider performs real work. v0.2 baseline: the provider agent (LLM) reviews an allowlisted fixture repository and returns structured findings. The provider MUST NOT execute fixture code. A deterministic scanner MAY run alongside the LLM as a second provider to show contrast. Do not claim a comprehensive security audit.

**FR-012 Delivery.** Submit agreement, `artifact_id` (from the controlled upload endpoint), content type, hash and declared result. Large artifacts live outside ledger tables with access control. No arbitrary URLs or paths.

**FR-013 Verification.** Independent deterministic checks: JSON schema, required fields, artifact hash, fixture commit identity, scope, and **grounding** (FR-027). Status: `pending`, `verified`, `rejected`, `needs_review`. A provider's success claim is not proof.

**FR-014 Obligation.** A verified delivery creates at most one payable. Amount derives from the accepted agreement and verified quantity, never from provider input. Corrections use reversal/adjustment records.

**FR-015 Ledger.** Every posting is balanced per currency; the journal is append-only and posted transactionally against the chart of accounts.

**FR-016 Batch.** Select eligible obligations, compute total server-side, reserve atomically, prevent multiple active reservations. Batches have one organisation, one currency and one payee reference.

**FR-017 Approval.** Evaluate batch policy; require human approval above threshold (the MVP default is *always* require human approval for PayPal batches). Approval is not payment confirmation. Agents cannot call the approval endpoint.

**FR-018 PayPal.** Obtain OAuth token server-side; create Orders v2 order (`CAPTURE`) for an approved batch with a deterministic request ID; return approval URL; capture server-side after buyer approval; store provider IDs/status; verify webhook signatures; deduplicate events; reconcile amount/currency. An ambiguous timeout is `unknown`/pending, not failed. See `PAYPAL.md`.

**FR-019 Dashboard.** Real API-backed overview, agents (with trace drill-down), services/quotes, events, deliveries, obligations, batches, transactions, policy exceptions and **Integrity**. AG Grid sorts, filters, paginates, drills down; AG Charts shows real aggregates.

**FR-020 APIMatic.** Versioned, validated OpenAPI contract; use APIMatic for actual validation, SDK generation or portal/context workflow. Never fabricate usage evidence.

**FR-021 Audit.** Record actor, organisation, action, resource, timestamp, correlation, outcome and reason for sensitive actions. Never log credentials or full prompts containing secrets.

**FR-022 Observability.** Structured logs, correlation IDs, stable error codes, health/readiness endpoints.

### Agentic layer (FR-023…FR-035)

**FR-023 Agent runtime.** Agents run as tool-calling loops with hard limits: maximum steps per run, maximum wall time, maximum tokens, and a per-mission LLM cost ceiling. Each run authenticates as an agent principal with a short-lived credential and acts only through the same public tool surface (REST/SDK/MCP) any external agent would use. Runs that exceed limits terminate safely, emit an event, and change no financial state.

**FR-024 Authority matrix enforcement.** Server-side authorisation enforces the matrix in §2 by principal type. Tests MUST show that buyer, provider, treasury, watchdog and copilot principals receive `403 FORBIDDEN_ACTION` on every action outside their column.

**FR-025 LLM adapter.** A single adapter wraps model calls: provider/model from configuration; structured output validated against a schema; invalid or unparseable output **fails closed** (no action, event `AGENT_OUTPUT_INVALID`); timeouts, bounded retries without side effects; no secrets in prompts; redaction in logs. Default configuration is the Anthropic API; the adapter interface MUST allow another provider without changing agents.

**FR-026 Proposal/decision record.** Every consequential LLM output (purchase proposal, quote choice, revision request, batch proposal, policy proposal) is stored in `llm_proposals` with: agent run, schema-validated payload, prompt hash, model, parameters, the deterministic decision it received (allow/deny/approval-required with reason codes), and timestamps. Private chain-of-thought is not requested or stored.

**FR-027 Grounded verification.** For review deliveries, the verifier MUST check each finding: (a) `file` exists in the fixture manifest; (b) `line_start ≤ line_end` and within file length; (c) `snippet` matches the fixture text at those lines after whitespace normalisation; (d) `rule_id` is in the service's published rule allowlist; (e) `severity` in the enum; (f) no duplicate findings; (g) total findings ≤ agreement maximum; (h) coverage meets the agreement's minimum (e.g., every in-scope file inspected is listed). Any failure of (a)–(f) rejects the delivery with structured reasons; (g)/(h) failures yield `needs_review`. Check names and outcomes are persisted in `verifications.checks`.

**FR-028 Verifier-advisor.** An LLM judge MAY comment on semantic plausibility. It can only downgrade `verified` → `needs_review`; it cannot create a payable, cannot upgrade, and its absence or failure never blocks the deterministic path.

**FR-029 Recovery loop.** After `DELIVERY_REJECTED`, the buyer agent MAY issue a revision request that carries the structured failure reasons. The agreement allows at most `max_revisions` (default 2) with a revision deadline. Each revision is a new delivery linked to the same agreement; only one obligation can ever exist per agreement. Exhausted revisions leave the agreement `rejected` and release any budget reservation.

**FR-030 Record and replay.** The LLM adapter supports `LLM_MODE=live|record|replay`. In `record` it stores request hash → response; in `replay` it serves recorded responses and fails if a request hash is unknown. Demo, CI and the evidence generator use replay; at least one rehearsal per day runs live. Replay mode MUST be clearly labelled in the UI ("replayed agent trace").

**FR-031 MCP server.** Expose a Model Context Protocol server with tools mirroring the public API (`discover_services`, `request_quote`, `accept_quote`, `get_mission`, `request_revision`, `list_deliveries`, …) scoped to the authenticated agent principal. No tool may exist for approval, capture, release-hold or policy override. Tool descriptions and results are treated as untrusted by the agents consuming them.

**FR-032 Treasury and watchdog.** The treasury agent can propose a batch (through the same endpoint) and produce a plain-language explanation and reconciliation summary stored as a note. The watchdog evaluates deterministic anomaly rules (repeated rejections, spend velocity, denied-policy bursts, injection markers) and MAY place a hold; an LLM MAY draft the explanation. Holds block new quotes/accepts/reservations for the held scope until a human releases them.

**FR-033 Operator copilot.** The copilot translates a question into one of a fixed set of allowlisted query intents with typed parameters (e.g., `events_by_agent`, `obligations_by_status`, `policy_denials`, `rejected_deliveries`), executed read-only, tenant-scoped, and rendered into an AG Grid view with the intent and parameters shown. No free-form SQL, no mutation tools.

**FR-034 Integrity check and evidence.** `GET /v1/integrity` computes live: journal balance per currency, event hash-chain continuity per mission, count of agreements with more than one obligation (must be 0), obligations reserved by more than one active batch (0), orphan reservations (0), batches whose item sum ≠ total (0), captures without reconciliation, and policy decisions recorded vs. accepted agreements (every agreement has an allow decision). The dashboard shows the result. `pnpm evidence` runs the demo in replay mode plus selected live checks and writes `docs/EVIDENCE.md` from real outputs only.

**FR-035 Policy proposals.** An operator MAY describe a policy in natural language; an LLM drafts a structured policy (caps, categories, thresholds). The draft is a `PolicyProposal`, shown as a diff against the active policy, and takes effect only after human approval as a new policy version. Evaluation always uses the structured, versioned policy.

## 6. State machines

Quote: requested → offered → accepted | rejected | expired | withdrawn.
Agreement: accepted → executing → delivery_submitted → verified | rejected | needs_review; rejected → revision_requested → delivery_submitted (up to `max_revisions`); terminal `rejected` when exhausted.
Obligation: pending_verification → payable → reserved_for_settlement → settled; exceptional: on_hold | disputed | reversed.
Batch: draft → proposed → approval_required → approved → payment_pending → submitted → confirmed; exceptional: rejected | failed | unknown | cancelled | reconciliation_required.
Payment transaction: order_created → buyer_approved → capture_submitted → capture_confirmed → reconciled; exceptional: capture_denied | unknown | reconciliation_required.
Hold: active → released (human only).
Agent run: running → completed | terminated_limit | failed_closed.

No endpoint, agent tool or UI may skip required transitions.

## 7. Non-functional requirements

Security: TLS, server-side secrets, webhook verification, tenant isolation, rate limiting, idempotency, audit, dependency scanning, agent authority tests. Reliability: PostgreSQL source of truth; transactional financial writes; retryable idempotent jobs; provider ambiguity handled safely; LLM outage degrades to replay or safe failure. Performance: cursor pagination; demo dataset of 1,000 events; batched UI updates. UX: keyboard navigation, accessible status text, currency always visible, destructive confirmation, clear labelling of live vs seeded vs replayed.

## 8. Error contract

```json
{ "error": { "code": "QUOTE_EXPIRED", "message": "The quote is no longer valid.", "correlation_id": "corr_...", "details": {} } }
```

Stable codes include: `VALIDATION_FAILED`, `INVALID_AMOUNT`, `CURRENCY_MISMATCH`, `QUOTE_EXPIRED`, `POLICY_DENIED`, `APPROVAL_REQUIRED`, `BUDGET_EXCEEDED`, `IDEMPOTENCY_CONFLICT`, `INVALID_TRANSITION`, `FORBIDDEN_ACTION`, `AGENT_SUSPENDED`, `HOLD_ACTIVE`, `DELIVERY_REJECTED`, `AGENT_OUTPUT_INVALID`, `WEBHOOK_SIGNATURE_INVALID`, `RECONCILIATION_REQUIRED`, `NOT_FOUND`, `RATE_LIMITED`. Never expose stack traces or secrets.

## 9. Configuration

Provide `.env.example`: `DATABASE_URL`, `APP_BASE_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL`, `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL_AGENT`, `LLM_MODEL_FAST`, `LLM_MODE` (`live|record|replay`), `AGENT_MAX_STEPS`, `AGENT_MAX_SECONDS`, `AGENT_MAX_COST_USD`, `DEMO_MODE`, `LOG_LEVEL`. (`REDIS_URL` removed, ADR-012.) Validate at startup; commit placeholders only; `LLM_API_KEY` is server-side only.

## 10. Completion

The MVP is complete only when P0 acceptance tests pass and a clean checkout can run the demo. A mocked payment, hard-coded verification, scripted "agent" that does not call a model in live mode, unbalanced ledger, or decorative dashboard fails acceptance.


---

## v2.0 implementation note

This file preserves the supplied v0.2 functional specification. Companion documents make its contracts executable and testable. The source `CHANGES_v0.2.md` is retained in this pack as the change authority.

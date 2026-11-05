# STOAT — Changes from v0.1.0 to v0.2.0

Each change lists the problem found in v0.1, the fix, and which judging criterion it serves (TI = Technological Implementation, D = Design, PI = Potential Impact, I = Innovation, P = Presentation).

## A. Requirement-level gaps

| # | Problem in v0.1 | Change in v0.2 | Criteria |
|---|---|---|---|
| A1 | **No AI in the product.** Rules only said what LLMs may not do; no model or tool was named; the hackathon requires meaningful AI. | New `AGENTS.md`; buyer, provider, treasury, watchdog, verifier-advisor and copilot agents; LLM adapter; FR-023…FR-030. | TI, I |
| A2 | Provider "work" was a deterministic fixture scan — trivial and not AI. | Provider is an LLM code reviewer; deterministic **grounding verifier** checks each finding against the fixture. | TI, I |
| A3 | Two incompatible demos ($1 mission vs "$10 fleet negotiating") and the fleet needed agents the spec lacked. | One signature mission with four scripted beats (see `DEMO_SCRIPT.md`). | P |
| A4 | `SPEC.md` referenced "P0 acceptance tests" that were never defined in the spec. | Explicit P0/P1/P2 table in `SPEC.md` §3 and `ROADMAP.md`. | TI |
| A5 | PayPal role was thin and payout semantics unresolved ("who gets the money?"). | `PAYPAL.md` settlement-model decision, Day-1 spike, honest labels, richer Orders usage (request IDs, custom_id, status handling). | TI, PI |
| A6 | MCP interface was optional/P1. | MCP server is P0-lite: lets any external agent (including judges') run a mission. | I, P |

## B. Contract and data defects found during audit

| # | Defect | Fix |
|---|---|---|
| B1 | `API_SPEC.yaml` `Amount` pattern used an over-escaped dot (`\\.`), so it rejected `"0.12"`; every decimal price would fail validation. | Pattern corrected; added precision guidance and contract tests. |
| B2 | `/deliveries` took `artifact_uri` while the threat model forbids arbitrary URLs (SSRF/path traversal) and DATABASE uses `artifact_reference`. | Replaced with controlled `artifact_id` from an upload endpoint; URI form removed. |
| B3 | No endpoints for missions, agent suspension, webhooks, PayPal approval/capture, payment transactions, ledger, integrity, agent runs. | Added (see `API_SPEC.yaml`). |
| B4 | No standard error schema or 4xx/409/422 responses in the contract, though SPEC §7 defines one. | `Error` schema and shared responses. |
| B5 | PROTOCOL requires persisting idempotency request hash and result; DATABASE had no table. | `idempotency_keys` table. |
| B6 | DATABASE mentions a "reconciliation record" and "approval" with no tables; no chart of accounts; no policy-decision record. | Added `reconciliation_records`, `approvals`, `accounts`, `policy_decisions`, `artifacts`, `jobs`, `agent_runs`, `agent_steps`, `llm_proposals`, `holds`. |
| B7 | Agent-supplied `occurred_at` was required while server order is authoritative. | Now optional metadata; server `recorded_at` governs. |
| B8 | `*_1` duplicates of ARCHITECTURE, CLAUDE, IDEA and SPEC were byte-identical. | Removed; one canonical file each. |

## C. Architecture simplifications

| # | Change | Reason |
|---|---|---|
| C1 | Redis/BullMQ and the outbox pattern removed; Postgres `jobs` table with `FOR UPDATE SKIP LOCKED`. | One fewer moving part in a 13-day build; ADR-012. |
| C2 | Priorities reset: signature path first, extras behind explicit cut lines. | Scope risk. |

## D. New capabilities

1. **Agent runtime** with asymmetric authority: agents may restrict (hold, flag, reject) freely but may spend only inside a deterministic envelope.
2. **Grounded verification** of LLM output plus an advisory LLM judge that can only downgrade a result.
3. **Prompt-injection red-team provider** and test suite.
4. **Reject → revise → re-verify recovery loop** in the buyer agent.
5. **Policy proposals**: natural-language policy drafts compiled to structured rules; human approval; versioned.
6. **Agent trace recording** (proposal, tool calls, deterministic decision) with **record/replay** for deterministic demos and CI.
7. **Integrity endpoint and panel**: ledger balance, hash-chain continuity, duplicate-obligation count, orphan reservations, all computed live.
8. **Evidence generator** (`pnpm evidence`) producing `docs/EVIDENCE.md` from real runs.
9. **Operator copilot** limited to allowlisted, read-only, tenant-scoped query intents rendered in AG Grid.
10. **Watchdog agent** that can place holds but never release them.
11. **SUBMISSION.md**: Devpost text, tool disclosure, judging-criteria map, prize targeting, submission checklist.
12. Fallback ladder and rehearsal protocol for the demo.

## E. Honest limitations carried forward

Payout to providers is not implemented in the MVP unless the PayPal spike proves it feasible; Orders capture is a buyer payment to the merchant account. x402/MPP adapters remain future work. APIMatic and AG Studio access must be confirmed, never assumed. Production readiness is explicitly not claimed.

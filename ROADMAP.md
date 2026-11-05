# Roadmap — 31 October to 12 November 2026

This schedule assumes a small team and an existing repository. Protect the signature vertical slice; do not expand scope until the P0 gates work.

## Phase 0 — scope lock and integration spikes (Oct 31)
- Confirm source v0.2 requirements and this pack.
- Verify repository baseline, build and test commands.
- Spike LLM structured output and cost tracking.
- Spike PayPal Sandbox create/approve/capture/webhook.
- Spike MCP SDK/server transport and external client connection.
- Confirm AG Grid/AG Charts licensing and APIMatic access.

**Gate:** written proof each critical dependency can be called from the deployed environment.

## Phase 1 — foundation (Nov 1–2)
- PostgreSQL schema/migrations, tenant and agent identity.
- OpenAPI contract and error model.
- policy engine, idempotency and mission/quote/agreement lifecycle.
- jobs table and worker.

**Gate:** API contract tests, tenant isolation, concurrent budget test.

## Phase 2 — agent mission (Nov 3–5)
- LLM adapter and record/replay.
- buyer and provider roles.
- controlled fixture and artifact model.
- grounding verifier and structured reasons.
- revision loop and trace UI.

**Gate:** live provider call plus deterministic rejection and successful revision.

## Phase 3 — finance (Nov 6–7)
- obligation, chart of accounts, journal.
- batch proposal and human approval.
- PayPal Orders v2 and webhook/reconciliation.
- integrity endpoint.

**Gate:** real Sandbox capture and zero integrity violations.

## Phase 4 — MCP and console (Nov 8–9)
- P0-lite MCP external client flow.
- AG Grid workspaces and AG Charts.
- copilot only if P0 stable.
- APIMatic evidence if access confirmed.

**Gate:** judge/external client can invoke mission tools; UI reflects real API data.

## Phase 5 — hardening and submission (Nov 10–11)
- red-team injection suite, security review, failure tests.
- `pnpm evidence`, README, architecture diagram and demo rehearsal.
- Devpost copy and judging criteria map.
- freeze P0 scope.

## Deadline day — Nov 12
- no risky feature work.
- clean deployment verification, final live smoke test.
- verify demo credentials, links, screenshots and submission.
- submit before 11:00pm East Africa Time (GMT+3).

## Cut line

If schedule slips, cut P1 features first: policy copilot, verifier-advisor, advanced MCP, extra services, advanced analytics. Never cut deterministic grounding, human approval, ledger integrity, PayPal honesty or external MCP P0-lite.

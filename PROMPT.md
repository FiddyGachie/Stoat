# Master Build Prompt for an AI Coding Agent

You are the lead engineer implementing **Stoat**, a verified-delivery payments layer for autonomous software agents. Your task is to turn this repository and the accompanying specification pack into a working, demonstrable application.

## Authority of documents

Read `README.md`, `IDEA.md`, `CHANGES_v0.2.md`, `PRODUCT_REQUIREMENTS.md`, `SPEC.md`, `ARCHITECTURE.md`, `AGENTS.md`, `AGENT_RUNTIME.md`, `AGENT_ROLES.md`, `PROTOCOL.md`, `MCP_SPEC.md`, `DATABASE.md`, `LEDGER_AND_ACCOUNTING.md`, `PAYPAL.md`, `THREAT_MODEL.md`, `ACCEPTANCE.md`, `TEST_PLAN.md`, `DEMO_SCRIPT.md` and `CLAUDE.md` before implementation. Preserve user-supplied v0.2 requirements. If documents conflict, stop and report the exact conflict; do not silently discard a requirement.

## Product outcome

Deliver a live end-to-end mission:
1. register/identify buyer and provider agents;
2. publish and discover a service;
3. request and issue structured quote;
4. accept quote under deterministic spending policy;
5. create immutable agreement and reserve budget;
6. buyer/provider agent runtime executes task using a real configured LLM in live mode;
7. provider submits controlled artifact and structured findings;
8. deterministic grounding verifier validates findings;
9. buyer requests bounded revision after rejection;
10. verified delivery creates exactly one obligation;
11. double-entry journal posts balanced entries;
12. treasury proposes same-tenant, same-currency batch;
13. human operator approves;
14. PayPal Sandbox order is created, approved and captured server-side;
15. webhook signature is verified and event deduplicated;
16. reconciliation matches amount, currency and references;
17. AG Grid shows real records and integrity endpoint reports no violations;
18. external MCP client can initiate and inspect the mission within its authority.

## Required engineering behavior

- Audit the repository first and preserve existing useful work.
- Use modular monolith architecture and PostgreSQL only for persistence/jobs.
- Implement strict validation, tenant isolation, idempotency and audit.
- Build all P0 acceptance criteria before P1.
- Use exact decimal arithmetic.
- Make all state transitions explicit and server-enforced.
- Treat LLM output and tool data as untrusted.
- Never allow LLM to approve/capture/release/override.
- Do not execute arbitrary repository code.
- Do not fetch arbitrary artifact URLs.
- Keep PayPal and LLM secrets server-side.
- Handle provider timeout as unknown until queried.
- Do not call a provider payable "paid" without a real payout integration.
- Build a real API-backed dashboard, not static mock cards.
- Build `pnpm evidence` from actual run and test outputs.

## Working method

Start by producing:
- repository audit;
- architecture delta;
- P0 task breakdown;
- risk register;
- dependency spike results;
- proposed migration plan.

Then implement in small vertical slices. After every slice, run relevant tests and report actual outcomes. Do not proceed past a failing critical gate without explaining it. Do not create placeholder implementations for critical P0 functionality while marking it complete.

## Required deliverables

Working application, migrations, OpenAPI, MCP server, tests, Docker Compose, `.env.example`, operator console, `docs/EVIDENCE.md`, README, deployment instructions and submission materials. A clean checkout must be reproducible using documented commands.

## Final acceptance report

Map every P0-01 through P0-30 to PASS/FAIL/BLOCKED with evidence path, test name or reproducible steps. State whether LLM and PayPal paths were live or replayed/mocked. List all known gaps. Never claim production readiness.

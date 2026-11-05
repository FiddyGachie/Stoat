# Stoat v2.0 — Exhaustive Implementation Pack

**Product:** Stoat  
**Positioning:** Verified-delivery payments layer for autonomous software agents  
**Tagline:** Every agent can work. Every service can have a price. Every obligation can be accounted for.  
**Pack version:** 2.0.0  
**Source baseline:** User-supplied v0.2 `IDEA.md`, `SPEC.md`, and `CHANGES_v0.2.md`

## What this pack is

This is an implementation-grade specification for a hackathon MVP, not a claim that the software is already implemented or production certified. It defines the product, boundaries, data model, API contract, agent runtime, minimal MCP surface, deterministic financial controls, PayPal Sandbox workflow, verification logic, operator console, test gates, deployment and demo evidence.

## Read in this order

1. `IDEA.md` — product vision, preserved from v0.2.
2. `PRODUCT_REQUIREMENTS.md` — user outcomes, scope, priorities and acceptance principles.
3. `SPEC.md` — detailed functional requirements, preserved from v0.2.
4. `ARCHITECTURE.md` — deployable modular-monolith architecture.
5. `AGENTS.md`, `AGENT_RUNTIME.md`, `AGENT_ROLES.md` — agent behavior and authority.
6. `PROTOCOL.md`, `MCP_SPEC.md`, `API_SPEC.yaml` — external contracts.
7. `DATABASE.md`, `LEDGER_AND_ACCOUNTING.md` — persistence and money invariants.
8. `PAYPAL.md`, `SECURITY_RUNBOOK.md`, `THREAT_MODEL.md` — payment and safety controls.
9. `ACCEPTANCE.md`, `TEST_PLAN.md`, `DEMO_SCRIPT.md` — proof that it works.
10. `CLAUDE.md`, `PROMPT.md`, `ROADMAP.md` — coding-agent execution workflow.

## One end-to-end mission

The only signature demo is a buyer agent purchasing an AI code review from a provider agent under a small fixed budget. The provider uses a configured LLM in live mode to produce structured findings against a controlled repository fixture. A deterministic grounding verifier validates file, line, snippet, rule, severity, duplicates, scope and limits. Rejected work can enter a bounded revise-and-reverify loop. A verified delivery accrues one obligation. The treasury agent proposes a settlement batch. A human approves. Stoat creates a PayPal Orders v2 Sandbox order, the buyer approves, the backend captures, webhooks are verified and deduplicated, and reconciliation confirms the captured amount and currency. The operator console shows the complete trace and integrity checks.

## P0 build principle

Build one real, auditable vertical slice before adding breadth. No fake AI in live mode, no fake financial events, no arbitrary code execution, no self-approval, no provider payout claim, no invented interoperability.

## Source integrity

`IDEA.md`, `SPEC.md`, and `CHANGES_v0.2.md` are based on the user-provided v0.2 files. `SPEC (1).md` was byte-identical to `SPEC.md` and is intentionally not duplicated. The rest of this pack expands those requirements into implementation contracts and explicit build decisions.

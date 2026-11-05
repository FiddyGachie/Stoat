Slice 1: Foundation & Persistence: Package setup, TypeScript config, PostgreSQL schema migrations (DATABASE.md), and in-process/pg dual engine.
Slice 2: Domain Core & API: OpenAPI 3.1 endpoints, tenant isolation, agent credentials, services registry, mission budgets, quotes, and atomic quote acceptance.
Slice 3: Agent Runtime & LLM Adapter: Step/token/wall-clock limits, prompt hashing, proposal records (llm_proposals), record/replay/live modes, and controlled code-review fixture.
Slice 4: Grounded Verifier & Revision Recovery: Deterministic grounding engine (FR-027), artifact upload (artifact_id), delivery rejection with structured reasons, and revision recovery loop.
Slice 5: Double-Entry Ledger & Integrity: Unique obligation accrual, append-only balanced journal transactions, and /v1/integrity invariant calculations.
Slice 6: Settlement Batches, Human Approval & PayPal Integration: Batch proposal, human approval barrier, PayPal Orders v2 Sandbox integration, webhook signature verification, and reconciliation.
Slice 7: P0-Lite MCP Server: Authenticated MCP tools for discovery, quote, acceptance, inspection, revision, and batch proposal.
Slice 8: Operator Console: React + Vite frontend with AG Grid and AG Charts workspaces.
Slice 9: Evidence Generator & Acceptance Verification: Automated test suite covering P0-01 through P0-30 and pnpm evidence script generating docs/EVIDENCE.md.

# Architecture Decision Records

## ADR-001 — Hybrid protocol + reference platform
Keep protocol semantics open while delivering a working reference implementation, API/SDK/MCP and payment adapter. Stoat does not replace existing payment networks.

## ADR-002 — Modular monolith
Use a modular NestJS application and worker process. Microservices add operational cost without improving the hackathon proof.

## ADR-003 — PostgreSQL is authoritative
All financial, event, job and audit records live in PostgreSQL. Redis/BullMQ and outbox are removed per v0.2 change C1. Workers claim jobs with `FOR UPDATE SKIP LOCKED`.

## ADR-004 — Real LLM provider work
Provider agent performs LLM code review. Deterministic grounding verifier checks every finding against controlled fixture. This addresses v0.2 change A1/A2.

## ADR-005 — One signature mission
Use one coherent mission with four beats rather than conflicting $1 and $10 demos, as required by v0.2 change A3.

## ADR-006 — PayPal buyer-to-merchant capture
MVP captures buyer payment to Stoat merchant account. Provider payout is not implemented unless a separate spike proves it and it is fully tested. Ledger provider payable is not proof of disbursement.

## ADR-007 — MCP P0-lite
MCP is required in P0 as an external agent entry point. The minimum mission tools are P0; advanced resources, prompts and broad tool catalogue remain P1. This resolves v0.2 change A6 without expanding the critical path.

## ADR-008 — Controlled artifact IDs
Delivery accepts `artifact_id`, not arbitrary URI. Prevent SSRF/path traversal and align API with threat model.

## ADR-009 — Decimal-safe money
Amounts are decimal strings at API boundaries and exact decimal in PostgreSQL/domain code. No JS floating point or silent rounding.

## ADR-010 — Deterministic financial authority
LLMs can propose; policy engine and domain services decide. Human approves PayPal batch. No model can approve, capture, release hold or override.

## ADR-011 — Grounding verifier authority
Deterministic checks are authoritative. Verifier-advisor may only downgrade verified to needs_review; it cannot create or upgrade payables.

## ADR-012 — PostgreSQL jobs, no Redis/BullMQ
Use `jobs` table with row locking and `SKIP LOCKED`. Keep jobs idempotent and bounded.

## ADR-013 — Honest payment labels
Order created, buyer approved, capture submitted, capture confirmed and reconciled are separate states. Provider payout is not implied.

## ADR-014 — Source preservation
The uploaded v0.2 IDEA and SPEC are retained verbatim as the base. Implementation details are expanded in companion documents, not silently substituted.

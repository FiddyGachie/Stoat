# Product Requirements Document

## 1. Product objective

Demonstrate that autonomous software agents can participate in a controlled commercial transaction whose service scope, price, authority, delivery evidence, payable obligation and payment state are independently traceable.

The product succeeds when a reviewer can follow a single mission from intent to verified work and a real PayPal Sandbox capture, while seeing deterministic policy enforcement and accounting integrity.

## 2. Primary users

- **Mission owner / buyer:** defines task, budget, deadline, acceptable providers and acceptance criteria.
- **Service provider:** publishes a machine-readable service and performs the contracted task.
- **Operator / finance reviewer:** inspects agents, traces, evidence, obligations, approvals and reconciliation.
- **External agent developer:** integrates through REST, generated SDK or the P0-lite MCP server.
- **Hackathon judge:** evaluates meaningful AI, technical implementation, usability, innovation, impact and credibility.

## 3. Jobs to be done

1. As a mission owner, I can request a task without giving an LLM unrestricted spending authority.
2. As a buyer agent, I can discover services, compare structured quotes and propose an agreement.
3. As a provider agent, I can perform useful LLM work and submit structured evidence.
4. As the system, I can reject unsupported claims without asking another LLM to decide truth.
5. As the buyer agent, I can request a bounded revision using precise rejection reasons.
6. As finance, I can see exactly why an obligation exists and how it was accounted for.
7. As an operator, I can approve a payment batch and distinguish order, approval, capture and reconciliation.
8. As an external agent, I can initiate a mission using MCP without gaining privileged operations.

## 4. Scope and priority

### P0 — required for a passing live demo
- Authenticated tenant and agent principals; role/authority enforcement.
- Service registry and structured quote lifecycle.
- Mission, agreement and immutable agreement terms.
- Deterministic spending policy and atomic budget reservation.
- Buyer/provider agent runtime using a real configured LLM in live mode.
- LLM structured-output adapter with time/token/cost/step limits.
- Controlled code-review fixture; no arbitrary execution.
- Grounded deterministic delivery verifier.
- Bounded reject → revise → re-verify loop.
- Append-only event stream and agent trace.
- PostgreSQL jobs table with `FOR UPDATE SKIP LOCKED`.
- Double-entry ledger, one obligation per agreement, batch proposal.
- Human approval required for PayPal batch.
- PayPal Orders v2 Sandbox create/approve/capture; webhook signature verification and reconciliation.
- P0-lite MCP tools for mission execution under authenticated scope.
- Real AG Grid dashboard and AG Charts aggregates.
- Integrity endpoint/panel and `pnpm evidence`.
- Reproducible Docker Compose startup and documented demo.

### P1 — only after all P0 gates pass
- Policy proposals from natural language with human-approved versioning.
- Watchdog anomaly explanations and richer holds.
- Verifier-advisor LLM downgrade-only review.
- Operator copilot with allowlisted read-only query intents.
- Advanced MCP resources/prompts and broader tool coverage.
- Additional provider services and richer service metering.
- APIMatic SDK/portal workflow if access is confirmed.
- AG Studio if entitlement/access is confirmed.

### P2 — explicitly outside hackathon MVP
- Real provider payouts / disbursements.
- Custody, escrow, wallet or stored value.
- Production multi-network payment routing.
- x402 and MPP adapters unless separately implemented and tested.
- Arbitrary third-party code execution.
- Blockchain, token issuance, speculative reputation marketplace.
- Kubernetes, Kafka, microservices decomposition.
- Production compliance certification or regulated financial services.

## 5. Success metrics

- A clean checkout starts with documented commands.
- One full mission completes in live mode using a real model call.
- At least one deliberately invalid provider finding is rejected by deterministic grounding.
- A revision attempt is demonstrated, or a recorded trace proves the bounded recovery path; the live demo should prefer a real revision.
- One and only one payable obligation is accrued for the agreement.
- Ledger debits equal credits per currency.
- A human approves the batch.
- PayPal Sandbox order and capture are real and queryable; webhook and reconciliation evidence is retained.
- Integrity endpoint reports zero invariant violations.
- An external MCP client can run a mission using only P0 tools.
- Dashboard values are API-backed and traceable to stored records.

## 6. Product guardrails

- LLMs propose; deterministic code decides.
- The verifier does not trust provider assertions or the verifier-advisor.
- The model cannot approve a batch, capture a payment, release a hold or alter policy.
- No obligation before verified delivery.
- No silent mutation of accepted agreement terms.
- No edit or delete of financial journal entries; use reversals and adjustments.
- No UI status is stronger than backend evidence.
- Simulated, seeded, recorded and live activity must be visibly distinguished.

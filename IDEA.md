# STOAT — Product Vision (v0.2)

## 1. Executive vision

**Stoat is the verified-delivery payments layer for autonomous software agents.** Agents can already research, code, review, translate and extract data. What remains fragmented is the commercial lifecycle around their work: who is authorized to buy, what was agreed, how delivery is judged, what is owed, and whether payment actually settled.

Stoat makes machine commerce accountable. It is a hybrid: an open protocol specification, a reference platform, a developer API/SDK/MCP surface, and adapters to existing payment networks. It does not replace PayPal, x402, MPP or agentic-checkout standards; it supplies the commercial context around them.

**Positioning (credible version).** *Pay on verified delivery, with a ledger and an audit trail, settled on PayPal.* The larger phrase "economic protocol for the autonomous internet" is the long-term direction, used sparingly, never as a claim of present interoperability.

**Tagline.** Every agent can work. Every service can have a price. Every obligation can be accounted for.

## 2. The problem

- **Discovery is not agreement.** A listing does not establish buyer, scope, price, acceptance criteria or remedies.
- **Payment is not proof of work.** A receipt does not show the delivery met the contract. With LLM providers this is acute: fluent output can be wrong, fabricated or injected.
- **Autonomy lacks enforceable bounds.** A model must not grant itself budget or approve its own payment.
- **Metering is fragmented.** Services charge per request, token, second, file or task.
- **Finance teams lack traceability.** Operators cannot connect agent, mission, quote, agreement, delivery, payable and provider transaction.

## 3. Product thesis

Represent each machine-to-machine commercial interaction as a structured, traceable economic lifecycle with one rule at its centre:

> **LLMs propose. Deterministic code decides. Evidence unlocks money. Humans approve settlement.**

## 4. Capabilities

### Stoat Protocol
Versioned schemas and semantics (SEP v0.2) for identity and delegation, service descriptions, quotes, agreements, events, delivery evidence, obligations, settlement references and agent decision records.

### Stoat Exchange
Machine-readable service registry. Providers publish capability, pricing, delivery format and verification method. Buyers (human or agent) discover services, request quotes and compare structured offers via REST, generated SDK or **MCP tools**.

### Stoat Agents (new)
A small agent runtime and reference agents: **buyer** (plans, compares, proposes, recovers), **provider** (performs LLM work), **verifier-advisor** (semantic second opinion, downgrade-only), **treasury** (proposes batches, explains reconciliation), **watchdog** (places holds), and an **operator copilot** (read-only investigation). All run under *asymmetric authority*: agents may restrict freely but spend only inside a deterministic envelope.

### Stoat Settlement
Append-only event journal, obligations, double-entry accounting, batch proposals, human approvals, provider adapters and reconciliation. A proposal is not a payment; a submitted payment is not a confirmed settlement.

### Stoat Control
AG Grid + AG Charts command centre: agent activity and traces, quotes, policy decisions, deliveries and verification checks, obligations, payment transactions, exceptions, and a live **Integrity panel** that proves the accounting invariants hold.

## 5. Core innovation: the Economic Event Lifecycle with grounded verification

`MISSION_CREATED → SERVICE_DISCOVERED → QUOTE_REQUESTED → QUOTE_ISSUED → AGREEMENT_ACCEPTED → SERVICE_EXECUTED → DELIVERY_SUBMITTED → DELIVERY_VERIFIED | DELIVERY_REJECTED → (REVISION_REQUESTED → DELIVERY_SUBMITTED …) → OBLIGATION_ACCRUED → SETTLEMENT_BATCHED → PAYMENT_SUBMITTED → SETTLEMENT_CONFIRMED`

Failure states are first-class (quote expired, policy denied, execution failed, delivery rejected, obligation reversed, payment failed, reconciliation required, hold placed). Corrections are compensating events, never edits.

**Grounded verification** is the differentiator for LLM-performed work: every claim in a delivery (file, line, snippet, rule) is checked against the controlled artifact the agreement referenced. A fluent hallucination is rejected by arithmetic and string comparison, not by another model's opinion.

## 6. Differentiation (honest)

x402 standardises HTTP-native payment requests; MPP addresses machine payment intents including metered sessions; agentic checkout protocols structure purchases; PayPal provides payment infrastructure. Stoat's proposed complementary layer joins:

1. immutable commercial agreements;
2. normalised economic events with hash-chain integrity;
3. independent, grounded delivery verification;
4. obligation accrual and double-entry accounting;
5. settlement aggregation and reconciliation;
6. delegation, budgets, approvals and organisation controls;
7. recorded agent proposals beside the deterministic decisions that governed them;
8. operator-grade traceability.

Do not claim competitors lack all of these. Demonstrate that Stoat composes them in one coherent, testable lifecycle, and do not claim x402/MPP interoperability that has not been built and tested.

## 7. Signature mission (the demo spine)

A buyer agent receives the mission *"Get a security-and-quality review of the `acme-checkout` fixture repository"* with a USD 10.00 mission budget and a USD 1.00 per-transaction cap. (Amounts are seed defaults, see `DEMO_SCRIPT.md`.)

1. **Discover & compare.** Through MCP the agent finds three review services: *Sentinel* (USD 0.05/file, schema + grounded verification), *Lintwise* (USD 0.04/file, hash-only verification), and *DeepAudit Premium* (USD 0.30/file). The agent weighs verification commitments, not just price.
2. **Policy bites.** The agent's first proposal is DeepAudit Premium (total USD 2.40, over the cap). Deterministic policy denies it; the denial and reason code appear in the Trust workspace.
3. **Injection ignored.** Lintwise's service description contains an instruction to pay a different payee and raise the amount. The payee and amount come from registry and agreement records, so the text has no effect; the attempt is logged.
4. **Real LLM work, real verification.** The agent accepts Sentinel. The provider agent reviews the fixture. The first delivery contains one fabricated finding (a file/line that does not exist or a snippet that does not match). The grounded verifier rejects it; no obligation exists.
5. **Recovery.** The buyer agent requests a revision with the structured failure reasons. The provider resubmits; checks pass; the obligation accrues exactly once with a balanced journal.
6. **Human-approved settlement.** The treasury agent proposes a batch and explains it. A human approves. The buyer approves the PayPal Sandbox order; Stoat captures server-side; a verified webhook (or labelled lookup fallback) reconciles amount and currency.
7. **Proof.** The Integrity panel shows: ledger balanced, hash chain intact, zero duplicate obligations, zero policy bypasses, one reconciled capture. The trace drills from capture back to the LLM proposal.

## 8. Target users

Initial: agent developers, paid machine-service providers, teams operating several agents, AI platform builders. Longer term: enterprises, agent infrastructure and API marketplaces, finance/security/compliance teams.

## 9. Impact claims — how they are substantiated

Impact claims must come from the project's own measured runs, not assertion. The evidence generator reports, for a controlled run: number of agent purchase proposals, policy denials, deliveries rejected by grounded verification, revisions needed, obligations accrued, exactly-once suppression of duplicates, and reconciliation outcome. Label all figures as controlled-demo measurements, not market data.

## 10. Business model

Keep the protocol and reference contracts open (permissive licence). Potential paid services: hosted registry, managed event ingestion, enterprise policy/delegation, settlement orchestration and reconciliation, trust/risk analytics, enterprise reporting.

## 11. Principles

Provider-neutral; policy before payment; evidence before payable; append-only economics; exact money; idempotent operations; human control; observable by design; honest adapter capabilities; **agents restrict freely, spend only within envelope**; **record proposals beside decisions**; incremental delivery.

## 12. Scope discipline

The hackathon MVP is one complete vertical slice. Do not attempt escrow, custody, token economies, multi-currency FX, dispute arbitration, or every payment protocol. A narrow, functioning, auditable lifecycle with real AI work beats many superficial integrations. Anything outside the P0 table in `SPEC.md` §3 requires a recorded decision and must not displace P0 work.


---

## v2.0 implementation note

This file is preserved from the supplied v0.2 product vision. The implementation pack expands it through the companion requirements, architecture, agent runtime, protocol, security, testing and delivery documents. Where implementation detail is more specific than this vision, the detailed contract files govern build and acceptance.

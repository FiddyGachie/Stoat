# Signature Demo — The Verified Agent Mission

## Demo objective

Show that a model can perform real service work while Stoat—not the model—controls authority, evidence acceptance, accounting and payment state.

## Four beats

### Beat 1 — Autonomy with a budget
- Create mission: review a controlled repository fixture.
- Display budget and mission limits.
- Buyer agent discovers service and compares quote.
- Accept quote only after deterministic policy decision and atomic reservation.
- Show trace and policy decision.

### Beat 2 — AI work meets grounded proof
- Provider agent calls configured LLM in live mode.
- It returns structured code-review findings.
- Deliberately include or replay a plausible unsupported finding.
- Grounding verifier rejects unsupported file/line/snippet/rule.
- Buyer agent requests revision with exact failure reasons.
- Provider revises; verifier checks again.
- Show the evidence and persisted checks.

### Beat 3 — Verified work becomes an obligation
- Show one obligation created only after verified delivery.
- Open journal: debit buyer expense, credit provider payable.
- Show balanced totals and integrity panel.
- Treasury proposes settlement batch.
- Operator approves; show that agent cannot approve.

### Beat 4 — Real payment proof
- Create PayPal Sandbox order for approved batch.
- Buyer approves in PayPal Sandbox.
- Backend captures.
- Verify webhook signature and dedupe.
- Reconcile amount, currency and IDs.
- Explain clearly: buyer payment is captured to merchant account; provider payable is recorded internally and not paid out by this MVP.

## Required demo evidence

- mission/agreement IDs;
- agent run IDs and model metadata;
- proposal and deterministic decision;
- delivery artifact hash;
- verification checks and verdict;
- revision count;
- obligation and journal IDs;
- batch and approval IDs;
- PayPal order and capture IDs (redacted where appropriate);
- webhook verification and reconciliation record;
- integrity response;
- dashboard screenshots and `docs/EVIDENCE.md`.

## Rehearsal

- Run end-to-end at least once in live mode daily.
- Run replay mode for deterministic presentation.
- Confirm Sandbox credentials and buyer account before judging.
- Freeze feature work after all P0 gates pass.
- Prepare a 90-second fallback recording from a genuine successful run.

## Honest narration

Say "verified delivery" only when deterministic checks passed. Say "captured" only when PayPal confirms capture. Say "reconciled" only after amount/currency/ID match. Do not say "provider paid" because provider payout is not implemented.

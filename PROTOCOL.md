# Stoat Economic Protocol (SEP) v0.2 / Implementation Profile

## 1. Scope

SEP describes the commercial context surrounding a machine-to-machine service interaction. It does not define a new payment rail and does not replace PayPal, x402, MPP or agentic checkout standards.

## 2. Core resources

- `Agent`: identity, role, tenant, status, delegation and capability scopes.
- `Service`: provider capability, pricing model, currency, input/output schema, verification method, limits and status.
- `Mission`: buyer intent, budget, deadline, constraints and lifecycle.
- `Quote`: provider offer with price, scope, expiry and terms.
- `Agreement`: immutable accepted quote and acceptance criteria.
- `EconomicEvent`: append-only event with actor, aggregate, sequence, timestamp, payload hash and previous hash.
- `Delivery`: artifact reference, schema, provider run and evidence metadata.
- `Verification`: deterministic checks, verdict and reason codes.
- `Obligation`: amount owed after accepted delivery.
- `JournalEntry`: balanced debit/credit lines.
- `SettlementBatch`: grouped obligations with approval and payment status.
- `PaymentTransaction`: external provider order/capture references and reconciliation.
- `PolicyDecision`: deterministic authorization result.
- `AgentRun`: execution trace and limits.

## 3. Required invariants

1. Accepted agreement terms are immutable.
2. Every accepted agreement has exactly one effective policy allow decision.
3. No payable obligation exists before verified delivery.
4. At most one obligation exists per agreement.
5. Every journal transaction balances per currency.
6. Every settlement batch contains one tenant and one currency.
7. An obligation is reserved by at most one active batch.
8. A payment capture is not considered reconciled until amount, currency and provider references match.
9. Event ordering uses server `recorded_at` and aggregate sequence; agent-supplied `occurred_at` is optional metadata only.
10. Corrections use compensating events, never edits.

## 4. Lifecycle

`MISSION_CREATED → SERVICE_DISCOVERED → QUOTE_REQUESTED → QUOTE_ISSUED → AGREEMENT_ACCEPTED → SERVICE_EXECUTED → DELIVERY_SUBMITTED → DELIVERY_VERIFIED | DELIVERY_REJECTED → REVISION_REQUESTED → DELIVERY_SUBMITTED … → OBLIGATION_ACCRUED → SETTLEMENT_BATCHED → PAYMENT_SUBMITTED → SETTLEMENT_CONFIRMED`

Failure and exception states are first-class. State transitions must be validated by domain services, not inferred from event names or UI actions.

## 5. Event envelope

```json
{
  "event_id": "uuid",
  "tenant_id": "uuid",
  "aggregate_type": "mission",
  "aggregate_id": "uuid",
  "sequence": 7,
  "event_type": "DELIVERY_VERIFIED",
  "actor_type": "agent",
  "actor_id": "uuid",
  "correlation_id": "uuid",
  "recorded_at": "RFC3339 timestamp",
  "occurred_at": "optional RFC3339 metadata",
  "payload": {},
  "payload_hash": "sha256",
  "previous_hash": "sha256 or null"
}
```

## 6. Amount representation

API amounts are decimal strings. Currency is mandatory. Never use binary floating point. Database uses `NUMERIC(20, 6)` or a precision justified by supported currencies; currency-specific precision is validated before posting. No silent rounding. Reject unsupported precision.

## 7. Versioning

Protocol resources carry schema/version identifiers. Additive optional fields may be introduced compatibly. Breaking changes require a new major protocol version and migration notes. The OpenAPI contract is the canonical API representation; protocol semantics are documented here.

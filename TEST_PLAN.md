# Test Plan

## 1. Test layers

- Unit: policy, amount validation, state machines, grounding checks, journal balancing, batch totals.
- Integration: repository + PostgreSQL transaction, idempotency, job worker, PayPal adapter, webhook verification.
- Contract: OpenAPI schema, error envelope, MCP input/output schemas.
- Security: tenant isolation, role matrix, prompt injection, SSRF prevention, secret redaction.
- E2E: full mission, revision, obligation, approval, PayPal Sandbox capture and reconciliation.
- Replay: deterministic agent traces and evidence generation.

## 2. Critical test cases

### Money and policy
- `"0.12"` accepted as valid decimal; malformed decimal rejected.
- Excess currency precision rejected, not rounded.
- Mission reservation exactly at cap allowed; one unit over denied.
- Two concurrent accept requests cannot overspend.
- Same idempotency key + same body returns same result.
- Same key + different body returns `IDEMPOTENCY_CONFLICT`.
- Currency mismatch denied.

### Grounding
- Existing file, valid line, exact snippet passes.
- Unknown file fails.
- Out-of-range line fails.
- Reversed line range fails.
- Snippet mismatch fails.
- Rule not allowlisted fails.
- Invalid severity fails.
- Duplicate finding fails.
- Finding count above agreement max fails / review per contract.
- Missing in-scope file triggers coverage review.
- Prompt-injection string in fixture does not alter tool permissions.

### Lifecycle
- Expired quote cannot be accepted.
- Accepted agreement cannot be edited.
- Delivery rejected does not accrue obligation.
- Revision count cannot exceed agreement max.
- Multiple verified deliveries still create only one obligation.
- Active hold blocks new quote acceptance/reservation.
- Only human principal releases hold.

### Ledger and batch
- Each posted journal transaction balances by currency.
- Reversal exactly offsets original.
- Obligation cannot be in two active batches.
- Batch total equals sum of items.
- Unverified, disputed, held or reversed obligation excluded.

### PayPal
- OAuth failure is safe and redacted.
- Create order retry uses request ID.
- Browser redirect alone does not mark capture.
- Capture timeout enters unknown and queries provider.
- Invalid webhook signature rejected.
- Duplicate webhook event is idempotent.
- Amount/currency mismatch creates reconciliation exception.
- Capture does not mark provider payable as paid.

### MCP and authority
- Buyer can discover and request quote.
- Buyer cannot propose treasury batch.
- Treasury cannot approve batch.
- No MCP tool exists for capture or hold release.
- Cross-tenant resource ID cannot be read.
- Tool arguments reject unexpected fields.

## 3. Definition of done

All P0 tests pass in CI. Critical integration and E2E tests pass against a disposable PostgreSQL database and PayPal Sandbox. Evidence artifacts are generated from test outputs. Failures are not hidden by retry loops or seeded data.

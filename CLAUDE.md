# Coding Agent Instructions — Stoat v2.0

## Mission

Implement the Stoat v0.2 product as specified in this repository. Build the P0 vertical slice first. Treat the supplied `IDEA.md`, `SPEC.md` and `CHANGES_v0.2.md` as source requirements and this pack's companion documents as implementation detail.

## Mandatory workflow

1. Inspect repository structure, package scripts, existing implementation and tests before editing.
2. Create an implementation plan mapped to P0 acceptance IDs.
3. Do not overwrite working code without understanding it.
4. Implement one vertical slice at a time; run tests after each domain boundary.
5. Update OpenAPI, migrations, tests and docs together.
6. Report exact files changed, commands run, test results and blockers.
7. Never claim tests passed unless actually run.
8. Never fabricate evidence, IDs, screenshots, provider responses or transaction states.

## Non-negotiable invariants

- PostgreSQL is source of truth; no Redis/BullMQ.
- No arbitrary artifact URLs; use controlled `artifact_id`.
- LLMs propose; deterministic code authorizes and decides.
- Provider output is not trusted; grounding verifier is deterministic.
- Verifier-advisor can only downgrade.
- Human approves PayPal batch.
- No agent can approve, capture, release hold or override policy.
- No obligation before verified delivery; unique obligation per agreement.
- Journal is balanced and append-only; corrections use reversals.
- PayPal capture is buyer-to-merchant; no provider payout claim.
- Amounts are decimal strings at boundaries and exact decimal in storage.
- Every sensitive action is tenant-scoped, authorized and audited.

## Implementation order

1. Repository audit, environment, Docker Compose, CI.
2. PostgreSQL migrations and identity.
3. OpenAPI and API error/idempotency middleware.
4. Mission, service, quote, agreement and policy.
5. Agent runtime, LLM adapter and trace.
6. Provider review task, artifact upload and grounding verifier.
7. Revision workflow.
8. Obligations, accounts, journal and integrity.
9. Batch proposal and human approval.
10. PayPal create/approval/capture/webhook/reconciliation.
11. P0 MCP server.
12. AG Grid/AG Charts dashboard.
13. evidence generator, red-team and submission.

## Code quality

- TypeScript strict mode.
- Validate all external inputs.
- Domain services own transitions; controllers are thin.
- Use decimal library / PostgreSQL NUMERIC; never JS float for money.
- Use transaction boundaries and row locking for financial writes.
- Use structured logs and correlation IDs.
- Keep generated SDK output separate; do not hand-edit it.
- No secrets in frontend or repository.
- Prefer explicit enums and discriminated unions over stringly typed state.

## Completion response format

For each milestone report: implemented behavior, files changed, migrations, tests executed with results, manual verification, known gaps, next acceptance gate. Clearly distinguish live, mocked, seeded and replayed behavior.

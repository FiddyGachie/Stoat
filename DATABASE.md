# Database Specification

## 1. General rules

PostgreSQL is authoritative. Use UUID primary keys, tenant IDs on tenant-owned rows, `created_at`/`updated_at` where applicable, server timestamps, foreign keys and indexes. Monetary columns use exact `NUMERIC`, never `FLOAT` or `DOUBLE PRECISION`. Store raw external payloads only when necessary, redacted and access-controlled.

## 2. Required tables

| Table | Key fields / purpose |
|---|---|
| `tenants` | tenant identity, status, settings |
| `users` | operator identity, tenant membership |
| `agents` | role, status, tenant, scopes, credential hash |
| `agent_delegations` | delegator, delegate, scope, expiry, revocation |
| `services` | provider, capability, pricing, schema, verification profile |
| `missions` | buyer, brief, budget, currency, deadline, status |
| `quote_requests` | mission, requested scope, status |
| `quotes` | provider, price, currency, terms, expiry, status |
| `agreements` | accepted quote snapshot, immutable terms, revision limits |
| `economic_events` | append-only event envelope, sequence, hash chain |
| `deliveries` | agreement, provider run, `artifact_id`, schema and status |
| `artifacts` | controlled object key, hash, size, content type, tenant |
| `verifications` | verdict, checks JSON, verifier version, reasons |
| `obligations` | agreement unique key, amount, currency, status |
| `accounts` | chart of accounts by tenant/currency/account code |
| `journal_transactions` | source event, effective time, posting status |
| `journal_lines` | account, debit, credit, currency |
| `settlement_batches` | tenant, currency, total, status, approver |
| `settlement_batch_items` | batch, obligation, amount |
| `payment_transactions` | provider, order/capture IDs, amount, currency, status |
| `webhook_events` | provider event ID unique, signature result, processing state |
| `reconciliation_records` | expected/actual amount, currency, IDs, verdict |
| `approvals` | approver, action, target, policy snapshot, timestamp |
| `policy_versions` | version, structured rules, active state |
| `policy_decisions` | actor, action, resource, policy version, result, reason |
| `holds` | scope, reason, placed_by, release_by, status |
| `idempotency_keys` | scope, key, request hash, response reference/status |
| `agent_runs` | role, mission, parent, model, limits, terminal state |
| `agent_steps` | tool calls, hashes, authorization and results |
| `llm_proposals` | schema payload, prompt hash, model, decision |
| `jobs` | type, payload reference, status, attempts, lock, run_after |
| `audit_logs` | actor, action, resource, correlation, outcome |
| `recorded_llm_responses` | request hash, schema version, response payload, model metadata |

## 3. Constraints and indexes

- Unique `(tenant_id, agreement_id)` on obligations.
- Unique `(tenant_id, aggregate_type, aggregate_id, sequence)` on events.
- Unique `(tenant_id, principal_id, route, idempotency_key)` on idempotency.
- Unique provider webhook event ID.
- Unique payment provider + provider order/capture ID where present.
- Check constraint: journal line debit and credit are non-negative and exactly one side is positive.
- Check constraint: amount greater than zero where required.
- Index mission timeline by `(tenant_id, mission_id, recorded_at)`.
- Index jobs by `(status, run_after, priority)`.
- Index obligations by `(tenant_id, status, currency)`.
- Index events by `(tenant_id, aggregate_type, aggregate_id, sequence)`.

## 4. Artifact storage

The public API accepts an `artifact_id`, never an arbitrary `artifact_uri`. Upload endpoint issues a controlled artifact record and storage key. Enforce tenant ownership, size limits, content type allowlist, malware scanning where available, generated storage names, checksum and retention. Do not fetch arbitrary URLs. Fixture files are read-only and versioned by manifest hash.

## 5. Migration policy

Use forward-only versioned migrations. Test migrations from empty DB and from previous release. Do not edit migration history after it has been applied. Backups and restore drills are outside the demo minimum but required before production.

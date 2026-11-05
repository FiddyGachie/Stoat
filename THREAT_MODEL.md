# Threat Model

## 1. Assets

Tenant data, agent credentials, mission scope, service listings, quotes, accepted agreements, artifacts, LLM prompts/responses, budget reservations, policy versions, ledger and obligations, PayPal credentials, webhook integrity, approvals, audit trail and deployment secrets.

## 2. Trust boundaries

- Browser ↔ API.
- External MCP client ↔ MCP server.
- Agent ↔ tool/API.
- Provider LLM ↔ untrusted repository fixture.
- API/worker ↔ PostgreSQL.
- Backend ↔ LLM provider.
- Backend ↔ PayPal.
- Webhook sender ↔ webhook receiver.
- Tenant ↔ tenant.
- Artifact upload ↔ object storage.

## 3. Threats and mitigations

| Threat | Example | Required mitigation |
|---|---|---|
| Prompt injection | fixture tells provider to ignore task and exfiltrate secrets | treat fixture as data; no secret context; no arbitrary tools |
| Hallucinated finding | model invents a line or snippet | deterministic grounding verifier |
| Agent privilege escalation | buyer tries approval endpoint | server role matrix and 403 tests |
| Overspend race | parallel quote acceptance exceeds mission budget | atomic reservation and row lock |
| Duplicate request | retry creates second obligation | idempotency and unique constraints |
| Tenant escape | MCP tool reads another tenant | tenant derived from principal; query scoping |
| SSRF | delivery submits attacker URL | controlled artifact ID; no arbitrary URI fetch |
| Path traversal | artifact path manipulates storage | generated object keys; normalized path validation |
| Webhook spoof | forged capture event | signature verification and event dedupe |
| Capture ambiguity | timeout after PayPal accepted capture | unknown state, query before retry |
| Ledger tampering | update or delete journal line | append-only DB permissions and reversal entries |
| Double batching | same obligation in two batches | atomic reservation and unique active constraint |
| Copilot injection | user requests raw SQL | fixed typed intent allowlist |
| Secret leakage | API key in logs or browser bundle | server-only secrets, redaction, secret scanning |
| Replay confusion | recorded trace presented as live | visible replay label and evidence metadata |
| Malicious service listing | provider advertises unsupported capability | schema validation, allowlisted categories and evidence |
| LLM denial/cost attack | repeated expensive calls | quotas, rate limits, budget ceiling, circuit breaker |

## 4. Abuse cases

Test buyer trying to accept expired quote, provider submitting artifact from another tenant, provider changing price after agreement, agent requesting hold release, watchdog attempting spend, treasury self-approving, copilot requesting cross-tenant data, webhook replay, same idempotency key with different payload, and simultaneous acceptance of quotes that exceed budget.

## 5. Security acceptance

Every sensitive endpoint has authentication, authorization, tenant scoping, validation, audit and rate limits. Every forbidden agent action has automated negative tests. No critical secrets appear in frontend assets, logs, generated evidence or repository history.

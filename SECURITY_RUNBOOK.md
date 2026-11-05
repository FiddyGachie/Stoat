# Security and Incident Runbook

## 1. Credential handling

- Store LLM and PayPal secrets in deployment secret manager / environment variables.
- Never commit `.env`; commit `.env.example` with placeholders only.
- Rotate credentials after suspected exposure.
- Redact authorization headers, access tokens, webhook signature material and sensitive prompts.
- Use separate Sandbox and any production credentials.

## 2. Agent suspension

On suspected compromise:
1. Suspend agent principal.
2. Revoke its active credentials/delegations.
3. Place a scoped hold if financial or service activity may continue.
4. Preserve traces and audit records.
5. Identify missions, quotes, agreements and obligations touched by the agent.
6. Re-run integrity checks.
7. Require human review before reactivation.

## 3. Payment incident

For unknown or mismatched PayPal outcome:
1. Mark transaction `unknown` or `reconciliation_required`.
2. Prevent new capture attempts for same batch.
3. Query PayPal order/capture state.
4. Verify webhook processing and provider IDs.
5. Compare amount, currency, custom ID and batch.
6. Record reconciliation result and operator action.
7. Escalate unresolved mismatch; do not edit ledger to force a match.

## 4. Data integrity incident

- Freeze affected financial mutations.
- Export relevant event, journal, batch and payment records.
- Run integrity endpoint and independent SQL checks.
- Preserve original records.
- Apply compensating entries only after approval.
- Document cause, scope, resolution and evidence.

## 5. Prompt injection incident

- Stop affected run.
- Preserve artifact hash and trace.
- Confirm no unauthorized tools were exposed.
- Re-run with fixture treated as data and minimal context.
- Add the payload to red-team fixtures.
- Do not let an LLM decide whether its own behavior was safe.

## 6. Demo emergency fallback

Fallbacks must be disclosed:
1. Live LLM unavailable → replay trace clearly labelled.
2. PayPal Sandbox outage → show last real capture evidence and label current run blocked; do not claim a live capture.
3. MCP client issue → show REST path and MCP conformance test evidence.
4. Dashboard issue → use API responses and recorded screen capture; do not fabricate UI activity.

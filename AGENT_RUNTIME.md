# Agent Runtime Specification

## 1. Run lifecycle

`created → queued → running → completed | terminated_limit | failed_closed | failed_retryable`

Terminal state is immutable. A run may create child runs with explicit parent linkage. Every tool call is recorded as an agent step with input hash, tool name, authorization result, output reference/hash, duration and error code. Avoid storing credentials or unnecessary sensitive content.

## 2. Execution loop

1. Load authenticated principal, tenant and mission scope.
2. Load role permissions and current policy version.
3. Check mission and agent are active and not held/suspended.
4. Load run limits and decrement step/time/token/cost budgets.
5. Send only necessary context to LLM adapter.
6. Validate structured output against schema.
7. Store proposal before consequential action.
8. Submit proposed action to domain API.
9. Domain API independently checks authority, policy, state and idempotency.
10. Persist deterministic decision and tool result.
11. Continue, complete or fail closed.

## 3. Limits

Required configurable limits:
- maximum steps per run;
- maximum wall-clock seconds;
- maximum input/output tokens;
- maximum LLM cost per run and per mission;
- maximum tool calls per tool;
- maximum revision count;
- maximum artifact bytes and finding count.

If any limit is exceeded: terminate safely, emit an event, release only reservations that are safe to release under the relevant state machine, and never mutate a settled financial record.

## 4. LLM adapter

Interface responsibilities:
- provider selection and model configuration;
- timeout and bounded retry;
- structured response mode / JSON schema validation;
- token and estimated cost capture;
- redaction and prompt hashing;
- record/replay;
- normalized errors (`RATE_LIMITED`, `PROVIDER_TIMEOUT`, `INVALID_OUTPUT`, `PROVIDER_ERROR`).

Retries are allowed only before side effects or when the operation is idempotent. The adapter never invokes financial endpoints directly.

## 5. Proposal and decision record

`llm_proposals` stores proposal type, schema version, validated payload, prompt hash, model, model parameters, run ID, mission ID, created time and decision reference. `policy_decisions` stores allow/deny/approval-required, policy version, principal, action, amount/currency when relevant, reason codes and timestamp.

## 6. Failure handling

- Invalid JSON/schema: fail closed.
- LLM timeout: bounded retry, then safe failure.
- Tool 403: record denied step; do not ask model to bypass.
- Quote expiry: rediscover/requote; never accept stale quote.
- Delivery rejection: request revision only within agreement limit.
- Unknown payment state: query provider and reconcile; never blind retry capture.
- Database unavailable: no financial mutation; return retryable error.

# Observability and Evidence

## Correlation

Every HTTP request, MCP invocation, agent run, job, event, payment operation and webhook has a correlation ID. Propagate parent correlation IDs across async boundaries.

## Structured logs

Required fields: timestamp, level, service, environment, correlation ID, tenant ID, actor type/ID, mission ID where relevant, operation, outcome, duration and stable error code. Do not log secrets, authorization headers, raw payment credentials or full sensitive prompts.

## Metrics

- API request rate, latency and error rate.
- Agent runs by role/outcome/model.
- LLM latency, token count, estimated cost and failures.
- Job queue depth, attempts, age and dead jobs.
- Quote acceptance and policy denial counts.
- Delivery verdict and rejection reasons.
- Obligation accrual count/value.
- Journal imbalance count (must be zero).
- Batch and PayPal order/capture states.
- Webhook verification failures and duplicates.
- Reconciliation mismatch count.
- Integrity violations.

## Evidence generator

`pnpm evidence` must:
1. run replay mission and selected integration checks;
2. capture actual command exit codes and timestamps;
3. query persisted IDs and state from API/DB;
4. include test results, integrity report and environment mode;
5. redact secrets and personal data;
6. write `docs/EVIDENCE.md`;
7. fail if required evidence is missing.

Never generate evidence by copying expected output strings. Mark each record `live`, `replayed`, `seeded` or `mocked`.

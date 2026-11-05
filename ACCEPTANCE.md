# Acceptance Matrix

## P0 — hard gates

| ID | Requirement | Pass condition / evidence |
|---|---|---|
| P0-01 | Clean install | documented install and migrations work from clean checkout |
| P0-02 | Tenant isolation | cross-tenant API and MCP reads return 404/403 without leakage |
| P0-03 | Agent identity | each run has role, tenant, scope, limits and trace |
| P0-04 | Real AI provider | live mode makes real configured model call; replay is labelled |
| P0-05 | Structured output | malformed output fails closed and emits event |
| P0-06 | Service discovery | buyer finds active service from registry |
| P0-07 | Quote | quote has price, currency, scope and expiry |
| P0-08 | Agreement | accepted terms are immutable |
| P0-09 | Budget policy | over-budget accept is denied; concurrent requests cannot overspend |
| P0-10 | Provider work | LLM code review uses controlled fixture and produces schema-valid output |
| P0-11 | Grounding | invented file/line/snippet/rule is rejected deterministically |
| P0-12 | Recovery | bounded revision loop operates and cannot exceed max revisions |
| P0-13 | Obligation | only verified delivery accrues; unique one per agreement |
| P0-14 | Ledger | journal balances per currency; corrections are reversals |
| P0-15 | Batch | same tenant/currency; exact total; no duplicate reservation |
| P0-16 | Human approval | agents cannot approve; PayPal batch requires human approval |
| P0-17 | PayPal create | real Sandbox order created for approved batch |
| P0-18 | PayPal capture | capture performed server-side after buyer approval |
| P0-19 | Webhook | signature verified and duplicate event idempotently handled |
| P0-20 | Reconciliation | amount/currency/provider IDs matched; unknown not falsely marked success |
| P0-21 | MCP P0-lite | external client can execute mission lifecycle within role scope |
| P0-22 | MCP authority | no approval/capture/release/override tools; forbidden calls denied |
| P0-23 | Dashboard | AG Grid API-backed; sorting/filtering/pagination/drilldown work |
| P0-24 | Charts | AG Charts derived from real API aggregates |
| P0-25 | Integrity | all invariant counters zero for clean demo |
| P0-26 | Evidence | `pnpm evidence` writes evidence from actual run output |
| P0-27 | Replay | replay exact hash; unknown hash fails; UI labels replay |
| P0-28 | Red team | prompt-injection fixtures do not cause tool/secret escalation |
| P0-29 | Audit | sensitive actions record actor, resource, outcome, reason, correlation |
| P0-30 | Demo honesty | live, replayed, seeded and mocked states visibly distinguished |

## P1 — stretch gates

- Policy proposal → human diff review → versioned activation.
- Watchdog hold placement and human-only release.
- Verifier-advisor can only downgrade.
- Operator copilot typed intent, read-only and tenant scoped.
- APIMatic validation and SDK generation evidenced if account access available.
- Advanced MCP resources/prompts.
- Additional services or metering models.

## Release rule

Do not start P1 until every P0 gate is green or a blocker is documented honestly. A mocked payment, scripted fake live agent, hard-coded verification, unbalanced ledger, or decorative-only dashboard fails the MVP.

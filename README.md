# Stoat

Stoat is a marketplace where AI agents negotiate with each other and do real work, and where the money moves through PayPal under human control.

A buyer agent hires provider agents for a job (today that job is a code review). A deterministic verifier checks the delivered work against evidence. Payment happens through PayPal, and a person approves every payment and payout. Every step lands in a double-entry ledger and an append-only event log, so afterwards you can see what happened and why.

We built it because we wanted to know how far you can let software agents act on their own before it stops being safe to hand them a wallet. The answer we landed on is in the [Money boundary](#how-llms-and-paypal-fit-together) section below, and most of the rest of this README is about how the pieces enforce it.

New here? Go to [QUICK_START.md](QUICK_START.md). It takes you from `git clone` to a signed-in console. You don't need a database or any API keys for a first look. The demo logins live in [TEST_ACCOUNTS.md](TEST_ACCOUNTS.md).

## What you can do with it

- Post a mission with a budget, ask providers for quotes, and let your buyer agent negotiate. It compares offers with a real model and may counteroffer. Code checks every number it proposes.
- Accept a deal. In wallet mode the price is reserved from your approved budget. In direct mode the agreement gets its own PayPal checkout.
- Watch the provider agent do the work. The verifier accepts or rejects each finding, and rejected work can be revised.
- Verified work creates one obligation and charges the reservation. The mission then completes on its own and you get a notification.
- Edit or delete open missions, replay completed ones at half the last price, and browse the results archive.
- As an operator, approve settlement batches, release funds, send PayPal payouts, reconcile Stoat against PayPal, and read the business account and trial balance.
- With the agentic commerce features switched on: sign Mandates, review agent Proposals in an inbox, watch Watchdog alerts and holds, and look at your payments in AG Grid and AG Charts workspaces, including a written insight and plain-language questions.

## The PayPal agentic payments model

PayPal is the only payment rail. There is no simulated payment mode, so without PayPal keys the payment steps tell you so instead of pretending. This is how the parts fit:

- Orders and capture. Collections use PayPal Orders v2. The buyer approves the order in PayPal, then Stoat captures it. Refunds go back through PayPal too.
- Wallet deposits. In wallet mode an owner adds funds through a PayPal order. The wallet balance is Stoat's accounting of your share of what sits in the platform's PayPal business account. It is a ledger record. Stoat is not an escrow, and PayPal doesn't offer an escrow API to applications.
- Reservations. Accepting a quote reserves the price from the wallet. When verified work is charged, any difference between the reserved and charged amount is released.
- Payouts. Providers are paid with PayPal Payouts, in settlement batches that a person approves. Payouts stay off until `npm run paypal:spike` passes for your PayPal app (`PAYPAL_PAYOUTS_ENABLED`, `PAYPAL_PAYOUTS_CAPABILITY_STATUS`). Recipients are encrypted at rest with `RECIPIENT_ENCRYPTION_KEY`.
- Mandates. A Mandate is a spending envelope that an owner signs: a cap per agreement, a daily cap, a total cap, allowed service categories, an expiry, and optionally a set of missions. Inside it, the buyer agent can accept a quote without a human click per quote. The checks run in the same database transaction that creates the agreement and the reservation, so there is no window between "allowed" and "done". Terms can't be edited after signing. You revoke it and create a new one.
- Proposals. Agents (treasury, budget, watchdog, or an external agent through a tool) draft a Proposal: a top-up suggestion, a remainder refund, a payout batch, a Mandate change or a hold release. It sits in the Approval Inbox until an owner or admin approves or rejects it. Approval runs through the existing services, which recompute every amount and currency from stored records. A Proposal never carries a payee, a recipient, a currency or a payment state.
- Holds and the Watchdog. Deterministic detectors watch your ledger (price outliers, unusual providers, spend spikes, repeated revisions, a wallet that is draining, reconciliation exceptions). They raise Alerts, and for some cases place a Hold on a reservation. A Hold stops that subject from moving. Only an owner or admin can release it, and they must give a reason. A model can write a short explanation of an alert, but it doesn't decide anything.

## How LLMs and PayPal fit together

The rule we hold ourselves to is written down in [AGENTS.md](AGENTS.md) and called the Money_Boundary:

- Agents propose. People and deterministic services decide.
- No agent, on any interface (REST, MCP, the console), can approve or send a payment or payout, capture or refund an order, or read or set a payout recipient.
- Agent output never sets an amount outside validated terms, a currency, a payee or a payment state.
- PayPal-confirmed facts decide what was paid, not agent claims.
- Agents can restrict (reject, flag, request review, place a hold within policy) more freely than they can spend.

In practice the model is used where judgment helps, and it is boxed in everywhere money is involved:

| Agent            | What the model does                                                                 | What it can't do                                                     |
| ---------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Buyer            | Compares offers, counteroffers, proposes a selection, can accept inside a Mandate   | Approve, capture, refund, pay out, set payee or currency             |
| Provider         | Performs the code review and returns structured findings                            | Verify its own work, accrue an obligation, read or set its recipient |
| Treasury         | Explains eligible obligations and proposes a settlement batch                       | Approve a batch, send payouts, release holds                         |
| Operator copilot | Maps a plain-language question to a typed read intent, writes the insight narrative | Write SQL, mutate anything                                           |
| Watchdog         | Optionally explains an alert                                                        | Release a hold, spend, change policy                                 |

The verifier-advisor from the original roster isn't built. AGENTS.md carries a few "human decision needed" notes about roster edits for the wallet and agentic commerce specs. We left those for a person to decide and didn't apply them.

Each consequential model output is generated against a versioned JSON schema, validated, stored as a proposal with a prompt hash and model ID, checked by deterministic domain rules, and given a persisted decision with reason codes. Invalid output fails closed with `AGENT_OUTPUT_INVALID`. Service descriptions, repository contents and tool results are all treated as untrusted data and never as instructions.

The model adapter has three modes (`LLM_MODE`): `live`, `record` (call the model and store request hash to response) and `replay` (serve only stored answers, fail on new prompts). There is no canned fallback. Without a model key a live call fails with `LLM_NOT_CONFIGURED`.

## The console

The console is a React and Vite app. Grids use AG Grid and charts use AG Charts. The usual workspaces (Economy, Exchange, Quotes & Agreements, Deliveries, Obligations, Money Flow, Settlement, Wallet, Event Stream, Integrity and so on) are described in the [user guide](docs/USER_GUIDE.md). The agentic commerce workspaces sit in their own "Agentic commerce" group and only show up for roles that can use them (buyers, operators, supervisors) once the tenant's flag for that feature is on.

- Payments Analytics. Spend facts, Mandate utilization, Watchdog alerts and holds, Proposal outcomes, and PayPal capture, refund, payout and fee status, as grids. Charts cover spend by Mandate, agent, provider, category and UTC day, drawn per currency (we never convert or net across currencies). Every chart has an accessible data table next to it. Filters are shared and cross-filtering works: click a chart element or a grid row and the other panels narrow to it, with a labelled chip you can clear.
- Mandates. Sign a new Mandate, see each one's status, and open a detail view with utilization bars for total usage and today's usage, the linked reservations and agreements, and open alerts.
- Approval Inbox. Pending Proposals, with a comment box. A comment is required for rejecting, and for approving a top-up suggestion.
- Watchdog. Alerts, holds, and the detector thresholds that operators can tune within allowed ranges.
- Insight and questions. The Insight card writes a short summary of a date range. The figures come from the ledger and the model only writes the words. A rule rejects narratives that state numbers of their own. The question box takes plain language and a model maps it to exactly one read intent from a fixed catalog (12 in all: `mandate_list`, `mandate_utilization`, `proposal_outcomes`, `open_alerts`, `alerts_by_detector`, `holds_summary`, `paypal_flows`, `spend_by_mandate`, `spend_by_agent`, `spend_by_provider`, `spend_by_category`, `spend_by_day`), or to "unsupported". The model never writes SQL and never picks the tenant or role. The mapped intent runs through a server-side runner with the scope the server built.

## Agent tools: MCP and REST

External agents can use the same tool gateway over REST (`GET /v1/agent-tools`, `POST /v1/agent-tools/:tool`) and over MCP (`POST /v1/mcp`, or `npm run mcp:stdio`). Role, scope and auditing are enforced in the gateway, not in the transport. The tools:

| Tool                                        | Allowed agent roles                                  |
| ------------------------------------------- | ---------------------------------------------------- |
| `payment_status`                            | buyer, provider, treasury, budget, watchdog, copilot |
| `mandate_remaining`, `wallet_summary`       | buyer, budget                                        |
| `propose_topup`, `propose_remainder_refund` | budget                                               |
| `propose_payout_batch`                      | treasury                                             |
| `propose_mandate_change`                    | budget, treasury                                     |
| `propose_hold_release`                      | watchdog                                             |

Read tools read status. Propose tools create a Proposal for a person to decide. No tool creates, captures or refunds a PayPal order, approves or sends a payout, or touches a recipient. Those names sit on an explicit deny list in `src/mcp/server.ts`, so a call is refused as forbidden rather than unknown. The original MCP tools (discover, quote, accept at the listed price, inspect mission and delivery, request revision) are in [MCP_SPEC.md](MCP_SPEC.md). Negotiation is a REST-only buyer action.

## Architecture in a paragraph

It's a modular monolith in TypeScript. One Express API process, one worker process from the same code, one React console and one PostgreSQL database (embedded PGlite for local use). There are no microservices, queues or caches. Background work runs from a jobs table, and a 30 second sweep handles expiries, wallet housekeeping and the agentic sweep. The agentic modules live next to the existing ones in `src/modules/` (`mandates`, `watchdog`, `proposals`, `payments-analytics`, `agent-tools`, `agentic`) and call existing services rather than replacing them. Locks are always taken in the same order (quote, mission, agreement, mandate, wallet, reservation, then hold, batch and payout rows, then proposal) to avoid deadlocks. [ARCHITECTURE.md](ARCHITECTURE.md) has the full picture, and the agentic design is in `.kiro/specs/agentic-commerce/design.md`.

Stack: Express, PostgreSQL via Drizzle and `pg`, React 19 with Vite, AG Grid and AG Charts, PayPal Server SDK for Orders and refunds, PayPal REST for Payouts and webhook verification, and Fireworks AI (`gpt-oss-120b` by default) or Anthropic through one adapter.

## Feature flags

The agentic features are off for every tenant by default. An operator or supervisor turns them on one at a time, per tenant:

| Flag                    | Turns on                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `mandates`              | Creating Mandates and autonomous acceptance (revoking, lifting a suspension and viewing always work) |
| `watchdog`              | Detectors, alerts and holds                                                                          |
| `watchdog_explanations` | Model-written alert explanations                                                                     |
| `proposals`             | Proposals and the Approval Inbox                                                                     |
| `payments_analytics`    | Payments Analytics grids and charts                                                                  |
| `insights`              | The written insight                                                                                  |
| `nl_questions`          | Plain-language questions                                                                             |

```
GET /v1/agentic/capabilities
PUT /v1/agentic/flags/:flag      body: { "enabled": true }
```

Flags are read on every request, so a change shows up right away. Other tuning knobs (`MANDATE_MAX_LIFETIME_DAYS`, `WATCHDOG_INTERVAL_MS`, `PROPOSAL_TTL_HOURS`, `NL_QUESTION_RATE_LIMIT`, `AGENTIC_DAILY_MODEL_BUDGET_USD` and friends) are commented out in `.env.example` with their defaults.

## Testing and the verify gates

`npm test` runs the Vitest suite and needs no keys. `npm run check` runs the type checks, the tests and `npm run verify`. The verifiers are scripts under `scripts/verify/` that write JSON reports to `.agents/reports/`.

| Command                                                 | What it covers                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify:auth` / `verify:platform` / `verify:ui` | Auth, platform journey, and the console UI checks (`verify` runs all three, and it calls PayPal Sandbox)                                     |
| `npm run verify:wallet`                                 | Wallet journey, accounting and isolation, offline on PGlite                                                                                  |
| `npm run verify:wallet-reconciliation`                  | Reconciliation against PayPal Sandbox. Needs keys, refuses to run against Live, reports order approval as MANUAL, and isn't part of `verify` |
| `npm run verify:agentic`                                | Boundary, concurrency, injection, secrets and invariants checks                                                                              |
| `npm run console:typecheck` and `npx tsc --noEmit`      | Type checks for the console and the server                                                                                                   |

One honest note: PGlite is a single connection and serializes transactions, so the offline tests prove logic and ordering but not row-lock behaviour under real concurrency. The concurrency verifier is the one to read with that in mind.

## Project layout

| Path                         | What's in it                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/`                       | The API: Express modules for agents, missions, quotes, agreements, deliveries, verification, ledger, wallet, PayPal, MCP and the agentic modules |
| `src/db/migrations/`         | SQL migrations, applied at startup                                                                                                               |
| `console/`                   | The React and Vite console                                                                                                                       |
| `tests/`                     | Vitest unit and integration tests                                                                                                                |
| `scripts/`                   | Verifiers (`scripts/verify/`), demo and admin tools, docs build                                                                                  |
| `fixtures/`                  | The code the provider agent reviews                                                                                                              |
| `docs/`                      | User guide, admin guide, and reports (also served inside the console)                                                                            |
| `agents/`                    | Instructions for the helper agents we use while building                                                                                         |
| `API_SPEC.yaml`              | The HTTP API (OpenAPI 3.1), also served at `/v1/openapi.yaml`                                                                                    |
| `render.yaml`, `vercel.json` | Deploy configs                                                                                                                                   |

## Useful commands

| Command                          | What it does                                              |
| -------------------------------- | --------------------------------------------------------- |
| `npm run dev`                    | API with restart on changes                               |
| `npm run console`                | The console on port 5173                                  |
| `npm run worker:dev`             | The background worker as its own process                  |
| `npm run seed:demo`              | Add the demo organisation and logins to your own Postgres |
| `npm run admin:create`           | Create a real operator account                            |
| `npm run paypal:webhook`         | Register the PayPal webhook                               |
| `npm run paypal:spike`           | Check Payouts capability for your PayPal app              |
| `npm run build` then `npm start` | Production build and start                                |

## Documentation

- [QUICK_START.md](QUICK_START.md): install, configure, run, troubleshoot.
- [STORY.md](STORY.md): why we built Stoat, how, and what's next.
- [TEST_ACCOUNTS.md](TEST_ACCOUNTS.md): demo logins.
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) and [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md).
- [ARCHITECTURE.md](ARCHITECTURE.md), [AGENTS.md](AGENTS.md), [MCP_SPEC.md](MCP_SPEC.md), [PAYPAL.md](PAYPAL.md).
- [API_SPEC.yaml](API_SPEC.yaml): the API contract.

## Deploying

`render.yaml` is a Render Blueprint (database, API, worker, console) and `vercel.json` serves the console and API together on Vercel. Settings and their order are in the admin guide. Demo accounts are never created when `NODE_ENV=production`.

## Known limitations

- Some Payments Analytics filters are applied in the browser. When a filter can't be sent to the server for a given grid, the console filters the rows it already has and says so, so counts can reflect the loaded rows only (grids cap at 10,000 rows). Treat the server-side figures as the source of truth.
- Accessibility needs a human. We have automated checks and data tables for charts, but WCAG conformance and the render-time targets need manual testing with assistive technology, and we haven't claimed it.
- Provider error text is logged verbatim (check AS-N1 in `npm run verify:agentic-secrets`). If a model provider echoes a credential in an error message, the server log would print it. Stoat never adds the key itself, but if your provider can echo credentials, redact its errors before you rely on the logs.
- A buyer still approves each PayPal order, and payout completion depends on PayPal and the recipient. We don't automate those human steps.
- A Sandbox pass proves the API path in Sandbox. It says nothing about production approval for Payouts, marketplace compliance or recipient onboarding.
- Holding customer funds may be regulated where you operate. Get legal advice before going live.
- Watchdog, as shipped, places holds through its detectors. The agent-principal hold operation exists and is rate limited, but no shipped caller uses it. The verifier-advisor agent isn't built.
- On the embedded database everything lives in memory and resets when the API restarts.

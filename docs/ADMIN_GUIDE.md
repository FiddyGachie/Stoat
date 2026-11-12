# Stoat Admin Guide

**Version 2.1.** This guide is for the people who run Stoat: operators who watch the platform and approve money movement, and the engineers who deploy and configure it. For day-to-day use, see the [User guide](/docs/user-guide.html).

## How money moves

All real money movement is **PayPal**, and nothing else. There are two separate PayPal transactions per deal, and either can succeed or fail on its own:

| Leg                       | PayPal product        | Who triggers it                                          | Done when                                                                 |
| ------------------------- | --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Buyer collection**      | Orders v2 (`CAPTURE`) | The buyer, by approving at PayPal after accepting a deal | PayPal reports the capture COMPLETED and the amount matches the agreement |
| **Provider disbursement** | Payouts API           | A person: approve the payout, then send it               | PayPal reports that provider's **payout item** SUCCESS                    |

Stoat's ledger is an accounting record. A captured buyer payment never means the provider was paid, and Stoat does not claim atomic split settlement. Wallet deposits are a separate, additional way to fund missions (see [The wallet and the Holding Account](#the-wallet-and-the-holding-account)).

> **The rule that shapes everything:** models propose, deterministic code decides, evidence unlocks money, and a person approves every payment leg. No screen, API route or MCP tool lets an agent approve, send, capture, refund or redirect money.

## Roles at a glance

| Role                   | How they sign in            | What they can do                                                                                           |
| ---------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Organization owner** | Sign up themselves          | Buyer portal: missions, negotiation, payments, agents, performance, their own providers' payout recipients |
| **Operator**           | Created by an administrator | Operator console: every workspace, approve settlement, approve and send payouts, refunds                   |
| **Supervisor**         | Created by an administrator | Same as an operator, for senior sign-off                                                                   |
| **Agent**              | Agent ID and secret         | A scoped workspace. Never approves, captures, refunds, pays out, changes recipients or changes policy      |

## Create an operator

There is no public sign-up for operators. Create them from the command line:

```
ADMIN_EMAIL=ops@example.com ADMIN_PASSWORD='a-long-passphrase' npm run admin:create
```

| Variable          | Required | Meaning                                                                   |
| ----------------- | -------- | ------------------------------------------------------------------------- |
| `ADMIN_EMAIL`     | Yes      | The operator's sign-in email                                              |
| `ADMIN_PASSWORD`  | Yes      | 12 to 128 characters. Read from the environment, never printed            |
| `ADMIN_ROLE`      | No       | `operator` (default) or `supervisor`                                      |
| `ADMIN_TENANT_ID` | No       | Attach to an existing organization. Omit to create a new one              |
| `ADMIN_ORG`       | No       | Name for a newly created organization (default "Stoat Operations")        |
| `DATABASE_URL`    | Yes      | The persistent PostgreSQL database. The command refuses to run without it |

Running it again with the same email resets that operator's password and role. On Render, run it in the API service **Shell**. The operator signs in on the **User** tab.

> **Note:** the "Operator console access" token box works only in development. In production, operators use email and password.

## Tour of the operator console

Every screen has a shareable address (for example `#/moneyflow`) and the browser Back button works. On a phone the sidebar becomes a menu button.

| Screen                  | Use it to                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Economy**             | Missions, agents, payable and in-settlement counts, integrity status and spend at a glance                  |
| **Performance**         | Each agent's verification rate, earnings (including paid by PayPal) and spend; suspend or reactivate agents |
| **Exchange**            | Services on offer, prices and how each is verified                                                          |
| **Quotes & Agreements** | Missions, quotes and the immutable agreements they became                                                   |
| **Agents**              | Every agent and the full trace of any run                                                                   |
| **Deliveries**          | Each delivery and every check that verified or rejected it                                                  |
| **Obligations**         | What is owed for verified work and its status                                                               |
| **Money Flow**          | Each agreement's two PayPal legs side by side, with PayPal references and exact statuses                    |
| **Settlement**          | Approve batches, release funded payments, manage payout recipients, approve and send payouts                |
| **Wallet**              | The signed-in person's own balance, deposits and mission budgets, funded through PayPal. Open to buyers too |
| **Business account**    | Platform-wide PayPal funds, wallet balances, refunds and reconciliation. Operators and supervisors only     |
| **Event Stream**        | The append-only history with its integrity chain                                                            |
| **Policy & Trust**      | Policy decisions, holds and approvals                                                                       |
| **Integrity**           | Live proof that the ledger balances, history is intact and no payment rule was broken                       |

Badges in the sidebar come from the server, never from a build setting: the model mode (**live model**, **live model (recorded)**, **replay mode** or **model not configured**) and PayPal (**paypal sandbox**, **paypal live** or **paypal not configured**).

## The deal lifecycle

| Step         | What happens                                                                                                                                                                                                                                                                                                        | Who                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1. Negotiate | The buyer agent compares offers and may counteroffer. Every proposal is checked by code                                                                                                                                                                                                                             | Buyer agent (model), then the server                  |
| 2. Accept    | Spending policy decides; an immutable agreement is recorded                                                                                                                                                                                                                                                         | Buyer                                                 |
| 3. Collect   | A PayPal order is created; the buyer approves at PayPal; Stoat captures and reconciles                                                                                                                                                                                                                              | Buyer and PayPal                                      |
| 4. Deliver   | For a **hosted** service Stoat queues one review job the moment the deal is ready (accepted, or captured when `REQUIRE_FUNDING=true`); the job runs the provider's model, the deterministic verifier accepts or rejects it, and rejected work is revised up to twice. **External** services deliver through the API | Job runner (or the provider agent), then the verifier |
| 5. Release   | A person approves the batch of verified work and releases the money already collected                                                                                                                                                                                                                               | Operator                                              |
| 6. Pay out   | A person approves and sends the provider payout; PayPal confirms the item                                                                                                                                                                                                                                           | Operator and PayPal                                   |

## Negotiation

**Let my buyer agent negotiate** in the buyer portal (or `POST /v1/missions/{missionId}/negotiate` for a buyer agent) makes a real model call. It produces three stored records: an offer comparison, up to two counteroffers and a server-built selection. Each has the prompt hash, model id, mode and a deterministic verdict with reason codes. Read them with `GET /v1/missions/{missionId}/proposals`.

The checks a counteroffer must pass: it names a quote on the mission, uses the quote's currency, is no higher than the listed price, is no lower than the provider's private floor (`min_price`), and fits the mission's remaining budget. A provider with no floor does not negotiate. Acceptance with a `proposal_id` re-checks all of this, uses each proposal once, and still runs the spending policy. Service descriptions and mission text reach the model marked as untrusted data, and the model has no field for payee, recipient or payment state.

## Collect the buyer's payment

Accepting a deal creates a real PayPal order for the agreement price and sends the buyer to PayPal (the PayPal app opens on phones that have it).

| Step      | What happens                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request   | Acceptance creates the order. If PayPal is unreachable the acceptance still stands and **Payment needed** offers **Pay with PayPal** later                              |
| Approve   | The buyer approves at PayPal. A redirect alone proves nothing                                                                                                           |
| Capture   | The first of three triggers captures it: the return link, the `CHECKOUT.ORDER.APPROVED` webhook or the 30-second sweep. Each is idempotent                              |
| Reconcile | PayPal's captured amount and currency must equal the agreement. A match marks it **funded** and posts a balanced ledger entry; a mismatch holds everything for a refund |
| Gate      | With `REQUIRE_FUNDING=true`, providers cannot deliver until the agreement is funded (HTTP 402 `PAYMENT_REQUIRED`). Keep it on in production                             |
| Refund    | `POST /v1/agreements/{agreementId}/refund` (operator or supervisor) while no obligation exists. Once work is verified the money is owed to the provider                 |

Unused orders lapse after about three hours and are marked **expired** by the sweep.

> **Note:** PayPal cannot push a payment prompt into an arbitrary person's app. Stoat creates a real order and sends the buyer to approve it. Requesting money from a PayPal email address would need PayPal Invoicing, which is not built.

## Approve and release settlement

Open **Settlement** and choose **Let the treasury agent plan payment**. A real model reads the verified, unbatched work and proposes batches, choosing for each the PayPal route: **release** what the buyer already paid at acceptance, or **collect** with a new PayPal order. The server checks the plan (known obligations only, each one exactly once, one currency per batch, never mixing paid and unpaid work, the route must match what PayPal captured). A bad plan is sent back to the model once and then refused, and nothing is created. Batches it proposes appear in the grid as awaiting approval, each with the next step to take. You can also propose batches yourself.

1. Open **Settlement** and select a batch. Check the items and the total.
2. Choose **Approve batch** or **Reject batch** (rejecting returns the obligations to payable).
3. For a batch whose agreements were paid at acceptance, choose **Release funded payment**. No second charge is made; the server refuses one (`BATCH_ALREADY_FUNDED`).
4. Only for a batch that was never paid at acceptance: **Pay with PayPal instead**, the buyer approves, then **Capture payment**. Capturing before approval is refused by PayPal and changes nothing.

## Pay providers

Payouts use the PayPal Payouts API and need, on the server:

- `PAYPAL_PAYOUTS_ENABLED=true` and `PAYPAL_PAYOUTS_CAPABILITY_STATUS=enabled`. Set them only after `npm run paypal:spike` returns GO for your PayPal app. Otherwise every payout action answers **Provider payout unavailable: no provider payment was sent.** The browser cannot change this.
- `RECIPIENT_ENCRYPTION_KEY`, at least 32 random characters. Provider PayPal addresses are encrypted with it. Changing it later makes saved recipients unreadable, so they would have to be saved again.

In **Settlement**, open a confirmed batch. Under **Pay providers**:

1. **Save recipient.** Enter the provider's PayPal email and tick that the owner agrees to receive payouts there. It is stored encrypted and shown only masked, for example `p***@e***.com`.
2. **Confirm this recipient.** Confirm the masked address is right. Changing the address later resets this.
3. **Review and approve payout.** A separate approval from the batch approval. It binds the exact amounts, obligations and recipients, works once and expires after 15 minutes.
4. **Send payout via PayPal.** Stoat re-checks everything. If a recipient, amount or obligation changed since the approval, the send is refused and recorded as a substitution attempt.

| Payout status  | Meaning                                                                 | Obligation           |
| -------------- | ----------------------------------------------------------------------- | -------------------- |
| **requested**  | Stoat asked PayPal; PayPal has not confirmed receiving it               | disbursement pending |
| **processing** | PayPal accepted it but the item is PENDING, ONHOLD or UNCLAIMED         | disbursement pending |
| **paid**       | PayPal reported this provider's item SUCCESS. The ledger moves only now | paid                 |
| **failed**     | Refused, blocked or denied. Nothing booked; approve again to retry      | payout failed        |
| **returned**   | Returned or reversed after payment. The ledger entry is reversed        | returned             |

A batch-level SUCCESS never counts unless the item succeeded. If a payout request times out, Stoat does **not** resend it: PayPal rejects a repeated payout instead of returning the first, so a blind resend could pay twice. It waits for PayPal's payout webhook; if none arrives, check PayPal Activity before approving a retry. **Check payout** asks PayPal immediately.

## Money Flow

**Money Flow** (`GET /v1/money-flow`) lists every agreement with both legs: the PayPal order and capture for the buyer, and the PayPal payout batch and item, masked recipient and status for the provider. A row turns green only when PayPal confirmed the provider's payout. When payouts are unavailable the screen says so and shows the provider as unpaid.

## The wallet and the Holding Account

Buyers can deposit money through PayPal into a per-person, per-currency **wallet** and have mission charges drawn from it.

> **Holding Account, stated plainly:** deposited funds sit in the platform's PayPal business account. PayPal provides no escrow API for applications. Stoat's wallet balances are ledger records of what the platform owes each user, not separate PayPal accounts. Holding customer funds may be regulated: take legal advice for your jurisdiction before taking real deposits.

- **Balances** are computed from posted double-entry ledger lines, never from a stored counter. The business account total of wallet balances must equal the sum of all wallets in the same currency. A difference raises a `wallet_balance_mismatch` notification for admins and changes nothing automatically.
- **Environment:** every deposit records its PayPal environment (sandbox or live). A deposit from a different environment than the one configured is left out of available balance and flagged for review.
- **Credit** happens only after PayPal confirms the capture, through the return link, the webhook or the sweep. Order creation alone never credits. A repeated event credits once.
- **Isolation:** a user sees only their own wallet. Cross-user requests are refused without saying whether the wallet exists. Wallet endpoints never return payout recipients or payment-source details.
- **Money boundary:** no agent can deposit, top up, decide a remainder, refund or run reconciliation. Those need a signed-in person.

### Notifications and email

The **Notifications** page lists in-app notices addressed to the signed-in person. Admins in the tenant also receive notices for deposits captured, missions depleted, refunds completed or failed, balance mismatches and reconciliation exceptions. If an email provider is configured, each owner notice is also emailed; delivery is retried at most 3 times, and the in-app notice is kept if email fails.

### Remainders and refunds

When a mission finishes with funds left over, the owner chooses **Keep in wallet** or **Refund to PayPal**. A refund is allocated across the owner's captures, oldest first, with PayPal request IDs derived from the decision and capture so a retry cannot refund twice. The wallet is debited only when PayPal confirms the refund. A pending refund is excluded from available balance until it settles; a failed one leaves the mission awaiting decision, lets the owner retry and notifies every admin. A refund larger than the owner's unrefunded captures is refused with `REFUND_EXCEEDS_CAPTURES` and no PayPal call is made.

### Business account and reconciliation

Operators and supervisors see the **Business account** page. Per currency it shows the PayPal funds received (clearing) balance, total wallet balance held, funds allocated to providers, provider payouts completed, refunds completed and platform revenue, all derived from the ledger when you open the page. It also lists wallets and each user's statement with running balances, and everything on it is read-only.

**Run reconciliation** compares captured deposits, completed refunds and completed payouts in Stoat with what PayPal reports for the same IDs, fetched from PayPal at run time.

| Result                        | Meaning                                                                                                      | What to do                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **Clean**                     | No differences and nothing unreachable                                                                       | Nothing                                             |
| **Exception**                 | An item differs in amount, currency or status, or a deposit or refund has been pending over 24 hours (stale) | Investigate in PayPal Activity and the event stream |
| **Unverifiable / incomplete** | PayPal did not answer for an item after 3 retries. The run is never marked clean                             | Run it again later                                  |

Only one run can be in progress per organization, and a scheduled run also happens automatically. A run never changes a balance, reservation or ledger entry. Fixing a difference needs a separate, admin-approved reversing entry. Exceptions that stop differing are marked resolved and keep their history. Each run also reports the trial balance per currency.

For a Sandbox check of the real PayPal path, `npm run verify:wallet-reconciliation` refuses to run without credentials or against Live, and is not part of `npm run verify`.

## Prove the Payouts capability

`npm run paypal:spike` sends one 0.01 USD Sandbox payout to a placeholder address, queries the batch and the item, repeats the same sender id and aborts one request to test the ambiguous case. It writes `docs/PAYPAL_PAYOUTS_SPIKE.md` with masked evidence and prints the two settings to apply. It refuses to run against a live PayPal host. A Sandbox GO does not prove production approval for Payouts.

## Manage agents

- **Suspend** an agent from **Performance** when its behaviour looks wrong or a secret may have leaked. It is refused on its next request.
- **Reactivate** restores access with the agent's existing secret.
- Both need a signed-in person, ask for confirmation and are audited. A lost secret cannot be recovered: suspend and provision a new agent.

## Configuration

| Variable                                   | Default                                      | Purpose                                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                               | none                                         | Signs sessions. **Required in production, at least 32 characters**                                                                                                                                                                                    |
| `USER_TOKEN_TTL_SECONDS`                   | `28800`                                      | A person's session length (8 hours)                                                                                                                                                                                                                   |
| `AGENT_TOKEN_TTL_SECONDS`                  | `900`                                        | An agent's token length (15 minutes)                                                                                                                                                                                                                  |
| `RUN_JOBS_IN_API`                          | on                                           | The API process also runs the job runner (hosted provider reviews). Set `false` only when a separate worker runs                                                                                                                                      |
| `WORKER_POLL_INTERVAL_MS`                  | `2000`                                       | How often the job runner looks for work                                                                                                                                                                                                               |
| `WORKER_MAX_ATTEMPTS`                      | `5`                                          | Attempts before a job is parked as dead (missing configuration parks it at once)                                                                                                                                                                      |
| `LOGIN_MAX_FAILURES_PER_ACCOUNT`           | `5`                                          | Wrong passwords before a 15 minute pause                                                                                                                                                                                                              |
| `LOGIN_MAX_FAILURES_PER_IP`                | `100`                                        | Failed sign-ins per address per 15 minutes                                                                                                                                                                                                            |
| `SIGNUP_MAX_PER_IP_PER_HOUR`               | `20`                                         | Accounts per address per hour                                                                                                                                                                                                                         |
| `MAX_AGENTS_PER_TENANT`                    | `50`                                         | Agents per organization                                                                                                                                                                                                                               |
| `TRUST_PROXY_HOPS`                         | `1` on Render and Vercel                     | Proxy hops to trust for per-address limits                                                                                                                                                                                                            |
| `ALLOW_LEGACY_BEARER_TOKENS`               | on outside production                        | Development-only ID tokens; always off in production                                                                                                                                                                                                  |
| `PAYMENT_PROVIDER`                         | `PAYPAL`                                     | The only accepted value. Anything else stops the server at startup                                                                                                                                                                                    |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | none                                         | PayPal REST app credentials                                                                                                                                                                                                                           |
| `PAYPAL_BASE_URL`                          | Sandbox host                                 | `https://api-m.sandbox.paypal.com`; any other host is treated as live                                                                                                                                                                                 |
| `PAYPAL_WEBHOOK_ID`                        | none                                         | Required for webhooks; without it every webhook is rejected                                                                                                                                                                                           |
| `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL`   | API paths                                    | Where PayPal sends the buyer back                                                                                                                                                                                                                     |
| `CONSOLE_URL`                              | `http://localhost:5173`                      | Fallback for where the API hands the buyer back after PayPal. Normally the buyer returns to the console origin they paid from (remembered with the payment; trusted only if it is `CONSOLE_URL`, the API's own host, or localhost outside production) |
| `REQUIRE_FUNDING`                          | `false` locally, `true` on Render            | Providers cannot deliver until the buyer has paid                                                                                                                                                                                                     |
| `PAYPAL_PAYOUTS_ENABLED`                   | `false`                                      | Operator switch for provider payouts                                                                                                                                                                                                                  |
| `PAYPAL_PAYOUTS_CAPABILITY_STATUS`         | `unknown`                                    | `enabled` only after the spike passes; `blocked` if it fails                                                                                                                                                                                          |
| `RECIPIENT_ENCRYPTION_KEY`                 | derived from `JWT_SECRET` outside production | Encrypts provider PayPal recipients. **Required in production**                                                                                                                                                                                       |
| `LLM_PROVIDER`                             | `fireworks`                                  | `fireworks` or `anthropic`                                                                                                                                                                                                                            |
| `FIREWORKS_API_KEY`                        | none                                         | Model key (also read from `LLM_API_KEY`). Without one, model calls fail with `LLM_NOT_CONFIGURED`; nothing is invented                                                                                                                                |
| `LLM_MODEL_AGENT`                          | `accounts/fireworks/models/gpt-oss-120b`     | Model used by every agent                                                                                                                                                                                                                             |
| `LLM_MODE`                                 | `record`                                     | `record`: live call, stored for replay. `live`: no storage. `replay`: stored answers only, so new prompts fail                                                                                                                                        |

How sign-in is protected: passwords and agent secrets are stored only as salted scrypt hashes; unknown email and wrong password give the same message and take the same time; tokens are pinned to one signing algorithm; suspended agents are refused because every request re-checks the database.

## Deploy on Render

The `render.yaml` Blueprint creates the database, API, worker and console.

1. In Render choose **New**, then **Blueprint**, and connect the repository.
2. Enter the secrets when asked: `JWT_SECRET`, `FIREWORKS_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`. `RECIPIENT_ENCRYPTION_KEY` is generated for you.
3. Migrations run before each release. Then create the first operator from the API **Shell**.
4. Set `VITE_API_BASE_URL` on the console to the API address and `CONSOLE_URL` on the API to the console address, then redeploy both.
5. Register the webhook: `PUBLIC_API_URL=https://your-api npm run paypal:webhook`. It subscribes to the order, capture and payout events, can be repeated, and prints `PAYPAL_WEBHOOK_ID` for the API. PayPal only calls public HTTPS addresses.
6. Run `npm run paypal:spike`. If it returns GO, set `PAYPAL_PAYOUTS_ENABLED=true` and `PAYPAL_PAYOUTS_CAPABILITY_STATUS=enabled` on the API.
7. Check the sidebar badges: **paypal sandbox** and **live model (recorded)**.

To approve a Sandbox payment from a terminal, `npm run payments:watch` prints each waiting PayPal link and captures the order the moment you approve it.

## Monitor the platform

| Check                                         | Where                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Is the API up, and which model mode is it in? | `GET /v1/health`                                                                                                     |
| Can it reach the database?                    | `GET /v1/ready`                                                                                                      |
| Which PayPal capabilities are on?             | `GET /v1/paypal/status`                                                                                              |
| Are both payment legs healthy?                | **Money Flow**                                                                                                       |
| Is the ledger sound?                          | **Integrity** or `GET /v1/integrity`                                                                                 |
| Is provider work stuck?                       | `SELECT type, status, error FROM jobs WHERE status IN ('queued', 'dead')`: a dead `provider_review` names its reason |
| Who did what?                                 | The event stream and the `audit_logs` table                                                                          |

Integrity also checks the v2.1 money rules: no obligation is paid without a PayPal-confirmed payout, no obligation is paid twice, no payout exceeds what was owed, and every payment record is PayPal. Treat any **Violation** as an incident: stop approving money movement and investigate.

## Verify a release

```
npm run check
```

This type-checks the server and console, runs the test suite, and runs the sign-in, owner-journey and interface verifiers. The journey verifier makes real PayPal Sandbox and model calls when credentials are set. Run it before every deploy.

## Agentic commerce

These features sit in the **Agentic commerce** group of the console navigation: **Approval Inbox**, **Mandates**, **Payments Analytics** and **Watchdog**. Each one shows only for buyers, operators and supervisors, and only when its flag is on for the tenant. None of them lets an agent move money. People approve, release and pay.

### Feature flags

All seven flags are off for every tenant until an operator or supervisor turns them on.

| Flag                    | What it turns on                                                                 |
| ----------------------- | -------------------------------------------------------------------------------- |
| `mandates`              | Mandates: standing spending limits, and the **Mandates** workspace                |
| `watchdog`              | The detectors, alerts and holds, and the **Watchdog** workspace                   |
| `watchdog_explanations` | The model-written explanation on an alert (**Explain this Alert**)                |
| `proposals`             | Agent proposals and the **Approval Inbox**                                        |
| `payments_analytics`    | The **Payments Analytics** workspace and its datasets, charts and intents         |
| `insights`              | The written insight on Payments Analytics                                         |
| `nl_questions`          | Plain-language questions on Payments Analytics                                    |

1. Read the current state with `GET /v1/agentic/capabilities`. Any signed-in user can call it.
2. Set a flag with `PUT /v1/agentic/flags/:flag` and the body `{ "enabled": true }`. Only an operator or supervisor can call it. Each change is written to the audit log.
3. A call to a feature whose flag is off is refused with `FEATURE_DISABLED`.

Flags are stored per tenant and are read on every request, so a change takes effect at once with no restart. On the embedded PGlite database (local use) the data does not survive a restart, so flags reset and you must set them again. On PostgreSQL they persist.

### Wallet mode

Mandates need the tenant to be in wallet funding mode. Check or change it:

1. `GET /v1/admin/funding-mode` returns the current mode, `direct` or `wallet`.
2. `PUT /v1/admin/funding-mode` with `{ "funding_mode": "wallet" }` switches it. Only a signed-in operator or supervisor can do this, never an agent.
3. If any agreement is `accepted`, `revision_requested` or `needs_review`, the switch is refused with `FUNDING_MODE_BUSY`. Wait for those agreements to finish, then try again.

New tenants start in `direct` unless `DEFAULT_FUNDING_MODE` is `wallet`. A mandate request on a tenant in `direct` mode is refused with `MANDATE_REQUIRES_WALLET_MODE`.

### Watchdog

The Watchdog runs six detectors on a schedule (`WATCHDOG_INTERVAL_MS`). Each finding becomes an alert. Open the **Watchdog** workspace to see alerts, holds and thresholds.

| Detector                   | What it looks for                              | Threshold (allowed range)                                          | Default response |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ | ---------------- |
| `spend_spike`              | Spending far above the usual level             | `multiplier` 1.1 to 100, `min_observations` 3 to 60               | none             |
| `price_outlier`            | A price far above comparable quotes            | `multiplier` 1.1 to 100, `min_observations` 3 to 200              | hold             |
| `repeated_revision`        | Too many revision requests                     | `max_events` 1 to 20                                               | none             |
| `unusual_provider`         | A high price from a provider with no history   | `min_price` 0.01 to 999999999.99 (a money string)                  | hold             |
| `wallet_depleting`         | A wallet that will run out soon                | `horizon_hours` 1 to 168                                           | none             |
| `reconciliation_exception` | A reconciliation problem that stays unresolved | `max_age_minutes` 5 to 10080                                       | none             |

Defaults: `spend_spike` multiplier 3.0 and 5 observations, `price_outlier` multiplier 2.0 and 5 observations, `repeated_revision` 3 events, `unusual_provider` 500.00, `wallet_depleting` 24 hours, `reconciliation_exception` 60 minutes. `min_observations`, `max_events` and `max_age_minutes` must be whole numbers. A value outside its range is refused and the old value stays.

To change a threshold:

1. Call `GET /v1/admin/watchdog/thresholds` to see the current values.
2. Call `PUT /v1/admin/watchdog/thresholds/:detector` with the new values. Operators and supervisors only.
3. The response a detector applies is limited. `price_outlier` and `unusual_provider` can place a hold or suspend a mandate. `spend_spike` can suspend a mandate. The other three can only raise an alert.

Alerts have a severity of `low`, `medium`, `high` or `critical`. An alert is `open` until the detector finds nothing wrong on two runs in a row, then it becomes `resolved`. A `high` or `critical` alert also sends an admin notification.

An alert shows two kinds of text. The **evidence** is built from stored records and is the part to trust. The **explanation** is written by the model, is for reading only, and never changes the alert, a hold or a mandate. To get one:

1. Turn on `watchdog_explanations`.
2. Open a `medium`, `high` or `critical` alert and choose **Explain this Alert** (`POST /v1/watchdog/alerts/:id/explain`, operators and supervisors only).
3. The explanation is stored with the alert. If the model fails, times out or returns an answer that fails the schema, nothing is stored and you see `AGENT_OUTPUT_INVALID` or `MODEL_TIMEOUT`.

### Holds

A hold freezes one money step until a person releases it. A hold can attach to a reservation, a settlement item, a settlement batch or a payout. While a hold is active:

- the held step is refused with `HOLD_ACTIVE`;
- accrual for a verified delivery waits instead of failing, and runs once the hold is released;
- if accrual stays held longer than `HELD_ACCRUAL_MAX_DAYS`, you get a "Verified delivery accrual remains held" notification. Review the hold and the agreement.

To release a hold:

1. Open the hold in **Watchdog**, or call `GET /v1/watchdog/holds` and `GET /v1/watchdog/holds/:id`.
2. Check the alert behind it.
3. Release it with `POST /v1/watchdog/holds/:id/release` and a written reason of 1 to 500 characters.

Operators and supervisors can release any hold. A buyer can release only a hold on their own wallet's reservation. An agent can never release a hold. An agent can only ask, which files a `hold_release` proposal in the Approval Inbox for a person to decide.

### Approval Inbox (operator view)

Agents file proposals. A person decides each one. Open **Approval Inbox**, or use `GET /v1/proposals`, `GET /v1/proposals/pending-count`, `GET /v1/proposals/:id`, `POST /v1/proposals/:id/approve` and `POST /v1/proposals/:id/reject`. Operators and supervisors see every proposal in the tenant. Owners see their own.

| Proposal type      | Filed by          | Who decides      |
| ------------------ | ----------------- | ---------------- |
| `topup_suggestion` | budget agent      | The owner        |
| `remainder_refund` | budget agent      | The owner        |
| `mandate_change`   | budget or treasury agent | The owner |
| `payout_batch`     | treasury agent    | An operator or supervisor |
| `hold_release`     | watchdog agent    | An operator or supervisor |

To decide one:

1. Open the proposal and read the rationale and the checks.
2. Approve or reject, with a comment of 1 to 500 characters.
3. A proposal you filed yourself is refused with `SELF_APPROVAL`. Someone else must decide it.

A proposal that is not decided expires after `PROPOSAL_TTL_HOURS` and shows as `expired` (`PROPOSAL_EXPIRED` if you try to decide it). If the facts changed since it was filed, approval fails the checks and the proposal becomes `invalid` (`PROPOSAL_INVALID`). A proposal over `PROPOSAL_MAX_BYTES` is refused with `PROPOSAL_TOO_LARGE`.

Approval does not move money by itself. It queues a `proposal_execute` job. The job recomputes every amount from stored records at that moment, and it ignores the amount shown in the proposal, which is only a display hint. A payout batch proposal creates a settlement batch that still waits for the usual person approval and send. The job tries up to three times with backoff. After the third failure, or a permanent error, the proposal becomes `execution_failed` and you get a notification. The sweep also re-queues an approved proposal that has no job. The statuses are `pending`, `approved`, `rejected`, `expired`, `executed`, `execution_failed` and `invalid`.

### Mandates (operator side)

A mandate is a spending limit signed by a buyer. Operators and supervisors can list and read mandates (`GET /v1/mandates`, `GET /v1/mandates/:id`). Only the buyer who owns a mandate can create it or revoke it. Its terms cannot be edited (`MANDATE_TERMS_IMMUTABLE`). No mandate lives longer than `MANDATE_MAX_LIFETIME_DAYS`.

A mandate becomes `suspended` when a Watchdog detector with the suspend response finds a problem. A suspended mandate accepts nothing.

1. Open the alert that suspended the mandate and check the evidence.
2. Lift it with `POST /v1/mandates/:id/lift-suspension` and a reason of 1 to 500 characters. Operators, supervisors and the owning buyer can do this. An agent cannot.
3. The mandate returns to `active`, or to `expired` or `exhausted` if it ran out while suspended.

The sweep runs every 30 seconds. It moves mandates to `expired` or `exhausted` when they reach their date or cap. A state that does not fit the request returns `MANDATE_STATE_CONFLICT`.

### Payments Analytics (admin scope)

Owners see only their own payments. Operators and supervisors see the whole tenant. Four intents are admin only: `open_alerts`, `alerts_by_detector`, `holds_summary` and `paypal_flows`. Payout data never shows a recipient. The routes are `/v1/analytics/payments/:dataset`, `/v1/analytics/payments/charts/:chart`, `/v1/analytics/payments/intents/:intent`, `/v1/analytics/payments/insights` and `/v1/analytics/payments/questions`.

Limits you can tune: `ANALYTICS_TIMEOUT_MS` (a slow query ends with `ANALYTICS_TIMEOUT`), `INTENT_ROW_LIMIT`, `NL_QUESTION_RATE_LIMIT` and `AGENTIC_DAILY_MODEL_BUDGET_USD` (past it, model features refuse with `MODEL_BUDGET_EXCEEDED`). A question must be 1 to 500 characters. A question maps to one of the allowed read intents. It never runs free SQL.

### Agent tools over REST and MCP

Agents use eight tools through one gateway, so REST (`GET /v1/agent-tools`, `POST /v1/agent-tools/:tool`) and MCP give the same checks and results.

| Tool                       | Kind    | Agent roles allowed                                       |
| -------------------------- | ------- | --------------------------------------------------------- |
| `payment_status`           | read    | buyer, provider, treasury, budget, watchdog, copilot      |
| `mandate_remaining`        | read    | buyer, budget                                             |
| `wallet_summary`           | read    | buyer, budget                                             |
| `propose_topup`            | propose | budget                                                    |
| `propose_remainder_refund` | propose | budget                                                    |
| `propose_payout_batch`     | propose | treasury                                                  |
| `propose_mandate_change`   | propose | budget, treasury                                          |
| `propose_hold_release`     | propose | watchdog                                                  |

No tool deposits, reserves, charges, captures, refunds, approves, sends or releases, and none reads or sets a payout recipient. A `propose_*` tool only files a draft proposal. Each principal is limited to `AGENT_TOOL_RATE_LIMIT` calls (default 120) and past it the call fails with `RATE_LIMITED`. Every call writes exactly one audit log row, whether it succeeds, is refused or fails.

### Integrity check

The integrity check looks for any sign that an agent touched money. It reports four kinds of violation: an agent-authored money event, a successful agent money action in the audit log, an agent ID in a human-only column (wallet deposits, wallet refunds, payout requests), and a tool run outside the eight tools.

- Run it on demand with `POST /v1/admin/agentic/integrity-check` (operators and supervisors).
- The sweep also queues one `agent_integrity_check` job per tenant every 24 hours.
- It reads data and only writes notifications, so it is safe to repeat.

Each violation sends one `agent_integrity_violation` admin notification that names the record. Treat it as an incident:

1. Stop approving money movement for the tenant.
2. Open the named record and find who or what wrote it, using the event stream and the `audit_logs` table.
3. Suspend the agent involved if it is still active (see [Manage agents](#manage-agents)).
4. Report it to the engineers. Do not edit the ledger to make the notification go away.

### Agentic settings

Set these in the environment. The defaults come from the code.

| Variable                         | Default  | Meaning                                                         |
| -------------------------------- | -------- | --------------------------------------------------------------- |
| `MANDATE_MAX_LIFETIME_DAYS`      | `30`     | Longest life a mandate can have                                 |
| `WATCHDOG_INTERVAL_MS`           | `300000` | How often the detectors run                                     |
| `HOLD_RATE_LIMIT`                | `20`     | Limit on holds placed through the agent operation               |
| `HELD_ACCRUAL_MAX_DAYS`          | `14`     | Days a verified delivery may stay held before you are notified  |
| `PROPOSAL_TTL_HOURS`             | `24`     | Hours before an undecided proposal expires                      |
| `PROPOSAL_RATE_LIMIT`            | `30`     | Limit on proposals filed                                        |
| `PROPOSAL_MAX_BYTES`             | `65536`  | Largest proposal accepted                                       |
| `ANALYTICS_TIMEOUT_MS`           | `10000`  | Time allowed for one analytics query                            |
| `INTENT_ROW_LIMIT`               | `1000`   | Most rows one intent returns                                    |
| `NL_QUESTION_RATE_LIMIT`         | `20`     | Limit on plain-language questions                               |
| `AGENT_TOOL_RATE_LIMIT`          | `120`    | Limit on tool calls per principal                               |
| `AGENTIC_DAILY_MODEL_BUDGET_USD` | `2`      | Daily model spend allowed for agentic features                  |

Each must be a number of at least 1. An invalid value stops the feature that reads it with an error naming the variable.

### Verify the agentic features

```
npm run verify:agentic
```

It runs five parts in order: `verify:agentic-boundary` (no agent path reaches a money action), `verify:agentic-concurrency` (parallel requests cannot overspend a mandate), `verify:agentic-injection` (hostile text in data is not obeyed), `verify:agentic-secrets` (no secret leaks) and `verify:agentic-invariants` (accounting and state rules hold).

The concurrency part needs real PostgreSQL row locks. Without `DATABASE_URL` it prints a skip message and exits 0, which is a skip and not a pass. To run it, set `DATABASE_URL` in your shell to a disposable database, one you can wipe. Never point it at a shared, staging or production database.

## Known limitations

- **Human steps:** a buyer must approve each order at PayPal, and payout confirmation depends on PayPal and the recipient. These steps are not automated.
- **Sandbox is not production:** a Sandbox GO for Payouts does not prove production approval, marketplace compliance, limits or recipient onboarding.
- **Recipients:** EMAIL recipients only.
- **Marketplace:** services are visible only inside their own organization.
- **Passwords:** no self-service reset or email verification; operators are reset with `admin:create`.
- **Rate limits:** held in each server's memory; several API instances each keep their own counts.
- **Sessions:** tokens cannot be revoked individually; suspending an agent works because every request re-checks it.

- **Provider error logging (AS-N1):** provider error text is logged verbatim. If a model provider echoes a credential in an error message, the server log would print it. Stoat never adds the key itself, but redact provider errors before you rely on the logs. `npm run verify:agentic-secrets` reports this as AS-N1.
- **Analytics filters:** the filters in Payments Analytics are applied in the browser to the rows already loaded, not by the server. A filtered view of a capped result can hide rows beyond `INTENT_ROW_LIMIT`.
- **Flags on PGlite:** feature flags reset on restart when you use the embedded database.

## Troubleshooting

| Symptom                                                                                          | Likely cause                                                             | Fix                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Operator cannot sign in                                                                          | Account missing or locked                                                | Run `admin:create` again                                                                                                                  |
| Everyone is rate limited                                                                         | Proxy not trusted                                                        | Set `TRUST_PROXY_HOPS=1`                                                                                                                  |
| "session expired" again and again                                                                | `JWT_SECRET` changed between deploys                                     | Keep it stable                                                                                                                            |
| Console cannot reach the API                                                                     | `VITE_API_BASE_URL` missing or wrong                                     | Set it and redeploy the console                                                                                                           |
| "The API ... has no ... route" or `HTTP 404` on new screens, `/v1/health` reports an old version | The API was started from an older build                                  | `npm run build`, then restart the API (`npm start`)                                                                                       |
| After paying, PayPal returns to a page that does not load (404 or "can't connect")               | The console is not running at the address it returns to                  | Start it with `npm run console` (it refuses to start if port 5173 is taken, so the address cannot drift); in production set `CONSOLE_URL` |
| Accepted deals never get a delivery                                                              | No job runner, `RUN_JOBS_IN_API=false` without a worker, or no model key | Run the worker or the API with jobs on; check `FIREWORKS_API_KEY`; read the dead job's error                                              |
| Server will not start: payment provider not allowed                                              | `PAYMENT_PROVIDER` is not `PAYPAL`                                       | Set it to `PAYPAL`                                                                                                                        |
| `LLM_NOT_CONFIGURED`                                                                             | No model key                                                             | Set `FIREWORKS_API_KEY`                                                                                                                   |
| `REPLAY_NOT_FOUND`                                                                               | `LLM_MODE=replay` and the prompt was never recorded                      | Use `LLM_MODE=record`                                                                                                                     |
| `AGENT_OUTPUT_INVALID`                                                                           | The model's answer failed the schema or the checks                       | Nothing was stored as a result; run it again                                                                                              |
| "PayPal has not approved this order yet"                                                         | The buyer has not approved at PayPal                                     | Approve, then capture again                                                                                                               |
| `PAYPAL_AUTH_FAILED`                                                                             | Wrong credentials, or Sandbox keys with a live host                      | Check the credentials and `PAYPAL_BASE_URL`                                                                                               |
| `PAYPAL_PAYOUTS_UNAVAILABLE`                                                                     | Payouts switched off or the spike has not passed                         | Run `npm run paypal:spike`, then set the two payout settings                                                                              |
| `PAYPAL_PAYOUTS_NOT_ENABLED`                                                                     | PayPal refused payouts for this app                                      | Enable Payouts on the REST app; payouts read as degraded until restart                                                                    |
| `PAYOUT_ACCOUNT_MISSING`                                                                         | A provider has no verified recipient                                     | Save and confirm one under **Pay providers**                                                                                              |
| Payout send refused after approval                                                               | A recipient, amount or obligation changed                                | Review the change, then approve again                                                                                                     |
| `BATCH_ALREADY_FUNDED`                                                                           | The buyer already paid at acceptance                                     | Use **Release funded payment**                                                                                                            |
| Batch stuck in reconciliation required                                                           | PayPal captured a different amount                                       | Investigate in the event stream; never edit the ledger to force a match                                                                   |
| `FEATURE_DISABLED` | The feature's flag is off for the tenant | Turn it on with `PUT /v1/agentic/flags/:flag` |
| An **Agentic commerce** entry is missing from the navigation | Flag off, or the role is not buyer, operator or supervisor | Check `GET /v1/agentic/capabilities` and set the flag |
| Flags are off again after a restart | Local PGlite database | Set them again, or use PostgreSQL |
| `FUNDING_MODE_BUSY` | An agreement is accepted, revision_requested or needs_review | Let those agreements finish, then switch again |
| `HOLD_ACTIVE` | A hold covers that reservation, item, batch or payout | Review the alert, then release the hold with a reason |
| `PROPOSAL_EXPIRED` or `PROPOSAL_INVALID` | Not decided within `PROPOSAL_TTL_HOURS`, or the facts changed | Ask the agent to file a new proposal |
| `SELF_APPROVAL` | You tried to decide a proposal you filed | Ask another operator or supervisor |
| Proposal stuck in `execution_failed` | The execution job failed three times | Read the notification and the job error, fix the cause, then file a new proposal |
| `MANDATE_STATE_CONFLICT` | The mandate is not in a state that allows the action | Read its status, and lift a suspension if that is the cause |
| `RATE_LIMITED` on an agent tool | Over `AGENT_TOOL_RATE_LIMIT` | Wait, or raise the limit |
| `MODEL_BUDGET_EXCEEDED` | Daily model budget used up | Wait for the next day or raise `AGENTIC_DAILY_MODEL_BUDGET_USD` |
| `ANALYTICS_TIMEOUT` | Query ran past `ANALYTICS_TIMEOUT_MS` | Narrow the date range |
| `agent_integrity_violation` notification | A record shows an agent touching money | Follow the steps under Integrity check |
| `verify:agentic-concurrency` says SKIPPED | `DATABASE_URL` is not set | Set it to a disposable PostgreSQL database in your shell |

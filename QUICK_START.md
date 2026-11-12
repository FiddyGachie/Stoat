# Quick start

This takes you from a fresh clone to a running Stoat, signed in, and then through a first pass at the agentic commerce features (Mandates, the Approval Inbox, Payments Analytics). Plan on ten minutes for the first part. The walkthrough at the end takes longer because it needs PayPal Sandbox keys and a model key.

If something breaks, the [Troubleshooting](#troubleshooting) section covers what we and our testers have actually hit.

## What you're about to run

Two processes run side by side on your machine:

| Part    | What it is                                         | Address               |
| ------- | -------------------------------------------------- | --------------------- |
| API     | The server: agents, missions, ledger, PayPal calls | http://localhost:3000 |
| Console | The web app you click around in                    | http://localhost:5173 |

You don't need to install a database. If `DATABASE_URL` is empty, the API uses PGlite, an embedded Postgres that lives in memory and gets filled with demo data on every start. That's convenient and also the thing to remember: restart the API and your missions are gone.

## 1. Prerequisites

- Node.js 20 or newer. `.node-version` pins `20.18.0`, and `package.json` says `>=20.0.0`. Check with `node -v`. Node 18 won't work.
- Git.
- npm, which comes with Node. The scripts all use npm. (There's a `pnpm-lock.yaml` in the repo, but `package-lock.json` is what we use.)
- Docker is optional. You only need it if you want a real Postgres instead of PGlite.

## 2. Clone and install

```bash
git clone https://github.com/FiddyGachie/Stoat.git
cd Stoat
npm install
```

It takes a minute or two. You may see a warning like `Unknown project config "node-linker"`. It comes from a pnpm setting in `.npmrc` and you can ignore it.

## 3. Environment setup

```bash
# macOS / Linux / Git Bash
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

`.env` is git-ignored. Don't commit it. Open it and make one change for the easiest start, which is to leave `DATABASE_URL` empty:

```ini
DATABASE_URL=
```

(If you leave a Postgres URL in there and nothing is listening, the API waits about 10 seconds, prints a warning, and falls back to PGlite.)

Here are the variables you're likely to touch. `.env.example` has comments for the rest.

| Variable                                                     | What it's for                                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                               | Empty means PGlite. Set it to use your own Postgres                                                                    |
| `JWT_SECRET`                                                 | Signs login tokens. Set your own value anywhere that isn't a throwaway local run                                       |
| `LLM_PROVIDER`                                               | `fireworks` (default) or `anthropic`                                                                                   |
| `FIREWORKS_API_KEY`                                          | Key for Fireworks AI, from https://fireworks.ai/account/api-keys                                                       |
| `LLM_API_KEY`                                                | Key to use if `LLM_PROVIDER=anthropic`                                                                                 |
| `LLM_MODEL_AGENT`                                            | Which model the agents use                                                                                             |
| `LLM_MODE`                                                   | `live`, `record` or `replay` (see below)                                                                               |
| `AGENT_MAX_STEPS`, `AGENT_MAX_SECONDS`, `AGENT_MAX_COST_USD` | Per-run limits for agents                                                                                              |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`                   | Sandbox app credentials                                                                                                |
| `PAYPAL_BASE_URL`                                            | `https://api-m.sandbox.paypal.com` for Sandbox                                                                         |
| `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL`, `CONSOLE_URL`      | Where PayPal sends the buyer back                                                                                      |
| `PAYPAL_WEBHOOK_ID`                                          | Set after you register a webhook (`npm run paypal:webhook`)                                                            |
| `REQUIRE_FUNDING`                                            | If true, providers can't deliver until the buyer has paid through PayPal                                               |
| `PAYMENT_PROVIDER`                                           | Has to be PayPal. Any other value stops the server at startup                                                          |
| `PAYPAL_PAYOUTS_ENABLED`, `PAYPAL_PAYOUTS_CAPABILITY_STATUS` | Payouts stay off until `npm run paypal:spike` passes for your app                                                      |
| `RECIPIENT_ENCRYPTION_KEY`                                   | Encrypts provider PayPal recipients at rest. At least 32 random characters, required in production, and keep it stable |
| `DEFAULT_FUNDING_MODE`                                       | `direct` or `wallet` for new tenants                                                                                   |

### The model key

Stoat's agents call a real model. There's no canned fallback. If you haven't set a key, anything that needs a model (negotiation, the provider's code review, insights, questions) fails with `LLM_NOT_CONFIGURED`. The rest of the console still works, so you can click around without a key, but you won't get quotes negotiated or reviews done.

```ini
LLM_PROVIDER=fireworks
FIREWORKS_API_KEY=<your key>
```

`LLM_MODE=record` calls the model live and stores the request hash and response. `replay` serves only stored answers and fails on a prompt it hasn't seen. If you're running in the default way, leave it alone.

### PayPal Sandbox

PayPal is the only payment rail, and there's no fake mode. Payment steps need Sandbox keys.

1. Sign in at https://developer.paypal.com, open Apps & Credentials, pick Sandbox, and create an app (or open the default one).
2. Copy the Client ID. Then click Show under Secret key and copy that. They're two different values, and mixing them up is the most common setup mistake.
3. Put them in `.env`:

```ini
PAYPAL_CLIENT_ID=<sandbox client id>
PAYPAL_CLIENT_SECRET=<sandbox secret>
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
PAYPAL_RETURN_URL=http://localhost:3000/v1/paypal/return
PAYPAL_CANCEL_URL=http://localhost:3000/v1/paypal/cancel
CONSOLE_URL=http://localhost:5173
```

4. When PayPal asks you to approve a payment, sign in with a Sandbox personal (buyer) account from Sandbox, then Accounts in the developer dashboard. Don't use your real PayPal login.

`PAYPAL_BASE_URL` has to be the API host `api-m.sandbox.paypal.com`, not the website `sandbox.paypal.com`. Settings are read once at startup, so restart the API after you edit `.env`.

## 4. Database

Pick one.

PGlite (the default). Do nothing. Leave `DATABASE_URL` empty. Migrations and demo data run on every start.

Your own Postgres. The repo has a `docker-compose.yml` for Postgres 16:

```bash
docker compose up -d          # localhost:5432, user stoat, password stoatpassword, database stoat
```

Then in `.env`:

```ini
DATABASE_URL=postgresql://stoat:stoatpassword@localhost:5432/stoat
```

If you use a hosted database like Supabase, use the session pooler or the direct connection on port 5432. The transaction pooler on port 6543 is meant for short-lived serverless functions, and it makes a long-running API hang.

## 5. Migrations

The API applies migrations when it starts. You'll see `[Startup] Migrations complete.` in its output. If you'd rather run them yourself:

```bash
npm run migrate:dev           # from source
npm run migrate               # from the build in dist/
```

## 6. Run the server and the console

Two terminals.

Terminal 1, the API:

```bash
npm run dev
```

Wait for lines like these:

```
[Startup] No DATABASE_URL — using embedded PGlite.
[Startup] Migrations complete.
[Startup] Seed data inserted (local PGlite).
[Startup] Demo logins ready: buyer@demo.stoat.local / admin@demo.stoat.local (see TEST_ACCOUNTS.md).
[Startup] Listening on 0.0.0.0:3000
```

Terminal 2, the console:

```bash
npm run console
```

Open http://localhost:5173. The API restarts on its own when you change code. For a production-style run use `npm run build` and then `npm start`.

## 7. Seed data and demo accounts

On PGlite the demo organisation and logins are created automatically on every start. On your own Postgres run this once (it's safe to repeat):

```bash
npm run seed:demo
```

The logins, including the buyer, the admin and the two demo agents, are in [TEST_ACCOUNTS.md](TEST_ACCOUNTS.md). We don't copy them here so there's one place to keep them current. Start with the buyer. Use the admin when a step says "operator". They're demo-only and are never created when `NODE_ENV=production` (or when `DEMO_ACCOUNTS=false`).

To make a real operator account on a real database: `npm run admin:create`.

A first tour, no keys needed beyond a model key:

1. In Missions, create a mission with a title, a short brief and a budget such as `5.00`.
2. Request a quote from "AI Deep Code Review". It shows up under the mission with a price.
3. Accept it. The provider agent starts reviewing the code fixture. Without a model key you'll see the `LLM_NOT_CONFIGURED` error. With one, results arrive in about a minute.
4. When the work is verified the mission completes by itself and a notification arrives. Findings are kept in the results archive.

The demo organisation starts in direct funding mode, so this works without PayPal keys until you reach a step that needs a payment.

## 8. Turn on the agentic features

The agentic commerce features are off for every tenant by default. An operator or supervisor switches them on per tenant. The flags are `mandates`, `watchdog`, `watchdog_explanations`, `proposals`, `payments_analytics`, `insights` and `nl_questions`. Until a flag is on, the matching workspace doesn't appear in the console nav.

The simplest way is a few API calls as the demo admin. Take the admin's email and password from TEST_ACCOUNTS.md.

```bash
# macOS / Linux / Git Bash
API=http://localhost:3000
TOKEN=$(curl -s -X POST $API/v1/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.stoat.local","password":"<from TEST_ACCOUNTS.md>"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).access_token")

for f in mandates watchdog proposals payments_analytics insights nl_questions; do
  curl -s -X PUT $API/v1/agentic/flags/$f -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{"enabled":true}'
done
curl -s $API/v1/agentic/capabilities -H "Authorization: Bearer $TOKEN"
```

```powershell
# Windows PowerShell
$api = 'http://localhost:3000'
$t = (Invoke-RestMethod -Method Post "$api/v1/auth/login" -ContentType 'application/json' `
  -Body (@{ email = 'admin@demo.stoat.local'; password = '<from TEST_ACCOUNTS.md>' } | ConvertTo-Json)).access_token
foreach ($f in 'mandates','watchdog','proposals','payments_analytics','insights','nl_questions') {
  Invoke-RestMethod -Method Put "$api/v1/agentic/flags/$f" -ContentType 'application/json' `
    -Headers @{ Authorization = "Bearer $t" } -Body '{"enabled":true}'
}
```

Flags are stored per tenant and read on each request, so there's nothing to restart. On PGlite they reset when the API restarts, so you'll repeat this after every restart. Adding `watchdog_explanations` turns on model-written alert explanations.

### Wallet mode

Mandates spend from a wallet, because accepting a quote under a Mandate creates a reservation. So the walkthrough below needs the organisation in wallet mode and a funded wallet, and funding needs the PayPal Sandbox keys from step 3. Switch the demo organisation (same admin token as above):

```bash
curl -s -X PUT $API/v1/admin/funding-mode -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"funding_mode":"wallet"}'
```

```powershell
Invoke-RestMethod -Method Put "$api/v1/admin/funding-mode" -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $t" } -Body '{"funding_mode":"wallet"}'
```

On PGlite this resets on restart as well. To switch an existing tenant on a real database, `.env.example` points at `npx tsx scripts/wallet/enable-wallet-mode.ts` (a dry run) and `--apply`.

## 9. A guided first walkthrough

You need: PayPal Sandbox keys, a model key, the flags above, and wallet mode.

1. Fund the wallet. Sign in as the buyer. Open Payments Dashboard, then Set mission spend, or Wallet, then Add funds. Approve the deposit in PayPal Sandbox with a Sandbox personal account.

2. Create a Mandate. Open Mandates and use "Sign a new Mandate". Set a per-agreement maximum, a daily cap and a total cap (in that order of size, because the server rejects a per-agreement max above the daily cap or a daily cap above the total cap). Choose allowed categories from your services, such as `code_review`, and an expiry. Terms can't be edited after signing, so if you get it wrong you revoke and sign a new one. Through the API it's `POST /v1/mandates` with `per_agreement_max`, `daily_cap`, `total_cap`, `allowed_categories`, `expires_at`, and optionally `currency` and `mission_scope`.

3. Post a mission and get a quote. As the buyer, create a mission and request a quote from "AI Deep Code Review", as in the first tour. Keep the quote under the Mandate's caps.

4. Let the buyer agent accept. Acceptance under a Mandate is an agent action, not a console button. The route is `POST /v1/missions/:id/mandate-selection`, and it only works for a buyer agent principal. Sign the demo buyer agent in with the Agent ID and secret from TEST_ACCOUNTS.md (`POST /v1/auth/agent/login` with `agent_id` and `secret`), then call the route with the Mandate ID and an `Idempotency-Key` header:

```bash
curl -s -X POST $API/v1/missions/<mission-id>/mandate-selection \
  -H "Authorization: Bearer <agent token>" -H "Idempotency-Key: walkthrough-1" \
  -H "Content-Type: application/json" -d '{"mandate_id":"<mandate-id>"}'
```

The model picks a quote, and then deterministic code checks it against the Mandate (status, expiry, per-agreement max, total, daily cap, category, mission scope, currency, available balance). If any check fails, nothing is created, the quote stays open, and you can still accept it yourself. Back in Mandates, the detail view shows the usage bars move and the linked reservation and agreement.

5. Approve a Proposal. Open the Approval Inbox. Proposals come from agents with the treasury or budget role (for example a top-up suggestion when the wallet runs low, or a payout batch), or from an external agent calling the `propose_*` tools. The demo accounts only include a buyer agent and a provider agent, so a fresh install may well show an empty inbox. That's expected, not a fault. When there is a pending Proposal, open it, add a comment (required to reject, and to approve a top-up suggestion), and approve or reject. Nothing an agent drafts moves money until you decide, and approval runs through the existing services, which recompute the amounts.

6. Look at Payments Analytics. Open it, pick a date range, and look at the spend grids and the per-currency charts. Each chart has a data table. Click a bar or a row to cross-filter the other panels, and clear the chip to go back. Mandate utilization shows usage against caps.

7. Ask a question. In Payments Analytics, use the question box (needs the `nl_questions` flag and a model key). Try "Which mandates are closest to their cap?" or "Show open alerts". The model maps your question to one fixed read intent (or says it's unsupported), and the server runs it with your own scope. You can also generate the written Insight for the same range.

## 10. Running tests and verifiers

```bash
npm test                      # Vitest suite, no keys needed, takes a few minutes
npx tsc --noEmit              # type-check the server
npm run console:typecheck     # type-check the console
npm run verify:wallet         # wallet journey, accounting, isolation (offline)
npm run verify:agentic        # boundary, concurrency, injection, secrets, invariants
npm run verify:ui             # console UI checks
npm run check                 # type checks, tests and verify (verify calls PayPal Sandbox)
```

Verifiers write JSON reports to `.agents/reports/`. `npm run verify:wallet-reconciliation` needs the Sandbox keys, refuses to run against Live, and isn't part of `verify`. `verify:agentic-secrets` ends with a note (AS-N1) about provider errors being logged verbatim. It's a note rather than a failure, and it's described under Known limitations in the [README](README.md#known-limitations).

## Troubleshooting

| What you see                                                                            | What to do                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[vite] http proxy error ... ECONNREFUSED` in terminal 2                                | The API isn't running. Start it in terminal 1 and wait for "Listening on 0.0.0.0:3000".                                                                                                                                                                                                                                                                                                                                       |
| Sign-in says the email or password is wrong                                             | Use the exact values in TEST_ACCOUNTS.md. With your own Postgres, run `npm run seed:demo`.                                                                                                                                                                                                                                                                                                                                    |
| Missions, flags or wallet mode vanished after a restart                                 | Expected on PGlite, which is in memory. Use Postgres (step 4) to keep data.                                                                                                                                                                                                                                                                                                                                                   |
| `LLM_NOT_CONFIGURED`                                                                    | Set a model key (`FIREWORKS_API_KEY`, or `LLM_PROVIDER=anthropic` with `LLM_API_KEY`) and restart the API.                                                                                                                                                                                                                                                                                                                    |
| `PAYPAL_NOT_CONFIGURED` or `PAYPAL_AUTH_FAILED`                                         | Check you used two different values from a Sandbox app, and that `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`. Restart the API.                                                                                                                                                                                                                                                                                         |
| PayPal shows "Things don't appear to be working at the moment"                          | Sign in with a Sandbox personal account, try a private window, or wait a few minutes. Sandbox has outages.                                                                                                                                                                                                                                                                                                                    |
| The Mandates, Approval Inbox, Payments Analytics or Watchdog workspace isn't in the nav | Its flag is off for this tenant, or you're signed in with a role that can't use it (buyers, operators and supervisors can). See step 8.                                                                                                                                                                                                                                                                                       |
| A feature call returns a "feature disabled" error                                       | Same cause: turn the flag on with `PUT /v1/agentic/flags/:flag`.                                                                                                                                                                                                                                                                                                                                                              |
| The mandate-selection call is refused                                                   | It only works for a buyer agent principal, not for a person. Sign the agent in with `/v1/auth/agent/login`. Otherwise read the refusal code: `MANDATE_EXPIRED`, `MANDATE_PER_AGREEMENT_EXCEEDED`, `MANDATE_TOTAL_EXCEEDED`, `MANDATE_DAILY_EXCEEDED`, `MANDATE_CATEGORY_NOT_ALLOWED`, `MANDATE_MISSION_OUT_OF_SCOPE`, `MANDATE_CURRENCY_MISMATCH`, `MANDATE_NOT_ACTIVE` or `INSUFFICIENT_FUNDS` tell you which limit was hit. |
| Switching to wallet mode is refused with `FUNDING_MODE_BUSY`                            | The tenant still has agreements in an open state. Finish or cancel them, then try again.                                                                                                                                                                                                                                                                                                                                                    |
| Payouts don't send                                                                      | They're off until `npm run paypal:spike` passes and `PAYPAL_PAYOUTS_ENABLED` is set, and a provider recipient must be set.                                                                                                                                                                                                                                                                                                    |
| A hold is blocking delivery accrual                                                     | Verified work is queued as a held accrual until a person releases the hold in the Watchdog workspace, with a reason.                                                                                                                                                                                                                                                                                                          |
| Port 3000 or 5173 is already in use                                                     | Stop the other program. The console expects the API on 3000.                                                                                                                                                                                                                                                                                                                                                                  |
| `npm install` fails                                                                     | Check `node -v`. You need 20 or newer.                                                                                                                                                                                                                                                                                                                                                                                        |
| Pages show "Loading…" for a long time against a hosted database                         | Use the session pooler or direct connection on port 5432 (step 4).                                                                                                                                                                                                                                                                                                                                                            |

## Where to go next

- [README.md](README.md): what Stoat is, the payments model and the Money_Boundary.
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) and [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md).
- [ARCHITECTURE.md](ARCHITECTURE.md) and [API_SPEC.yaml](API_SPEC.yaml) (also served at `/v1/openapi.yaml`).

# Stoat

**AI agents that hire each other, prove the work, and pay through PayPal.**

Stoat is a marketplace where a *buyer agent* hires *provider agents* to do a job (today: a code
review), a deterministic verifier checks the work against evidence, and money moves only through
**PayPal**, with a person approving every payment and payout. Every step is recorded in a
double-entry ledger and an append-only event log, so you can see exactly what happened and why.

> **New here? Start with [QUICK_START.md](QUICK_START.md).** It gets you from `git clone` to a
> running app, signed in with a ready-made test account, in about ten minutes. No database and no
> API keys are needed for a first look. The test logins are in [TEST_ACCOUNTS.md](TEST_ACCOUNTS.md).

## What you can do with it

- **Post a mission** with a budget, request quotes from providers, and let your **buyer agent
  negotiate**: it compares offers with a real model and may counteroffer. Code checks every number.
- **Accept** a deal. In *wallet* mode the price is **reserved from your approved budget**; in
  *direct* mode the agreement is paid with its own PayPal checkout.
- Watch the **provider agent** do the work. A **deterministic verifier** accepts or rejects every
  finding; rejected work can be revised.
- Verified work creates one **obligation** and charges the reservation. The mission **completes by
  itself** and you get a notification with the results.
- **Edit or delete** open missions, **replay** completed ones at half the last price (your agent
  negotiates toward it), and browse the **results archive**, a permanent record of every verified
  result.
- As an **Admin**: approve settlement batches, release funds, send PayPal payouts to providers,
  reconcile Stoat against PayPal, and read the business account and trial balance.

## How money works (honest version)

- **PayPal is the only payment rail.** Collections use PayPal Orders v2; provider payouts use PayPal
  Payouts. There is no simulated payment mode: without PayPal keys, payment steps say so.
- **The wallet is a ledger record.** Approved budgets and deposits are held in the platform's PayPal
  business account; your wallet balance is Stoat's accounting of your share. Stoat does not offer
  escrow, and PayPal provides no escrow API to applications.
- **Agents can't move money.** No agent, on any interface, can approve or send a payment or payout,
  capture or refund, or set who is paid. Agents may only restrict (reject, flag, request review).
- **PayPal decides what was paid.** Stoat records PayPal-confirmed facts, not agent claims.

## Run it

The short version (details, options and troubleshooting are in [QUICK_START.md](QUICK_START.md)):

```bash
git clone https://github.com/FiddyGachie/Stoat.git
cd Stoat
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
#   then set DATABASE_URL= (empty) in .env to use the built-in database
npm run dev                 # terminal 1: the API on http://localhost:3000
npm run console             # terminal 2: the console on http://localhost:5173
```

Open http://localhost:5173 and sign in as `buyer@demo.stoat.local` / `StoatDemo-2026!`.

To unlock the AI agents add a Fireworks (or Anthropic) key; to unlock payments add PayPal **Sandbox**
app keys. Both are explained step by step in the quick start.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the API (restarts on code changes) |
| `npm run console` | Start the console (web app) |
| `npm test` | Run the test suite (no keys needed) |
| `npx tsc --noEmit` / `npm run console:typecheck` | Type-check the server / the console |
| `npm run verify:wallet` | Offline checks of wallet journeys, accounting and isolation |
| `npm run check` | Everything, including PayPal Sandbox calls (needs PayPal keys) |
| `npm run seed:demo` | Add the demo organisation and test logins to your own Postgres |
| `npm run admin:create` | Create a real operator account |
| `npm run build` then `npm start` | Production build and start |

## Project layout

| Folder | What's in it |
|---|---|
| `src/` | The API: Express modules for agents, missions, quotes, agreements, deliveries, verification, ledger, wallet, PayPal, MCP |
| `console/` | The React + Vite web console (AG Grid, AG Charts) |
| `src/db/migrations/` | SQL migrations, applied automatically at startup |
| `tests/` | Vitest unit and integration tests |
| `scripts/` | Verifiers, demo and admin tools, docs build |
| `fixtures/` | The code the provider agent reviews |
| `docs/` | User and admin guides (also served inside the console) |
| `API_SPEC.yaml` | The HTTP API (OpenAPI 3.1), served at `/v1/openapi.yaml` |

## Stack

TypeScript throughout. Express modular monolith on PostgreSQL (embedded PGlite for local use) with
a jobs-table worker. React + Vite console. PayPal Server SDK for Orders and refunds, PayPal REST for
Payouts and webhook verification. Fireworks AI (`gpt-oss-120b` by default) or Anthropic through one
adapter with live, record and replay modes. A minimal MCP server for external agents, with no
payment tools.

## Documentation

- [QUICK_START.md](QUICK_START.md): install, configure, run, troubleshoot.
- [TEST_ACCOUNTS.md](TEST_ACCOUNTS.md): ready-made demo logins.
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md): for organisation owners and agent developers.
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md): operators, configuration, deployment, troubleshooting.
- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit together.
- [API_SPEC.yaml](API_SPEC.yaml): the API contract.

## Deploy

`render.yaml` is a Render Blueprint (database, API, worker, console) and `vercel.json` serves the
console and API together on Vercel. Settings and their order are in the admin guide. Demo test
accounts are never created when `NODE_ENV=production`.

## Limits worth knowing

- A buyer approves each PayPal order, and payout completion depends on PayPal and the recipient.
  These human steps are not automated.
- A Sandbox result proves the API path in Sandbox only, not production approval for Payouts,
  marketplace compliance or recipient onboarding.
- Holding customer funds may be regulated where you operate; get legal advice before going live.

# Quick start

This guide takes you from a fresh clone to a running Stoat, signed in, in about ten minutes. It
assumes no prior knowledge of the project. If anything goes wrong, the
[Troubleshooting](#troubleshooting) section at the end covers the problems testers usually hit.

## What you are about to run

Stoat has two parts that run side by side on your machine:

| Part | What it is | Address |
|---|---|---|
| **API** | The server: agents, missions, ledger, PayPal calls. | http://localhost:3000 |
| **Console** | The web app you click around in. It talks to the API for you. | http://localhost:5173 |

You do **not** need a database to start: if none is configured, the API uses a built-in one
(PGlite) that lives in memory and is filled with demo data, including ready-made logins
(see [TEST_ACCOUNTS.md](TEST_ACCOUNTS.md)).

## 1. Install the tools (once)

- **Node.js 20 or newer** (20 LTS and 24 are both fine). Check with `node -v`.
  Get it from https://nodejs.org or with a version manager (nvm, nvm-windows, fnm, volta).
- **Git.** Check with `git --version`.
- **Optional:** Docker, only if you want a real Postgres instead of the built-in database.

npm comes with Node. You don't need pnpm; the commands below use npm.

## 2. Get the code and install dependencies

```bash
git clone https://github.com/FiddyGachie/Stoat.git
cd Stoat
npm install
```

`npm install` takes a minute or two. Warnings such as `Unknown project config "node-linker"` are
harmless; they come from a pnpm setting in `.npmrc`.

## 3. Create your settings file

Copy the example settings to `.env`:

```bash
# macOS / Linux / Git Bash
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

Open `.env` in an editor and make **one change** for the easiest start: empty the database line so
the built-in database is used.

```ini
DATABASE_URL=
```

(If you leave the example value and no Postgres is running, the API waits about 10 seconds, prints a
warning and falls back to the built-in database anyway.)

Everything else can stay as it is for a first look. The keys in
[step 6](#6-optional-unlock-the-ai-agents-and-paypal) unlock more of the app; add them whenever
you're ready.

## 4. Start it (two terminals)

**Terminal 1, the API:**

```bash
npm run dev
```

Wait until you see lines like:

```
[Startup] No DATABASE_URL — using embedded PGlite.
[Startup] Migrations complete.
[Startup] Seed data inserted (local PGlite).
[Startup] Demo logins ready: buyer@demo.stoat.local / admin@demo.stoat.local (see TEST_ACCOUNTS.md).
[Startup] Listening on 0.0.0.0:3000
```

**Terminal 2, the console:**

```bash
npm run console
```

Leave both running. The API restarts on its own when code changes.

## 5. Sign in and look around

Open **http://localhost:5173** and sign in as the demo buyer:

- Email: `buyer@demo.stoat.local`
- Password: `StoatDemo-2026!`

All demo logins, including the Admin and the two agents, are in [TEST_ACCOUNTS.md](TEST_ACCOUNTS.md).

A good first tour:

1. **Missions:** create a mission (title, short brief, a budget such as `5.00`).
2. **Request a quote** from "AI Deep Code Review". It appears under the mission with a price.
3. **Accept** the quote. The provider agent starts reviewing the code fixture. Without an AI key
   (step 6) the review cannot run and you'll see why; with a key, results arrive within a minute.
4. When the work is verified the mission completes by itself, a notification arrives (bell icon),
   and the findings are kept in the **Results archive** under your missions.
5. On a completed mission, try **Replay at half price**. On an open one, try **Edit** and **Delete**.
6. Sign in as `admin@demo.stoat.local` (Operator access) to see Settlement, the Business account
   and reconciliation.

## 6. Optional: unlock the AI agents and PayPal

Add these to `.env`, then stop the API (Ctrl+C) and start it again. Settings are only read at
startup.

### AI agents (negotiation, code review)

Stoat's agents use a real model; there is no canned fallback.

```ini
LLM_PROVIDER=fireworks
FIREWORKS_API_KEY=your-fireworks-key        # https://fireworks.ai/account/api-keys
```

(Or `LLM_PROVIDER=anthropic` with `LLM_API_KEY=...`.)

### PayPal Sandbox (payments, wallet deposits, refunds)

1. Sign in at https://developer.paypal.com, open **Apps & Credentials**, choose **Sandbox**, and
   create an app (or open the default one).
2. Copy the **Client ID**, then click **Show** under *Secret key* and copy the secret. They are two
   different values.
3. Put them in `.env`:

   ```ini
   PAYPAL_CLIENT_ID=your-sandbox-client-id
   PAYPAL_CLIENT_SECRET=your-sandbox-secret
   PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
   PAYPAL_RETURN_URL=http://localhost:3000/v1/paypal/return
   PAYPAL_CANCEL_URL=http://localhost:3000/v1/paypal/cancel
   CONSOLE_URL=http://localhost:5173
   ```

4. When PayPal asks you to approve a payment, sign in with a **Sandbox personal (buyer) account**
   from *Sandbox → Accounts* in the developer dashboard, not your real PayPal login.

`PAYPAL_BASE_URL` must be the API host `api-m.sandbox.paypal.com`, not the website
`sandbox.paypal.com`.

### Try the wallet

In **wallet** mode, an approved spending budget funds missions: accepting a quote reserves the price
from your wallet instead of opening PayPal per agreement, and you're told to top up when funds run
low. It needs the PayPal Sandbox keys above so you can fund the wallet.

With the API running, switch the demo organisation as the demo Admin:

```bash
# macOS / Linux / Git Bash
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.stoat.local","password":"StoatDemo-2026!"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).access_token")
curl -s -X PUT http://localhost:3000/v1/admin/funding-mode -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"funding_mode":"wallet"}'
```

```powershell
# Windows PowerShell
$t = (Invoke-RestMethod -Method Post http://localhost:3000/v1/auth/login -ContentType 'application/json' `
  -Body '{"email":"admin@demo.stoat.local","password":"StoatDemo-2026!"}').access_token
Invoke-RestMethod -Method Put http://localhost:3000/v1/admin/funding-mode -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $t" } -Body '{"funding_mode":"wallet"}'
```

Then, as the buyer, open **Payments Dashboard → Set mission spend** (or **Wallet → Add funds**),
approve in PayPal Sandbox, and accept quotes: they now say "Accept & reserve from wallet". On the
built-in database this setting resets when the API restarts.

## 7. Optional: use a real Postgres

```bash
docker compose up -d          # Postgres 16 on localhost:5432 (user stoat / stoatpassword)
```

In `.env`:

```ini
DATABASE_URL=postgresql://stoat:stoatpassword@localhost:5432/stoat
```

Start the API once so it creates the tables, then add the demo organisation and logins:

```bash
npm run seed:demo
```

Data now survives restarts. For a hosted database such as Supabase, use its **session pooler** or
direct connection (port **5432**), not the transaction pooler on 6543, which is meant for short-lived
serverless functions and makes a long-running API hang.

## Checking that everything works

```bash
npm test                  # the test suite (no keys needed; takes a few minutes)
npx tsc --noEmit          # type-check the server
npm run console:typecheck # type-check the console
npm run verify:wallet     # offline wallet checks: journeys, accounting, isolation
```

`npm run check` runs everything including `npm run verify`, which makes real PayPal Sandbox calls
and so needs the PayPal keys.

## Troubleshooting

| What you see | What to do |
|---|---|
| `[vite] http proxy error ... ECONNREFUSED` in terminal 2 | The API isn't running. Start it in terminal 1 and wait for "Listening on 0.0.0.0:3000". |
| Sign-in says the email or password is wrong | Use the exact values from [TEST_ACCOUNTS.md](TEST_ACCOUNTS.md). They are created on the built-in database automatically; with your own Postgres run `npm run seed:demo`. |
| My missions disappeared after a restart | Expected on the built-in database (it's in memory). Use Postgres (step 7) to keep data. |
| `LLM_NOT_CONFIGURED` when an agent should work | Add an AI key (step 6) and restart the API. |
| `PAYPAL_NOT_CONFIGURED` or `PAYPAL_AUTH_FAILED` | Check the PayPal keys: two different values, from a **Sandbox** app, and `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`. Restart the API after editing `.env`. |
| PayPal shows "Things don't appear to be working at the moment" | Sign in with a Sandbox *personal* account, try a private window, or wait a few minutes (Sandbox outages happen). |
| Port 3000 or 5173 is already in use | Stop the other program using it. The console expects the API on 3000. |
| `npm install` fails on Node 18 | Use Node 20 or newer. |
| Pages show "Loading…" for a long time against a hosted database | Use the session pooler or direct connection (port 5432), as described in step 7. |

## Where to go next

- [README.md](README.md): what Stoat is and how money moves.
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md): the full user guide (also in the console under *User guide*).
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md): configuration, deployment and operations.
- [API_SPEC.yaml](API_SPEC.yaml): the HTTP API (OpenAPI 3.1), also served at `/v1/openapi.yaml`.

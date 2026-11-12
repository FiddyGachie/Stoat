# Test accounts

These logins exist so you can try Stoat straight away, without signing up. They are **demo-only**
and **public**: they are created on *your own* machine, in *your own* local database, the first time
the API starts on the built-in database (no `DATABASE_URL`). They never exist in production, and they
are not anyone's real account.

| Who | Sign-in screen | Login | Password / secret |
|---|---|---|---|
| **Buyer** (owns the demo agents; use this one first) | Welcome back (email + password) | `buyer@demo.stoat.local` | `StoatDemo-2026!` |
| **Admin** (operator: settlement, business account, reconciliation) | Operator access (email + password) | `admin@demo.stoat.local` | `StoatDemo-2026!` |
| **Buyer agent** "BuyerAgent Alpha" | Agent sign in | Agent ID `00000000-0000-0000-0000-000000000010` | `stoat-demo-buyer-agent-secret-2026` |
| **Provider agent** "LLM Code Reviewer Provider" | Agent sign in | Agent ID `00000000-0000-0000-0000-000000000020` | `stoat-demo-provider-agent-secret-2026` |

## Where they come from

- **Built-in database (default):** created automatically every time `npm run dev` starts. The
  built-in database lives in memory, so everything you do is reset when the API restarts, and the
  demo logins are recreated.
- **Your own Postgres** (for example `docker compose up -d`): run `npm run seed:demo` once. It adds
  the demo organisation and these logins, and is safe to run again.
- **Turning them off:** set `DEMO_ACCOUNTS=false`. They are always off when `NODE_ENV=production`.

## Good to know

- The demo organisation starts in **direct** funding mode, so you can run the whole agent flow
  without PayPal keys. To try the **wallet** (approved budgets fund missions), see
  [QUICK_START.md](QUICK_START.md#try-the-wallet).
- Money only moves through **PayPal Sandbox**, with *your* Sandbox app keys. There is no fake money:
  without PayPal keys, payment steps say so instead of pretending.
- Please don't reuse these passwords anywhere else. They are printed here on purpose.

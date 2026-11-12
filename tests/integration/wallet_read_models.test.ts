// Task 16.1: statement, user account, wallet list, business account and trial balance routes
// (R9.13, R10.1 to R10.11). Uses WalletPayPalDouble: it proves Stoat's handling of stated PayPal
// responses, not PayPal's behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { RefundService } from "../../src/modules/wallet/refund.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const T2 = randomUUID();
const OWNER = randomUUID();
const OTHER = randomUUID();
const FOREIGN = randomUUID();
const ADMIN = SEED_IDS.userId; // seeded operator
const db = () => getDb();
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const user = (id: string) => as(`user:${id}`);
const agent = as(`agent:${SEED_IDS.buyerAgentId}`);
const q = async <R = any>(sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows as R[];

const principal = (id: string): AuthenticatedPrincipal => ({
  id,
  tenantId: T,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
});

describe("wallet read models", () => {
  let app: any;
  let paypal: WalletPayPalDouble;
  let walletId: string;

  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
  });
  afterAll(async () => {
    await closeDb();
  });
  beforeEach(async () => {
    await db().query(TRUNCATE_ALL);
    await db().query(
      `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`,
      [T, JSON.stringify({ funding_mode: "wallet" })],
    );
    await db().query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Other') ON CONFLICT DO NOTHING`,
      [T2],
    );
    for (const [id, tenant, email] of [
      [OWNER, T, "rm-o@x.test"],
      [OTHER, T, "rm-other@x.test"],
      [FOREIGN, T2, "rm-f@x.test"],
    ]) {
      await db().query(
        `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'buyer') ON CONFLICT (id) DO NOTHING`,
        [id, tenant, email],
      );
    }
    paypal = new WalletPayPalDouble();
    app = createApp({ gateway: paypal });
  });

  async function deposit(owner: string, amount: string) {
    const svc = new DepositService({ gateway: paypal });
    const v = await svc.createDeposit({
      tenantId: T,
      owner: principal(owner),
      amount,
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
    await svc.captureByOrder({
      orderId: v.paypal_order_id!,
      tenantId: T,
      source: "return",
    });
    return v;
  }
  const get = (url: string, who: Record<string, string>) =>
    dispatch(app, { method: "GET", url, headers: who });

  it("statement is ascending with a running balance that ends at the wallet balance", async () => {
    const d1 = await deposit(OWNER, "25.00");
    walletId = d1.wallet_id;
    await deposit(OWNER, "10.00");
    await new RefundService({ gateway: paypal }).refundUnlinked({
      tenantId: T,
      owner: principal(OWNER),
      walletId,
      amount: "5.00",
      idempotencyKey: `k-${randomUUID()}`,
    });

    const s = await get("/v1/wallet/statement?currency=USD", user(OWNER));
    expect(s.status).toBe(200);
    expect(
      s.body.lines.map((l: any) => [l.kind, l.amount, l.balance_after]),
    ).toEqual([
      ["deposit", "25", "25"],
      ["deposit", "10", "35"],
      ["refund", "-5", "30"],
    ]);
    expect(s.body.balance).toBe("30");
    expect(s.body.lines.at(-1).balance_after).toBe(s.body.balance);
    const wallet = await get("/v1/wallet", user(OWNER));
    expect(wallet.body.wallets[0].balance).toBe(s.body.balance);
    expect(JSON.stringify(s.body)).not.toMatch(
      /recipient|payee|payment_source/i,
    );

    const adminView = await get(
      `/v1/admin/wallets/${walletId}/statement`,
      user(ADMIN),
    );
    expect(adminView.status).toBe(200);
    expect(adminView.body.lines).toHaveLength(3);
  });

  it("a wallet with no movements gives an empty statement and zero balance", async () => {
    const s = await get("/v1/wallet/statement", user(OTHER));
    expect(s.status).toBe(200);
    expect(s.body.lines).toEqual([]);
    expect(s.body.balance).toBe("0");
  });

  it("user account shows the Owner's entries with PayPal IDs; Admin sees it; another buyer cannot", async () => {
    await deposit(OWNER, "25.00");
    const own = await get("/v1/wallet/account", user(OWNER));
    expect(own.status).toBe(200);
    const w = own.body.wallets[0];
    expect(w.wallet.balance).toBe("25");
    expect(w.deposits).toHaveLength(1);
    expect(w.deposits[0].paypal_order_id).toBeTruthy();
    expect(w.deposits[0].paypal_capture_id).toBeTruthy();

    const adminView = await get(
      `/v1/admin/users/${OWNER}/wallet-account`,
      user(ADMIN),
    );
    expect(adminView.status).toBe(200);
    expect(adminView.body.wallets[0].deposits[0].id).toBe(w.deposits[0].id);

    const denied = await get(
      `/v1/admin/users/${OWNER}/wallet-account`,
      user(OTHER),
    );
    expect(denied.status).toBe(403);
    // No wallet data leaks: no wallets/deposits payload and no money field carrying the
    // Owner's figure. (A bare "25" check is flaky: correlation IDs are random and can contain it.)
    expect(denied.body.wallets).toBeUndefined();
    expect(denied.body.deposits).toBeUndefined();
    expect(JSON.stringify(denied.body)).not.toMatch(
      /"(balance|amount|available|credited_amount|captured_amount)"\s*:\s*"?25(\.0+)?"?/,
    );
    expect(JSON.stringify(denied.body)).not.toContain(w.deposits[0].id);
    // The Owner's own account never shows another Owner's figures.
    expect((await get("/v1/wallet/account", user(OTHER))).body.wallets).toEqual(
      [],
    );
    // Cross-tenant user looks missing.
    expect(
      (await get(`/v1/admin/users/${FOREIGN}/wallet-account`, user(ADMIN)))
        .status,
    ).toBe(404);
  });

  it("wallet list: default 50, max 200, null last activity, tenant scoped, buyers refused", async () => {
    await deposit(OWNER, "25.00");
    await db().query(
      `INSERT INTO wallets (id, tenant_id, owner_user_id, currency, paypal_environment)
       VALUES (gen_random_uuid(), $1, $2, 'USD', 'sandbox')`,
      [T, OTHER],
    );
    await db().query(
      `INSERT INTO wallets (id, tenant_id, owner_user_id, currency, paypal_environment)
       VALUES (gen_random_uuid(), $1, $2, 'USD', 'sandbox')`,
      [T2, FOREIGN],
    );
    const list = await get("/v1/admin/wallets", user(ADMIN));
    expect(list.status).toBe(200);
    expect(list.body.wallets).toHaveLength(2);
    const idle = list.body.wallets.find((x: any) => x.owner_user_id === OTHER);
    expect(idle.last_activity_at).toBeNull();
    expect(
      list.body.wallets.some((x: any) => x.owner_user_id === FOREIGN),
    ).toBe(false);

    const paged = await get("/v1/admin/wallets?limit=1", user(ADMIN));
    expect(paged.body.wallets).toHaveLength(1);
    expect(paged.body.next_cursor).toBeTruthy();
    const next = await get(
      `/v1/admin/wallets?limit=1&cursor=${paged.body.next_cursor}`,
      user(ADMIN),
    );
    expect(next.body.wallets).toHaveLength(1);
    expect(next.body.wallets[0].id).not.toBe(paged.body.wallets[0].id);
    expect((await get("/v1/admin/wallets?limit=201", user(ADMIN))).status).toBe(
      400,
    );
    expect((await get("/v1/admin/wallets?limit=0", user(ADMIN))).status).toBe(
      400,
    );

    const denied = await get("/v1/admin/wallets", user(OWNER));
    expect(denied.status).toBe(403);
    expect(denied.body.wallets).toBeUndefined();
    // Cross-tenant wallet statement looks missing.
    const other = await q(`SELECT id FROM wallets WHERE tenant_id = $1`, [T2]);
    expect(
      (await get(`/v1/admin/wallets/${other[0].id}/statement`, user(ADMIN)))
        .status,
    ).toBe(404);
  });

  it("business account is derived from the ledger and raises one notification per distinct mismatch", async () => {
    await deposit(OWNER, "25.00");
    const r = await get("/v1/admin/business-account", user(ADMIN));
    expect(r.status).toBe(200);
    const usd = r.body.currencies.find((c: any) => c.currency === "USD");
    expect(usd.paypal_funds_received).toBe("25");
    expect(usd.wallet_balance_held).toBe("25");
    expect(usd.wallet_balance_sum).toBe("25");
    expect(usd.difference).toBe("0");
    const kind = "wallet_balance_mismatch";
    const notices = () =>
      q(
        `SELECT 1 FROM notifications WHERE tenant_id = $1 AND kind = $2 AND title = 'Business account mismatch'`,
        [T, kind],
      );
    expect(await notices()).toHaveLength(0);

    // Make the stored balance drift from the ledger; reading twice raises one notice per Admin.
    await db().query(
      `UPDATE wallets SET balance_cache = 20 WHERE tenant_id = $1`,
      [T],
    );
    const admins = (
      await q(
        `SELECT 1 FROM users WHERE tenant_id = $1 AND role IN ('operator','supervisor')`,
        [T],
      )
    ).length;
    const before = await q(`SELECT count(*)::int AS n FROM journal_lines`);
    const d1 = await get("/v1/admin/business-account", user(ADMIN));
    await get("/v1/admin/business-account", user(ADMIN));
    expect(d1.body.currencies[0].difference).toBe("5");
    expect(await notices()).toHaveLength(admins);
    expect(await q(`SELECT count(*)::int AS n FROM journal_lines`)).toEqual(
      before,
    );
    expect(
      await q(
        `SELECT balance_cache::text AS b FROM wallets WHERE tenant_id = $1`,
        [T],
      ),
    ).toEqual([{ b: "20.000000" }]);

    const denied = await get("/v1/admin/business-account", user(OWNER));
    expect(denied.status).toBe(403);
    expect(denied.body.currencies).toBeUndefined();
  });

  it("trial balance is balanced per currency and admin-only", async () => {
    await deposit(OWNER, "25.00");
    const r = await get("/v1/admin/trial-balance", user(ADMIN));
    expect(r.status).toBe(200);
    const usd = r.body.currencies.find((c: any) => c.currency === "USD");
    expect(usd.balanced).toBe(true);
    expect(usd.difference).toBe("0");
    expect(usd.total_debits).toBe(usd.total_credits);
    expect((await get("/v1/admin/trial-balance", user(OWNER))).status).toBe(
      403,
    );
  });

  it("refuses an agent on every read-model route with one audit row each", async () => {
    const urls = [
      "/v1/wallet/statement",
      "/v1/wallet/account",
      "/v1/admin/business-account",
      "/v1/admin/wallets",
      `/v1/admin/wallets/${randomUUID()}/statement`,
      `/v1/admin/users/${randomUUID()}/wallet-account`,
      "/v1/admin/trial-balance",
    ];
    for (const url of urls) {
      const before = (
        await q(
          `SELECT count(*)::int AS n FROM audit_logs WHERE outcome = 'refused'`,
        )
      )[0].n;
      const r = await get(url, agent);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code, url).toBe("FORBIDDEN_ACTION");
      const after = (
        await q(
          `SELECT count(*)::int AS n FROM audit_logs WHERE outcome = 'refused'`,
        )
      )[0].n;
      expect(after, url).toBe(before + 1);
    }
  });
});

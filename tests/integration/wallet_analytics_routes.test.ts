// Task 20.2: analytics routes (R14.8, R14.9, R14.12, R19.4, R19.11). Uses WalletPayPalDouble: it
// proves Stoat's handling of stated PayPal responses, not PayPal's behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import {
  ANALYTICS_CHARTS,
  ANALYTICS_DATASETS,
} from "../../src/modules/wallet/analytics.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const T2 = randomUUID();
const OWNER = randomUUID();
const OTHER = randomUUID();
const FOREIGN = randomUUID();
const ADMIN = SEED_IDS.userId;
const db = () => getDb();
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const user = (id: string) => as(`user:${id}`);
const agent = as(`agent:${SEED_IDS.buyerAgentId}`);
const q = async <R = any>(sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows as R[];
const refusals = async () =>
  (
    await q(
      `SELECT count(*)::int AS n FROM audit_logs WHERE outcome = 'refused'`,
    )
  )[0].n as number;

const principal = (id: string, tenantId = T): AuthenticatedPrincipal => ({
  id,
  tenantId,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
});

describe("wallet analytics routes", () => {
  let app: any;
  let paypal: WalletPayPalDouble;

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
      `INSERT INTO tenants (id, name) VALUES ($1, 'Other') ON CONFLICT DO NOTHING`,
      [T2],
    );
    for (const t of [T, T2])
      await db().query(
        `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`,
        [t, JSON.stringify({ funding_mode: "wallet" })],
      );
    for (const [id, tenant, email] of [
      [OWNER, T, "ar-o@x.test"],
      [OTHER, T, "ar-other@x.test"],
      [FOREIGN, T2, "ar-f@x.test"],
    ]) {
      await db().query(
        `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'buyer') ON CONFLICT (id) DO NOTHING`,
        [id, tenant, email],
      );
    }
    paypal = new WalletPayPalDouble();
    app = createApp({ gateway: paypal });
  });

  async function deposit(who: string, amount: string, tenant = T) {
    const svc = new DepositService({ gateway: paypal });
    const v = await svc.createDeposit({
      tenantId: tenant,
      owner: principal(who, tenant),
      amount,
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
    await svc.captureByOrder({
      orderId: v.paypal_order_id!,
      tenantId: tenant,
      source: "return",
    });
    return v;
  }
  const get = (url: string, who: Record<string, string>) =>
    dispatch(app, { method: "GET", url, headers: who });

  it("refuses an agent on every dataset, CSV and chart route with one audit row and no data", async () => {
    await deposit(OWNER, "25.00");
    const urls = [
      ...ANALYTICS_DATASETS.map((d) => `/v1/analytics/wallet/${d}`),
      ...ANALYTICS_DATASETS.map((d) => `/v1/analytics/wallet/${d}.csv`),
      ...ANALYTICS_CHARTS.map((c) => `/v1/analytics/wallet/charts/${c}`),
    ];
    for (const url of urls) {
      const before = await refusals();
      const r = await get(url, agent);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code, url).toBe("FORBIDDEN_ACTION");
      expect(r.body.rows, url).toBeUndefined();
      expect(r.body.points, url).toBeUndefined();
      expect(await refusals(), url).toBe(before + 1);
    }
    const row = (
      await q(
        `SELECT metadata FROM audit_logs WHERE outcome = 'refused' ORDER BY created_at DESC LIMIT 1`,
      )
    )[0];
    expect(JSON.stringify(row.metadata)).toContain("agent_principal");
  });

  it("an Owner gets only own rows; an Admin gets the tenant; another tenant gets nothing", async () => {
    const mine = await deposit(OWNER, "25.00");
    const theirs = await deposit(OTHER, "7.50");
    await deposit(FOREIGN, "99.00", T2);

    const own = await get("/v1/analytics/wallet/deposits", user(OWNER));
    expect(own.status).toBe(200);
    expect(own.body.dataset).toBe("deposits");
    expect(own.body.paypal_environment).toBeTruthy();
    expect(own.body.rows.map((r: any) => r.id)).toEqual([mine.id]);
    expect(own.body.rows[0].amount).toBe("25");
    expect(own.body.next_cursor).toBeNull();
    expect(JSON.stringify(own.body)).not.toMatch(
      /recipient|payee|payment_source|paypal_email/i,
    );

    const adm = await get("/v1/analytics/wallet/deposits", user(ADMIN));
    expect(adm.body.rows.map((r: any) => r.id).sort()).toEqual(
      [mine.id, theirs.id].sort(),
    );

    const foreign = await get("/v1/analytics/wallet/deposits", user(FOREIGN));
    expect(foreign.body.rows).toHaveLength(1);
    expect(foreign.body.rows[0].id).not.toBe(mine.id);
  });

  it("pages with a cursor, rejects a bad cursor and an unknown dataset or chart", async () => {
    await deposit(OWNER, "1.00");
    await deposit(OWNER, "2.00");
    await deposit(OWNER, "3.00");
    const p1 = await get(
      "/v1/analytics/wallet/deposits?limit=2",
      user(OWNER),
    );
    expect(p1.body.rows).toHaveLength(2);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await get(
      `/v1/analytics/wallet/deposits?limit=2&cursor=${p1.body.next_cursor}`,
      user(OWNER),
    );
    expect(p2.body.rows).toHaveLength(1);
    expect(p2.body.next_cursor).toBeNull();
    const ids = [...p1.body.rows, ...p2.body.rows].map((r: any) => r.id);
    expect(new Set(ids).size).toBe(3);

    expect((await get("/v1/analytics/wallet/deposits?cursor=!!", user(OWNER))).status).toBe(400);
    expect((await get("/v1/analytics/wallet/nope", user(OWNER))).status).toBe(404);
    expect((await get("/v1/analytics/wallet/charts/nope", user(OWNER))).status).toBe(404);
  });

  it("exports all authorized rows as CSV with a header, and charts return points", async () => {
    await deposit(OWNER, "25.00");
    await deposit(OTHER, "7.50");
    const csv = await get("/v1/analytics/wallet/deposits.csv", user(OWNER));
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["content-disposition"]).toMatch(/attachment/);
    const lines = String(csv.body).trim().split("\r\n");
    expect(lines[0]).toContain("amount");
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain("7.5");

    const chart = await get(
      "/v1/analytics/wallet/charts/deposit-status",
      user(OWNER),
    );
    expect(chart.status).toBe(200);
    expect(chart.body.chart).toBe("deposit-status");
    expect(chart.body.paypal_environment).toBeTruthy();
    expect(chart.body.points[0]).toMatchObject({
      status: "captured",
      amount: "25",
    });

    // Reconciliation is Admin business data: an Owner gets empty rows.
    const rec = await get(
      "/v1/analytics/wallet/reconciliation-exceptions",
      user(OWNER),
    );
    expect(rec.status).toBe(200);
    expect(rec.body.rows).toEqual([]);
  });
});

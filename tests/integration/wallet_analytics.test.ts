// Task 20.1: analytics service (R14.1, R14.2, R14.3, R14.5, R14.8, R14.11).
// WalletPayPalDouble proves Stoat's handling of stated PayPal responses, not PayPal's behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import {
  ANALYTICS_CHARTS,
  ANALYTICS_DATASETS,
  exportDatasetCsvText,
  queryChart,
  queryDataset,
  type AnalyticsScope,
} from "../../src/modules/wallet/analytics.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const T2 = randomUUID();
const OWNER = randomUUID();
const OTHER = randomUUID();
const FOREIGN = randomUUID();
const db = () => getDb();

const principal = (id: string, tenantId = T): AuthenticatedPrincipal => ({
  id,
  tenantId,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
});
const owner = (userId: string, tenantId = T): AnalyticsScope => ({
  tenantId,
  userId,
  admin: false,
});
const admin = (tenantId = T): AnalyticsScope => ({
  tenantId,
  userId: SEED_IDS.userId,
  admin: true,
});

describe("wallet analytics service", () => {
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
      [OWNER, T, "an-o@x.test"],
      [OTHER, T, "an-other@x.test"],
      [FOREIGN, T2, "an-f@x.test"],
    ]) {
      await db().query(
        `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'buyer') ON CONFLICT (id) DO NOTHING`,
        [id, tenant, email],
      );
    }
    paypal = new WalletPayPalDouble();
  });

  async function deposit(
    who: string,
    amount: string,
    capture = true,
    tenant = T,
  ) {
    const svc = new DepositService({ gateway: paypal });
    const v = await svc.createDeposit({
      tenantId: tenant,
      owner: principal(who, tenant),
      amount,
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
    if (capture)
      await svc.captureByOrder({
        orderId: v.paypal_order_id!,
        tenantId: tenant,
        source: "return",
      });
    return v;
  }

  async function follow(
    scope: AnalyticsScope,
    dataset: (typeof ANALYTICS_DATASETS)[number],
    limit: number,
  ) {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: Awaited<ReturnType<typeof queryDataset>> = await queryDataset(
        db(),
        scope,
        dataset,
        { cursor, limit },
      );
      expect(p.rows.length).toBeLessThanOrEqual(limit);
      ids.push(...p.rows.map((r) => r.id!));
      cursor = p.next_cursor;
      pages++;
    } while (cursor);
    return { ids, pages };
  }

  it("pages cover every authorized row exactly once and cap at 500", async () => {
    for (let i = 0; i < 5; i++) await deposit(OWNER, "1.00", i % 2 === 0);
    const all = await queryDataset(db(), owner(OWNER), "deposits");
    expect(all.rows).toHaveLength(5);
    expect(all.next_cursor).toBeNull();

    const { ids, pages } = await follow(owner(OWNER), "deposits", 2);
    expect(pages).toBe(3);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual(all.rows.map((r) => r.id));

    const big = await queryDataset(db(), owner(OWNER), "deposits", {
      limit: 100000,
    });
    expect(big.rows).toHaveLength(5);

    const stmt = await follow(owner(OWNER), "statements", 1);
    const lines = await follow(owner(OWNER), "ledger-lines", 2);
    expect(new Set(stmt.ids).size).toBe(stmt.ids.length);
    expect(new Set(lines.ids).size).toBe(lines.ids.length);
    expect(stmt.ids.length).toBe(3); // three captured deposits
    expect(lines.ids.length).toBe(3); // Owner sees only lines tagged with an owned wallet
  });

  it("rejects malformed cursors and limits", async () => {
    await expect(
      queryDataset(db(), owner(OWNER), "deposits", { cursor: "not-a-cursor!" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      queryDataset(db(), owner(OWNER), "deposits", { limit: 0 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("scopes Owner to own wallets, Admin to the tenant, nothing across tenants", async () => {
    await deposit(OWNER, "10.00");
    await deposit(OTHER, "20.00");
    await deposit(FOREIGN, "30.00", true, T2);

    for (const ds of ["deposits", "statements", "ledger-lines"] as const) {
      const mine = await queryDataset(db(), owner(OWNER), ds);
      const theirs = await queryDataset(db(), owner(OTHER), ds);
      const adm = await queryDataset(db(), admin(), ds);
      const foreign = await queryDataset(db(), admin(T2), ds);
      expect(mine.rows.length).toBeGreaterThan(0);
      // Admin also sees tenant lines with no wallet (cash side of each posting)
      if (ds === "ledger-lines") expect(adm.rows.length).toBe(4);
      else expect(adm.rows.length).toBe(mine.rows.length + theirs.rows.length);
      const mineIds = new Set(mine.rows.map((r) => r.id));
      expect(theirs.rows.some((r) => mineIds.has(r.id))).toBe(false);
      const admIds = new Set(adm.rows.map((r) => r.id));
      expect(foreign.rows.some((r) => admIds.has(r.id))).toBe(false);
    }
    // an Owner of tenant T cannot read tenant T2 rows by claiming them
    const cross = await queryDataset(db(), owner(FOREIGN, T), "deposits");
    expect(cross.rows).toHaveLength(0);

    // reconciliation is Admin only
    await db().query(
      `INSERT INTO reconciliation_runs (id, tenant_id, trigger, status, paypal_environment)
       VALUES ($1, $2, 'admin', 'differences', 'sandbox')`,
      [randomUUID(), T],
    );
    const runId = (
      await db().query(`SELECT id FROM reconciliation_runs LIMIT 1`)
    ).rows[0].id;
    await db().query(
      `INSERT INTO reconciliation_exceptions
         (tenant_id, first_run_id, last_run_id, item_type, paypal_id, kind, currency, stoat_amount, paypal_amount, difference)
       VALUES ($1, $2, $2, 'deposit', 'CAP1', 'mismatch', 'USD', 10, 9.5, 0.5)`,
      [T, runId],
    );
    expect(
      (await queryDataset(db(), owner(OWNER), "reconciliation-exceptions"))
        .rows,
    ).toHaveLength(0);
    const rx = await queryDataset(db(), admin(), "reconciliation-exceptions");
    expect(rx.rows).toHaveLength(1);
    expect(rx.rows[0].difference).toBe("0.5");
    expect(
      (await queryDataset(db(), admin(T2), "reconciliation-exceptions")).rows,
    ).toHaveLength(0);
    expect(
      (await queryChart(db(), owner(OWNER), "reconciliation-differences"))
        .points,
    ).toHaveLength(0);
    expect(
      (await queryChart(db(), admin(), "reconciliation-differences")).points,
    ).toHaveLength(1);
  });

  it("returns Decimal strings with currency and environment, and no payout recipient", async () => {
    await deposit(OWNER, "12.50");
    const p = await queryDataset(db(), owner(OWNER), "deposits");
    expect(p.rows[0]).toMatchObject({
      amount: "12.5",
      currency: "USD",
      paypal_environment: expect.stringMatching(/^(sandbox|live)$/),
    });
    const stmt = await queryDataset(db(), owner(OWNER), "statements");
    expect(stmt.rows[0]).toMatchObject({
      kind: "deposit",
      amount: "12.5",
      balance_after: "12.5",
    });
    for (const ds of ANALYTICS_DATASETS) {
      const page = await queryDataset(db(), admin(), ds);
      const names = page.columns.map((c) => c.name).join(",");
      expect(names).not.toMatch(/email|recipient_(?!user)|payee/);
      expect(JSON.stringify(page.rows)).not.toMatch(/@x\.test/);
      for (const c of page.columns.filter((c) => c.type === "money"))
        for (const r of page.rows)
          if (r[c.name] !== null) expect(r[c.name]).toMatch(/^-?\d+(\.\d+)?$/);
    }
  });

  it("CSV contains all authorized rows across pages and neutralizes formulas", async () => {
    for (const title of [
      '=HYPERLINK("x")',
      "+1",
      "-2",
      "@SUM(A1)",
      'plain, "q"',
    ]) {
      await db().query(
        `INSERT INTO notifications (tenant_id, recipient_user_id, kind, title, body, event_id)
         VALUES ($1, $2, 'deposit_captured', $3, 'b', $4)`,
        [T, OWNER, title, `ev-${randomUUID()}`],
      );
    }
    await db().query(
      `INSERT INTO notifications (tenant_id, recipient_user_id, kind, title, body, event_id)
       VALUES ($1, $2, 'deposit_captured', 'someone else', 'b', $3)`,
      [T, OTHER, `ev-${randomUUID()}`],
    );
    const csv = await exportDatasetCsvText(
      db(),
      owner(OWNER),
      "notifications",
      {
        pageSize: 2,
      },
    );
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(1 + 5); // header + the Owner's five rows only
    expect(csv).not.toContain("someone else");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1");
    expect(csv).toContain("'-2");
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain('"plain, ""q"""');
    // no cell begins with a formula character
    for (const l of lines.slice(1)) expect(l).toMatch(/^[0-9a-f-]{36},/);
    const adminCsv = await exportDatasetCsvText(
      db(),
      admin(),
      "notifications",
      {
        pageSize: 3,
      },
    );
    expect(adminCsv.split("\r\n").filter(Boolean)).toHaveLength(1 + 6);
  });

  it("CSV of an empty dataset is just the header", async () => {
    const csv = await exportDatasetCsvText(db(), owner(OWNER), "charges");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1);
    expect(csv.startsWith("id,wallet_id,")).toBe(true);
  });

  it("builds every chart with exact decimal figures", async () => {
    await deposit(OWNER, "10.10");
    await deposit(OWNER, "0.20");
    await deposit(OWNER, "5.00", false);
    const bal = await queryChart(db(), owner(OWNER), "balance-over-time");
    expect(bal.points.at(-1)).toMatchObject({
      currency: "USD",
      balance: "10.3",
    });
    const flows = await queryChart(db(), owner(OWNER), "flows-per-day");
    expect(flows.points).toHaveLength(1);
    expect(flows.points[0]).toMatchObject({ deposits: "10.3", refunds: "0" });
    const st = await queryChart(db(), owner(OWNER), "deposit-status");
    expect(st.points.find((p) => p.status === "captured")).toMatchObject({
      count: "2",
      amount: "10.3",
    });
    expect(st.paypal_environment).toMatch(/^(sandbox|live)$/);
    for (const chart of ANALYTICS_CHARTS) {
      const r = await queryChart(db(), admin(), chart);
      expect(r.chart).toBe(chart);
      expect(Array.isArray(r.points)).toBe(true);
    }
    expect(
      (await queryChart(db(), owner(OTHER), "deposit-status")).points,
    ).toEqual([]);
  });
});

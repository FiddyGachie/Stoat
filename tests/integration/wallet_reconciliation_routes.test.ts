// Task 17.2: reconciliation routes, the wallet_reconciliation job and its schedule
// (R11.8 to R11.11, R19.4). WalletPayPalDouble proves Stoat's handling of stated PayPal
// responses, not PayPal's behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { enqueueReconciliationJobs } from "../../src/modules/wallet/reconciliation.service.js";
import { runWalletSweep } from "../../src/modules/wallet/wallet.sweep.js";
import { runOneJob } from "../../src/jobs/runner.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const T2 = randomUUID();
const OWNER = randomUUID();
const ADMIN = SEED_IDS.userId; // seeded operator
const db = () => getDb();
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const user = (id: string) => as(`user:${id}`);
const agent = as(`agent:${SEED_IDS.buyerAgentId}`);
const q = async <R = any>(sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows as R[];

const owner: AuthenticatedPrincipal = {
  id: OWNER,
  tenantId: T,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
};

describe("reconciliation routes, job and schedule", () => {
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
    await db().query(`DELETE FROM jobs`);
    await db().query(
      `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`,
      [T, JSON.stringify({ funding_mode: "wallet" })],
    );
    await db().query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Other') ON CONFLICT DO NOTHING`,
      [T2],
    );
    await db().query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, 'rc-o@x.test', 'buyer') ON CONFLICT (id) DO NOTHING`,
      [OWNER, T],
    );
    paypal = new WalletPayPalDouble();
    app = createApp({ gateway: paypal });
  });

  async function deposit(amount: string) {
    const svc = new DepositService({ gateway: paypal });
    const v = await svc.createDeposit({
      tenantId: T,
      owner,
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
  const call = (
    method: "GET" | "POST",
    url: string,
    who: Record<string, string>,
  ) => dispatch(app, { method, url, headers: who });

  it("an Admin starts a run, then lists it and reads it with its exceptions", async () => {
    await deposit("25.00");
    const start = await call(
      "POST",
      "/v1/admin/reconciliation/runs",
      user(ADMIN),
    );
    expect(start.status).toBe(201);
    expect(start.body.status).toBe("clean");
    expect(start.body.counts.captures).toBe(1);
    expect(start.body.exceptions).toEqual([]);
    expect(start.body.trial_balance[0]).toMatchObject({
      currency: "USD",
      balanced: true,
    });

    const list = await call(
      "GET",
      "/v1/admin/reconciliation/runs",
      user(ADMIN),
    );
    expect(list.status).toBe(200);
    expect(list.body.runs.map((r: any) => r.id)).toEqual([start.body.id]);

    const one = await call(
      "GET",
      `/v1/admin/reconciliation/runs/${start.body.id}`,
      user(ADMIN),
    );
    expect(one.status).toBe(200);
    expect(one.body.exceptions).toEqual([]);
    expect(JSON.stringify(one.body)).not.toMatch(
      /recipient|payee|payment_source/i,
    );
    expect(
      (
        await call(
          "GET",
          `/v1/admin/reconciliation/runs/${randomUUID()}`,
          user(ADMIN),
        )
      ).status,
    ).toBe(404);
  });

  it("lists an exception when PayPal disagrees, with a signed difference", async () => {
    const d = await deposit("25.00");
    const cap = (
      await q(`SELECT paypal_capture_id FROM wallet_deposits WHERE id = $1`, [
        d.id,
      ])
    )[0].paypal_capture_id;
    // Stoat believes 25.00 was captured; make PayPal say otherwise.
    const real = paypal.getCapture.bind(paypal);
    paypal.getCapture = async (id: string) => ({
      ...(await real(id)),
      amount: "20.00",
    });
    const start = await call(
      "POST",
      "/v1/admin/reconciliation/runs",
      user(ADMIN),
    );
    expect(start.status).toBe(201);
    expect(start.body.status).toBe("differences");
    const ex = await call(
      "GET",
      "/v1/admin/reconciliation/exceptions?status=open",
      user(ADMIN),
    );
    expect(ex.status).toBe(200);
    expect(ex.body.exceptions).toHaveLength(1);
    expect(ex.body.exceptions[0]).toMatchObject({
      paypal_id: cap,
      kind: "mismatch",
      difference: "5",
    });
    expect(
      (
        await call(
          "GET",
          "/v1/admin/reconciliation/exceptions?status=bogus",
          user(ADMIN),
        )
      ).status,
    ).toBe(400);
  });

  it("refuses a second run while one is running with 409 and leaves it unchanged", async () => {
    const [run] = await q(
      `INSERT INTO reconciliation_runs (tenant_id, trigger, requested_by, status, paypal_environment)
       VALUES ($1, 'admin', $2, 'running', 'sandbox') RETURNING id`,
      [T, ADMIN],
    );
    const r = await call("POST", "/v1/admin/reconciliation/runs", user(ADMIN));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("RECONCILIATION_IN_PROGRESS");
    const rows = await q(`SELECT id, status FROM reconciliation_runs`);
    expect(rows).toEqual([{ id: run.id, status: "running" }]);
  });

  it("refuses agents and buyers with one 403 and one audit row, starting no run", async () => {
    const targets: ["GET" | "POST", string][] = [
      ["POST", "/v1/admin/reconciliation/runs"],
      ["GET", "/v1/admin/reconciliation/runs"],
      ["GET", `/v1/admin/reconciliation/runs/${randomUUID()}`],
      ["GET", "/v1/admin/reconciliation/exceptions"],
    ];
    for (const who of [agent, user(OWNER)]) {
      for (const [method, url] of targets) {
        const before = (
          await q(
            `SELECT count(*)::int AS n FROM audit_logs WHERE outcome = 'refused'`,
          )
        )[0].n;
        const r = await call(method, url, who);
        expect(r.status, `${method} ${url}`).toBe(403);
        const after = (
          await q(
            `SELECT count(*)::int AS n FROM audit_logs WHERE outcome = 'refused'`,
          )
        )[0].n;
        expect(after, `${method} ${url}`).toBe(before + 1);
      }
    }
    expect(await q(`SELECT 1 FROM reconciliation_runs`)).toHaveLength(0);
    expect(paypal.calls.length).toBe(0);
  });

  it("an Admin of another tenant sees none of this tenant's runs", async () => {
    await deposit("5.00");
    await call("POST", "/v1/admin/reconciliation/runs", user(ADMIN));
    const admin2 = randomUUID();
    await db().query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, 'rc-a2@x.test', 'operator')`,
      [admin2, T2],
    );
    const list = await call(
      "GET",
      "/v1/admin/reconciliation/runs",
      user(admin2),
    );
    expect(list.status).toBe(200);
    expect(list.body.runs).toEqual([]);
  });

  it("the schedule queues one job per tenant with wallets, throttled by the interval", async () => {
    await deposit("5.00");
    expect(await enqueueReconciliationJobs(db(), 86_400_000)).toBe(1);
    expect(await enqueueReconciliationJobs(db(), 86_400_000)).toBe(0); // already queued
    const sweep = await runWalletSweep(db());
    expect(sweep.reconciliationQueued).toBe(0);
    const jobs = await q(
      `SELECT tenant_id, payload FROM jobs WHERE type = 'wallet_reconciliation'`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].tenant_id).toBe(T);
  });

  it("the job handler runs a scheduled run and tolerates one already in progress", async () => {
    await deposit("5.00");
    await enqueueReconciliationJobs(db(), 0);
    await db().query(`DELETE FROM jobs WHERE type <> 'wallet_reconciliation'`);
    expect(await runOneJob(db(), "t", { gateway: paypal })).toBe(true);
    const [run] = await q(`SELECT trigger, status FROM reconciliation_runs`);
    expect(run).toEqual({ trigger: "schedule", status: "clean" });
    const [job] = await q(
      `SELECT status FROM jobs WHERE type = 'wallet_reconciliation'`,
    );
    expect(job.status).toBe("succeeded");

    await db().query(
      `INSERT INTO reconciliation_runs (tenant_id, trigger, status, paypal_environment)
       VALUES ($1, 'schedule', 'running', 'sandbox')`,
      [T],
    );
    await db().query(`DELETE FROM jobs`);
    await enqueueReconciliationJobs(db(), 0);
    expect(await runOneJob(db(), "t", { gateway: paypal })).toBe(true);
    const [again] = await q(
      `SELECT status FROM jobs WHERE type = 'wallet_reconciliation'`,
    );
    expect(again.status).toBe("succeeded");
  });
});

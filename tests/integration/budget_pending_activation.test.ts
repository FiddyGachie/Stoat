// Budgets pending approval must activate once the buyer approves at PayPal. PayPal returns every
// order to PAYPAL_RETURN_URL, so the shared return handler, the 30 s sweep and a human-only
// "check PayPal" route all activate the budget. WalletPayPalDouble states PayPal's answers;
// it proves Stoat's handling, not PayPal's behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { BudgetService } from "../../src/modules/payments/budget.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const T = SEED_IDS.tenantId;
const OWNER = randomUUID();
const db = () => getDb();
const user = { authorization: `Bearer user:${OWNER}` };
const agent = { authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` };

let paypal: WalletPayPalDouble;
let app: any;
let server: Server | null = null;

/** Real HTTP so the 302 and its Location header are observed, not followed. */
async function hit(path: string) {
  if (!server) {
    server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  }
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

async function createBudget(amount = "25.00") {
  const r = await dispatch(app, { method: "POST", url: "/v1/budgets", headers: user, body: { amount, currency: "USD" } });
  expect(r.status).toBe(201);
  return r.body.budget as { id: string; paypal_order_id: string; status: string };
}
const status = async (id: string) =>
  (await db().query<{ status: string; balance: string }>(`SELECT status, balance::text AS balance FROM spending_budgets WHERE id = $1`, [id])).rows[0];

describe("pending budgets activate after PayPal approval", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server!.close(r));
    await closeDb();
  });
  beforeEach(async () => {
    await db().query(TRUNCATE_ALL);
    await db().query(`DELETE FROM budget_decisions`);
    await db().query(`DELETE FROM budget_debits`);
    await db().query(`DELETE FROM spending_budgets`);
    await db().query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, 'pb-owner@x.test', 'buyer') ON CONFLICT (id) DO NOTHING`,
      [OWNER, T],
    );
    paypal = new WalletPayPalDouble();
    if (server) { await new Promise((r) => server!.close(r)); server = null; }
    app = createApp({ gateway: paypal });
  });

  it("the shared PayPal return URL activates the budget and lands on #/payments", async () => {
    const b = await createBudget();
    expect(b.status).toBe("pending_approval");
    const r = await hit(`/v1/paypal/return?token=${b.paypal_order_id}`);
    expect(r.status).toBe(302);
    const loc = r.location;
    expect(loc).toContain("#/payments");
    expect(loc).toContain(`budget_id=${b.id}`);
    expect(loc).toContain("budget_status=active");
    expect(await status(b.id)).toMatchObject({ status: "active" });
    expect(paypal.count("captureOrder")).toBe(1);
    // A second return captures nothing more.
    await hit(`/v1/paypal/return?token=${b.paypal_order_id}`);
    expect(paypal.count("captureOrder")).toBe(1);
  });

  it("cancel leaves the budget pending and captures nothing", async () => {
    const b = await createBudget();
    const r = await hit(`/v1/paypal/cancel?token=${b.paypal_order_id}`);
    expect(r.status).toBe(302);
    expect(r.location).toContain("paypal=cancel");
    expect(await status(b.id)).toMatchObject({ status: "pending_approval" });
    expect(paypal.count("captureOrder")).toBe(0);
  });

  it("the sweep activates only budgets PayPal reports as approved", async () => {
    const b = await createBudget();
    paypal.configure({ orderStatus: "PAYER_ACTION_REQUIRED" });
    const svc = new BudgetService(db(), paypal);
    expect(await svc.sweep()).toMatchObject({ checked: 1, activated: 0, errors: 0 });
    expect(await status(b.id)).toMatchObject({ status: "pending_approval" });
    expect(paypal.count("captureOrder")).toBe(0);
    paypal.configure({ orderStatus: "APPROVED" });
    expect(await svc.sweep()).toMatchObject({ checked: 1, activated: 1, errors: 0 });
    expect(await status(b.id)).toMatchObject({ status: "active" });
  });

  it("a person can ask Stoat to check PayPal; agents are refused", async () => {
    const b = await createBudget();
    const refused = await dispatch(app, { method: "POST", url: `/v1/budgets/${b.id}/sync`, headers: agent, body: {} });
    expect(refused.status).toBe(403);
    expect(await status(b.id)).toMatchObject({ status: "pending_approval" });
    const ok = await dispatch(app, { method: "POST", url: `/v1/budgets/${b.id}/sync`, headers: user, body: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.budget.status).toBe("active");
    const missing = await dispatch(app, { method: "POST", url: `/v1/budgets/${randomUUID()}/sync`, headers: user, body: {} });
    expect(missing.status).toBe(404);
  });

  // ── Edit / Delete for budgets that never went through ─────────────────────
  const list = async (q = "") =>
    (await dispatch(app, { method: "GET", url: `/v1/budgets${q}`, headers: user })).body.budgets as { id: string }[];

  it("Delete clears a budget PayPal never approved: cancelled, hidden, history kept, no capture", async () => {
    const b = await createBudget();
    paypal.configure({ orderStatus: "PAYER_ACTION_REQUIRED" });
    const r = await dispatch(app, { method: "DELETE", url: `/v1/budgets/${b.id}`, headers: user });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deleted: true, budget: { id: b.id, status: "cancelled" } });
    expect(await status(b.id)).toMatchObject({ status: "cancelled" });
    expect((await list()).map((x) => x.id)).not.toContain(b.id);
    expect((await list("?status=cancelled")).map((x) => x.id)).toContain(b.id);
    expect(paypal.count("captureOrder")).toBe(0);
    const ev = await db().query(
      `SELECT event_type FROM economic_events WHERE aggregate_id = $1 ORDER BY sequence`, [b.id]);
    expect(ev.rows.map((e: any) => e.event_type)).toEqual(["BUDGET_CREATED", "BUDGET_CANCELLED"]);
  });

  it("Delete is refused when PayPal reports the buyer approved; the budget activates instead", async () => {
    const b = await createBudget();
    paypal.configure({ orderStatus: "APPROVED" });
    const r = await dispatch(app, { method: "DELETE", url: `/v1/budgets/${b.id}`, headers: user });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("BUDGET_ALREADY_APPROVED");
    expect(await status(b.id)).toMatchObject({ status: "active" });
  });

  it("Delete works for an order PayPal no longer knows (expired), and refuses when PayPal is unreachable", async () => {
    const gone = await createBudget();
    await db().query(`UPDATE spending_budgets SET paypal_order_id = 'EXPIRED-ORDER-1' WHERE id = $1`, [gone.id]);
    const ok = await dispatch(app, { method: "DELETE", url: `/v1/budgets/${gone.id}`, headers: user });
    expect(ok.status).toBe(200);
    expect(await status(gone.id)).toMatchObject({ status: "cancelled" });

    const b = await createBudget();
    paypal.failNext("getOrder", { times: 1, code: "PAYPAL_UNREACHABLE" });
    const r = await dispatch(app, { method: "DELETE", url: `/v1/budgets/${b.id}`, headers: user });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("BUDGET_PAYPAL_UNVERIFIED");
    expect(await status(b.id)).toMatchObject({ status: "pending_approval" });
  });

  it("Edit creates a new PayPal order with the new amount and retires the old budget", async () => {
    const b = await createBudget("25.00");
    paypal.configure({ orderStatus: "PAYER_ACTION_REQUIRED" });
    const r = await dispatch(app, { method: "PATCH", url: `/v1/budgets/${b.id}`, headers: user, body: { amount: "40.00", currency: "USD" } });
    expect(r.status).toBe(200);
    const nb = r.body.budget;
    expect(nb.id).not.toBe(b.id);
    expect(nb).toMatchObject({ status: "pending_approval", currency: "USD" });
    expect(Number(nb.amount)).toBe(40);
    expect(nb.paypal_order_id).not.toBe(b.paypal_order_id);
    expect(r.body.replaced).toMatchObject({ id: b.id, status: "cancelled" });
    const ids = (await list()).map((x) => x.id);
    expect(ids).toContain(nb.id);
    expect(ids).not.toContain(b.id);
    expect(paypal.count("createOrder")).toBe(2);
  });

  it("Edit leaves the old budget untouched when PayPal cannot create the new order", async () => {
    const b = await createBudget("25.00");
    paypal.configure({ orderStatus: "PAYER_ACTION_REQUIRED" });
    paypal.failNext("createOrder", { times: 2, code: "PAYPAL_UNREACHABLE" });
    const r = await dispatch(app, { method: "PATCH", url: `/v1/budgets/${b.id}`, headers: user, body: { amount: "40.00" } });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await status(b.id)).toMatchObject({ status: "pending_approval" });
    expect((await list()).map((x) => x.id)).toContain(b.id);
  });

  it("Edit and Delete refuse agents, other buyers, bad amounts and budgets that are not pending", async () => {
    const b = await createBudget();
    paypal.configure({ orderStatus: "PAYER_ACTION_REQUIRED" });
    expect((await dispatch(app, { method: "DELETE", url: `/v1/budgets/${b.id}`, headers: agent })).status).toBe(403);
    expect((await dispatch(app, { method: "PATCH", url: `/v1/budgets/${b.id}`, headers: agent, body: { amount: "5" } })).status).toBe(403);

    const OTHER = randomUUID();
    await db().query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, 'pb-other@x.test', 'buyer') ON CONFLICT (id) DO NOTHING`, [OTHER, T]);
    const other = { authorization: `Bearer user:${OTHER}` };
    const notOwned = await dispatch(app, { method: "DELETE", url: `/v1/budgets/${b.id}`, headers: other });
    expect(notOwned.status).toBe(403);
    expect(notOwned.body.error.code).toBe("BUDGET_NOT_OWNED");

    const bad = await dispatch(app, { method: "PATCH", url: `/v1/budgets/${b.id}`, headers: user, body: { amount: "0" } });
    expect(bad.status).toBe(400);
    expect(await status(b.id)).toMatchObject({ status: "pending_approval" });

    paypal.configure({ orderStatus: "COMPLETED" });
    await dispatch(app, { method: "POST", url: `/v1/budgets/${b.id}/sync`, headers: user, body: {} });
    expect(await status(b.id)).toMatchObject({ status: "active" });
    const active = await dispatch(app, { method: "DELETE", url: `/v1/budgets/${b.id}`, headers: user });
    expect(active.status).toBe(409);
    expect(active.body.error.code).toBe("BUDGET_NOT_PENDING");
    expect(await status(b.id)).toMatchObject({ status: "active" });
  });

});

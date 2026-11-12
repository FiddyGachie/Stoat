// Task 18.2: /v1/budgets stays compatible; legacy decideRemainder keeps PayPal outside the
// transaction and uses Decimal arithmetic; wallet-backed budgets delegate to the wallet module
// (R17.3, R17.4, R17.10, R8.7). WalletPayPalDouble proves Stoat's handling of stated PayPal
// responses, not PayPal's behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { BudgetService } from "../../src/modules/payments/budget.service.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL, BUYER } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const OWNER = randomUUID();
const db = () => getDb();
const user = (id: string) => ({ authorization: `Bearer user:${id}` });
const agent = { authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` };

/** Double that records, at the moment of the refund call, whether a DB transaction is open and the intent state. */
class SpyDouble extends WalletPayPalDouble {
  observed: { txOpen: boolean; intent: string | null }[] = [];
  async refundCapture(input: any) {
    // An open transaction that has written has an assigned transaction ID; autocommit has none.
    const tx = await getDb().query<{ x: string | null }>(
      `SELECT txid_current_if_assigned()::text AS x`,
    );
    const intent = await getDb().query<{ s: string | null }>(
      `SELECT refund_status AS s FROM budget_decisions LIMIT 1`,
    );
    this.observed.push({
      txOpen: tx.rows[0].x !== null,
      intent: intent.rows[0]?.s ?? null,
    });
    return super.refundCapture(input);
  }
}

let paypal: SpyDouble;
let app: any;

const principal = (id: string): AuthenticatedPrincipal => ({
  id,
  tenantId: T,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
});

async function legacyBudget(
  status: string,
  balance: string,
  amount = "10",
  captureId: string | null = "CAP-LEGACY",
) {
  const id = randomUUID();
  await db().query(
    `INSERT INTO spending_budgets
       (id, tenant_id, owner_id, owner_type, amount, currency, balance, total_debited, status,
        paypal_capture_id, paypal_environment)
     VALUES ($1, $2, $3, 'user', $4, 'USD', $5, $4::numeric - $5::numeric, $6, $7, 'sandbox')`,
    [id, T, OWNER, amount, balance, status, captureId],
  );
  return id;
}
const decide = (id: string, body: unknown, who = user(OWNER)) =>
  dispatch(app, {
    method: "POST",
    url: `/v1/budgets/${id}/decide`,
    headers: who,
    body,
  });
const row = async (id: string) =>
  (
    await db().query(
      `SELECT status, balance::text AS balance FROM spending_budgets WHERE id = $1`,
      [id],
    )
  ).rows[0];
const decisions = async () =>
  (await db().query(`SELECT * FROM budget_decisions`)).rows;

describe("/v1/budgets compatibility and legacy fixes", () => {
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
    await db().query(`DELETE FROM budget_decisions`);
    await db().query(`DELETE FROM budget_debits`);
    await db().query(`DELETE FROM spending_budgets`);
    await db().query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','direct') WHERE id = $1`,
      [T],
    );
    await db().query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, 'bc-owner@x.test', 'buyer') ON CONFLICT (id) DO NOTHING`,
      [OWNER, T],
    );
    paypal = new SpyDouble();
    app = createApp({ gateway: paypal });
  });

  describe("legacy direct-mode decideRemainder", () => {
    it("refunds with PayPal called outside any transaction, after the intent is committed", async () => {
      const id = await legacyBudget("awaiting_decision", "7.500000");
      const r = await decide(id, { decision: "refund", note: "thanks" });
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["budget", "decision"]);
      expect(r.body.budget).toMatchObject({ id, status: "refunded", balance: "0.000000" });
      expect(r.body.decision).toMatchObject({
        budget_id: id,
        decision: "refund",
        decided_by: OWNER,
        refund_status: "COMPLETED",
        note: "thanks",
      });
      expect(r.body.decision.paypal_refund_id).toBeTruthy();

      expect(paypal.count("refundCapture")).toBe(1);
      expect(paypal.observed).toEqual([{ txOpen: false, intent: "submitted" }]);
      const d = await decisions();
      expect(d).toHaveLength(1);
      expect(d[0].refund_status).toBe("COMPLETED");
      expect(d[0].paypal_refund_id).toBe(r.body.decision.paypal_refund_id);
    });

    it("sends the exact remainder with a deterministic request ID", async () => {
      const id = await legacyBudget("awaiting_decision", "0.300000", "1");
      await decide(id, { decision: "refund" });
      const call = paypal.calls.find((c) => c.method === "refundCapture")!;
      expect(call.args).toMatchObject({
        captureId: "CAP-LEGACY",
        amount: "0.30",
        currency: "USD",
        requestId: `budget-refund-${id}`,
      });
    });

    it("a PayPal failure removes the intent, leaves the budget awaiting, and a retry succeeds", async () => {
      const id = await legacyBudget("awaiting_decision", "4.000000");
      paypal.failNext("refundCapture", { times: 1, code: "PAYPAL_UNREACHABLE" });
      const bad = await decide(id, { decision: "refund" });
      expect(bad.status).toBeGreaterThanOrEqual(500);
      expect(await decisions()).toHaveLength(0);
      expect((await row(id)).status).toBe("awaiting_decision");

      const ok = await decide(id, { decision: "refund" });
      expect(ok.status).toBe(200);
      expect((await row(id)).status).toBe("refunded");
    });

    it("resumes an interrupted refund: an intent without a PayPal refund ID is completed once", async () => {
      const id = await legacyBudget("awaiting_decision", "4.000000");
      await db().query(
        `INSERT INTO budget_decisions (tenant_id, budget_id, decision, decided_by, refund_status)
         VALUES ($1, $2, 'refund', $3, 'submitted')`,
        [T, id, OWNER],
      );
      const r = await decide(id, { decision: "refund" });
      expect(r.status).toBe(200);
      expect(paypal.count("refundCapture")).toBe(1);
      expect(await decisions()).toHaveLength(1);
      expect((await row(id)).status).toBe("refunded");
    });

    it("an in-flight refund cannot be switched to retain, and a finished decision is a 409", async () => {
      const id = await legacyBudget("awaiting_decision", "4.000000");
      await db().query(
        `INSERT INTO budget_decisions (tenant_id, budget_id, decision, decided_by, refund_status)
         VALUES ($1, $2, 'refund', $3, 'submitted')`,
        [T, id, OWNER],
      );
      const sw = await decide(id, { decision: "retain" });
      expect(sw.status).toBe(409);
      expect(sw.body.error.code).toBe("DECISION_ALREADY_MADE");
      expect(paypal.count("refundCapture")).toBe(0);

      await decide(id, { decision: "refund" });
      const again = await decide(id, { decision: "refund" });
      expect(again.status).toBe(422); // budget is now refunded: same code the old path gave
      expect(again.body.error.code).toBe("BUDGET_INVALID_STATE");
    });

    it("retain makes no PayPal call and keeps the balance", async () => {
      const id = await legacyBudget("awaiting_decision", "2.500000");
      const r = await decide(id, { decision: "retain" });
      expect(r.status).toBe(200);
      expect(r.body.budget).toMatchObject({ status: "retained", balance: "2.500000" });
      expect(r.body.decision).toMatchObject({
        decision: "retain",
        paypal_refund_id: null,
        refund_status: null,
      });
      expect(paypal.count("refundCapture")).toBe(0);
    });

    it("refund without a capture is refused before any PayPal call", async () => {
      const id = await legacyBudget("awaiting_decision", "2.000000", "10", null);
      const r = await decide(id, { decision: "refund" });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("BUDGET_NO_CAPTURE");
      expect(paypal.count("refundCapture")).toBe(0);
      expect(await decisions()).toHaveLength(0);
    });

    it("an agent cannot decide", async () => {
      const id = await legacyBudget("awaiting_decision", "2.000000");
      const r = await decide(id, { decision: "refund" }, agent);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(paypal.count("refundCapture")).toBe(0);
    });
  });

  describe("Decimal arithmetic", () => {
    it("debits that sum exactly to the balance deplete the budget (no float drift)", async () => {
      const id = await legacyBudget("active", "0.300000", "0.3");
      const svc = new BudgetService(db(), paypal);
      for (let i = 0; i < 3; i++) {
        await svc.debit({
          tenantId: T,
          budgetId: id,
          actorType: "system",
          actorId: SEED_IDS.tenantId,
          amount: "0.1",
          reason: "decimal",
        });
      }
      const view = await svc.getBudget(T, id);
      expect(view.status).toBe("depleted");
      expect(view.balance).toBe("0.000000");
      expect(view.total_debited).toBe("0.300000");
      expect(view.utilization_pct).toBe(100);
    });

    it("utilization is exact and rejects non-decimal amounts", async () => {
      const id = await legacyBudget("active", "6.666667", "10");
      const svc = new BudgetService(db(), paypal);
      expect((await svc.getBudget(T, id)).utilization_pct).toBe(33.33);
      for (const amount of ["abc", "", "-1", "0", "NaN", "Infinity"]) {
        await expect(
          svc.debit({
            tenantId: T,
            budgetId: id,
            actorType: "system",
            actorId: SEED_IDS.tenantId,
            amount,
            reason: "bad",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }
    });
  });

  describe("wallet-backed budgets delegate to the wallet module", () => {
    let missionId: string;
    let budgetId: string;

    beforeEach(async () => {
      await db().query(
        `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','wallet') WHERE id = $1`,
        [T],
      );
      await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [
        SEED_IDS.buyerAgentId,
        OWNER,
      ]);
      const m = await dispatch(app, {
        method: "POST",
        url: "/missions",
        headers: BUYER,
        body: { title: `BC ${randomUUID()}`, brief: "x", budget: "50", currency: "USD" },
      });
      expect(m.status).toBe(201);
      missionId = m.body.id;

      const svc = new DepositService({ gateway: paypal });
      const v = await svc.createDeposit({
        tenantId: T,
        owner: principal(OWNER),
        amount: "10.00",
        currency: "USD",
        idempotencyKey: `k-${randomUUID()}`,
      });
      await svc.captureByOrder({
        orderId: v.paypal_order_id!,
        tenantId: T,
        source: "return",
      });
      budgetId = randomUUID();
      await db().query(
        `INSERT INTO spending_budgets
           (id, tenant_id, owner_id, owner_type, mission_id, amount, currency, balance, total_debited,
            status, paypal_capture_id, paypal_environment, wallet_deposit_id)
         VALUES ($1, $2, $3, 'user', $4, 10, 'USD', 10, 0, 'active', 'CAP-W', 'sandbox',
                 (SELECT id FROM wallet_deposits WHERE paypal_order_id = $5 LIMIT 1))`,
        [budgetId, T, OWNER, missionId, v.paypal_order_id],
      );
    });

    it("complete goes through the wallet and keeps the legacy response shape", async () => {
      const r = await dispatch(app, {
        method: "POST",
        url: `/v1/budgets/${budgetId}/complete`,
        headers: user(OWNER),
        body: {},
      });
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["agent_prompt", "budget"]);
      expect(r.body.budget.id).toBe(budgetId);
      expect(r.body.budget.status).toBe("awaiting_decision");
      const m = await db().query(`SELECT status FROM missions WHERE id = $1`, [missionId]);
      expect(m.rows[0].status).toBe("completed");

      const again = await dispatch(app, {
        method: "POST",
        url: `/v1/budgets/${budgetId}/complete`,
        headers: user(OWNER),
        body: {},
      });
      expect(again.status).toBe(422);
      expect(again.body.error.code).toBe("BUDGET_INVALID_STATE");
    });

    it("retain maps to keep: no PayPal call, decision reads back as retain", async () => {
      await dispatch(app, {
        method: "POST",
        url: `/v1/budgets/${budgetId}/complete`,
        headers: user(OWNER),
        body: {},
      });
      const r = await decide(budgetId, { decision: "retain", note: "later" });
      expect(r.status).toBe(200);
      expect(r.body.budget.status).toBe("retained");
      expect(r.body.decision).toMatchObject({
        budget_id: budgetId,
        decision: "retain",
        decided_by: OWNER,
        paypal_refund_id: null,
        note: "later",
      });
      expect(paypal.count("refundCapture")).toBe(0);
      const rd = await db().query(`SELECT decision FROM remainder_decisions WHERE mission_id = $1`, [missionId]);
      expect(rd.rows[0].decision).toBe("keep");
      // the legacy table is untouched by the delegated path
      expect(await decisions()).toHaveLength(0);

      const got = await dispatch(app, {
        method: "GET",
        url: `/v1/budgets/${budgetId}/decision`,
        headers: user(OWNER),
      });
      expect(got.status).toBe(200);
      expect(got.body.decision).toMatchObject({ decision: "retain", budget_id: budgetId });
      const one = await dispatch(app, {
        method: "GET",
        url: `/v1/budgets/${budgetId}`,
        headers: user(OWNER),
      });
      expect(one.body.budget.status).toBe("retained");

      const repeat = await decide(budgetId, { decision: "retain" });
      expect(repeat.status).toBe(409);
      expect(repeat.body.error.code).toBe("DECISION_ALREADY_MADE");
    });

    it("refund goes through the wallet refund plan", async () => {
      await dispatch(app, {
        method: "POST",
        url: `/v1/budgets/${budgetId}/complete`,
        headers: user(OWNER),
        body: {},
      });
      const r = await decide(budgetId, { decision: "refund" });
      expect(r.status).toBe(200);
      expect(r.body.decision.decision).toBe("refund");
      expect(r.body.decision.paypal_refund_id).toBeTruthy();
      expect(paypal.count("refundCapture")).toBe(1);
      expect(r.body.budget.status).toBe("refunded");
    });

    it("rejects an invalid decision value", async () => {
      await dispatch(app, {
        method: "POST",
        url: `/v1/budgets/${budgetId}/complete`,
        headers: user(OWNER),
        body: {},
      });
      const r = await decide(budgetId, { decision: "keep" });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("direct-mode tenants keep the legacy path even for a linked budget", async () => {
      await db().query(
        `UPDATE tenants SET settings = settings || jsonb_build_object('funding_mode','direct') WHERE id = $1`,
        [T],
      );
      const r = await dispatch(app, {
        method: "POST",
        url: `/v1/budgets/${budgetId}/complete`,
        headers: user(OWNER),
        body: {},
      });
      expect(r.status).toBe(200);
      expect(r.body.budget.status).toBe("awaiting_decision");
      const m = await db().query(`SELECT status FROM missions WHERE id = $1`, [missionId]);
      expect(m.rows[0].status).not.toBe("completed");
    });
  });

  it("only the deprecated debit route carries deprecation headers", async () => {
    const id = await legacyBudget("active", "5");
    for (const url of [`/v1/budgets/${id}`, "/v1/budgets", "/v1/budgets/analytics", `/v1/budgets/${id}/debits`]) {
      const r = await dispatch(app, { method: "GET", url, headers: user(OWNER) });
      expect(r.status).toBe(200);
      expect(r.headers?.["deprecation"] ?? r.headers?.["Deprecation"]).toBeUndefined();
    }
    const list = await dispatch(app, { method: "GET", url: "/v1/budgets", headers: user(OWNER) });
    expect(Object.keys(list.body)).toEqual(["budgets"]);
    expect(list.body.budgets[0]).toHaveProperty("utilization_pct");
  });
});

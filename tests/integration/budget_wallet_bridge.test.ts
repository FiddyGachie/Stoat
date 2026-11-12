// Approved spending budgets fund missions through the wallet (wallet funding mode).
// Switching to wallet mode moves captured budgets into the Owner's wallet; budgets approved
// afterwards move automatically on activation. Books stay balanced (Dr 2101 / Cr 2103).
// WalletPayPalDouble states PayPal's answers; it proves Stoat's handling, not PayPal's.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { BudgetService } from "../../src/modules/payments/budget.service.js";
import { setFundingMode, getFundingMode } from "../../src/modules/wallet/funding-mode.js";
import { getBalances } from "../../src/modules/wallet/wallet.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL, BUYER } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";

const T = SEED_IDS.tenantId;
const OWNER = randomUUID();
const db = () => getDb();
const user = { authorization: `Bearer user:${OWNER}` };
let paypal: WalletPayPalDouble;
let app: any;

async function activeBudget(amount: string) {
  const r = await dispatch(app, { method: "POST", url: "/v1/budgets", headers: user, body: { amount, currency: "USD" } });
  expect(r.status).toBe(201);
  const v = await new BudgetService(db(), paypal).activateByOrder(r.body.budget.paypal_order_id, "test");
  return v!;
}
const walletOf = async () =>
  (await db().query(`SELECT id FROM wallets WHERE tenant_id = $1 AND owner_user_id = $2`, [T, OWNER])).rows[0]?.id as string | undefined;
const net = async (code: string) =>
  (await db().query<{ n: string }>(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS n
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.tenant_id = $1 AND a.account_code = $2`, [T, code])).rows[0].n;

describe("approved budgets fund missions through the wallet", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
  });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => {
    await db().query(TRUNCATE_ALL);
    await db().query(`DELETE FROM budget_decisions`);
    await db().query(`DELETE FROM budget_debits`);
    await db().query(`DELETE FROM spending_budgets`);
    await db().query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','direct') WHERE id = $1`, [T]);
    await db().query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, 'bw-owner@x.test', 'buyer') ON CONFLICT (id) DO NOTHING`, [OWNER, T]);
    paypal = new WalletPayPalDouble();
    app = createApp({ gateway: paypal });
  });

  it("switching to wallet mode moves an active budget into the Owner's wallet, balanced and once", async () => {
    const b = await activeBudget("35.00");
    expect(b.status).toBe("active");
    expect(await walletOf()).toBeUndefined();
    const before2101 = await net("2101");

    const res = await setFundingMode({ tenantId: T, mode: "wallet", actorId: OWNER });
    expect(res.changed).toBe(true);
    expect(res.budgets_moved).toEqual([expect.objectContaining({ bridged: true, budgetId: b.id })]);
    expect(await getFundingMode(db(), T)).toBe("wallet");

    const w = await walletOf();
    expect(w).toBeTruthy();
    const bal = await getBalances(db(), w!);
    expect(Number(bal.balance)).toBe(35);
    expect(Number(bal.available)).toBe(35);
    // Held funds were reclassified, not duplicated: 2101 fell by 35 and 2103 rose by 35.
    expect(Number(await net("2101"))).toBe(Number(before2101) - 35);
    expect(Number(await net("2103"))).toBe(35);
    const dep = await db().query(`SELECT status, credited_amount::text AS c, paypal_order_id FROM wallet_deposits WHERE migrated_from_budget_id = $1`, [b.id]);
    expect(dep.rows[0]).toMatchObject({ status: "captured", paypal_order_id: null });
    expect(Number(dep.rows[0].c)).toBe(35);
    const link = await db().query(`SELECT wallet_deposit_id FROM spending_budgets WHERE id = $1`, [b.id]);
    expect(link.rows[0].wallet_deposit_id).toBeTruthy();

    // Idempotent: switching again (no change) or re-bridging adds nothing.
    const again = await setFundingMode({ tenantId: T, mode: "wallet", actorId: OWNER });
    expect(again.changed).toBe(false);
    expect(Number((await getBalances(db(), w!)).balance)).toBe(35);
    // Every journal transaction balances.
    const unbalanced = await db().query(
      `SELECT transaction_id FROM journal_lines GROUP BY transaction_id
        HAVING SUM(debit - credit) <> 0`);
    expect(unbalanced.rows).toEqual([]);
  });

  it("in wallet mode a newly approved budget moves into the wallet on activation", async () => {
    await setFundingMode({ tenantId: T, mode: "wallet", actorId: OWNER });
    const b = await activeBudget("20.00");
    expect(b.status).toBe("active");
    const w = await walletOf();
    expect(w).toBeTruthy();
    expect(Number((await getBalances(db(), w!)).balance)).toBe(20);
    // The PayPal return for that order still routes to the budget, not to a deposit.
    const dep = await db().query(`SELECT paypal_order_id FROM wallet_deposits WHERE migrated_from_budget_id = $1`, [b.id]);
    expect(dep.rows[0].paypal_order_id).toBeNull();
    const note = await db().query(`SELECT title FROM notifications WHERE recipient_user_id = $1 AND kind = 'deposit_captured'`, [OWNER]);
    expect(note.rows.map((r: any) => r.title)).toContain("Budget added to your wallet");
  });

  it("direct mode is unchanged: activation books 1101/2101 and creates no wallet", async () => {
    const b = await activeBudget("10.00");
    expect(b.status).toBe("active");
    expect(await walletOf()).toBeUndefined();
    expect(Number(await net("2103"))).toBe(0);
  });

  // ── End to end: an agent's accepted quote is funded from the approved budget ──
  async function missionAndQuote(budget = "500.000000") {
    const m = await dispatch(app, { method: "POST", url: "/missions", headers: BUYER,
      body: { title: `Bridge ${randomUUID()}`, brief: "Review the fixture", budget, currency: "USD" } });
    expect(m.status).toBe(201);
    const q = await dispatch(app, { method: "POST", url: "/quotes", headers: BUYER,
      body: { mission_id: m.body.id, service_id: SEED_IDS.aiServiceId, requested_scope: { files: ["src/auth.ts"] } } });
    expect(q.status).toBe(201);
    return { missionId: m.body.id as string, quoteId: q.body.id as string };
  }

  it("an accepted quote reserves from the budget-funded wallet and asks PayPal for nothing", async () => {
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [SEED_IDS.buyerAgentId, OWNER]);
    await activeBudget("35.00");
    await setFundingMode({ tenantId: T, mode: "wallet", actorId: OWNER });
    const ordersBefore = paypal.count("createOrder");

    const { quoteId } = await missionAndQuote();
    const r = await dispatch(app, { method: "POST", url: `/quotes/${quoteId}/accept`, headers: BUYER });
    expect(r.status).toBe(200);
    const agreementId = r.body.id ?? r.body.agreement?.id;
    expect(r.body.payment ?? null).toBeNull();

    const ag = await db().query(`SELECT funding_status, price::text AS price FROM agreements WHERE id = $1`, [agreementId]);
    expect(ag.rows[0].funding_status).toBe("funded");
    const res = await db().query(`SELECT amount::text AS amount, status FROM wallet_reservations WHERE agreement_id = $1`, [agreementId]);
    expect(res.rows[0]).toMatchObject({ status: "active" });
    expect(Number(res.rows[0].amount)).toBe(Number(ag.rows[0].price));
    // No PayPal order and no agreement payment were created for the agreement.
    expect(paypal.count("createOrder")).toBe(ordersBefore);
    expect((await db().query(`SELECT count(*)::int AS n FROM agreement_payments WHERE agreement_id = $1`, [agreementId])).rows[0].n).toBe(0);

    const w = await walletOf();
    const bal = await getBalances(db(), w!);
    expect(Number(bal.reserved)).toBe(Number(ag.rows[0].price));
    expect(Number(bal.available)).toBeCloseTo(35 - Number(ag.rows[0].price), 6);
  });

  it("when the approved budget is too small the quote is refused and the Owner is told to top up", async () => {
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [SEED_IDS.buyerAgentId, OWNER]);
    await activeBudget("0.01");
    await setFundingMode({ tenantId: T, mode: "wallet", actorId: OWNER });
    const ordersBefore = paypal.count("createOrder");

    const { quoteId } = await missionAndQuote();
    const r = await dispatch(app, { method: "POST", url: `/quotes/${quoteId}/accept`, headers: BUYER });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.code).toBe("WALLET_INSUFFICIENT_FUNDS");
    expect(paypal.count("createOrder")).toBe(ordersBefore);
    const n = await db().query(`SELECT kind FROM notifications WHERE recipient_user_id = $1 AND kind = 'low_balance'`, [OWNER]);
    expect(n.rows.length).toBe(1);
  });

});

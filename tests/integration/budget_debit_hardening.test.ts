// Task 18.1: POST /v1/budgets/:id/debit is human-Owner only, deprecated and debits nothing
// (R6.12, R17.10-R17.14)
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { dispatch } from "../test-utils.js";

const T = SEED_IDS.tenantId;
const OWNER = randomUUID();
const OTHER = randomUUID();
const db = () => getDb();
const user = (id: string) => ({ authorization: `Bearer user:${id}` });
const agent = { authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` };
let app: any;
let budgetId: string;

const budgetRow = async () =>
  (
    await db().query(
      `SELECT balance::text AS balance, total_debited::text AS total_debited FROM spending_budgets WHERE id = $1`,
      [budgetId],
    )
  ).rows[0];
const refusals = async () =>
  (
    await db().query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE outcome = 'refused' AND action = 'budget.debit'`,
    )
  ).rows[0].n as number;
const debitRows = async () =>
  (await db().query(`SELECT count(*)::int AS n FROM budget_debits`)).rows[0]
    .n as number;
const post = (headers: Record<string, string>, body?: unknown, id = budgetId) =>
  dispatch(app, {
    method: "POST",
    url: `/v1/budgets/${id}/debit`,
    headers,
    body,
  });

describe("POST /v1/budgets/:id/debit hardening", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
    app = createApp({ gateway: new WalletPayPalDouble() });
  });
  afterAll(async () => {
    await closeDb();
  });
  beforeEach(async () => {
    for (const [id, email] of [
      [OWNER, "bd-owner@x.test"],
      [OTHER, "bd-other@x.test"],
    ]) {
      await db().query(
        `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'buyer') ON CONFLICT (id) DO NOTHING`,
        [id, T, email],
      );
    }
    budgetId = randomUUID();
    await db().query(
      `INSERT INTO spending_budgets (id, tenant_id, owner_id, owner_type, amount, currency, balance, total_debited, status)
       VALUES ($1, $2, $3, 'user', 10, 'USD', 10, 0, 'active')`,
      [budgetId, T, OWNER],
    );
  });

  it("returns 200 with deprecation headers and debits nothing for the human Owner", async () => {
    const before = await budgetRow();
    const r = await post(user(OWNER), { reason: "x" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deprecated: true, debited: false });
    expect(typeof r.body.message).toBe("string");
    expect(r.headers?.["deprecation"] ?? r.headers?.["Deprecation"]).toBe(
      "true",
    );
    expect(r.headers?.["sunset"] ?? r.headers?.["Sunset"]).toBeTruthy();
    expect(await budgetRow()).toEqual(before);
    expect(await debitRows()).toBe(0);
  });

  it("refuses an agent with 403 FORBIDDEN_ACTION and exactly one audit row, even with an amount", async () => {
    const before = await refusals();
    const r = await post(agent, { amount: "1.00" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("FORBIDDEN_ACTION");
    expect(await refusals()).toBe(before + 1);
    const row = (
      await db().query(
        `SELECT actor_type, actor_id, resource_id FROM audit_logs WHERE action = 'budget.debit' ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0];
    expect(row).toMatchObject({
      actor_type: "agent",
      actor_id: SEED_IDS.buyerAgentId,
      resource_id: budgetId,
    });
    expect((await budgetRow()).total_debited).toMatch(/^0(\.0+)?$/);
    expect(await debitRows()).toBe(0);
  });

  it("refuses a human who is not the Owner with one audit row and no change", async () => {
    const before = await refusals();
    const r = await post(user(OTHER));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("FORBIDDEN_ACTION");
    expect(await refusals()).toBe(before + 1);
    expect(await debitRows()).toBe(0);
  });

  it("refuses an unauthenticated caller", async () => {
    const r = await post({});
    expect(r.status).toBe(401);
    expect(await debitRows()).toBe(0);
  });

  it("rejects any body amount from the Owner with VALIDATION_FAILED and no change", async () => {
    const before = await budgetRow();
    for (const amount of ["0.01", 5, null, "abc"]) {
      const r = await post(user(OWNER), { amount });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION_FAILED");
    }
    expect(await budgetRow()).toEqual(before);
    expect(await debitRows()).toBe(0);
  });

  it("returns 404 for an unknown or malformed budget ID without a refusal row", async () => {
    const before = await refusals();
    expect((await post(user(OWNER), {}, randomUUID())).status).toBe(404);
    expect((await post(user(OWNER), {}, "not-a-uuid")).status).toBe(404);
    expect(await refusals()).toBe(before);
  });
});

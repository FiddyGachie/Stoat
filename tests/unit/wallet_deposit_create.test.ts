// Task 8.1: DepositService.createDeposit (R2.1-2.14, R16.9, R16.10), using WalletPayPalDouble.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { UnconfiguredPayPalGateway } from "../../src/modules/paypal/paypal.gateway.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const O = SEED_IDS.userId;
const db = () => getDb();

const owner: AuthenticatedPrincipal = {
  id: O,
  tenantId: T,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
};
const agent: AuthenticatedPrincipal = {
  id: SEED_IDS.buyerAgentId,
  tenantId: T,
  type: "agent",
  role: "buyer",
  scopes: [],
  name: "Buyer agent",
};

const setMode = (mode: string) =>
  db().query(
    `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`,
    [T, JSON.stringify({ funding_mode: mode })],
  );
const count = async (table: string) =>
  (await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

async function ownedMission(currency = "USD"): Promise<string> {
  await db().query(`UPDATE agents SET owner_user_id = $1 WHERE id = $2`, [O, SEED_IDS.buyerAgentId]);
  const id = randomUUID();
  await db().query(
    `INSERT INTO missions (id, tenant_id, buyer_id, title, brief, budget, currency, deadline)
     VALUES ($1, $2, $3, 't', 'b', 50, $4, now() + interval '7 days')`,
    [id, T, SEED_IDS.buyerAgentId, currency],
  );
  return id;
}

const base = (over: Record<string, unknown> = {}) => ({
  tenantId: T,
  owner,
  amount: "25.00",
  currency: "USD",
  idempotencyKey: `key-${randomUUID()}`,
  ...over,
});

describe("DepositService.createDeposit", () => {
  let paypal: WalletPayPalDouble;
  let svc: DepositService;

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
    await setMode("wallet");
    paypal = new WalletPayPalDouble();
    svc = new DepositService({ gateway: paypal });
  });

  it("creates an order and stores awaiting_approval with order, URL and environment", async () => {
    const missionId = await ownedMission();
    const v = await svc.createDeposit(base({ missionId }));
    expect(v.status).toBe("awaiting_approval");
    expect(v.amount).toBe("25");
    expect(v.approve_url).toContain("paypal.com");
    expect(v.paypal_environment).toBe("sandbox");
    expect(v.mission_id).toBe(missionId);
    const call = paypal.calls.find((c) => c.method === "createOrder")!.args as any;
    expect(call.amount).toBe("25.00");
    expect(call.customId).toBe(`wallet:${v.id}`);
    const row = (await db().query(`SELECT * FROM wallet_deposits WHERE id = $1`, [v.id])).rows[0] as any;
    expect(row.paypal_request_id).toMatch(/^wallet-dep-[0-9a-f]{32}$/);
    expect(row.paypal_order_id).toBe(v.paypal_order_id);
    expect(Number(row.credited_amount)).toBe(0);
    // Never credited on order creation (R2.15).
    expect(await count("journal_lines")).toBe(0);
  });

  it("same key and params returns the original with one PayPal order; different params conflict", async () => {
    const p = base();
    const a = await svc.createDeposit(p);
    const b = await svc.createDeposit(p);
    expect(b.id).toBe(a.id);
    expect(paypal.count("createOrder")).toBe(1);
    await expect(svc.createDeposit({ ...p, amount: "26.00" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await count("wallet_deposits")).toBe(1);
    expect(paypal.count("createOrder")).toBe(1);
  });

  it("concurrent requests with one key create a single order", async () => {
    const p = base();
    const out = await Promise.all([svc.createDeposit(p), svc.createDeposit(p), svc.createDeposit(p)]);
    expect(new Set(out.map((d) => d.id)).size).toBe(1);
    expect(paypal.count("createOrder")).toBe(1);
  });

  it.each([
    ["zero", { amount: "0" }],
    ["negative", { amount: "-5" }],
    ["number type", { amount: 5 }],
    ["too many minor digits", { amount: "1.234" }],
    ["above maximum", { amount: "10000.01" }],
    ["unsupported currency", { currency: "XXX" }],
    ["missing key", { idempotencyKey: undefined }],
  ])("rejects invalid input (%s) with no deposit and no PayPal call", async (_n, over) => {
    await expect(svc.createDeposit(base(over))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await count("wallet_deposits")).toBe(0);
    expect(paypal.calls).toHaveLength(0);
  });

  it("accepts the maximum amount exactly", async () => {
    const v = await svc.createDeposit(base({ amount: "10000.00" }));
    expect(v.status).toBe("awaiting_approval");
  });

  it("gives the same not-found answer for a missing and a foreign mission", async () => {
    await ownedMission();
    await db().query(`UPDATE agents SET owner_user_id = NULL WHERE id = $1`, [SEED_IDS.buyerAgentId]);
    const foreign = randomUUID();
    await db().query(
      `INSERT INTO missions (id, tenant_id, buyer_id, title, brief, budget, deadline)
       VALUES ($1, $2, $3, 't', 'b', 5, now() + interval '1 day')`,
      [foreign, T, SEED_IDS.buyerAgentId],
    );
    const e1 = await svc.createDeposit(base({ missionId: foreign })).catch((e) => e);
    const e2 = await svc.createDeposit(base({ missionId: randomUUID() })).catch((e) => e);
    const e3 = await svc.createDeposit(base({ missionId: "not-a-uuid" })).catch((e) => e);
    for (const e of [e1, e2, e3]) expect(e).toMatchObject({ code: "NOT_FOUND", message: "Mission not found." });
    expect(await count("wallet_deposits")).toBe(0);
    expect(paypal.calls).toHaveLength(0);
  });

  it("refuses in direct mode with WALLET_NOT_ENABLED before any insert or call", async () => {
    await setMode("direct");
    await expect(svc.createDeposit(base())).rejects.toMatchObject({ code: "WALLET_NOT_ENABLED" });
    expect(await count("wallet_deposits")).toBe(0);
    expect(paypal.calls).toHaveLength(0);
  });

  it("returns PAYPAL_NOT_CONFIGURED with no deposit and no wallet row", async () => {
    const s = new DepositService({ gateway: new UnconfiguredPayPalGateway() });
    await expect(s.createDeposit(base())).rejects.toMatchObject({ code: "PAYPAL_NOT_CONFIGURED" });
    expect(await count("wallet_deposits")).toBe(0);
    expect(await count("wallets")).toBe(0);
  });

  it("returns PAYPAL_BAD_RESPONSE and leaves no awaiting_approval deposit when there is no approval URL", async () => {
    paypal.configure({ approveUrl: null });
    await expect(svc.createDeposit(base())).rejects.toMatchObject({ code: "PAYPAL_BAD_RESPONSE" });
    const rows = (await db().query(`SELECT status FROM wallet_deposits`)).rows as any[];
    expect(rows.map((r) => r.status)).toEqual(["creation_failed"]);
    expect(await count("journal_lines")).toBe(0);
  });

  it("marks creation_failed on a PayPal failure, after one retry, and never credits", async () => {
    paypal.failNext("createOrder", { times: 2 });
    await expect(svc.createDeposit(base())).rejects.toMatchObject({ code: "PAYPAL_UNREACHABLE" });
    expect(paypal.count("createOrder")).toBe(2);
    const rows = (await db().query(`SELECT status, credited_amount FROM wallet_deposits`)).rows as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("creation_failed");
    expect(Number(rows[0].credited_amount)).toBe(0);
  });

  it("recovers from one transient failure through the retry", async () => {
    paypal.failNext("createOrder", { times: 1 });
    const v = await svc.createDeposit(base());
    expect(v.status).toBe("awaiting_approval");
    expect(paypal.count("createOrder")).toBe(2);
  });

  it("refuses an agent principal with one audit row and no deposit", async () => {
    await expect(svc.createDeposit(base({ owner: agent }))).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    expect(await count("wallet_deposits")).toBe(0);
    expect(paypal.calls).toHaveLength(0);
    const a = (await db().query(`SELECT reason FROM audit_logs WHERE action = 'wallet.deposit.create'`)).rows as any[];
    expect(a).toHaveLength(1);
    expect(a[0].reason).toContain("agent_direct_request");
  });

  it("rejects any payee or recipient field", async () => {
    for (const field of ["payee", "payout_recipient", "recipient_email", "payment_source"]) {
      await expect(svc.createDeposit(base({ [field]: "x@example.com" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(await count("wallet_deposits")).toBe(0);
    expect(paypal.calls).toHaveLength(0);
  });

  it("view never exposes recipient-like keys and records a hash-chained event", async () => {
    const v = await svc.createDeposit(base());
    expect(JSON.stringify(v)).not.toMatch(/recipient|payee|payment_source/i);
    const ev = (await db().query(`SELECT event_type FROM economic_events WHERE aggregate_id = $1`, [v.id])).rows as any[];
    expect(ev.map((e) => e.event_type)).toEqual(["DEPOSIT_ORDER_CREATED"]);
  });
});

// Task 8.5: webhook claim, signature gate and custom_id routing (R3.2, R3.12, R3.13).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { PayPalService } from "../../src/modules/paypal/paypal.service.js";
import { EventsService } from "../../src/modules/events/events.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const db = () => getDb();
const owner: AuthenticatedPrincipal = {
  id: SEED_IDS.userId,
  tenantId: T,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
};
const one = async (sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows[0] as any;

describe("PayPalService.handleWebhook routing", () => {
  let paypal: WalletPayPalDouble;
  let pp: PayPalService;

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
    paypal = new WalletPayPalDouble();
    pp = new PayPalService(db(), new EventsService(db()), paypal);
  });

  async function newDeposit() {
    const v = await new DepositService({ gateway: paypal }).createDeposit({
      tenantId: T,
      owner,
      amount: "25.00",
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
    return { id: v.id, orderId: v.paypal_order_id! };
  }
  const hook = (id: string, orderId: string, customId: string) => ({
    id,
    event_type: "CHECKOUT.ORDER.APPROVED",
    resource: { id: orderId, purchase_units: [{ custom_id: customId }] },
  });

  it("routes a wallet: event to the deposit service, once", async () => {
    const d = await newDeposit();
    const h = hook(`WH-${randomUUID()}`, d.orderId, `wallet:${d.id}`);
    const first = await pp.handleWebhook({ headers: {}, rawBody: "", payload: h });
    expect(first).toMatchObject({ valid: true, duplicate: false });
    expect((await one(`SELECT status FROM wallet_deposits WHERE id = $1`, [d.id])).status).toBe("captured");

    const dup = await pp.handleWebhook({ headers: {}, rawBody: "", payload: h });
    expect(dup.duplicate).toBe(true);
    expect(paypal.count("captureOrder")).toBe(1);
    expect((await one(`SELECT count(*)::int AS n FROM webhook_events`)).n).toBe(1);
  });

  it("an unverified wallet: event is invalid, recorded nowhere, and audited", async () => {
    const d = await newDeposit();
    paypal.verifyWebhook = async () => false;
    const res = await pp.handleWebhook({
      headers: {},
      rawBody: "",
      payload: hook(`WH-${randomUUID()}`, d.orderId, `wallet:${d.id}`),
    });
    expect(res.valid).toBe(false);
    expect((await one(`SELECT count(*)::int AS n FROM webhook_events`)).n).toBe(0);
    expect(paypal.count("captureOrder")).toBe(0);
    const a = await one(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'paypal.webhook.verify' AND outcome = 'refused'`,
    );
    expect(a.n).toBe(1);
  });

  it("swallows processing errors after the claim", async () => {
    const d = await newDeposit();
    paypal.captureOrder = async () => {
      throw new Error("boom");
    };
    const res = await pp.handleWebhook({
      headers: {},
      rawBody: "",
      payload: hook(`WH-${randomUUID()}`, d.orderId, `wallet:${d.id}`),
    });
    expect(res.valid).toBe(true);
    expect((await one(`SELECT count(*)::int AS n FROM webhook_events`)).n).toBe(1);
  });

  it("a budget: event for an unknown order is claimed and changes nothing", async () => {
    const res = await pp.handleWebhook({
      headers: {},
      rawBody: "",
      payload: hook(`WH-${randomUUID()}`, "ORDER-NONE", `budget:${randomUUID()}`),
    });
    expect(res).toMatchObject({ valid: true, duplicate: false });
    expect(paypal.count("captureOrder")).toBe(0);
  });
});

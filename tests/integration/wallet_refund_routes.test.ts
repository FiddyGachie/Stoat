// Task 14.3: refund routes behind walletGuard and PayPal refund webhook routing
// (R8.9, 8.11, 8.14, 12.1, 12.2, 12.8, 12.9). Uses WalletPayPalDouble: it proves Stoat's handling of
// stated PayPal responses, not PayPal's behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { completeMission } from "../../src/modules/wallet/mission-completion.service.js";
import { PayPalService } from "../../src/modules/paypal/paypal.service.js";
import { EventsService } from "../../src/modules/events/events.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL, BUYER } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const OWNER = randomUUID();
const OTHER = randomUUID();
const ADMIN = SEED_IDS.userId; // seeded operator
const db = () => getDb();
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const user = (id: string) => as(`user:${id}`);
const agent = as(`agent:${SEED_IDS.buyerAgentId}`);
const q = async <R = any>(sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows as R[];
const count = async (table: string, where = "true") =>
  (await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n as number;
const refusals = () => count("audit_logs", "outcome = 'refused'");

const ownerPrincipal: AuthenticatedPrincipal = {
  id: OWNER,
  tenantId: T,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
};

describe("refund routes and refund webhooks", () => {
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
    for (const [id, email] of [
      [OWNER, "ro@x.test"],
      [OTHER, "rother@x.test"],
    ]) {
      await db().query(
        `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'buyer') ON CONFLICT (id) DO NOTHING`,
        [id, T, email],
      );
    }
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [
      SEED_IDS.buyerAgentId,
      OWNER,
    ]);
    paypal = new WalletPayPalDouble();
    app = createApp({ gateway: paypal });
  });

  async function captured(amount = "25.00") {
    const v = await new DepositService({ gateway: paypal }).createDeposit({
      tenantId: T,
      owner: ownerPrincipal,
      amount,
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
    await new DepositService({ gateway: paypal }).captureByOrder({
      orderId: v.paypal_order_id!,
      tenantId: T,
      source: "return",
    });
    walletId = v.wallet_id;
  }
  const post = (
    url: string,
    who: Record<string, string>,
    body: any = {},
    key: string | null = `k-${randomUUID()}`,
  ) =>
    dispatch(app, {
      method: "POST",
      url,
      headers: key ? { ...who, "idempotency-key": key } : who,
      body,
    });
  const get = (url: string, who: Record<string, string>) =>
    dispatch(app, { method: "GET", url, headers: who });

  it("Owner refunds unlinked funds; key required; repeat returns the original; body wallet ignored", async () => {
    await captured();
    const noKey = await post("/v1/wallet/refunds", user(OWNER), { amount: "5.00" }, null);
    expect(noKey.status).toBe(400);
    expect(paypal.count("refundCapture")).toBe(0);

    const key = `k-${randomUUID()}`;
    const r = await post(
      "/v1/wallet/refunds",
      user(OWNER),
      { amount: "10.00", wallet_id: randomUUID(), owner_user_id: OTHER },
      key,
    );
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("completed");
    expect(r.body.kind).toBe("unlinked");
    expect(r.body.amount).toBe("10");
    expect(r.body.wallet_id).toBe(walletId);
    expect(r.body.items).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toMatch(/recipient|payee|payment_source/i);

    const again = await post("/v1/wallet/refunds", user(OWNER), { amount: "10.00" }, key);
    expect(again.body.id).toBe(r.body.id);
    expect(paypal.count("refundCapture")).toBe(1);

    const list = await get("/v1/wallet/refunds", user(OWNER));
    expect(list.body.refunds).toHaveLength(1);
    expect(list.body.paypal_environment).toBe("sandbox");
    const one = await get(`/v1/wallet/refunds/${r.body.id}`, user(OWNER));
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(r.body.id);

    const retry = await post(`/v1/wallet/refunds/${r.body.id}/retry`, user(OWNER));
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe("REFUND_NOTHING_TO_RETRY");
  });

  it("another Owner is refused with WALLET_NOT_OWNED and one audit row each; lists stay scoped", async () => {
    await captured();
    const r = await post("/v1/wallet/refunds", user(OWNER), { amount: "5.00" });
    const before = await refusals();
    const read = await get(`/v1/wallet/refunds/${r.body.id}`, user(OTHER));
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe("WALLET_NOT_OWNED");
    const retry = await post(`/v1/wallet/refunds/${r.body.id}/retry`, user(OTHER));
    expect(retry.status).toBe(403);
    expect(retry.body.error.code).toBe("WALLET_NOT_OWNED");
    expect(await refusals()).toBe(before + 2);
    expect((await get("/v1/wallet/refunds", user(OTHER))).body.refunds).toHaveLength(0);
    expect((await get("/v1/wallet/refunds", user(ADMIN))).body.refunds).toHaveLength(1);
  });

  it("refuses an agent on every refund route: 403, one audit row each, no PayPal call", async () => {
    await captured();
    const id = randomUUID();
    const calls: Array<[string, string, any?]> = [
      ["POST", `/v1/wallet/missions/${id}/remainder-decision`, { decision: "refund" }],
      ["POST", "/v1/wallet/refunds", { amount: "1.00" }],
      ["POST", `/v1/wallet/refunds/${id}/retry`],
      ["GET", "/v1/wallet/refunds"],
      ["POST", `/v1/admin/wallets/${walletId}/refunds`, { amount: "1.00", reason: "x" }],
    ];
    for (const [method, url, body] of calls) {
      const before = await refusals();
      const r = await dispatch(app, {
        method: method as "GET" | "POST",
        url,
        headers: { ...agent, "idempotency-key": `k-${randomUUID()}` },
        body,
      });
      expect(r.status, url).toBe(403);
      expect(r.body.error.code, url).toBe("FORBIDDEN_ACTION");
      expect(await refusals(), url).toBe(before + 1);
    }
    expect(paypal.count("refundCapture")).toBe(0);
    expect(await count("wallet_refunds")).toBe(0);
  });

  it("Admin refund: operator only, reason required, actor recorded; a buyer is refused", async () => {
    await captured();
    const url = `/v1/admin/wallets/${walletId}/refunds`;

    const buyer = await post(url, user(OWNER), { amount: "5.00", reason: "x" });
    expect(buyer.status).toBe(403);
    const buyerRetry = await refusals();
    expect(buyerRetry).toBeGreaterThanOrEqual(1);

    const noKey = await post(url, user(ADMIN), { amount: "5.00", reason: "dup" }, null);
    expect(noKey.status).toBe(400);
    const noReason = await post(url, user(ADMIN), { amount: "5.00" });
    expect(noReason.status).toBe(400);
    expect(paypal.count("refundCapture")).toBe(0);

    const ok = await post(url, user(ADMIN), { amount: "5.00", reason: "Customer asked" });
    expect(ok.status).toBe(201);
    expect(ok.body.kind).toBe("admin");
    expect(ok.body.actor_role).toBe("admin");
    expect(ok.body.actor_user_id).toBe(ADMIN);
    expect(ok.body.reason).toBe("Customer asked");

    const missing = await post(`/v1/admin/wallets/${randomUUID()}/refunds`, user(ADMIN), {
      amount: "1.00",
      reason: "x",
    });
    expect(missing.status).toBe(404);
  });

  it("remainder-decision: key required, keep makes no PayPal call, repeat returns the stored decision", async () => {
    await captured();
    const m = await dispatch(app, {
      method: "POST",
      url: "/missions",
      headers: BUYER,
      body: { title: `RR ${randomUUID()}`, brief: "x", budget: "500", currency: "USD" },
    });
    expect(m.status).toBe(201);
    const missionId = m.body.id as string;
    await completeMission(db(), {
      tenantId: T,
      missionId,
      actor: { type: "owner", userId: OWNER },
    });
    const url = `/v1/wallet/missions/${missionId}/remainder-decision`;

    expect((await post(url, user(OWNER), { decision: "keep" }, null)).status).toBe(400);
    expect((await post(url, user(OTHER), { decision: "keep" })).status).toBe(403);

    const keep = await post(url, user(OWNER), { decision: "keep" });
    expect(keep.status).toBe(200);
    expect(keep.body.decision).toBe("keep");
    expect(keep.body.refund).toBeNull();
    expect(paypal.count("refundCapture")).toBe(0);

    const again = await post(url, user(OWNER), { decision: "refund" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(keep.body.id);
    expect(again.body.decision).toBe("keep");
  });

  describe("webhook routing", () => {
    let pp: PayPalService;
    beforeEach(() => {
      pp = new PayPalService(db(), new EventsService(db()), paypal);
    });
    const event = (type: string, resource: any, id = `WH-${randomUUID()}`) => ({
      id,
      event_type: type,
      resource,
    });

    async function pendingRefund() {
      await captured();
      paypal.configure({ refundStatus: "PENDING" });
      const r = await post("/v1/wallet/refunds", user(OWNER), { amount: "10.00" });
      expect(r.body.items[0].status).toBe("pending");
      paypal.configure({ refundStatus: "COMPLETED" });
      return r.body;
    }
    const itemStatus = async (id: string) =>
      (await q(`SELECT status FROM wallet_refund_items WHERE id = $1`, [id]))[0].status;

    it("PAYMENT.CAPTURE.REFUNDED syncs the item once; a duplicate event changes nothing", async () => {
      const r = await pendingRefund();
      const item = r.items[0];
      const ev = event("PAYMENT.CAPTURE.REFUNDED", { id: item.paypal_refund_id });
      const res = await pp.handleWebhook({ headers: {}, rawBody: "", payload: ev });
      expect(res).toMatchObject({ valid: true, duplicate: false });
      expect(await itemStatus(item.id)).toBe("completed");
      expect((await get(`/v1/wallet/refunds/${r.id}`, user(OWNER))).body.status).toBe("completed");
      const getRefunds = paypal.count("getRefund");

      const dup = await pp.handleWebhook({ headers: {}, rawBody: "", payload: ev });
      expect(dup.duplicate).toBe(true);
      expect(paypal.count("getRefund")).toBe(getRefunds);
      expect(await count("journal_transactions", "reference LIKE 'wallet:refund:%'")).toBe(1);
    });

    it("a refund event naming only the capture also finds the item (REVERSED)", async () => {
      const r = await pendingRefund();
      const item = r.items[0];
      await pp.handleWebhook({
        headers: {},
        rawBody: "",
        payload: event("PAYMENT.CAPTURE.REVERSED", {
          id: "UNRELATED",
          links: [
            { rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${item.paypal_capture_id}` },
          ],
        }),
      });
      expect(await itemStatus(item.id)).toBe("completed");
    });

    it("an unverified refund event is rejected before anything is read or changed", async () => {
      const r = await pendingRefund();
      paypal.verifyWebhook = async () => false;
      const res = await pp.handleWebhook({
        headers: {},
        rawBody: "",
        payload: event("PAYMENT.CAPTURE.REFUNDED", { id: r.items[0].paypal_refund_id }),
      });
      expect(res.valid).toBe(false);
      expect(await itemStatus(r.items[0].id)).toBe("pending");
      expect(await count("webhook_events")).toBe(0);
    });

    it("a refund event that matches no wallet refund is claimed and changes nothing", async () => {
      await captured();
      const res = await pp.handleWebhook({
        headers: {},
        rawBody: "",
        payload: event("PAYMENT.CAPTURE.REFUNDED", { id: "REFUND-UNKNOWN" }),
      });
      expect(res.valid).toBe(true);
      expect(await count("webhook_events")).toBe(1);
      expect(await count("wallet_refund_items")).toBe(0);
    });
  });
});

// Task 14.2: remainder decision, unlinked and Admin refunds, retry and sweep
// (R8.3, 8.9, 8.10, 8.11, 8.12, 8.14, 8.15, 8.17, 8.19, 12.8, 12.9).
// Uses WalletPayPalDouble: it proves Stoat's handling of stated PayPal responses, not PayPal's
// behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { RefundService } from "../../src/modules/wallet/refund.service.js";
import { completeMission } from "../../src/modules/wallet/mission-completion.service.js";
import { runWalletSweep } from "../../src/modules/wallet/wallet.sweep.js";
import { getBalances } from "../../src/modules/wallet/wallet.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL, BUYER } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const O = SEED_IDS.userId;
const db = () => getDb();

const principal = (
  id: string,
  role: string,
  type: "user" | "agent" = "user",
): AuthenticatedPrincipal => ({
  id,
  tenantId: T,
  type,
  role: role as AuthenticatedPrincipal["role"],
  scopes: [],
  name: "P",
});
const owner = principal(O, "buyer");

async function makeAdmin(role: string) {
  const id = randomUUID();
  await getDb().query(
    `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, $4)`,
    [id, T, `${id}@x.test`, role],
  );
  return principal(id, role);
}

const q = async <R = any>(sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows as R[];
const one = async (sql: string, params: unknown[] = []) =>
  (await q(sql, params))[0];
const count = async (sql: string, params: unknown[] = []) =>
  (await one(sql, params)).n as number;

describe("RefundService decisions, unlinked and Admin refunds, retry, sweep", () => {
  let paypal: WalletPayPalDouble;
  let deposits: DepositService;
  let svc: RefundService;
  let app: any;
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
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [
      SEED_IDS.buyerAgentId,
      O,
    ]);
    paypal = new WalletPayPalDouble();
    app = createApp({ gateway: paypal });
    deposits = new DepositService({ gateway: paypal });
    svc = new RefundService({ gateway: paypal });
  });

  async function captured(amount: string) {
    const v = await deposits.createDeposit({
      tenantId: T,
      owner,
      amount,
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
    await deposits.captureByOrder({
      orderId: v.paypal_order_id!,
      tenantId: T,
      source: "return",
    });
    walletId = v.wallet_id;
    return v.id as string;
  }

  /** Funded wallet plus a completed mission that is awaiting the Owner's decision. */
  async function awaitingMission(funds = "25.00") {
    await captured(funds);
    const m = await dispatch(app, {
      method: "POST",
      url: "/missions",
      headers: BUYER,
      body: { title: `RD ${randomUUID()}`, brief: "x", budget: "500", currency: "USD" },
    });
    expect(m.status).toBe(201);
    const missionId = m.body.id as string;
    const snap = await completeMission(db(), {
      tenantId: T,
      missionId,
      actor: { type: "owner", userId: O },
    });
    expect(snap.state).toBe("awaiting_decision");
    return missionId;
  }

  const funding = async (missionId: string) =>
    (await one(`SELECT state FROM mission_funding WHERE mission_id = $1`, [
      missionId,
    ])).state as string;
  const decide = (
    missionId: string,
    decision: "refund" | "keep",
    extra: Record<string, unknown> = {},
  ) =>
    svc.decideRemainder({
      tenantId: T,
      owner,
      missionId,
      decision,
      idempotencyKey: `d-${randomUUID()}`,
      ...extra,
    });
  const notes = (kind: string) =>
    q(`SELECT * FROM notifications WHERE kind = $1`, [kind]);
  const refusals = () =>
    count(`SELECT count(*)::int AS n FROM audit_logs WHERE outcome = 'refused'`);

  it("keep: no PayPal call, balance kept, mission closed; a repeat with another choice returns the stored decision", async () => {
    const missionId = await awaitingMission();
    const d = await decide(missionId, "keep");
    expect(d.decision).toBe("keep");
    expect(d.refund).toBeNull();
    expect(d.remainder_amount).toBe("25");
    expect(paypal.count("refundCapture")).toBe(0);
    expect(await funding(missionId)).toBe("closed");
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(25);

    const again = await decide(missionId, "refund");
    expect(again.id).toBe(d.id);
    expect(again.decision).toBe("keep");
    expect(paypal.count("refundCapture")).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM remainder_decisions`)).toBe(1);
  });

  it("refund: records decision and plan together, completes, closes the mission, notifies", async () => {
    const missionId = await awaitingMission();
    const d = await decide(missionId, "refund");
    expect(d.decision).toBe("refund");
    expect(d.refund_amount).toBe("25");
    expect(d.refund?.status).toBe("completed");
    expect(d.refund?.kind).toBe("remainder");
    expect(d.refund?.mission_id).toBe(missionId);
    expect(await funding(missionId)).toBe("closed");
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(0);
    expect((await notes("refund_completed")).length).toBe(2);

    const again = await decide(missionId, "keep");
    expect(again.id).toBe(d.id);
    expect(again.decision).toBe("refund");
    expect(paypal.count("refundCapture")).toBe(1);
  });

  it("refund over the Remainder or with bad decimals is refused with no decision and no PayPal call", async () => {
    const missionId = await awaitingMission();
    for (const amount of ["25.01", "0", "1.005", "-1"]) {
      await expect(
        decide(missionId, "refund", { amount }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(paypal.count("refundCapture")).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM remainder_decisions`)).toBe(0);
    expect(await funding(missionId)).toBe("awaiting_decision");
  });

  it("a partial refund amount leaves the rest in the wallet", async () => {
    const missionId = await awaitingMission();
    const d = await decide(missionId, "refund", { amount: "10.00" });
    expect(d.refund_amount).toBe("10");
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(15);
    expect(await funding(missionId)).toBe("closed");
  });

  it("failure keeps awaiting_decision and tells Admins; retry re-issues the failed item with the same request ID and closes", async () => {
    const missionId = await awaitingMission();
    paypal.failNext("refundCapture", {
      times: 1,
      code: "PAYPAL_REQUEST_REJECTED",
      statusCode: 422,
    });
    const d = await decide(missionId, "refund");
    expect(d.refund?.status).toBe("failed");
    expect(await funding(missionId)).toBe("awaiting_decision");
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(25);
    expect((await notes("refund_failed")).length).toBeGreaterThan(0);
    expect((await notes("refund_completed")).length).toBe(0);

    // The same decision repeated is not a retry: nothing is re-issued.
    await decide(missionId, "refund");
    expect(paypal.count("refundCapture")).toBe(1);

    const retried = await svc.retryFailed({
      tenantId: T,
      actor: owner,
      refundId: d.refund!.id,
    });
    expect(retried.status).toBe("completed");
    const ids = paypal.calls
      .filter((c) => c.method === "refundCapture")
      .map((c) => (c.args as any).requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(await funding(missionId)).toBe("closed");
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(0);
    expect((await notes("refund_completed")).length).toBe(2);

    await expect(
      svc.retryFailed({ tenantId: T, actor: owner, refundId: d.refund!.id }),
    ).rejects.toMatchObject({ code: "REFUND_NOTHING_TO_RETRY" });
  });

  it("PENDING keeps the mission awaiting_decision until the sweep sees COMPLETED", async () => {
    const missionId = await awaitingMission();
    paypal.configure({ refundStatus: "PENDING" });
    const d = await decide(missionId, "refund");
    expect(d.refund?.items[0].status).toBe("pending");
    expect(await funding(missionId)).toBe("awaiting_decision");
    const b = await getBalances(db(), walletId);
    expect(Number(b.pendingRefund)).toBe(25);
    expect(Number(b.balance)).toBe(25);

    // Still pending at PayPal: nothing changes.
    expect(await svc.sweep()).toEqual({ checked: 1, completed: 0, failed: 0 });
    expect(await funding(missionId)).toBe("awaiting_decision");

    paypal.configure({ refundStatus: "COMPLETED" });
    expect(await svc.sweep()).toEqual({ checked: 1, completed: 1, failed: 0 });
    // The wallet sweep runs the refund step (no open items: nothing to check).
    expect((await runWalletSweep(db())).refunds).toEqual({
      checked: 0,
      completed: 0,
      failed: 0,
    });
    expect(await funding(missionId)).toBe("closed");
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(0);
    expect(await svc.sweep()).toEqual({ checked: 0, completed: 0, failed: 0 });
  });

  it("refuses agents and non-owners with one audit row each and no PayPal call", async () => {
    const missionId = await awaitingMission();
    const before = await refusals();

    await expect(
      decide(missionId, "refund", {
        owner: principal(SEED_IDS.buyerAgentId, "buyer", "agent"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    expect(await refusals()).toBe(before + 1);

    await expect(
      decide(missionId, "keep", { owner: principal(randomUUID(), "buyer") }),
    ).rejects.toMatchObject({ code: "WALLET_NOT_OWNED" });
    expect(await refusals()).toBe(before + 2);

    expect(paypal.count("refundCapture")).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM remainder_decisions`)).toBe(0);
    expect(await funding(missionId)).toBe("awaiting_decision");
  });

  it("refuses a decision on a mission that is not awaiting one", async () => {
    await captured("25.00");
    const m = await dispatch(app, {
      method: "POST",
      url: "/missions",
      headers: BUYER,
      body: { title: "open", brief: "x", budget: "500", currency: "USD" },
    });
    await expect(decide(m.body.id, "keep")).rejects.toMatchObject({
      code: "MISSION_NOT_AWAITING_DECISION",
    });
  });

  it("unlinked refund defaults to the full Available_Balance and is idempotent", async () => {
    await captured("25.00");
    const key = `u-${randomUUID()}`;
    const a = await svc.refundUnlinked({
      tenantId: T,
      owner,
      walletId,
      idempotencyKey: key,
    });
    expect(a.kind).toBe("unlinked");
    expect(a.amount).toBe("25");
    expect(a.status).toBe("completed");
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(0);
    const b = await svc.refundUnlinked({
      tenantId: T,
      owner,
      walletId,
      idempotencyKey: key,
    });
    expect(b.id).toBe(a.id);
    expect(paypal.count("refundCapture")).toBe(1);
  });

  it("unlinked refund is refused for agents and for another user's wallet", async () => {
    await captured("25.00");
    const before = await refusals();
    await expect(
      svc.refundUnlinked({
        tenantId: T,
        owner: principal(SEED_IDS.buyerAgentId, "buyer", "agent"),
        walletId,
        idempotencyKey: `u-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    await expect(
      svc.refundUnlinked({
        tenantId: T,
        owner: principal(randomUUID(), "buyer"),
        walletId,
        idempotencyKey: `u-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "WALLET_NOT_OWNED" });
    expect(await refusals()).toBe(before + 2);
    expect(paypal.count("refundCapture")).toBe(0);
  });

  it("Admin refund needs a supervisor or operator and a reason, and records the actor", async () => {
    await captured("25.00");
    const admin = await makeAdmin("supervisor");
    const base = {
      tenantId: T,
      walletId,
      amount: "5.00",
      idempotencyKey: `a-${randomUUID()}`,
    };
    const before = await refusals();

    // Wrong role, agent, missing reason: refused, no PayPal call, balance unchanged.
    await expect(
      svc.adminRefund({ ...base, admin: principal(randomUUID(), "buyer"), reason: "why" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    await expect(
      svc.adminRefund({
        ...base,
        admin: principal(randomUUID(), "supervisor", "agent"),
        reason: "why",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    for (const reason of [undefined, "", "   ", "x".repeat(501)]) {
      await expect(
        svc.adminRefund({ ...base, admin, reason }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(await refusals()).toBe(before + 2 + 4);
    expect(paypal.count("refundCapture")).toBe(0);
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(25);

    const v = await svc.adminRefund({ ...base, admin, reason: "customer request" });
    expect(v.kind).toBe("admin");
    expect(v.status).toBe("completed");
    expect(v.reason).toBe("customer request");
    const row = await one(`SELECT actor_user_id, actor_role FROM wallet_refunds WHERE id = $1`, [v.id]);
    expect(row.actor_user_id).toBe(admin.id);
    expect(row.actor_role).toBe("admin");
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(20);
  });

  it("only an Admin retries an Admin refund; the Owner retries their own", async () => {
    await captured("25.00");
    const admin = await makeAdmin("operator");
    paypal.failNext("refundCapture", {
      times: 1,
      code: "PAYPAL_REQUEST_REJECTED",
      statusCode: 422,
    });
    const v = await svc.adminRefund({
      tenantId: T,
      admin,
      walletId,
      amount: "5.00",
      reason: "test",
      idempotencyKey: `a-${randomUUID()}`,
    });
    expect(v.status).toBe("failed");
    const calls = paypal.count("refundCapture");
    await expect(
      svc.retryFailed({ tenantId: T, actor: owner, refundId: v.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    expect(paypal.count("refundCapture")).toBe(calls);
    const done = await svc.retryFailed({ tenantId: T, actor: admin, refundId: v.id });
    expect(done.status).toBe("completed");
  });
});

// Task 17.1: ReconciliationService (R11.1-11.7, 11.11-11.15, 9.13-9.15, 19.1).
// Uses WalletPayPalDouble: it proves Stoat's handling of stated PayPal responses, not PayPal's
// behaviour. Real PayPal behaviour is shown only by Sandbox runs.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { RefundService } from "../../src/modules/wallet/refund.service.js";
import { ReconciliationService } from "../../src/modules/wallet/reconciliation.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import type { GatewayPayout } from "../../src/modules/paypal/paypal.gateway.js";
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

const q = async <R = any>(sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows as R[];
const one = async (sql: string, params: unknown[] = []) =>
  (await q(sql, params))[0];

/** Double whose payout batch reports a chosen item status. */
class PayoutDouble extends WalletPayPalDouble {
  itemStatus = "SUCCESS";
  async getPayout(batchId: string): Promise<GatewayPayout> {
    return {
      batchId,
      batchStatus: "SUCCESS",
      items: [
        {
          senderItemId: "ITEM-1",
          itemId: "PP-ITEM-1",
          status: this.itemStatus,
          reason: null,
        },
      ],
    };
  }
}

describe("ReconciliationService", () => {
  let paypal: WalletPayPalDouble;
  let deposits: DepositService;
  let refunds: RefundService;
  let svc: ReconciliationService;
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
    await db().query(`DELETE FROM reconciliation_exceptions`);
    await db().query(`DELETE FROM reconciliation_runs`);
    await db().query(
      `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`,
      [T, JSON.stringify({ funding_mode: "wallet" })],
    );
    paypal = new WalletPayPalDouble();
    deposits = new DepositService({ gateway: paypal });
    refunds = new RefundService({ gateway: paypal });
    svc = new ReconciliationService({ gateway: paypal, retryDelayMs: 0 });
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
    return v;
  }

  const snapshot = async () => ({
    cache: (
      await one(`SELECT balance_cache::text AS b FROM wallets WHERE id = $1`, [
        walletId,
      ])
    )?.b,
    lines: (await one(`SELECT count(*)::int AS n FROM journal_lines`)).n,
    reservations: (
      await one(`SELECT count(*)::int AS n FROM wallet_reservations`)
    ).n,
  });
  const exceptions = (status?: string) =>
    q(
      `SELECT * FROM reconciliation_exceptions ${status ? "WHERE status = $1" : ""} ORDER BY created_at, id`,
      status ? [status] : [],
    );

  it("records a clean result with counts, a trial balance and one event, and changes no money state", async () => {
    await captured("25.00");
    await refunds.refund({
      tenantId: T,
      walletId,
      kind: "unlinked",
      amount: "10.00",
      actorUserId: O,
      actorRole: "owner",
      idempotencyKey: `r-${randomUUID()}`,
    });
    const before = await snapshot();

    const run = await svc.startRun(T, "admin", O);

    expect(run.status).toBe("clean");
    expect(run.counts).toMatchObject({
      captures: 1,
      refunds: 1,
      payouts: 0,
      new_exceptions: 0,
      unverifiable: 0,
    });
    expect(run.counts.totals.USD.captures).toEqual({
      stoat: "25",
      paypal: "25",
    });
    expect(run.counts.totals.USD.refunds).toEqual({
      stoat: "10",
      paypal: "10",
    });
    expect(run.finished_at).toBeTruthy();
    expect(run.trial_balance.length).toBeGreaterThan(0);
    expect(run.trial_balance.every((r) => r.difference === "0")).toBe(true);
    expect(await snapshot()).toEqual(before);

    const row = await one(
      `SELECT status, counts, trial_balance FROM reconciliation_runs WHERE id = $1`,
      [run.id],
    );
    expect(row.status).toBe("clean");
    expect(row.trial_balance.length).toBeGreaterThan(0);
    const ev = await q(
      `SELECT * FROM economic_events WHERE aggregate_type = 'reconciliation_run' AND aggregate_id = $1`,
      [run.id],
    );
    expect(ev).toHaveLength(1);
    expect(
      await q(
        `SELECT 1 FROM notifications WHERE kind = 'reconciliation_exception'`,
      ),
    ).toHaveLength(0);
    // PayPal figures came from live gateway reads, not from local copies.
    expect(paypal.count("getCapture")).toBe(1);
    expect(paypal.count("getRefund")).toBe(1);
  });

  it("records a signed-difference exception per item, one Admin notification, then resolves it keeping history", async () => {
    await captured("25.00");
    paypal.configure({ captureAmount: "20.00" });

    const run = await svc.startRun(T, "admin", O);
    expect(run.status).toBe("differences");
    const open = await exceptions("open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      item_type: "capture",
      kind: "mismatch",
      currency: "USD",
    });
    expect(Number(open[0].stoat_amount)).toBe(25);
    expect(Number(open[0].paypal_amount)).toBe(20);
    expect(Number(open[0].difference)).toBe(5);
    const notes = await q(
      `SELECT recipient_user_id FROM notifications WHERE kind = 'reconciliation_exception'`,
    );
    expect(notes.length).toBeGreaterThanOrEqual(1);

    // Same difference again: updated in place, no new exception, no new notification.
    const again = await svc.startRun(T, "admin", O);
    expect(again.counts.new_exceptions).toBe(0);
    expect(await exceptions()).toHaveLength(1);
    expect(
      (
        await q(
          `SELECT 1 FROM notifications WHERE kind = 'reconciliation_exception'`,
        )
      ).length,
    ).toBe(notes.length);

    paypal.configure({ captureAmount: null });
    const fixed = await svc.startRun(T, "admin", O);
    expect(fixed.status).toBe("clean");
    expect(fixed.counts.resolved_exceptions).toBe(1);
    const all = await exceptions();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("resolved");
    expect(all[0].resolved_run_id).toBe(fixed.id);
    expect(all[0].resolved_at).toBeTruthy();
  });

  it("retries a failed fetch 3 times, then records unverifiable and marks the run incomplete (never clean)", async () => {
    await captured("25.00");
    paypal.reset();
    paypal.failNext("getCapture", { times: 4 });

    const run = await svc.startRun(T, "admin", O);

    expect(paypal.count("getCapture")).toBe(4);
    expect(run.status).toBe("incomplete");
    expect(run.counts.unverifiable).toBe(1);
    const ex = await exceptions("open");
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ kind: "unverifiable", item_type: "capture" });
    expect(ex[0].detail.attempts).toBe(4);
    expect(
      await q(`SELECT 1 FROM reconciliation_runs WHERE status = 'clean'`),
    ).toHaveLength(0);

    // Verified on the next run: the unverifiable exception resolves.
    const next = await svc.startRun(T, "admin", O);
    expect(next.status).toBe("clean");
    expect((await exceptions())[0].status).toBe("resolved");
  });

  it("a fetch that succeeds within the 3 retries is not an exception", async () => {
    await captured("25.00");
    paypal.reset();
    paypal.failNext("getCapture", { times: 3 });
    const run = await svc.startRun(T, "admin", O);
    expect(paypal.count("getCapture")).toBe(4);
    expect(run.status).toBe("clean");
    expect(await exceptions()).toHaveLength(0);
  });

  it("an unconfigured PayPal gateway leaves items unverifiable, not simulated", async () => {
    await captured("25.00");
    const { UnconfiguredPayPalGateway } =
      await import("../../src/modules/paypal/paypal.gateway.js");
    const res = await new ReconciliationService({
      gateway: new UnconfiguredPayPalGateway(),
      retryDelayMs: 0,
    }).startRun(T, "schedule");
    expect(res.status).toBe("incomplete");
    expect((await exceptions("open"))[0].kind).toBe("unverifiable");
  });

  it("rejects a second run while one is running and leaves the running run unchanged", async () => {
    const running = await one(
      `INSERT INTO reconciliation_runs (tenant_id, trigger, status, paypal_environment)
       VALUES ($1, 'schedule', 'running', 'sandbox') RETURNING id`,
      [T],
    );
    await expect(svc.startRun(T, "admin", O)).rejects.toMatchObject({
      code: "RECONCILIATION_IN_PROGRESS",
    });
    const rows = await q(
      `SELECT id, status, finished_at FROM reconciliation_runs`,
    );
    expect(rows).toEqual([
      { id: running.id, status: "running", finished_at: null },
    ]);
  });

  it("records a stale exception on every run until the deposit is terminal, then resolves it", async () => {
    const v = await deposits.createDeposit({
      tenantId: T,
      owner,
      amount: "12.00",
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
    walletId = v.wallet_id;
    await db().query(
      `UPDATE wallet_deposits SET created_at = now() - interval '25 hours' WHERE id = $1`,
      [v.id],
    );

    const first = await svc.startRun(T, "schedule");
    expect(first.status).toBe("differences");
    expect((await exceptions("open")).map((e) => e.kind)).toEqual(["stale"]);
    const second = await svc.startRun(T, "schedule");
    expect(second.status).toBe("differences");
    expect(second.counts.new_exceptions).toBe(0);
    expect(await exceptions("open")).toHaveLength(1);

    await db().query(
      `UPDATE wallet_deposits SET status = 'cancelled' WHERE id = $1`,
      [v.id],
    );
    const third = await svc.startRun(T, "schedule");
    expect(third.status).toBe("clean");
    expect((await exceptions())[0].status).toBe("resolved");
  });

  it("flags a payout whose PayPal item status differs from Stoat's", async () => {
    const pd = new PayoutDouble();
    const b = await one(
      `INSERT INTO settlement_batches (tenant_id, currency, total_amount, proposed_by)
       VALUES ($1, 'USD', 5, $2) RETURNING id`,
      [T, O],
    );
    await db().query(
      `INSERT INTO payouts (tenant_id, batch_id, agent_id, amount, currency, status, sender_batch_id,
                            provider_batch_id, sender_item_id)
       VALUES ($1, $2, $3, 5, 'USD', 'paid', 'SB-1', 'PB-1', 'ITEM-1')`,
      [T, b.id, SEED_IDS.providerAgentId],
    );
    const s = new ReconciliationService({ gateway: pd, retryDelayMs: 0 });

    expect((await s.startRun(T, "admin", O)).status).toBe("clean");
    pd.itemStatus = "RETURNED";
    const run = await s.startRun(T, "admin", O);
    expect(run.status).toBe("differences");
    const ex = (await exceptions("open"))[0];
    expect(ex).toMatchObject({
      item_type: "payout",
      paypal_id: "PB-1",
      kind: "mismatch",
    });
    expect(ex.detail).toMatchObject({
      stoat_status: "paid",
      paypal_item_status: "RETURNED",
    });
  });

  it("raises a wallet_balance_mismatch once for a drifted wallet and not again while still blocked", async () => {
    await captured("25.00");
    await db().query(`UPDATE wallets SET balance_cache = 99 WHERE id = $1`, [
      walletId,
    ]);
    await svc.startRun(T, "admin", O);
    const count = () =>
      q(
        `SELECT 1 FROM notifications WHERE kind = 'wallet_balance_mismatch'`,
      ).then((r) => r.length);
    const afterFirst = await count();
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    expect(
      (await one(`SELECT status FROM wallets WHERE id = $1`, [walletId]))
        .status,
    ).toBe("blocked");
    await svc.startRun(T, "admin", O);
    expect(await count()).toBe(afterFirst);
  });
});

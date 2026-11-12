// Task 14.1: RefundService plan, submit and finalize (R8.4-8.10, 8.13, 8.16-8.18, 9.5, 16.1, 16.2).
// Uses WalletPayPalDouble: it proves Stoat's handling of stated PayPal responses, not PayPal's
// behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { RefundService } from "../../src/modules/wallet/refund.service.js";
import { getBalances } from "../../src/modules/wallet/wallet.service.js";
import { deriveRefundRequestId } from "../../src/modules/wallet/wallet-math.js";
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

const q = async <R = any>(sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows as R[];
const one = async (sql: string, params: unknown[] = []) =>
  (await q(sql, params))[0];

describe("RefundService plan, submit and finalize", () => {
  let paypal: WalletPayPalDouble;
  let deposits: DepositService;
  let svc: RefundService;
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
    paypal = new WalletPayPalDouble();
    deposits = new DepositService({ gateway: paypal });
    svc = new RefundService({ gateway: paypal });
  });

  /** A captured deposit; `daysAgo` moves its capture time to test ordering and the window. */
  async function captured(amount: string, daysAgo = 0) {
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
    await db().query(
      `UPDATE wallet_deposits SET captured_at = now() - ($2::int * interval '1 day') WHERE id = $1`,
      [v.id, daysAgo],
    );
    return v.id as string;
  }

  const ask = (amount: string, extra: Record<string, unknown> = {}) =>
    svc.refund({
      tenantId: T,
      walletId,
      kind: "unlinked",
      amount,
      actorUserId: O,
      actorRole: "owner",
      idempotencyKey: `r-${randomUUID()}`,
      ...extra,
    });
  const notes = (kind: string) =>
    q(`SELECT * FROM notifications WHERE kind = $1`, [kind]);

  it("COMPLETED: reduces balance, posts Dr 2103 / Cr 1101 tagged with the wallet, notifies", async () => {
    await captured("25.00");
    const v = await ask("10.00");

    expect(v.status).toBe("completed");
    expect(v.items).toHaveLength(1);
    expect(v.items[0].status).toBe("completed");
    expect(v.items[0].paypal_refund_id).toMatch(/^REFUND-/);
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(15);

    const lines = await q(
      `SELECT a.account_code, l.debit, l.credit, l.wallet_id FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
         JOIN journal_transactions t ON t.id = l.transaction_id
        WHERE t.reference = $1 ORDER BY l.sequence`,
      [`wallet:refund:${v.items[0].id}`],
    );
    expect(
      lines.map((l) => [l.account_code, Number(l.debit), Number(l.credit)]),
    ).toEqual([
      ["2103", 10, 0],
      ["1101", 0, 10],
    ]);
    expect(lines[0].wallet_id).toBe(walletId);
    expect(
      await one(
        `SELECT 1 AS x FROM economic_events WHERE event_type = 'WALLET_REFUNDED'`,
      ),
    ).toBeTruthy();
    expect((await notes("refund_completed")).length).toBe(2); // Owner + Admins

    // Request ID is derived only from the group (the refund) and the capture (R8.6).
    const call = paypal.calls.find((c) => c.method === "refundCapture")!;
    expect((call.args as any).requestId).toBe(
      deriveRefundRequestId(v.id, v.items[0].paypal_capture_id),
    );
    expect((call.args as any).amount).toBe("10.00");
  });

  it("splits across captures oldest first and sums exactly", async () => {
    await captured("20.00", 1);
    await captured("10.00", 30);
    const v = await ask("25.00");
    expect(v.items.map((i) => i.amount)).toEqual(["10", "15"]);
    expect(paypal.count("refundCapture")).toBe(2);
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(5);
    // The oldest deposit (10.00) is refunded first, then 15.00 of the newer one.
    const ids = await q(
      `SELECT d.amount FROM wallet_refund_items i JOIN wallet_deposits d ON d.id = i.deposit_id
        WHERE i.refund_id = $1 ORDER BY d.captured_at, d.id`,
      [v.id],
    );
    expect(ids.map((d) => Number(d.amount))).toEqual([10, 20]);
  });

  it("refuses REFUND_EXCEEDS_CAPTURES before any PayPal call and persists nothing", async () => {
    await captured("25.00", 400); // outside the 180 day window
    await expect(ask("5.00")).rejects.toMatchObject({
      code: "REFUND_EXCEEDS_CAPTURES",
    });
    expect(paypal.count("refundCapture")).toBe(0);
    expect((await one(`SELECT count(*)::int AS n FROM wallet_refunds`)).n).toBe(
      0,
    );
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(25);
  });

  it("rejects zero, too many decimals and more than Available with no PayPal call", async () => {
    await captured("25.00");
    for (const amount of ["0", "1.005", "25.01", "-1", "abc"]) {
      await expect(ask(amount)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
    expect(paypal.count("refundCapture")).toBe(0);
    expect((await one(`SELECT count(*)::int AS n FROM wallet_refunds`)).n).toBe(
      0,
    );
  });

  it("PENDING: balance unchanged, amount excluded from Available, then COMPLETED through sync", async () => {
    await captured("25.00");
    paypal.configure({ refundStatus: "PENDING" });
    const v = await ask("10.00");
    expect(v.status).toBe("processing");
    expect(v.items[0].status).toBe("pending");
    const b = await getBalances(db(), walletId);
    expect(Number(b.balance)).toBe(25);
    expect(Number(b.pendingRefund)).toBe(10);
    expect(Number(b.available)).toBe(15);
    expect(
      (
        await one(
          `SELECT count(*)::int AS n FROM journal_transactions WHERE reference LIKE 'wallet:refund:%'`,
        )
      ).n,
    ).toBe(0);

    paypal.configure({ refundStatus: "COMPLETED" });
    expect(await svc.syncItem(v.items[0].id)).toBe("completed");
    // A second trigger changes nothing.
    expect(await svc.syncItem(v.items[0].id)).toBe("unchanged");
    const after = await getBalances(db(), walletId);
    expect(Number(after.balance)).toBe(15);
    expect(Number(after.pendingRefund)).toBe(0);
    expect(
      (
        await one(
          `SELECT count(*)::int AS n FROM journal_transactions WHERE reference LIKE 'wallet:refund:%'`,
        )
      ).n,
    ).toBe(1);
    expect((await q(`SELECT * FROM wallet_refunds`))[0].status).toBe(
      "completed",
    );
  });

  it("FAILED: balance and ledger unchanged, item failed, Admins notified", async () => {
    await captured("25.00");
    paypal.configure({ refundStatus: "FAILED" });
    const v = await ask("10.00");
    expect(v.status).toBe("failed");
    expect(v.items[0].status).toBe("failed");
    const b = await getBalances(db(), walletId);
    expect(Number(b.balance)).toBe(25);
    expect(Number(b.available)).toBe(25);
    expect(
      (
        await one(
          `SELECT count(*)::int AS n FROM journal_transactions WHERE reference LIKE 'wallet:refund:%'`,
        )
      ).n,
    ).toBe(0);
    expect((await notes("refund_failed")).length).toBeGreaterThan(0);
    expect((await notes("refund_completed")).length).toBe(0);
    expect(
      await one(
        `SELECT 1 AS x FROM economic_events WHERE event_type = 'WALLET_REFUND_FAILED'`,
      ),
    ).toBeTruthy();
  });

  it("a rejected PayPal call fails only that item; balance falls by confirmed items only", async () => {
    await captured("20.00", 1);
    await captured("10.00", 30);
    // The first (oldest) call is rejected with a non-retryable error; the second succeeds.
    paypal.failNext("refundCapture", {
      times: 1,
      code: "PAYPAL_REQUEST_REJECTED",
      statusCode: 422,
    });
    const v = await ask("25.00");
    expect(v.status).toBe("partially_completed");
    expect(v.items.map((i) => i.status)).toEqual(["failed", "completed"]);
    expect(v.items[0].failure_reason).toBe("PAYPAL_REQUEST_REJECTED");
    // Only the confirmed 15.00 left the wallet.
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(15);
  });

  it("repeating the Idempotency-Key returns the original and makes no second PayPal call", async () => {
    await captured("25.00");
    const key = `r-${randomUUID()}`;
    const a = await ask("10.00", { idempotencyKey: key });
    const b = await ask("10.00", { idempotencyKey: key });
    expect(b.id).toBe(a.id);
    expect(paypal.count("refundCapture")).toBe(1);
    await expect(ask("11.00", { idempotencyKey: key })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(Number((await getBalances(db(), walletId)).balance)).toBe(15);
  });

  it("has no agent path: a non-human actor role is refused before any row or call", async () => {
    await captured("25.00");
    await expect(ask("10.00", { actorRole: "agent" })).rejects.toMatchObject({
      code: "FORBIDDEN_ACTION",
    });
    expect(paypal.count("refundCapture")).toBe(0);
    expect((await one(`SELECT count(*)::int AS n FROM wallet_refunds`)).n).toBe(
      0,
    );
  });
});

// Task 8.2: DepositService capture, sync, expiry and sweep (R2.15, R3.1-3.7, R3.9-3.11, R3.15-3.19,
// R9.2, R9.6, R16.2, R16.7). Uses WalletPayPalDouble: it proves Stoat's handling of stated PayPal
// responses, not PayPal's behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import {
  DepositService,
  DEPOSIT_MAX_SWEEP_ATTEMPTS,
} from "../../src/modules/wallet/deposit.service.js";
import {
  getBalances,
  getOrCreateWallet,
} from "../../src/modules/wallet/wallet.service.js";
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

describe("DepositService capture, sync, expiry and sweep", () => {
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
    await db().query(
      `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`,
      [T, JSON.stringify({ funding_mode: "wallet" })],
    );
    paypal = new WalletPayPalDouble();
    svc = new DepositService({ gateway: paypal });
  });

  async function newDeposit(amount = "25.00") {
    const v = await svc.createDeposit({
      tenantId: T,
      owner,
      amount,
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
    return { id: v.id, orderId: v.paypal_order_id!, walletId: v.wallet_id };
  }
  const jCount = async (ref: string) =>
    (
      await one(
        `SELECT count(*)::int AS n FROM journal_transactions WHERE reference = $1`,
        [ref],
      )
    ).n;
  const notes = (kind: string) =>
    q(`SELECT * FROM notifications WHERE kind = $1`, [kind]);

  it("COMPLETED with matching amount credits once and posts Dr 1101 / Cr 2103", async () => {
    const d = await newDeposit();
    const v = await svc.captureByOrder({
      orderId: d.orderId,
      tenantId: T,
      source: "return",
    });
    expect(v?.status).toBe("captured");
    expect(v?.credited_amount).toBe("25");

    const dep = await one(`SELECT * FROM wallet_deposits WHERE id = $1`, [
      d.id,
    ]);
    expect(dep.paypal_capture_id).toMatch(/^CAPTURE-/);
    expect(Number(dep.captured_amount)).toBe(25);

    const lines = await q(
      `SELECT a.account_code, l.debit, l.credit, l.wallet_id FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id ORDER BY l.sequence`,
    );
    expect(
      lines.map((l) => [l.account_code, Number(l.debit), Number(l.credit)]),
    ).toEqual([
      ["1101", 25, 0],
      ["2103", 0, 25],
    ]);
    expect(lines[1].wallet_id).toBe(d.walletId);
    const bal = await getBalances(db(), d.walletId);
    expect(Number(bal.balance)).toBe(25);

    expect((await notes("deposit_captured")).length).toBe(2); // Owner + Admins
    expect(
      await one(
        `SELECT 1 AS x FROM economic_events WHERE event_type = 'DEPOSIT_CAPTURED'`,
      ),
    ).toBeTruthy();
    // Request ID is the deterministic one.
    expect(
      paypal.calls.find((c) => c.method === "captureOrder")!.args,
    ).toMatchObject({
      requestId: `wallet-cap-${d.id}`,
    });
  });

  it("posts Dr 5101 / Cr 1101 when PayPal reports a fee", async () => {
    paypal.configure({ paypalFee: "1.25" });
    const d = await newDeposit();
    await svc.captureByOrder({
      orderId: d.orderId,
      tenantId: T,
      source: "webhook",
    });
    expect(await jCount(`wallet:deposit-fee:${d.id}`)).toBe(1);
    const fee = await q(
      `SELECT a.account_code, l.debit, l.credit FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
         JOIN journal_transactions t ON t.id = l.transaction_id
        WHERE t.reference = $1 ORDER BY l.sequence`,
      [`wallet:deposit-fee:${d.id}`],
    );
    expect(
      fee.map((l) => [l.account_code, Number(l.debit), Number(l.credit)]),
    ).toEqual([
      ["5101", 1.25, 0],
      ["1101", 0, 1.25],
    ]);
    // Wallet balance is the full captured amount; the fee is the platform's cost.
    expect(Number((await getBalances(db(), d.walletId)).balance)).toBe(25);
  });

  it("credits exactly once under concurrent and repeated triggers", async () => {
    const d = await newDeposit();
    const results = await Promise.all([
      svc.captureByOrder({ orderId: d.orderId, tenantId: T, source: "return" }),
      svc.captureByOrder({
        orderId: d.orderId,
        tenantId: T,
        source: "webhook",
      }),
      svc.syncDeposit(d.id, "sweep"),
      svc.captureByOrder({ orderId: d.orderId, source: "webhook" }),
    ]);
    for (const r of results) expect(r?.status).toBe("captured");
    expect(await jCount(`wallet:deposit:${d.id}`)).toBe(1);
    expect(
      (
        await one(
          `SELECT count(*)::int AS n FROM journal_lines WHERE wallet_id = $1`,
          [d.walletId],
        )
      ).n,
    ).toBe(1);
    expect(Number((await getBalances(db(), d.walletId)).balance)).toBe(25);
    expect(
      (
        await one(
          `SELECT count(*)::int AS n FROM economic_events WHERE event_type = 'DEPOSIT_CAPTURED'`,
        )
      ).n,
    ).toBe(1);
    expect((await notes("deposit_captured")).length).toBe(2);

    // A later trigger on the terminal deposit makes no PayPal call (R3.18).
    const before = paypal.count("captureOrder") + paypal.count("getOrder");
    const again = await svc.captureByOrder({
      orderId: d.orderId,
      tenantId: T,
      source: "return",
    });
    expect(again?.status).toBe("captured");
    expect(paypal.count("captureOrder") + paypal.count("getOrder")).toBe(
      before,
    );
    expect(await jCount(`wallet:deposit:${d.id}`)).toBe(1);
  });

  it("amount or currency mismatch: no credit, no journal, Admin notice", async () => {
    paypal.configure({ captureAmount: "24.00" });
    const d = await newDeposit();
    const v = await svc.captureByOrder({
      orderId: d.orderId,
      tenantId: T,
      source: "return",
    });
    expect(v?.status).toBe("mismatch");
    expect(v?.credited_amount).toBe("0");
    expect((await one(`SELECT count(*)::int AS n FROM journal_lines`)).n).toBe(
      0,
    );
    const n = await notes("deposit_mismatch");
    expect(n.length).toBe(1);
    expect(n[0].body).toContain(d.id);
    expect(n[0].body).toContain("25");
    expect(n[0].body).toContain("24");

    const d2 = await newDeposit("10.00");
    paypal.configure({ captureAmount: null, captureCurrency: "EUR" });
    const v2 = await svc.captureByOrder({
      orderId: d2.orderId,
      tenantId: T,
      source: "return",
    });
    expect(v2?.status).toBe("mismatch");
  });

  it("PENDING waits without credit; a later sweep credits once COMPLETED", async () => {
    paypal.configure({ captureStatus: "PENDING" });
    const d = await newDeposit();
    const v = await svc.captureByOrder({
      orderId: d.orderId,
      tenantId: T,
      source: "return",
    });
    expect(v?.status).toBe("awaiting_capture");
    expect((await one(`SELECT count(*)::int AS n FROM journal_lines`)).n).toBe(
      0,
    );

    const still = await svc.syncDeposit(d.id, "sweep");
    expect(still.status).toBe("awaiting_capture");

    paypal.configure({ captureStatus: "COMPLETED" });
    const done = await svc.syncDeposit(d.id, "sweep");
    expect(done.status).toBe("captured");
    expect(await jCount(`wallet:deposit:${d.id}`)).toBe(1);
  });

  it("DECLINED, FAILED and a missing capture ID fail the deposit and tell the Owner", async () => {
    paypal.configure({ captureStatus: "DECLINED" });
    const a = await newDeposit();
    expect(
      (
        await svc.captureByOrder({
          orderId: a.orderId,
          tenantId: T,
          source: "return",
        })
      )?.status,
    ).toBe("failed");

    paypal.configure({ captureStatus: "FAILED" });
    const b = await newDeposit("11.00");
    expect(
      (
        await svc.captureByOrder({
          orderId: b.orderId,
          tenantId: T,
          source: "return",
        })
      )?.status,
    ).toBe("failed");

    paypal.configure({ captureStatus: "COMPLETED", returnCaptureId: false });
    const c = await newDeposit("12.00");
    expect(
      (
        await svc.captureByOrder({
          orderId: c.orderId,
          tenantId: T,
          source: "return",
        })
      )?.status,
    ).toBe("failed");

    expect((await notes("deposit_failed")).length).toBe(3);
    expect((await one(`SELECT count(*)::int AS n FROM journal_lines`)).n).toBe(
      0,
    );
  });

  it("rejects unknown, foreign-tenant and mismatched orders with an audit row and no capture call", async () => {
    const d = await newDeposit();
    const calls = () => paypal.count("captureOrder");

    expect(
      await svc.captureByOrder({
        orderId: "NOPE",
        tenantId: T,
        source: "return",
      }),
    ).toBeNull();
    expect(
      await svc.captureByOrder({
        orderId: d.orderId,
        tenantId: randomUUID(),
        source: "webhook",
      }),
    ).toBeNull();
    expect(
      await svc.captureByOrder({
        orderId: d.orderId,
        tenantId: T,
        customId: "wallet:other",
        source: "webhook",
      }),
    ).toBeNull();

    expect(calls()).toBe(0);
    const audits = await q(
      `SELECT * FROM audit_logs WHERE action = 'wallet.deposit.capture'`,
    );
    expect(audits.length).toBe(2); // the foreign-tenant id is not a tenant row, so it cannot be audited
    expect(audits.map((a) => a.reason).sort()).toEqual([
      "custom_id_mismatch",
      "unknown_order",
    ]);
    expect(
      (await one(`SELECT status FROM wallet_deposits WHERE id = $1`, [d.id]))
        .status,
    ).toBe("awaiting_approval");
  });

  it("cancel marks cancelled and leaves the ledger alone", async () => {
    const d = await newDeposit();
    const v = await svc.cancelByOrder({ orderId: d.orderId, tenantId: T });
    expect(v?.status).toBe("cancelled");
    expect((await one(`SELECT count(*)::int AS n FROM journal_lines`)).n).toBe(
      0,
    );
    // Terminal: a late capture trigger does nothing.
    const late = await svc.captureByOrder({
      orderId: d.orderId,
      tenantId: T,
      source: "webhook",
    });
    expect(late?.status).toBe("cancelled");
    expect(paypal.count("captureOrder")).toBe(0);
  });

  it("expires an unapproved order after 3 hours, and expires sooner on a voided order", async () => {
    paypal.configure({ orderStatus: "CREATED" });
    const d = await newDeposit();
    expect((await svc.syncDeposit(d.id, "sweep")).status).toBe(
      "awaiting_approval",
    );
    await db().query(
      `UPDATE wallet_deposits SET created_at = now() - interval '181 minutes' WHERE id = $1`,
      [d.id],
    );
    expect((await svc.syncDeposit(d.id, "sweep")).status).toBe("expired");
    expect((await one(`SELECT count(*)::int AS n FROM journal_lines`)).n).toBe(
      0,
    );

    paypal.configure({ orderStatus: "VOIDED" });
    const e = await newDeposit("9.00");
    expect((await svc.syncDeposit(e.id, "sweep")).status).toBe("expired");
  });

  it("sweep captures an APPROVED order", async () => {
    paypal.configure({ orderStatus: "APPROVED" });
    const d = await newDeposit();
    const r = await svc.sweep();
    expect(r.synced).toBe(1);
    expect(
      (await one(`SELECT status FROM wallet_deposits WHERE id = $1`, [d.id]))
        .status,
    ).toBe("captured");
    expect(await jCount(`wallet:deposit:${d.id}`)).toBe(1);
  });

  it("counts transient failures per sweep and raises deposit_stuck once after 10", async () => {
    paypal.configure({ orderStatus: "APPROVED" });
    const d = await newDeposit();
    paypal.failNext("getOrder", { times: 1000 });
    for (let i = 1; i < DEPOSIT_MAX_SWEEP_ATTEMPTS; i++) {
      await svc.sweep();
      expect(
        (
          await one(
            `SELECT capture_attempts AS n FROM wallet_deposits WHERE id = $1`,
            [d.id],
          )
        ).n,
      ).toBe(i);
    }
    expect((await notes("deposit_stuck")).length).toBe(0);
    await svc.sweep();
    await svc.sweep();
    expect((await notes("deposit_stuck")).length).toBe(1);
    const row = await one(`SELECT status FROM wallet_deposits WHERE id = $1`, [
      d.id,
    ]);
    expect(row.status).toBe("awaiting_approval");
    expect((await one(`SELECT count(*)::int AS n FROM journal_lines`)).n).toBe(
      0,
    );
    // One immediate retry per attempt (R16.4): two getOrder calls per failed sweep.
    expect(paypal.count("getOrder")).toBe(11 * 2);
  });

  it("recovers a stale creating row with the same request ID", async () => {
    const wallet = await getOrCreateWallet(db(), {
      tenantId: T,
      ownerUserId: O,
      currency: "USD",
      environment: "sandbox",
    });
    const id = randomUUID();
    const requestId = "wallet-dep-" + "a".repeat(32);
    await db().query(
      `INSERT INTO wallet_deposits (id, tenant_id, wallet_id, owner_user_id, provider, amount, currency,
          status, idempotency_key, request_hash, paypal_request_id, paypal_environment, created_at)
       VALUES ($1, $2, $3, $4, 'paypal', 40, 'USD', 'creating', 'stale-key', 'h', $5, 'sandbox',
          now() - interval '10 minutes')`,
      [id, T, wallet.id, O, requestId],
    );
    paypal.configure({ orderStatus: "CREATED" }); // not approved, so the same tick does not capture
    const r = await svc.sweep();
    expect(r.recovered).toBe(1);
    const row = await one(`SELECT * FROM wallet_deposits WHERE id = $1`, [id]);
    expect(row.status).toBe("awaiting_approval");
    expect(row.paypal_order_id).toBeTruthy();
    expect(row.approve_url).toBeTruthy();
    const call = paypal.calls.find((c) => c.method === "createOrder")!
      .args as any;
    expect(call.requestId).toBe(requestId);
    expect(call.customId).toBe(`wallet:${id}`);
    expect(call.amount).toBe("40.00");
  });
});

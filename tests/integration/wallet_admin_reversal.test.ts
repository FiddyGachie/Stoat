// Task 16.2: Admin reversing-entry route (R9.11, R9.15, R9.16). Uses WalletPayPalDouble.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { runBalanceCheck } from "../../src/modules/wallet/wallet.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const OWNER = randomUUID();
const ADMIN = SEED_IDS.userId; // seeded operator
const db = () => getDb();
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const user = (id: string) => as(`user:${id}`);
const agent = as(`agent:${SEED_IDS.buyerAgentId}`);
const q = async <R = any>(sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows as R[];

const principal = (id: string): AuthenticatedPrincipal => ({
  id,
  tenantId: T,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
});

describe("admin reversing entry", () => {
  let app: any;
  let paypal: WalletPayPalDouble;

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
    await db().query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, 'rev-o@x.test', 'buyer') ON CONFLICT (id) DO NOTHING`,
      [OWNER, T],
    );
    paypal = new WalletPayPalDouble();
    app = createApp({ gateway: paypal });
  });

  async function deposit(amount: string) {
    const svc = new DepositService({ gateway: paypal });
    const v = await svc.createDeposit({
      tenantId: T,
      owner: principal(OWNER),
      amount,
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
    await svc.captureByOrder({
      orderId: v.paypal_order_id!,
      tenantId: T,
      source: "return",
    });
    const tx = await q<{ id: string }>(
      `SELECT jt.id FROM journal_transactions jt
         JOIN journal_lines l ON l.transaction_id = jt.id
        WHERE l.wallet_id = $1 AND jt.reference NOT LIKE 'reversal:%'
        ORDER BY jt.effective_at DESC, jt.id LIMIT 1`,
      [v.wallet_id],
    );
    return { walletId: v.wallet_id, txId: tx[0].id };
  }
  const reverse = (
    id: string,
    who: Record<string, string>,
    body: unknown = { reason: "operator correction" },
  ) =>
    dispatch(app, {
      method: "POST",
      url: `/v1/admin/journal/transactions/${id}/reverse`,
      headers: who,
      body,
    });
  const wallet = async (id: string) =>
    (
      await q<any>(
        `SELECT status, balance_cache::text AS cache FROM wallets WHERE id = $1`,
        [id],
      )
    )[0];

  it("reversing an ordinary entry on a healthy wallet keeps the cache in step and does not block", async () => {
    await deposit("25.00");
    const d2 = await deposit("10.00");
    const r = await reverse(d2.txId, user(ADMIN));
    expect(r.status).toBe(201);
    expect(r.body.wallets).toEqual([
      { wallet_id: d2.walletId, status: "active", block_lifted: false },
    ]);
    const w = await wallet(d2.walletId);
    expect(w.status).toBe("active");
    expect(Number(w.cache)).toBe(25);
    expect((await runBalanceCheck(db(), d2.walletId)).outcome).toBe("ok");
    const audit = await q(
      `SELECT reason FROM audit_logs WHERE action = 'admin.journal.reverse' AND outcome = 'success'`,
    );
    expect(audit).toEqual([{ reason: "operator correction" }]);
    expect(
      await q(
        `SELECT 1 FROM economic_events WHERE event_type = 'JOURNAL_TRANSACTION_REVERSED' AND aggregate_id = $1`,
        [d2.txId],
      ),
    ).toHaveLength(1);
  });

  it("a block from genuine drift is lifted by the reversing entry that restores equality, with an event", async () => {
    await deposit("25.00");
    const d2 = await deposit("10.00");
    // Real drift: the stored balance no longer matches the ledger.
    await db().query(`UPDATE wallets SET balance_cache = 25 WHERE id = $1`, [
      d2.walletId,
    ]);
    expect((await runBalanceCheck(db(), d2.walletId)).outcome).toBe("blocked");

    const r = await reverse(d2.txId, user(ADMIN));
    expect(r.status).toBe(201);
    expect(r.body.wallets[0]).toMatchObject({
      status: "active",
      block_lifted: true,
    });
    expect((await wallet(d2.walletId)).status).toBe("active");
    expect(
      await q(
        `SELECT 1 FROM economic_events WHERE event_type = 'WALLET_BLOCK_LIFTED' AND aggregate_id = $1`,
        [d2.walletId],
      ),
    ).toHaveLength(1);
  });

  it("keeps the block when the reversal does not restore equality", async () => {
    const d1 = await deposit("25.00");
    await db().query(`UPDATE wallets SET balance_cache = 3 WHERE id = $1`, [
      d1.walletId,
    ]);
    await runBalanceCheck(db(), d1.walletId);
    const r = await reverse(d1.txId, user(ADMIN));
    expect(r.status).toBe(201);
    expect(r.body.wallets[0]).toMatchObject({
      status: "blocked",
      block_lifted: false,
    });
  });

  it("requires a reason, refuses buyers and agents, and rejects a second reversal", async () => {
    const d = await deposit("10.00");
    for (const body of [{}, { reason: "   " }, { reason: "x".repeat(501) }]) {
      expect((await reverse(d.txId, user(ADMIN), body)).status).toBe(400);
    }
    expect((await reverse(d.txId, user(OWNER))).status).toBe(403);
    expect((await reverse(d.txId, agent)).status).toBe(403);
    expect(
      (await q(`SELECT count(*)::int AS n FROM journal_transactions WHERE reference LIKE 'reversal:%'`))[0].n,
    ).toBe(0);
    expect((await reverse(d.txId, user(ADMIN))).status).toBe(201);
    expect((await reverse(d.txId, user(ADMIN))).status).toBe(409);
    expect((await reverse(randomUUID(), user(ADMIN))).status).toBe(404);
  });
});

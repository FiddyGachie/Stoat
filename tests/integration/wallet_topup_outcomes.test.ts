// Task 12.3: top-up capture outcomes and depletion/top-up flows
// (R7.1-7.3, 7.5, 7.9-7.12, 7.20, 7.21). Uses WalletPayPalDouble: it proves Stoat's handling of
// stated PayPal responses, not PayPal's behaviour.
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import {
  getDb,
  resetDb,
  closeDb,
  transaction,
} from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL, BUYER } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import { postJournal } from "../../src/modules/wallet/wallet-ledger.js";
import {
  getBalances,
  getOrCreateWallet,
} from "../../src/modules/wallet/wallet.service.js";
import { recomputeMissionFunding } from "../../src/modules/wallet/mission-funding.service.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { setEmailSender } from "../../src/modules/wallet/notification.service.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const O = SEED_IDS.userId;
const db = () => getDb();
let app: any;

const owner: AuthenticatedPrincipal = {
  id: O,
  tenantId: T,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
};

async function move(walletId: string, dir: "in" | "out", amount: string) {
  const eventId = randomUUID();
  await db().query(
    `INSERT INTO economic_events (id, tenant_id, aggregate_type, aggregate_id, sequence, event_type, actor_type, actor_id, correlation_id, payload_hash)
     VALUES ($1, $2, 'wallet', $3, 1, 'test', 'system', $4, $5, 'h')`,
    [eventId, T, randomUUID(), randomUUID(), randomUUID()],
  );
  await postJournal(db(), {
    tenantId: T,
    eventId,
    reference: `wallet:test:${eventId}`,
    currency: "USD",
    lines:
      dir === "in"
        ? [
            { accountCode: "1101", side: "debit", amount },
            { accountCode: "2103", side: "credit", amount, walletId },
          ]
        : [
            { accountCode: "2103", side: "debit", amount, walletId },
            { accountCode: "2102", side: "credit", amount },
          ],
  });
}

const quoteBody = (missionId: string) => ({
  mission_id: missionId,
  service_id: SEED_IDS.aiServiceId,
  requested_scope: { files: ["src/auth.ts"] },
});

async function acceptNew(missionId: string) {
  const q = await dispatch(app, {
    method: "POST",
    url: "/quotes",
    headers: BUYER,
    body: quoteBody(missionId),
  });
  return dispatch(app, {
    method: "POST",
    url: `/quotes/${q.body.id}/accept`,
    headers: BUYER,
  });
}

const q = async <R = any>(sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows as R[];
const notes = (missionId: string, kind: string) =>
  q(
    `SELECT * FROM notifications WHERE mission_id = $1 AND kind = $2 ORDER BY created_at`,
    [missionId, kind],
  );
const recompute = (id: string) =>
  transaction((tx) => recomputeMissionFunding(tx, id));

describe("top-up capture outcomes and depletion flows", () => {
  let paypal: WalletPayPalDouble;
  let svc: DepositService;
  let sent: Array<unknown>;

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
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','wallet') WHERE id = $1`,
      [T],
    );
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [
      SEED_IDS.buyerAgentId,
      O,
    ]);
    paypal = new WalletPayPalDouble();
    svc = new DepositService({ gateway: paypal });
    app = createApp({ gateway: paypal });
    sent = [];
    setEmailSender(null);
  });
  afterEach(() => setEmailSender(null));

  /** Funded wallet, one accepted agreement, then drained so the mission is depleted. */
  async function depletedMission(opts: { budgetEqualsPrice?: boolean } = {}) {
    const wallet = await getOrCreateWallet(db(), {
      tenantId: T,
      ownerUserId: O,
      currency: "USD",
    });
    await move(wallet.id, "in", "100");
    const m = await dispatch(app, {
      method: "POST",
      url: "/missions",
      headers: BUYER,
      body: {
        title: `TU ${randomUUID()}`,
        brief: "x",
        budget: "500",
        currency: "USD",
      },
    });
    const missionId = m.body.id as string;
    expect((await acceptNew(missionId)).status).toBe(200);
    const price = Number(
      (await q(`SELECT price FROM agreements LIMIT 1`))[0].price,
    );
    await move(wallet.id, "out", (100 - price).toFixed(6));
    if (opts.budgetEqualsPrice) {
      await db().query(`UPDATE missions SET budget = $2 WHERE id = $1`, [
        missionId,
        price,
      ]);
    }
    return { wallet, missionId, price };
  }

  async function topUp(missionId: string, amount: string) {
    const v = await svc.createDeposit({
      tenantId: T,
      owner,
      amount,
      currency: "USD",
      missionId,
      isTopUp: true,
      idempotencyKey: `tu-${randomUUID()}`,
    });
    return { id: v.id, orderId: v.paypal_order_id! };
  }
  const capture = (orderId: string) =>
    svc.captureByOrder({ orderId, tenantId: T, source: "return" });

  it("raises one low_balance notice when funding crosses the threshold", async () => {
    const wallet = await getOrCreateWallet(db(), {
      tenantId: T,
      ownerUserId: O,
      currency: "USD",
    });
    await move(wallet.id, "in", "100");
    const m = await dispatch(app, {
      method: "POST",
      url: "/missions",
      headers: BUYER,
      body: { title: "LB", brief: "x", budget: "500", currency: "USD" },
    });
    const missionId = m.body.id as string;
    await acceptNew(missionId);
    const price = Number(
      (await q(`SELECT price FROM agreements LIMIT 1`))[0].price,
    );
    await move(wallet.id, "out", (100 - price - 1).toFixed(6));
    await recompute(missionId);
    await recompute(missionId);
    expect(await notes(missionId, "low_balance")).toHaveLength(1);
  });

  it("depletion notifies the Owner and every Admin, and refuses new reservations", async () => {
    const { missionId } = await depletedMission();
    expect((await recompute(missionId))?.state).toBe("depleted");
    const dep = await notes(missionId, "depleted");
    const admins = await q<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 AND role IN ('operator','supervisor')`,
      [T],
    );
    const recipients = new Set(dep.map((n) => n.recipient_user_id));
    expect(recipients.has(O)).toBe(true);
    for (const a of admins) expect(recipients.has(a.id)).toBe(true);

    const before = (
      await q(`SELECT count(*)::int AS n FROM wallet_reservations`)
    )[0].n;
    const r = await acceptNew(missionId);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(
      (await q(`SELECT count(*)::int AS n FROM wallet_reservations`))[0].n,
    ).toBe(before);
  });

  it("a captured top-up that covers the shortfall resumes the mission with one topped_up notice", async () => {
    const { wallet, missionId } = await depletedMission();
    await recompute(missionId);
    const d = await topUp(missionId, "50.00");
    expect((await capture(d.orderId))?.status).toBe("captured");
    expect(
      (
        await q(`SELECT state FROM mission_funding WHERE mission_id = $1`, [
          missionId,
        ])
      )[0].state,
    ).toBe("active");
    expect(await notes(missionId, "topped_up")).toHaveLength(1);
    expect(
      Number((await getBalances(db(), wallet.id)).balance),
    ).toBeGreaterThan(50);

    // Duplicate capture trigger: terminal deposit, no second confirmation, no second credit.
    await capture(d.orderId);
    await svc.syncDeposit(d.id, "sweep");
    expect(await notes(missionId, "topped_up")).toHaveLength(1);
    expect(
      (
        await q(
          `SELECT count(*)::int AS n FROM journal_transactions WHERE reference = $1`,
          [`wallet:deposit:${d.id}`],
        )
      )[0].n,
    ).toBe(1);
  });

  it("a top-up that leaves the mission short updates the depletion notice in place and re-emails", async () => {
    const { missionId } = await depletedMission({ budgetEqualsPrice: true });
    await recompute(missionId);
    const first = await notes(missionId, "depleted");
    await db().query(
      `UPDATE notifications SET read_at = now() WHERE mission_id = $1 AND kind = 'depleted'`,
      [missionId],
    );
    setEmailSender({ send: async (m) => void sent.push(m) });

    const d = await topUp(missionId, "0.05");
    expect((await capture(d.orderId))?.status).toBe("captured");

    expect(
      (
        await q(`SELECT state FROM mission_funding WHERE mission_id = $1`, [
          missionId,
        ])
      )[0].state,
    ).toBe("depleted");
    const after = await notes(missionId, "depleted");
    expect(after).toHaveLength(first.length);
    console.log(
      "DBG",
      JSON.stringify(
        after.map((n) => [
          n.recipient_user_id,
          n.body,
          n.read_at,
          n.updated_at,
        ]),
      ),
      JSON.stringify(first.map((n) => n.body)),
    );
    for (const n of after) {
      expect(n.read_at).toBeNull();
      expect(n.updated_at).not.toBeNull();
    }
    expect(after[0].body).not.toBe(first[0].body);
    expect(await notes(missionId, "topped_up")).toHaveLength(0);
    const emails = await q(`SELECT * FROM jobs WHERE type = 'wallet_email'`);
    expect(emails.length).toBeGreaterThanOrEqual(1);
  });

  describe("incomplete top-up", () => {
    async function assertUnchanged(
      missionId: string,
      walletId: string,
      stateBefore: string,
      balBefore: string,
    ) {
      expect(
        (
          await q(`SELECT state FROM mission_funding WHERE mission_id = $1`, [
            missionId,
          ])
        )[0].state,
      ).toBe(stateBefore);
      expect((await getBalances(db(), walletId)).balance).toBe(balBefore);
      const inc = await notes(missionId, "topup_incomplete");
      expect(inc).toHaveLength(1);
      expect(inc[0].recipient_user_id).toBe(O);
      expect(await notes(missionId, "topped_up")).toHaveLength(0);
    }

    it("cancelled: one topup_incomplete, state and balance unchanged", async () => {
      const { wallet, missionId } = await depletedMission();
      await recompute(missionId);
      const bal = (await getBalances(db(), wallet.id)).balance;
      const d = await topUp(missionId, "10.00");
      await svc.cancelByOrder({ orderId: d.orderId, tenantId: T });
      await svc.cancelByOrder({ orderId: d.orderId, tenantId: T });
      await assertUnchanged(missionId, wallet.id, "depleted", bal);
    });

    it("failed capture: one topup_incomplete, no credit", async () => {
      const { wallet, missionId } = await depletedMission();
      await recompute(missionId);
      const bal = (await getBalances(db(), wallet.id)).balance;
      paypal.configure({ captureStatus: "DECLINED" });
      const d = await topUp(missionId, "10.00");
      expect((await capture(d.orderId))?.status).toBe("failed");
      await capture(d.orderId);
      await assertUnchanged(missionId, wallet.id, "depleted", bal);
    });

    it("3-hour expiry: one topup_incomplete, no credit", async () => {
      const { wallet, missionId } = await depletedMission();
      await recompute(missionId);
      const bal = (await getBalances(db(), wallet.id)).balance;
      paypal.configure({ orderStatus: "CREATED" });
      const d = await topUp(missionId, "10.00");
      await db().query(
        `UPDATE wallet_deposits SET created_at = now() - interval '4 hours' WHERE id = $1`,
        [d.id],
      );
      const v = await svc.syncDeposit(d.id, "sweep");
      expect(v.status).toBe("expired");
      await svc.syncDeposit(d.id, "sweep");
      await assertUnchanged(missionId, wallet.id, "depleted", bal);
    });

    it("a plain (non top-up) failed deposit does not send topup_incomplete", async () => {
      paypal.configure({ captureStatus: "DECLINED" });
      const v = await svc.createDeposit({
        tenantId: T,
        owner,
        amount: "10.00",
        currency: "USD",
        idempotencyKey: `k-${randomUUID()}`,
      });
      await capture(v.paypal_order_id!);
      expect(
        await q(`SELECT 1 FROM notifications WHERE kind = 'topup_incomplete'`),
      ).toHaveLength(0);
      expect(
        await q(`SELECT 1 FROM notifications WHERE kind = 'deposit_failed'`),
      ).toHaveLength(1);
    });
  });
});

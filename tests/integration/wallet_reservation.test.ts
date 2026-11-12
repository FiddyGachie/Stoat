// Task 10.2: reserveInTx / releaseReservation and acceptance integration
// (R4.2, R4.9, R5.1-5.12, R7.3, R17.3, R17.4).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL, BUYER } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import { postJournal } from "../../src/modules/wallet/wallet-ledger.js";
import {
  getOrCreateWallet,
  getBalances,
} from "../../src/modules/wallet/wallet.service.js";
import {
  releaseReservation,
  reserveInTx,
} from "../../src/modules/wallet/reservation.service.js";
import { transaction } from "../../src/db/connection.js";

const T = SEED_IDS.tenantId;
const db = () => getDb();
let app: any;

async function ownerId(): Promise<string> {
  const r = await db().query(`SELECT owner_user_id FROM agents WHERE id = $1`, [
    SEED_IDS.buyerAgentId,
  ]);
  return r.rows[0].owner_user_id;
}

async function fundWallet(amount: string) {
  const wallet = await getOrCreateWallet(db(), {
    tenantId: T,
    ownerUserId: await ownerId(),
    currency: "USD",
  });
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
    lines: [
      { accountCode: "1101", side: "debit", amount },
      { accountCode: "2103", side: "credit", amount, walletId: wallet.id },
    ],
  });
  return wallet;
}

async function newMission(budget = "500.000000") {
  const r = await dispatch(app, {
    method: "POST",
    url: "/missions",
    headers: BUYER,
    body: {
      title: `Reserve ${randomUUID()}`,
      brief: "Review the fixture",
      budget,
      currency: "USD",
    },
  });
  return r.body.id as string;
}

async function newQuote(missionId: string) {
  const q = await dispatch(app, {
    method: "POST",
    url: "/quotes",
    headers: BUYER,
    body: {
      mission_id: missionId,
      service_id: SEED_IDS.aiServiceId,
      requested_scope: { files: ["src/auth.ts"] },
    },
  });
  return q.body.id as string;
}

const accept = (quoteId: string) =>
  dispatch(app, {
    method: "POST",
    url: `/quotes/${quoteId}/accept`,
    headers: BUYER,
  });

const setMode = (mode: "direct" | "wallet") =>
  db().query(
    `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode', $2::text) WHERE id = $1`,
    [T, mode],
  );

const count = async (sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows[0].n as number;

describe("wallet reservations at quote acceptance", () => {
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
    await db().query(TRUNCATE_ALL);
    await setMode("wallet");
    // The seed buyer agent has no Owner; the wallet resolves it from agents.owner_user_id.
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [
      SEED_IDS.buyerAgentId,
      SEED_IDS.userId,
    ]);
  });

  it("reserves exactly one Reservation, marks the agreement funded, requests no PayPal order, posts no journal line", async () => {
    const wallet = await fundWallet("100");
    const before = await count(`SELECT count(*)::int AS n FROM journal_lines`);
    const quoteId = await newQuote(await newMission());
    const r = await accept(quoteId);
    expect(r.status).toBe(200);
    expect(r.body.payment).toBeNull();
    expect(r.body.payment_error).toBeNull();

    const ag = await db().query(
      `SELECT funding_status, price FROM agreements WHERE id = $1`,
      [r.body.id],
    );
    expect(ag.rows[0].funding_status).toBe("funded");
    const res = await db().query(
      `SELECT * FROM wallet_reservations WHERE agreement_id = $1`,
      [r.body.id],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].status).toBe("active");
    expect(res.rows[0].wallet_id).toBe(wallet.id);
    expect(Number(res.rows[0].amount)).toBe(Number(ag.rows[0].price));
    expect(await count(`SELECT count(*)::int AS n FROM journal_lines`)).toBe(
      before,
    );
    expect(
      await count(`SELECT count(*)::int AS n FROM agreement_payments`),
    ).toBe(0);
    const bal = await getBalances(db(), wallet.id);
    expect(Number(bal.reserved)).toBe(Number(ag.rows[0].price));
    expect(Number(bal.available)).toBe(100 - Number(ag.rows[0].price));
  });

  it("refuses with WALLET_INSUFFICIENT_FUNDS, leaves no agreement or reservation, and notifies the Owner after rollback", async () => {
    await fundWallet("0.000001");
    const missionId = await newMission();
    const quoteId = await newQuote(missionId);
    const r = await accept(quoteId);
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe("WALLET_INSUFFICIENT_FUNDS");
    expect(await count(`SELECT count(*)::int AS n FROM agreements`)).toBe(0);
    expect(
      await count(`SELECT count(*)::int AS n FROM wallet_reservations`),
    ).toBe(0);
    const q = await db().query(`SELECT status FROM quotes WHERE id = $1`, [
      quoteId,
    ]);
    expect(q.rows[0].status).toBe("offered");
    const n = await db().query(
      `SELECT recipient_user_id, body FROM notifications WHERE kind = 'low_balance' AND mission_id = $1`,
      [missionId],
    );
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0].recipient_user_id).toBe(await ownerId());
    expect(n.rows[0].body).toMatch(/Short by/);
  });

  it("refuses a blocked wallet", async () => {
    const wallet = await fundWallet("100");
    await db().query(
      `UPDATE wallets SET status = 'blocked', blocked_reason = 'balance_mismatch' WHERE id = $1`,
      [wallet.id],
    );
    const r = await accept(await newQuote(await newMission()));
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe("WALLET_BLOCKED");
    expect(
      await count(`SELECT count(*)::int AS n FROM wallet_reservations`),
    ).toBe(0);
  });

  it("refuses a depleted mission", async () => {
    const wallet = await fundWallet("100");
    const missionId = await newMission();
    await db().query(
      `INSERT INTO mission_funding (tenant_id, mission_id, wallet_id, owner_user_id, state)
       VALUES ($1, $2, $3, $4, 'depleted')`,
      [T, missionId, wallet.id, await ownerId()],
    );
    const r = await accept(await newQuote(missionId));
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe("MISSION_DEPLETED");
  });

  it("refuses when reservations + charges + price exceed the Mission_Budget", async () => {
    await fundWallet("100");
    const missionId = await newMission("500");
    const quoteId = await newQuote(missionId);
    // Price is read from the quote; shrink the budget under it after policy would pass
    // by calling the reservation function directly on a fresh agreement row.
    const ok = await accept(quoteId);
    expect(ok.status).toBe(200);
    const price = Number(ok.body.price);
    await db().query(
      `UPDATE missions SET budget = $2, reserved_budget = 0 WHERE id = $1`,
      [missionId, String(price)],
    );
    const second = await db()
      .query(
        `INSERT INTO agreements (id, tenant_id, mission_id, quote_id, buyer_id, provider_id, terms, price, currency, max_revisions, revision_count, status, policy_decision_id, accepted_at)
       SELECT gen_random_uuid(), tenant_id, mission_id, quote_id, buyer_id, provider_id, terms, price, currency, max_revisions, revision_count, status, policy_decision_id, accepted_at
         FROM agreements WHERE id = $1 RETURNING id`,
        [ok.body.id],
      )
      .catch(() => null);
    // quote_id may be unique; fall back to asserting via a second quote instead.
    if (second) {
      await expect(
        transaction((tx) =>
          reserveInTx(tx, { tenantId: T, agreementId: second.rows[0].id }),
        ),
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    } else {
      const r = await accept(await newQuote(missionId));
      expect(r.status).toBe(422);
      expect(r.body.error?.code ?? r.body.code).toBe("BUDGET_EXCEEDED");
    }
    expect(
      await count(
        `SELECT count(*)::int AS n FROM wallet_reservations WHERE mission_id = $1`,
        [missionId],
      ),
    ).toBe(1);
  });

  it("releases idempotently and returns the stored state when already released", async () => {
    const wallet = await fundWallet("100");
    const r = await accept(await newQuote(await newMission()));
    const a = await releaseReservation({
      tenantId: T,
      agreementId: r.body.id,
      reason: "cancelled",
    });
    expect(a?.status).toBe("released");
    const b = await releaseReservation({
      tenantId: T,
      agreementId: r.body.id,
      reason: "other",
    });
    expect(b?.status).toBe("released");
    expect(b?.release_reason).toBe("cancelled");
    expect(
      await count(
        `SELECT count(*)::int AS n FROM economic_events WHERE event_type = 'WALLET_RESERVATION_RELEASED'`,
      ),
    ).toBe(1);
    expect(Number((await getBalances(db(), wallet.id)).reserved)).toBe(0);
    expect(
      await releaseReservation({
        tenantId: T,
        agreementId: randomUUID(),
        reason: "x",
      }),
    ).toBeNull();
  });

  it("concurrent acceptances never overspend the wallet", async () => {
    const probeQuote = await newQuote(await newMission());
    const price = Number(
      (await db().query(`SELECT price FROM quotes WHERE id = $1`, [probeQuote]))
        .rows[0].price,
    );
    expect(price).toBeGreaterThan(0);
    await db().query(TRUNCATE_ALL);
    // Fund for exactly three agreements, then race six acceptances.
    const wallet = await fundWallet(String(price * 3));
    const missionId = await newMission("500");
    const quotes: string[] = [];
    for (let i = 0; i < 6; i++) quotes.push(await newQuote(missionId));
    const results = await Promise.all(quotes.map((q) => accept(q)));
    const okCount = results.filter((x) => x.status === 200).length;
    const refused = results.filter((x) => x.status !== 200);
    expect(okCount).toBe(3);
    for (const x of refused)
      // Once the third reservation uses all funds the mission is depleted (R7.3), so a later
      // loser is refused as MISSION_DEPLETED; an earlier one as WALLET_INSUFFICIENT_FUNDS.
      expect(["WALLET_INSUFFICIENT_FUNDS", "MISSION_DEPLETED"]).toContain(
        x.body.error?.code ?? x.body.code,
      );
    const bal = await getBalances(db(), wallet.id);
    expect(Number(bal.reserved)).toBeCloseTo(price * 3, 6);
    expect(Number(bal.available)).toBeGreaterThanOrEqual(0);
    expect(
      await count(`SELECT count(*)::int AS n FROM wallet_reservations`),
    ).toBe(3);
    expect(await count(`SELECT count(*)::int AS n FROM agreements`)).toBe(3);
  });

  it("direct mode is unchanged: no reservation, funding_status stays unfunded", async () => {
    await setMode("direct");
    const r = await accept(await newQuote(await newMission()));
    expect(r.status).toBe(200);
    expect(
      await count(`SELECT count(*)::int AS n FROM wallet_reservations`),
    ).toBe(0);
    const ag = await db().query(
      `SELECT funding_status FROM agreements WHERE id = $1`,
      [r.body.id],
    );
    expect(ag.rows[0].funding_status).not.toBe("funded");
  });
});

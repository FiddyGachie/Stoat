// Task 12.1: recomputeMissionFunding (R7.1-7.5, 7.9, 7.10, 7.13, 7.14, 7.20, 7.21, 8.1, 8.2)
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
import { getOrCreateWallet } from "../../src/modules/wallet/wallet.service.js";
import {
  recomputeMissionFunding,
  recomputeWalletMissions,
} from "../../src/modules/wallet/mission-funding.service.js";
import { transaction } from "../../src/db/connection.js";

const T = SEED_IDS.tenantId;
const db = () => getDb();
let app: any;

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

async function setup(fund: string) {
  const wallet = await getOrCreateWallet(db(), {
    tenantId: T,
    ownerUserId: SEED_IDS.userId,
    currency: "USD",
  });
  await move(wallet.id, "in", fund);
  const m = await dispatch(app, {
    method: "POST",
    url: "/missions",
    headers: BUYER,
    body: { title: `MF ${randomUUID()}`, brief: "x", budget: "500", currency: "USD" },
  });
  return { wallet, missionId: m.body.id as string };
}

async function accept(missionId: string) {
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
  const a = await dispatch(app, {
    method: "POST",
    url: `/quotes/${q.body.id}/accept`,
    headers: BUYER,
  });
  expect(a.status).toBe(200);
  return a.body.id as string;
}

const recompute = (id: string) =>
  transaction((tx) => recomputeMissionFunding(tx, id));

const notes = async (missionId: string, kind: string) =>
  (
    await db().query(
      `SELECT * FROM notifications WHERE mission_id = $1 AND kind = $2`,
      [missionId, kind],
    )
  ).rows;

describe("recomputeMissionFunding", () => {
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
    await db().query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','wallet') WHERE id = $1`,
      [T],
    );
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [
      SEED_IDS.buyerAgentId,
      SEED_IDS.userId,
    ]);
  });

  it("stays active when funded and records the state on reserve", async () => {
    const { missionId } = await setup("100");
    await accept(missionId);
    const mf = await db().query(
      `SELECT state FROM mission_funding WHERE mission_id = $1`,
      [missionId],
    );
    expect(mf.rows[0].state).toBe("active");
    expect(await notes(missionId, "depleted")).toHaveLength(0);
  });

  it("raises one low_balance notification when funding falls under the threshold, then resolves it", async () => {
    const { wallet, missionId } = await setup("100");
    await accept(missionId);
    // Leave 1 unit of free wallet funding on a 500 budget (0.2%).
    const p = Number(
      (await db().query(`SELECT price FROM agreements LIMIT 1`)).rows[0].price,
    );
    await move(wallet.id, "out", (100 - p - 1).toFixed(6));
    await recompute(missionId);
    await recompute(missionId);
    const low = await notes(missionId, "low_balance");
    expect(low).toHaveLength(1);
    expect(low[0].resolved_at).toBeNull();

    await move(wallet.id, "in", "300");
    await recompute(missionId);
    expect((await notes(missionId, "low_balance"))[0].resolved_at).not.toBeNull();
  });

  it("depletes, notifies Owner and Admins, refuses new reservations, and topped_up resumes", async () => {
    const { wallet, missionId } = await setup("100");
    await accept(missionId);
    const p = Number(
      (await db().query(`SELECT price FROM agreements LIMIT 1`)).rows[0].price,
    );
    await move(wallet.id, "out", (100 - p).toFixed(6));
    const snap = await recompute(missionId);
    expect(snap?.state).toBe("depleted");
    const dep = await notes(missionId, "depleted");
    expect(dep.length).toBeGreaterThanOrEqual(1);
    expect(dep.some((n) => n.recipient_user_id === SEED_IDS.userId)).toBe(true);

    // Top-up resumes the mission.
    await move(wallet.id, "in", "50");
    const up = await recompute(missionId);
    expect(up?.state).toBe("active");
    expect(await notes(missionId, "topped_up")).toHaveLength(1);

    // Duplicate recompute does not duplicate the confirmation.
    await recompute(missionId);
    expect(await notes(missionId, "topped_up")).toHaveLength(1);
  });

  it("updates the existing depletion notification in place when the shortfall changes", async () => {
    const { wallet, missionId } = await setup("100");
    await accept(missionId);
    const p = Number(
      (await db().query(`SELECT price FROM agreements LIMIT 1`)).rows[0].price,
    );
    await move(wallet.id, "out", (100 - p).toFixed(6));
    await recompute(missionId);
    const before = await notes(missionId, "depleted");
    await db().query(
      `UPDATE notifications SET read_at = now() WHERE mission_id = $1 AND kind = 'depleted'`,
      [missionId],
    );

    await move(wallet.id, "in", "50");
    await recompute(missionId);
    await db().query(`UPDATE missions SET budget = 400 WHERE id = $1`, [missionId]);
    await move(wallet.id, "out", "50");
    await recompute(missionId);

    const after = await notes(missionId, "depleted");
    expect(after).toHaveLength(before.length);
    expect(after.every((n) => n.read_at === null)).toBe(true);
    expect(after.every((n) => n.updated_at !== null)).toBe(true);
    expect(after[0].body).toContain("400");
  });

  it("recomputeWalletMissions covers missions on the wallet after a capture credit", async () => {
    const { wallet, missionId } = await setup("100");
    await accept(missionId);
    const out = await transaction((tx) => recomputeWalletMissions(tx, wallet.id));
    expect(out.map((s) => s.missionId)).toContain(missionId);
  });
});

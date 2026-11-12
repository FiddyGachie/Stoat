// Task 12.2: completeMission, mission routes and top-up (R7.4, 7.6-7.8, 8.1, 8.2, 15.2)
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
import { enqueueMissionCompletionJobs } from "../../src/modules/wallet/mission-completion.service.js";
import { runOneJob } from "../../src/jobs/runner.js";

const T = SEED_IDS.tenantId;
const OWNER = randomUUID();
const OTHER = randomUUID();
const db = () => getDb();
const user = (id: string) => ({ authorization: `Bearer user:${id}` });
const agent = { authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` };
let app: any;
let paypal: WalletPayPalDouble;

async function fund(amount: string) {
  const wallet = await getOrCreateWallet(db(), {
    tenantId: T,
    ownerUserId: OWNER,
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
}

async function newMission(budget = "500") {
  const m = await dispatch(app, {
    method: "POST",
    url: "/missions",
    headers: BUYER,
    body: { title: `MC ${randomUUID()}`, brief: "x", budget, currency: "USD" },
  });
  expect(m.status).toBe(201);
  return m.body.id as string;
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

const complete = (id: string, who = user(OWNER)) =>
  dispatch(app, {
    method: "POST",
    url: `/v1/wallet/missions/${id}/complete`,
    headers: who,
  });
const notes = async (missionId: string, kind: string) =>
  (
    await db().query(
      `SELECT * FROM notifications WHERE mission_id = $1 AND kind = $2`,
      [missionId, kind],
    )
  ).rows;
const refusals = async () =>
  (
    await db().query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE outcome = 'refused'`,
    )
  ).rows[0].n as number;

describe("completeMission, mission routes and top-up", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
    paypal = new WalletPayPalDouble();
    app = createApp({ gateway: paypal });
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
    await db()
      .query(`DELETE FROM users WHERE id = ANY($1)`, [[OWNER, OTHER]])
      .catch(() => undefined);
    for (const [id, email] of [
      [OWNER, "mc-owner@x.test"],
      [OTHER, "mc-other@x.test"],
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
  });

  it("shows the mission budget, available, shortfall, reserved, charged and state", async () => {
    await fund("100");
    const id = await newMission();
    await accept(id);
    const price = Number(
      (await db().query(`SELECT price FROM agreements LIMIT 1`)).rows[0].price,
    );
    const r = await dispatch(app, {
      method: "GET",
      url: `/v1/wallet/missions/${id}`,
      headers: user(OWNER),
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      mission_id: id,
      currency: "USD",
      budget: "500",
      charged: "0",
      state: "active",
      mission_status: "created",
    });
    expect(Number(r.body.reserved)).toBeCloseTo(price, 6);
    expect(Number(r.body.available)).toBeCloseTo(100 - price, 6);
    expect(Number(r.body.shortfall)).toBeCloseTo(400 + price, 6);
    expect(JSON.stringify(r.body)).not.toMatch(
      /recipient|payee|owner_user_id/i,
    );

    const list = await dispatch(app, {
      method: "GET",
      url: "/v1/wallet/missions",
      headers: user(OWNER),
    });
    expect(list.body.missions.map((m: any) => m.mission_id)).toContain(id);
    const none = await dispatch(app, {
      method: "GET",
      url: "/v1/wallet/missions",
      headers: user(OTHER),
    });
    expect(none.body.missions).toHaveLength(0);
  });

  it("completes with a remainder: cancels open agreements, releases, awaiting_decision + notice", async () => {
    await fund("100");
    const id = await newMission();
    const agreementId = await accept(id);
    const r = await complete(id);
    expect(r.status).toBe(200);
    expect(r.body.mission_status).toBe("completed");
    expect(r.body.state).toBe("awaiting_decision");
    expect(r.body.reserved).toBe("0");

    const ag = await db().query(`SELECT status FROM agreements WHERE id = $1`, [
      agreementId,
    ]);
    expect(ag.rows[0].status).toBe("cancelled");
    const res = await db().query(
      `SELECT status FROM wallet_reservations WHERE agreement_id = $1`,
      [agreementId],
    );
    expect(res.rows[0].status).toBe("released");
    const n = await notes(id, "mission_completed");
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain("100");
    expect(n[0].body).toMatch(/refund or keep/);
  });

  it("completes with no remainder: closed without a decision prompt, final spend stated", async () => {
    const id = await newMission();
    const r = await complete(id);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("closed");
    const n = await notes(id, "mission_completed");
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain("Final spend");
  });

  it("is idempotent and is the only path to status completed", async () => {
    await fund("10");
    const id = await newMission();
    await complete(id);
    const again = await complete(id);
    expect(again.status).toBe(200);
    expect(await notes(id, "mission_completed")).toHaveLength(1);
    const ev = await db()
      .query(
        `SELECT count(*)::int AS n FROM economic_events WHERE event_type = 'MISSION_COMPLETED' AND payload->>'tenant_id' = $1`,
        [T],
      )
      .catch(() => ({ rows: [{ n: 1 }] }));
    expect(ev.rows[0].n).toBe(1);
  });

  it("refuses agents (audited), other owners and unknown missions; direct mode refuses", async () => {
    const id = await newMission();
    const before = await refusals();
    for (const [method, url] of [
      ["GET", `/v1/wallet/missions/${id}`],
      ["GET", "/v1/wallet/missions"],
      ["POST", `/v1/wallet/missions/${id}/complete`],
      ["POST", `/v1/wallet/missions/${id}/top-up`],
    ] as const) {
      const b = await refusals();
      const r = await dispatch(app, {
        method,
        url,
        headers: { ...agent, "idempotency-key": "k1" },
        body:
          method === "POST"
            ? { amount: "5.00", currency: "USD", payee: "x@y.test" }
            : undefined,
      });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("FORBIDDEN_ACTION");
      expect(await refusals()).toBe(b + 1);
    }
    expect(await refusals()).toBe(before + 4);
    expect(
      (await db().query(`SELECT status FROM missions WHERE id = $1`, [id]))
        .rows[0].status,
    ).toBe("created");
    expect(
      (await db().query(`SELECT count(*)::int AS n FROM wallet_deposits`))
        .rows[0].n,
    ).toBe(0);

    const other = await complete(id, user(OTHER));
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("WALLET_NOT_OWNED");
    expect((await complete(randomUUID())).status).toBe(404);

    await db().query(
      `UPDATE tenants SET settings = settings || '{"funding_mode":"direct"}'::jsonb WHERE id = $1`,
      [T],
    );
    const direct = await complete(id);
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe("WALLET_NOT_ENABLED");
  });

  it("top-up creates a top-up deposit for the mission; server sets is_top_up", async () => {
    const id = await newMission();
    const r = await dispatch(app, {
      method: "POST",
      url: `/v1/wallet/missions/${id}/top-up`,
      headers: { ...user(OWNER), "idempotency-key": "tu-1" },
      body: { amount: "25.00", is_top_up: false },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      mission_id: id,
      is_top_up: true,
      amount: "25",
      currency: "USD",
    });
    const row = (
      await db().query(
        `SELECT is_top_up, owner_user_id FROM wallet_deposits WHERE id = $1`,
        [r.body.id],
      )
    ).rows[0];
    expect(row.is_top_up).toBe(true);
    expect(row.owner_user_id).toBe(OWNER);
  });

  it("top-up rejects a payee, a wrong currency, a bad amount and a completed mission", async () => {
    const id = await newMission();
    const post = (body: any, who = user(OWNER), key = `k-${randomUUID()}`) =>
      dispatch(app, {
        method: "POST",
        url: `/v1/wallet/missions/${id}/top-up`,
        headers: { ...who, "idempotency-key": key },
        body,
      });
    expect(
      (await post({ amount: "5.00", payout_recipient: "x@y.test" })).status,
    ).toBe(400);
    expect((await post({ amount: "5.00", currency: "EUR" })).status).toBe(400);
    expect((await post({ amount: "-5" })).status).toBe(400);
    expect((await post({ amount: "5.00" }, user(OTHER))).status).toBe(403);
    expect(
      (await db().query(`SELECT count(*)::int AS n FROM wallet_deposits`))
        .rows[0].n,
    ).toBe(0);
    await complete(id);
    const done = await post({ amount: "5.00" });
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe("MISSION_NOT_OPEN");
  });

  it("worker completes a mission once it has an agreement and none is live", async () => {
    await fund("100");
    const idle = await newMission();
    const id = await newMission();
    const agreementId = await accept(id);

    expect(await enqueueMissionCompletionJobs(db())).toBe(0); // agreement still live
    await db().query(
      `UPDATE agreements SET status = 'verified' WHERE id = $1`,
      [agreementId],
    );
    expect(await enqueueMissionCompletionJobs(db())).toBe(1);
    expect(await enqueueMissionCompletionJobs(db())).toBe(0); // already queued
    await db().query(
      `DELETE FROM jobs WHERE type <> 'wallet_mission_completion'`,
    );
    expect(await runOneJob(db())).toBe(true);

    const st = async (m: string) =>
      (await db().query(`SELECT status FROM missions WHERE id = $1`, [m]))
        .rows[0].status;
    expect(await st(id)).toBe("completed");
    expect(await st(idle)).toBe("created"); // no agreement, never auto-completed
    expect(await notes(id, "mission_completed")).toHaveLength(1);
  });
});

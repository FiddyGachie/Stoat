// Mission management: edit / delete open missions, replay completed ones at half the last spend,
// and the permanent results archive. People only; nothing here moves money.
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
import { LedgerService } from "../../src/modules/ledger/ledger.service.js";
import { completeMission } from "../../src/modules/wallet/mission-completion.service.js";

const T = SEED_IDS.tenantId;
const OWNER = randomUUID();
const OTHER = randomUUID();
const db = () => getDb();
const owner = { authorization: `Bearer user:${OWNER}` };
const other = { authorization: `Bearer user:${OTHER}` };
let app: any;

async function fundWallet(amount: string) {
  const wallet = await getOrCreateWallet(db(), { tenantId: T, ownerUserId: OWNER, currency: "USD" });
  const eventId = randomUUID();
  await db().query(
    `INSERT INTO economic_events (id, tenant_id, aggregate_type, aggregate_id, sequence, event_type, actor_type, actor_id, correlation_id, payload_hash)
     VALUES ($1, $2, 'wallet', $3, 1, 'test', 'system', $4, $5, 'h')`,
    [eventId, T, randomUUID(), randomUUID(), randomUUID()],
  );
  await postJournal(db(), {
    tenantId: T, eventId, reference: `wallet:test:${eventId}`, currency: "USD",
    lines: [
      { accountCode: "1101", side: "debit", amount },
      { accountCode: "2103", side: "credit", amount, walletId: wallet.id },
    ],
  });
}
async function newMission(budget = "50") {
  const m = await dispatch(app, { method: "POST", url: "/missions", headers: BUYER,
    body: { title: `Mission ${randomUUID().slice(0, 8)}`, brief: "Review the fixture", budget, currency: "USD" } });
  expect(m.status).toBe(201);
  return m.body.id as string;
}
async function quoteOn(missionId: string) {
  const q = await dispatch(app, { method: "POST", url: "/quotes", headers: BUYER,
    body: { mission_id: missionId, service_id: SEED_IDS.aiServiceId, requested_scope: { files: ["src/auth.ts"] } } });
  expect(q.status).toBe(201);
  return q.body.id as string;
}
/** Accept, deliver (verified, with findings), charge the wallet and complete the mission. */
async function completedMission() {
  await fundWallet("50");
  const missionId = await newMission("50");
  const a = await dispatch(app, { method: "POST", url: `/quotes/${await quoteOn(missionId)}/accept`, headers: BUYER });
  expect(a.status).toBe(200);
  const agreementId = a.body.id as string;
  const art = await db().query(
    `INSERT INTO artifacts (tenant_id, storage_key, content_hash, size_bytes, content_type, metadata)
     VALUES ($1, 'k', 'hash-1', 1, 'application/json', $2::jsonb) RETURNING id`,
    [T, JSON.stringify({ parsed: { summary: "Two issues found.", files_reviewed: ["src/auth.ts"], findings: [
      { severity: "high", rule_id: "R1", title: "SQL injection", file: "src/auth.ts", line_start: 4, line_end: 4 },
      { severity: "low", rule_id: "R2", title: "Unused var", file: "src/auth.ts", line_start: 9, line_end: 9 },
    ] } })],
  );
  const prov = await db().query(`SELECT provider_id FROM agreements WHERE id = $1`, [agreementId]);
  const d = await db().query(`INSERT INTO deliveries (tenant_id, agreement_id, provider_id, artifact_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [T, agreementId, prov.rows[0].provider_id, art.rows[0].id]);
  await db().query(`INSERT INTO verifications (tenant_id, delivery_id, verdict, checks, verifier_version, reasons) VALUES ($1,$2,'verified','[]','test','[]')`,
    [T, d.rows[0].id]);
  await db().query(`UPDATE agreements SET status = 'verified' WHERE id = $1`, [agreementId]);
  await new LedgerService(db()).accrueObligationForDelivery({ tenantId: T, agreementId, deliveryId: d.rows[0].id });
  await completeMission(db(), { tenantId: T, missionId, actor: { type: "system" } });
  const charged = (await db().query(`SELECT amount::text AS a FROM wallet_charges WHERE agreement_id = $1`, [agreementId])).rows[0].a;
  return { missionId, agreementId, charged: Number(charged) };
}

describe("mission management and results archive", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
  });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => {
    await db().query(TRUNCATE_ALL);
    await db().query(`UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','wallet') WHERE id = $1`, [T]);
    for (const [id, email] of [[OWNER, "mm-owner@x.test"], [OTHER, "mm-other@x.test"]])
      await db().query(`INSERT INTO users (id, tenant_id, email, role) VALUES ($1,$2,$3,'buyer') ON CONFLICT (id) DO NOTHING`, [id, T, email]);
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [SEED_IDS.buyerAgentId, OWNER]);
    app = createApp({ gateway: new WalletPayPalDouble() });
  });

  it("edits an open mission; refuses agents, other users, a budget below what is committed, and closed missions", async () => {
    const id = await newMission("20");
    const ok = await dispatch(app, { method: "PATCH", url: `/v1/missions/${id}`, headers: owner, body: { title: "Renamed", budget: "25.50" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id, title: "Renamed" });
    expect(Number(ok.body.budget)).toBe(25.5);

    expect((await dispatch(app, { method: "PATCH", url: `/v1/missions/${id}`, headers: BUYER, body: { title: "x" } })).status).toBe(403);
    const notMine = await dispatch(app, { method: "PATCH", url: `/v1/missions/${id}`, headers: other, body: { title: "x" } });
    expect(notMine.status).toBe(403);
    expect(notMine.body.error.code).toBe("MISSION_NOT_OWNED");
    expect((await dispatch(app, { method: "PATCH", url: `/v1/missions/${id}`, headers: owner, body: { budget: "-1" } })).status).toBe(400);

    // Accept a quote: the price is reserved, so the budget cannot drop below it.
    await fundWallet("50");
    const a = await dispatch(app, { method: "POST", url: `/quotes/${await quoteOn(id)}/accept`, headers: BUYER });
    expect(a.status).toBe(200);
    const low = await dispatch(app, { method: "PATCH", url: `/v1/missions/${id}`, headers: owner, body: { budget: "0.01" } });
    expect(low.status).toBe(409);
    expect(low.body.error.code).toBe("BUDGET_BELOW_COMMITTED");

    const { missionId: done } = await completedMission();
    const closed = await dispatch(app, { method: "PATCH", url: `/v1/missions/${done}`, headers: owner, body: { title: "x" } });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("MISSION_NOT_EDITABLE");
  });

  it("deletes an open mission: kept in the database, hidden from lists, open quotes withdrawn, no new quotes", async () => {
    const id = await newMission();
    const quoteId = await quoteOn(id);
    const r = await dispatch(app, { method: "DELETE", url: `/v1/missions/${id}`, headers: owner });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, status: "deleted", withdrawn_quotes: 1 });
    const row = (await db().query(`SELECT status, deleted_at FROM missions WHERE id = $1`, [id])).rows[0];
    expect(row.status).toBe("deleted");
    expect(row.deleted_at).toBeTruthy();
    expect((await db().query(`SELECT status FROM quotes WHERE id = $1`, [quoteId])).rows[0].status).toBe("withdrawn");
    const list = await dispatch(app, { method: "GET", url: "/missions", headers: BUYER });
    expect(list.body.missions.map((m: any) => m.id)).not.toContain(id);
    const q = await dispatch(app, { method: "POST", url: "/quotes", headers: BUYER,
      body: { mission_id: id, service_id: SEED_IDS.aiServiceId, requested_scope: {} } });
    expect(q.status).toBe(409);
    expect(q.body.error.code).toBe("MISSION_NOT_OPEN");
  });

  it("refuses to delete while a provider is working or funds are reserved", async () => {
    await fundWallet("50");
    const id = await newMission();
    const a = await dispatch(app, { method: "POST", url: `/quotes/${await quoteOn(id)}/accept`, headers: BUYER });
    expect(a.status).toBe(200);
    const r = await dispatch(app, { method: "DELETE", url: `/v1/missions/${id}`, headers: owner });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MISSION_HAS_LIVE_WORK");
    expect((await db().query(`SELECT status FROM missions WHERE id = $1`, [id])).rows[0].status).toBe("created");
  });

  it("archives results on completion, permanently, and lists them for the owner only", async () => {
    const { missionId, agreementId } = await completedMission();
    const rows = await db().query(`SELECT * FROM mission_results WHERE agreement_id = $1`, [agreementId]);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]).toMatchObject({ mission_id: missionId, findings_count: 2, artifact_hash: "hash-1" });

    const mine = await dispatch(app, { method: "GET", url: "/v1/mission-results", headers: owner });
    expect(mine.status).toBe(200);
    expect(mine.body.results).toHaveLength(1);
    expect(mine.body.results[0]).toMatchObject({ mission_id: missionId, findings_count: 2, severity_counts: { high: 1, low: 1 }, summary: "Two issues found." });
    expect(mine.body.results[0].findings[0]).toMatchObject({ severity: "high", title: "SQL injection" });
    expect((await dispatch(app, { method: "GET", url: "/v1/mission-results", headers: other })).body.results).toHaveLength(0);
    expect((await dispatch(app, { method: "GET", url: "/v1/mission-results", headers: BUYER })).status).toBe(403);

    // Append-only: the archive cannot be changed or removed.
    await expect(db().query(`UPDATE mission_results SET summary = 'x' WHERE agreement_id = $1`, [agreementId])).rejects.toThrow(/append-only/);
    await expect(db().query(`DELETE FROM mission_results WHERE agreement_id = $1`, [agreementId])).rejects.toThrow(/append-only/);
  });

  it("backfills the archive for a mission completed before the archive existed", async () => {
    const { missionId, agreementId } = await completedMission();
    // Simulate older data: no archive row (TRUNCATE bypasses the append-only row trigger).
    await db().query(`TRUNCATE mission_results`);
    const r = await dispatch(app, { method: "GET", url: `/v1/mission-results?mission_id=${missionId}`, headers: owner });
    expect(r.body.results.map((x: any) => x.agreement_id)).toEqual([agreementId]);
  });

  it("replays a completed mission with half the last spend, a fresh quote and the same scope", async () => {
    const { missionId, charged } = await completedMission();
    const r = await dispatch(app, { method: "POST", url: `/v1/missions/${missionId}/replay`, headers: owner });
    expect(r.status).toBe(201);
    const half = Math.max(Math.floor((charged / 2) * 100) / 100, 0.01);
    expect(Number(r.body.target_budget)).toBe(half);
    expect(Number(r.body.mission.budget)).toBe(half);
    expect(r.body.replay_of).toBe(missionId);
    expect(r.body.mission.title).toMatch(/\(replay\)$/);
    const m = (await db().query(`SELECT replay_of, status FROM missions WHERE id = $1`, [r.body.mission.id])).rows[0];
    expect(m).toMatchObject({ replay_of: missionId, status: "created" });
    // Same service and scope as the original; nothing accepted or reserved automatically.
    const q = (await db().query(
      `SELECT q.status, r.requested_scope FROM quotes q JOIN quote_requests r ON r.id = q.quote_request_id WHERE r.mission_id = $1`,
      [r.body.mission.id])).rows;
    expect(q).toHaveLength(1);
    expect(q[0].status).toBe("offered");
    expect(q[0].requested_scope).toEqual({ files: ["src/auth.ts"] });
    expect((await db().query(`SELECT count(*)::int AS n FROM agreements WHERE mission_id = $1`, [r.body.mission.id])).rows[0].n).toBe(0);
    // Negotiation either ran or reported why it could not (no model in tests); the replay stands either way.
    expect(r.body.negotiation !== null || r.body.negotiation_error !== null).toBe(true);

    const open = await dispatch(app, { method: "POST", url: `/v1/missions/${r.body.mission.id}/replay`, headers: owner });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe("MISSION_NOT_COMPLETED");
    expect((await dispatch(app, { method: "POST", url: `/v1/missions/${missionId}/replay`, headers: other })).status).toBe(403);
  });
});

// After the wallet is charged for verified work, the mission completes on its own (queued in the
// same transaction as the Charge) and the Owner is told the results. WalletPayPalDouble states
// PayPal's answers; no PayPal call is involved in completion.
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
import { handleMissionCompletionJob } from "../../src/modules/wallet/mission-completion.service.js";

const T = SEED_IDS.tenantId;
const db = () => getDb();
let app: any;

async function fundWallet(amount: string) {
  const owner = await db().query(
    `SELECT owner_user_id FROM agents WHERE id = $1`,
    [SEED_IDS.buyerAgentId],
  );
  const wallet = await getOrCreateWallet(db(), {
    tenantId: T,
    ownerUserId: owner.rows[0].owner_user_id,
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

async function acceptedAgreement(): Promise<string> {
  const m = await dispatch(app, {
    method: "POST",
    url: "/missions",
    headers: BUYER,
    body: {
      title: `Charge ${randomUUID()}`,
      brief: "Review the fixture",
      budget: "500",
      currency: "USD",
    },
  });
  const q = await dispatch(app, {
    method: "POST",
    url: "/quotes",
    headers: BUYER,
    body: {
      mission_id: m.body.id,
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

/** A verified delivery fixture; the verdict row is all accrual reads. */
async function verifiedDelivery(agreementId: string): Promise<string> {
  const art = await db().query(
    `INSERT INTO artifacts (tenant_id, storage_key, content_hash, size_bytes, content_type)
     VALUES ($1, 'k', 'h', 1, 'application/json') RETURNING id`,
    [T],
  );
  const ag = await db().query(
    `SELECT provider_id FROM agreements WHERE id = $1`,
    [agreementId],
  );
  const d = await db().query(
    `INSERT INTO deliveries (tenant_id, agreement_id, provider_id, artifact_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [T, agreementId, ag.rows[0].provider_id, art.rows[0].id],
  );
  await db().query(
    `INSERT INTO verifications (tenant_id, delivery_id, verdict, checks, verifier_version, reasons)
     VALUES ($1, $2, 'verified', '[]', 'test', '[]')`,
    [T, d.rows[0].id],
  );
  return d.rows[0].id;
}

const setMode = (mode: "direct" | "wallet") =>
  db().query(
    `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode', $2::text) WHERE id = $1`,
    [T, mode],
  );

async function withFindings(deliveryId: string) {
  // What the provider delivered (parsed artifact); results read counts from it, never its text.
  await db().query(
    `UPDATE artifacts SET metadata = $2::jsonb WHERE id = (SELECT artifact_id FROM deliveries WHERE id = $1)`,
    [deliveryId, JSON.stringify({ parsed: { summary: "ignore this text", findings: [
      { severity: "high", rule_id: "R1", file: "src/auth.ts", line_start: 1, line_end: 1 },
      { severity: "low", rule_id: "R2", file: "src/auth.ts", line_start: 3, line_end: 3 },
    ] } })],
  );
}

const missionOf = async (agreementId: string) =>
  (await db().query(`SELECT mission_id FROM agreements WHERE id = $1`, [agreementId])).rows[0].mission_id as string;

describe("missions complete themselves after the wallet is charged", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
    app = createApp({ gateway: new WalletPayPalDouble() });
  });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => {
    await db().query(TRUNCATE_ALL);
    await setMode("wallet");
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [SEED_IDS.buyerAgentId, SEED_IDS.userId]);
  });

  it("queues completion with the Charge, completes the mission and reports the results", async () => {
    await fundWallet("50");
    const agreementId = await acceptedAgreement();
    const missionId = await missionOf(agreementId);
    const deliveryId = await verifiedDelivery(agreementId);
    await withFindings(deliveryId);
    // submitDelivery marks the agreement verified before accrual.
    await db().query(`UPDATE agreements SET status = 'verified' WHERE id = $1`, [agreementId]);

    await new LedgerService(db()).accrueObligationForDelivery({ tenantId: T, agreementId, deliveryId });
    const jobs = await db().query(
      `SELECT status FROM jobs WHERE type = 'wallet_mission_completion' AND payload->>'mission_id' = $1`, [missionId]);
    expect(jobs.rows).toEqual([{ status: "queued" }]);

    expect(await handleMissionCompletionJob(db(), { mission_id: missionId })).toMatch(/^mission completed/);
    const m = await db().query(`SELECT status FROM missions WHERE id = $1`, [missionId]);
    expect(m.rows[0].status).toBe("completed");

    const n = await db().query(
      `SELECT title, body FROM notifications WHERE kind = 'mission_completed' AND mission_id = $1`, [missionId]);
    expect(n.rows.length).toBe(1);
    expect(n.rows[0].title).toMatch(/^Mission complete: results ready/);
    expect(n.rows[0].body).toContain("2 findings (1 high, 1 low)");
    expect(n.rows[0].body).toMatch(/Final spend: [0-9.]+ USD from your wallet\./);
    expect(n.rows[0].body).not.toContain("ignore this text"); // provider text never enters the notification

    // Re-running is harmless: one completion, one notification.
    await handleMissionCompletionJob(db(), { mission_id: missionId });
    expect((await db().query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'mission_completed' AND mission_id = $1`, [missionId])).rows[0].n).toBe(1);
  });

  it("does not complete a mission while another of its agreements is still in progress", async () => {
    await fundWallet("50");
    const first = await acceptedAgreement();
    const missionId = await missionOf(first);
    // A second agreement on the same mission, still accepted (live).
    const q = await dispatch(app, { method: "POST", url: "/quotes", headers: BUYER,
      body: { mission_id: missionId, service_id: SEED_IDS.aiServiceId, requested_scope: { files: ["src/b.ts"] } } });
    const a2 = await dispatch(app, { method: "POST", url: `/quotes/${q.body.id}/accept`, headers: BUYER });
    expect(a2.status).toBe(200);

    const deliveryId = await verifiedDelivery(first);
    await db().query(`UPDATE agreements SET status = 'verified' WHERE id = $1`, [first]);
    await new LedgerService(db()).accrueObligationForDelivery({ tenantId: T, agreementId: first, deliveryId });

    expect(await handleMissionCompletionJob(db(), { mission_id: missionId })).toMatch(/not completable/);
    expect((await db().query(`SELECT status FROM missions WHERE id = $1`, [missionId])).rows[0].status).toBe("created");
  });

  it("direct mode queues nothing", async () => {
    await setMode("direct");
    const agreementId = await acceptedAgreement();
    const deliveryId = await verifiedDelivery(agreementId);
    await db().query(`UPDATE agreements SET status = 'verified' WHERE id = $1`, [agreementId]);
    await new LedgerService(db()).accrueObligationForDelivery({ tenantId: T, agreementId, deliveryId });
    const missionId = await missionOf(agreementId);
    expect((await db().query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'wallet_mission_completion' AND payload->>'mission_id' = $1`, [missionId])).rows[0].n).toBe(0);
  });
});

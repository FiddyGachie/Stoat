// Task 10.3: release Reservations on final rejection, cancellation and completion
// (R5.8, R6.6, R6.7).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb, transaction } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL, BUYER, PROVIDER } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import { postJournal } from "../../src/modules/wallet/wallet-ledger.js";
import { getOrCreateWallet } from "../../src/modules/wallet/wallet.service.js";
import { cancelOpenAgreementsAndRelease } from "../../src/modules/wallet/reservation.service.js";

const T = SEED_IDS.tenantId;
const db = () => getDb();
let app: any;

async function fundWallet(amount: string) {
  const owner = await db().query(`SELECT owner_user_id FROM agents WHERE id = $1`, [
    SEED_IDS.buyerAgentId,
  ]);
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
}

async function acceptNew(): Promise<{ missionId: string; agreementId: string }> {
  const m = await dispatch(app, {
    method: "POST",
    url: "/missions",
    headers: BUYER,
    body: { title: `Rel ${randomUUID()}`, brief: "Review", budget: "500", currency: "USD" },
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
  const a = await dispatch(app, { method: "POST", url: `/quotes/${q.body.id}/accept`, headers: BUYER });
  expect(a.status).toBe(200);
  return { missionId: m.body.id, agreementId: a.body.id };
}

async function submitBad(agreementId: string) {
  const art = await dispatch(app, {
    method: "POST",
    url: "/artifacts",
    headers: PROVIDER,
    body: {
      findings: [
        { file: "nonexistent.ts", line_start: 1, line_end: 2, snippet: "bad", rule_id: "SEC-002", severity: "high" },
      ],
    },
  });
  return dispatch(app, {
    method: "POST",
    url: "/deliveries",
    headers: PROVIDER,
    body: { agreement_id: agreementId, artifact_id: art.body.id },
  });
}

const reservationStatus = async (agreementId: string) =>
  (await db().query(`SELECT status, release_reason FROM wallet_reservations WHERE agreement_id = $1`, [agreementId]))
    .rows[0];

describe("reservation release on rejection, cancellation and completion", () => {
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
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode', 'wallet') WHERE id = $1`,
      [T],
    );
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [
      SEED_IDS.buyerAgentId,
      SEED_IDS.userId,
    ]);
    await fundWallet("100");
  });

  it("keeps the Reservation on a revisable rejection and releases it when revisions are exhausted", async () => {
    const { agreementId } = await acceptNew();

    const d1 = await submitBad(agreementId);
    expect(d1.body.delivery.status).toBe("rejected");
    expect((await reservationStatus(agreementId)).status).toBe("active");

    for (let i = 0; i < 2; i++) {
      const last = await db().query(
        `SELECT id FROM deliveries WHERE agreement_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [agreementId],
      );
      const rev = await dispatch(app, {
        method: "POST",
        url: `/deliveries/${last.rows[0].id}/revision`,
        headers: BUYER,
        body: { reasons: ["again"] },
      });
      expect(rev.status).toBe(202);
      const d = await submitBad(agreementId);
      expect(d.body.delivery.status).toBe("rejected");
      if (i === 0) expect((await reservationStatus(agreementId)).status).toBe("active");
    }

    const r = await reservationStatus(agreementId);
    expect(r.status).toBe("released");
    expect(r.release_reason).toBe("delivery_rejected_final");
  });

  it("cancelOpenAgreementsAndRelease cancels open agreements, releases, and is idempotent", async () => {
    const { missionId, agreementId } = await acceptNew();
    const ids = await transaction((tx) => cancelOpenAgreementsAndRelease(tx, missionId));
    expect(ids).toEqual([agreementId]);
    const ag = await db().query(`SELECT status FROM agreements WHERE id = $1`, [agreementId]);
    expect(ag.rows[0].status).toBe("cancelled");
    const r = await reservationStatus(agreementId);
    expect(r.status).toBe("released");
    expect(r.release_reason).toBe("mission_completed");
    expect(await transaction((tx) => cancelOpenAgreementsAndRelease(tx, missionId))).toEqual([]);
  });

  it("leaves a needs_review agreement's Reservation until cancellation closes it", async () => {
    const { missionId, agreementId } = await acceptNew();
    await db().query(`UPDATE agreements SET status = 'needs_review' WHERE id = $1`, [agreementId]);
    expect((await reservationStatus(agreementId)).status).toBe("active");
    await transaction((tx) => cancelOpenAgreementsAndRelease(tx, missionId));
    expect((await reservationStatus(agreementId)).status).toBe("released");
  });

  it("does not cancel a settled (verified) agreement", async () => {
    const { missionId, agreementId } = await acceptNew();
    await db().query(`UPDATE agreements SET status = 'verified' WHERE id = $1`, [agreementId]);
    expect(await transaction((tx) => cancelOpenAgreementsAndRelease(tx, missionId))).toEqual([]);
    const ag = await db().query(`SELECT status FROM agreements WHERE id = $1`, [agreementId]);
    expect(ag.rows[0].status).toBe("verified");
  });
});

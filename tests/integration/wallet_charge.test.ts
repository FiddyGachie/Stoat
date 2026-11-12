// Task 11.1: chargeInTx and obligation accrual integration
// (R6.1-6.5, 6.8-6.10, 6.13, 9.3).
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
import { LedgerService } from "../../src/modules/ledger/ledger.service.js";

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

const count = async (sql: string, params: unknown[] = []) =>
  (await db().query(sql, params)).rows[0].n as number;

describe("wallet charge at obligation accrual", () => {
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
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [
      SEED_IDS.buyerAgentId,
      SEED_IDS.userId,
    ]);
  });

  const accrue = (agreementId: string, deliveryId: string) =>
    new LedgerService(db()).accrueObligationForDelivery({
      tenantId: T,
      agreementId,
      deliveryId,
    });

  it("charges exactly the obligation amount, marks the reservation charged and posts Dr 2103 / Cr 2102", async () => {
    const wallet = await fundWallet("100");
    const agreementId = await acceptedAgreement();
    const before = await getBalances(db(), wallet.id);
    const { obligation } = await accrue(
      agreementId,
      await verifiedDelivery(agreementId),
    );

    const ch = await db().query(
      `SELECT * FROM wallet_charges WHERE obligation_id = $1`,
      [obligation.id],
    );
    expect(ch.rows).toHaveLength(1);
    expect(Number(ch.rows[0].amount)).toBe(Number(obligation.amount));
    expect(ch.rows[0].wallet_id).toBe(wallet.id);
    expect(ch.rows[0].agreement_id).toBe(agreementId);
    expect(ch.rows[0].journal_transaction_id).toBeTruthy();

    const res = await db().query(
      `SELECT status FROM wallet_reservations WHERE agreement_id = $1`,
      [agreementId],
    );
    expect(res.rows[0].status).toBe("charged");

    const lines = await db().query(
      `SELECT a.account_code, l.debit, l.credit, l.wallet_id FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
        WHERE l.transaction_id = $1 ORDER BY l.sequence`,
      [ch.rows[0].journal_transaction_id],
    );
    expect(lines.rows.map((r) => r.account_code)).toEqual(["2103", "2102"]);
    expect(lines.rows[0].wallet_id).toBe(wallet.id);
    expect(Number(lines.rows[0].debit)).toBe(Number(obligation.amount));
    expect(Number(lines.rows[1].credit)).toBe(Number(obligation.amount));

    const after = await getBalances(db(), wallet.id);
    expect(Number(after.reserved)).toBe(0);
    expect(Number(after.balance)).toBe(
      Number(before.balance) - Number(obligation.amount),
    );
    expect(
      await count(
        `SELECT count(*)::int AS n FROM economic_events WHERE event_type = 'WALLET_CHARGED'`,
      ),
    ).toBe(1);
  });

  it("fails closed with WALLET_NO_ACTIVE_RESERVATION and rolls back the obligation", async () => {
    await fundWallet("100");
    const agreementId = await acceptedAgreement();
    await db().query(
      `UPDATE wallet_reservations SET status = 'released', release_reason = 'test', closed_at = now() WHERE agreement_id = $1`,
      [agreementId],
    );
    await expect(
      accrue(agreementId, await verifiedDelivery(agreementId)),
    ).rejects.toMatchObject({ code: "WALLET_NO_ACTIVE_RESERVATION" });
    expect(await count(`SELECT count(*)::int AS n FROM obligations`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM wallet_charges`)).toBe(0);
  });

  it("fails closed with CHARGE_LIMIT_EXCEEDED when the obligation exceeds the reservation", async () => {
    await fundWallet("100");
    const agreementId = await acceptedAgreement();
    // Price drifts above the reservation after acceptance.
    await db().query(`UPDATE agreements SET price = price + 1 WHERE id = $1`, [
      agreementId,
    ]);
    await expect(
      accrue(agreementId, await verifiedDelivery(agreementId)),
    ).rejects.toMatchObject({ code: "CHARGE_LIMIT_EXCEEDED" });
    expect(await count(`SELECT count(*)::int AS n FROM obligations`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM wallet_charges`)).toBe(0);
    const res = await db().query(
      `SELECT status FROM wallet_reservations WHERE agreement_id = $1`,
      [agreementId],
    );
    expect(res.rows[0].status).toBe("active");
  });

  it("refuses to charge a blocked wallet", async () => {
    const wallet = await fundWallet("100");
    const agreementId = await acceptedAgreement();
    await db().query(
      `UPDATE wallets SET status = 'blocked', blocked_reason = 'balance_mismatch' WHERE id = $1`,
      [wallet.id],
    );
    await expect(
      accrue(agreementId, await verifiedDelivery(agreementId)),
    ).rejects.toMatchObject({ code: "WALLET_BLOCKED" });
    expect(await count(`SELECT count(*)::int AS n FROM obligations`)).toBe(0);
  });

  it("direct mode creates no charge", async () => {
    await fundWallet("100");
    const agreementId = await acceptedAgreement();
    await setMode("direct");
    await accrue(agreementId, await verifiedDelivery(agreementId));
    expect(await count(`SELECT count(*)::int AS n FROM wallet_charges`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM obligations`)).toBe(1);
  });
});

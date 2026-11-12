// Task 11.2: wallet-aware batch release, payout planning and Money Flow
// (R9.4, 9.20, 17.3, 17.4, 14.1).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL, BUYER, USER } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import { postJournal } from "../../src/modules/wallet/wallet-ledger.js";
import { getOrCreateWallet } from "../../src/modules/wallet/wallet.service.js";
import { LedgerService } from "../../src/modules/ledger/ledger.service.js";
import { FundingService } from "../../src/modules/payments/funding.service.js";
import { PayoutService } from "../../src/modules/payments/payout.service.js";
import { MoneyFlowService } from "../../src/modules/payments/money-flow.service.js";
import { PayPalService } from "../../src/modules/paypal/paypal.service.js";
import { EventsService } from "../../src/modules/events/events.service.js";

const T = SEED_IDS.tenantId;
const db = () => getDb();
let app: any;
const gw = () => new WalletPayPalDouble();

async function fundWallet(amount: string) {
  const owner = await db().query(`SELECT owner_user_id FROM agents WHERE id = $1`, [SEED_IDS.buyerAgentId]);
  const wallet = await getOrCreateWallet(db(), { tenantId: T, ownerUserId: owner.rows[0].owner_user_id, currency: "USD" });
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

async function acceptedAgreement(): Promise<string> {
  const m = await dispatch(app, { method: "POST", url: "/missions", headers: BUYER, body: { title: `B ${randomUUID()}`, brief: "Review", budget: "500", currency: "USD" } });
  const q = await dispatch(app, { method: "POST", url: "/quotes", headers: BUYER, body: { mission_id: m.body.id, service_id: SEED_IDS.aiServiceId, requested_scope: { files: ["src/auth.ts"] } } });
  const a = await dispatch(app, { method: "POST", url: `/quotes/${q.body.id}/accept`, headers: BUYER });
  expect(a.status).toBe(200);
  return a.body.id as string;
}

async function verifiedDelivery(agreementId: string): Promise<string> {
  const art = await db().query(`INSERT INTO artifacts (tenant_id, storage_key, content_hash, size_bytes, content_type) VALUES ($1, 'k', 'h', 1, 'application/json') RETURNING id`, [T]);
  const ag = await db().query(`SELECT provider_id FROM agreements WHERE id = $1`, [agreementId]);
  const d = await db().query(`INSERT INTO deliveries (tenant_id, agreement_id, provider_id, artifact_id) VALUES ($1, $2, $3, $4) RETURNING id`, [T, agreementId, ag.rows[0].provider_id, art.rows[0].id]);
  await db().query(`INSERT INTO verifications (tenant_id, delivery_id, verdict, checks, verifier_version, reasons) VALUES ($1, $2, 'verified', '[]', 'test', '[]')`, [T, d.rows[0].id]);
  return d.rows[0].id;
}

const setMode = (mode: "direct" | "wallet") =>
  db().query(`UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode', $2::text) WHERE id = $1`, [T, mode]);

async function obligationFor(mode: "direct" | "wallet"): Promise<{ id: string; agreementId: string }> {
  await setMode("wallet");
  const agreementId = await acceptedAgreement();
  await setMode(mode);
  const { obligation } = await new LedgerService(db()).accrueObligationForDelivery({ tenantId: T, agreementId, deliveryId: await verifiedDelivery(agreementId) });
  return { id: obligation.id, agreementId };
}

async function approvedBatch(obligationIds: string[]): Promise<string> {
  const p = await dispatch(app, { method: "POST", url: "/settlement/batches", headers: USER, body: { obligation_ids: obligationIds } });
  expect(p.status).toBeLessThan(300);
  await dispatch(app, { method: "POST", url: `/settlement/batches/${p.body.id}/approve`, headers: USER });
  return p.body.id as string;
}

describe("wallet-aware batch release, payout planning and money flow", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
    app = createApp({ gateway: gw() });
  });
  afterAll(async () => {
    await closeDb();
  });
  beforeEach(async () => {
    await db().query(TRUNCATE_ALL);
    await db().query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [SEED_IDS.buyerAgentId, SEED_IDS.userId]);
    await fundWallet("100");
  });

  it("releases a wallet-charged batch without posting 2101 -> 2102, and payout planning is collection-ready", async () => {
    const ob = await obligationFor("wallet");
    const batchId = await approvedBatch([ob.id]);
    const funding = new FundingService(db(), gw());

    const released = await funding.releaseFundedBatch({ tenantId: T, batchId, userId: SEED_IDS.userId });
    expect(released.status).toBe("confirmed");

    const posted = await db().query(`SELECT count(*)::int AS n FROM journal_transactions WHERE reference = $1`, [`release:${batchId}`]);
    expect(posted.rows[0].n).toBe(0);
    const bal = await db().query(`SELECT SUM(debit)::text AS d, SUM(credit)::text AS c FROM journal_lines`);
    expect(bal.rows[0].d).toBe(bal.rows[0].c);

    const plan = await (new PayoutService(db(), gw()) as any).plan(T, batchId);
    expect(plan.collectionReady).toBe(true);
  });

  it("rejects a batch that mixes wallet and direct obligations", async () => {
    const w = await obligationFor("wallet");
    const d = await obligationFor("direct");
    const batchId = await approvedBatch([w.id, d.id]);
    await expect(new FundingService(db(), gw()).releaseFundedBatch({ tenantId: T, batchId, userId: SEED_IDS.userId })).rejects.toThrow(/mixes wallet/);
    const plan = await (new PayoutService(db(), gw()) as any).plan(T, batchId);
    expect(plan.collectionReady).toBe(false);
  });

  it("createOrderForBatch still refuses wallet-funded agreements", async () => {
    const ob = await obligationFor("wallet");
    const batchId = await approvedBatch([ob.id]);
    const pp = new PayPalService(db(), new EventsService(db()), gw());
    await expect(pp.createOrderForBatch({ tenantId: T, batchId, userId: SEED_IDS.userId })).rejects.toMatchObject({ code: "BATCH_ALREADY_FUNDED" });
  });

  it("Money Flow shows the wallet charge for a wallet-funded agreement", async () => {
    const ob = await obligationFor("wallet");
    const flows = (await new MoneyFlowService(db()).list(T)).flows;
    const f = flows.find((x: any) => x.agreement_id === ob.agreementId)!;
    expect(f.wallet_charge).toMatchObject({ currency: "USD", reason_code: expect.any(String) });
    expect(f.wallet_charge!.id).toBeTruthy();
    expect(f.collection).toBeNull();
  });
});

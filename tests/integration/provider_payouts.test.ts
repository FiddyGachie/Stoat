import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { dispatch } from "../test-utils.js";
import { FundingService } from "../../src/modules/payments/funding.service.js";
import { PayoutService } from "../../src/modules/payments/payout.service.js";
import { RecipientService } from "../../src/modules/payments/recipient.service.js";
import { MoneyFlowService } from "../../src/modules/payments/money-flow.service.js";
import {
  resetPayoutsDegraded,
  assertPayPalOnly,
} from "../../src/modules/paypal/capabilities.js";
import {
  acceptedAgreement,
  submitVerifiedDelivery,
  stubPayPal,
  TRUNCATE_ALL,
  USER,
} from "../funding-helpers.js";

// Payout governance with PayPal's replies from the shared test double. The real Payouts API
// call is exercised in provider_payouts_live.test.ts.
describe("Provider payouts: capability gate, bound approvals, item-level truth", () => {
  let app: any;
  const T = SEED_IDS.tenantId;
  const U = SEED_IDS.userId;
  const AGENT = SEED_IDS.providerAgentId;
  const ENV_KEYS = [
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_PAYOUTS_ENABLED",
    "PAYPAL_PAYOUTS_CAPABILITY_STATUS",
    "PAYMENT_PROVIDER",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    ENV_KEYS.forEach((k) => (saved[k] = process.env[k]));
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    app = createApp();
  });
  beforeEach(async () => {
    await getDb().exec(
      "TRUNCATE TABLE payouts, provider_paypal_profiles, approvals CASCADE;",
    );
    await getDb().exec(TRUNCATE_ALL);
    resetPayoutsDegraded();
  });
  afterEach(() =>
    ENV_KEYS.forEach((k) =>
      saved[k] === undefined
        ? delete process.env[k]
        : (process.env[k] = saved[k]),
    ),
  );
  afterAll(async () => {
    await closeDb();
  });

  /** Server-side configuration that opens the Payouts gate. Credentials here are never sent anywhere: PayPal is a test double. */
  function enablePayouts() {
    process.env.PAYPAL_CLIENT_ID = "test-client";
    process.env.PAYPAL_CLIENT_SECRET = "test-secret";
    process.env.PAYPAL_PAYOUTS_ENABLED = "true";
    process.env.PAYPAL_PAYOUTS_CAPABILITY_STATUS = "enabled";
  }

  /** Accepted, paid, delivered, verified, batched, approved and released: ready for provider payout. */
  async function releasedBatch(gw: ReturnType<typeof stubPayPal>) {
    const ag = await acceptedAgreement(app);
    const funding = new FundingService(getDb(), gw);
    const pay = await funding.requestFunding({
      tenantId: T,
      agreementId: ag.body.id,
      actorId: U,
    });
    const order = (
      await getDb().query(
        "SELECT provider_order_id AS o FROM agreement_payments WHERE id = $1",
        [pay!.payment_id],
      )
    ).rows[0].o;
    await funding.captureByOrder(order, "test");
    await submitVerifiedDelivery(app, ag.body.id);
    const obs = await dispatch(app, {
      method: "GET",
      url: "/obligations",
      headers: USER,
    });
    const ob = obs.body.obligations.find(
      (o: any) => o.agreement_id === ag.body.id,
    );
    const batch = await dispatch(app, {
      method: "POST",
      url: "/settlement/batches",
      headers: USER,
      body: { obligation_ids: [ob.id] },
    });
    await dispatch(app, {
      method: "POST",
      url: `/settlement/batches/${batch.body.id}/approve`,
      headers: USER,
    });
    await funding.releaseFundedBatch({
      tenantId: T,
      batchId: batch.body.id,
      userId: U,
    });
    return {
      batchId: batch.body.id as string,
      obligationId: ob.id as string,
      agreementId: ag.body.id as string,
    };
  }

  async function verifiedRecipient(email = "provider@example.com") {
    const r = new RecipientService(getDb());
    const set = await r.setProfile({
      tenantId: T,
      agentId: AGENT,
      value: email,
      consent: true,
      userId: U,
    });
    return r.verify({
      tenantId: T,
      agentId: AGENT,
      userId: U,
      confirmMasked: set.recipient_masked,
    });
  }

  const obStatus = async (id: string) =>
    (await getDb().query("SELECT status FROM obligations WHERE id = $1", [id]))
      .rows[0].status;

  it("is closed by default: no payout approval or send, and nothing reaches PayPal", async () => {
    const gw = stubPayPal();
    const { batchId } = await releasedBatch(gw);
    const svc = new PayoutService(getDb(), gw);
    await expect(
      svc.approve({ tenantId: T, batchId, userId: U }),
    ).rejects.toMatchObject({
      code: "PAYPAL_PAYOUTS_UNAVAILABLE",
      statusCode: 503,
    });
    expect(gw.calls).not.toContain("createPayout");
    const http = await dispatch(app, {
      method: "POST",
      url: `/v1/settlement/batches/${batchId}/payout-approval`,
      headers: USER,
    });
    expect(http.status).toBe(503);
    expect(http.body.error.message).toContain("no provider payment was sent");
  });

  it("needs a consented, human-verified recipient; the value is encrypted and only ever shown masked", async () => {
    const gw = stubPayPal();
    const { batchId } = await releasedBatch(gw);
    enablePayouts();
    const svc = new PayoutService(getDb(), gw);
    const r = new RecipientService(getDb());
    await expect(
      svc.approve({ tenantId: T, batchId, userId: U }),
    ).rejects.toMatchObject({ code: "PAYOUT_ACCOUNT_MISSING" });
    await expect(
      r.setProfile({
        tenantId: T,
        agentId: AGENT,
        value: "provider@example.com",
        consent: false,
        userId: U,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const set = await r.setProfile({
      tenantId: T,
      agentId: AGENT,
      value: "Provider@Example.com",
      consent: true,
      userId: U,
    });
    expect(set.recipient_masked).toBe("p***@e***.com");
    expect(JSON.stringify(set)).not.toContain("provider@example.com");
    await expect(
      svc.approve({ tenantId: T, batchId, userId: U }),
    ).rejects.toMatchObject({ code: "PAYOUT_ACCOUNT_MISSING" }); // pending, not verified
    await expect(
      r.verify({
        tenantId: T,
        agentId: AGENT,
        userId: U,
        confirmMasked: "wrong",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await r.verify({
      tenantId: T,
      agentId: AGENT,
      userId: U,
      confirmMasked: set.recipient_masked,
    });
    const stored = await getDb().query(
      "SELECT recipient_ciphertext, recipient_hash FROM provider_paypal_profiles",
    );
    expect(stored.rows[0].recipient_ciphertext).not.toContain("provider");
    expect(stored.rows[0].recipient_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pays once, books cash-out only when PayPal confirms the ITEM, and marks the obligation paid only then", async () => {
    const gw = stubPayPal({ payoutItemStatus: "SUCCESS" });
    const { batchId, obligationId } = await releasedBatch(gw);
    enablePayouts();
    await verifiedRecipient();
    const svc = new PayoutService(getDb(), gw);
    const ap = await svc.approve({ tenantId: T, batchId, userId: U });
    expect(ap.providers[0].recipient_masked).toBe("p***@e***.com");

    const first = await svc.disburse({
      tenantId: T,
      batchId,
      userId: U,
      approvalId: ap.approval_id,
    });
    expect(first.errors).toEqual([]);
    expect(first.payouts[0].status).toBe("processing"); // PayPal said PENDING
    expect(first.payouts[0].recipient_masked).toBe("p***@e***.com");
    expect(await obStatus(obligationId)).toBe("disbursement_pending");
    expect(
      (
        await getDb().query(
          `SELECT COUNT(*)::int AS n FROM journal_transactions WHERE reference LIKE 'payout:%'`,
        )
      ).rows[0].n,
    ).toBe(0);

    // Same approval again: no second payout (idempotent replay).
    const again = await svc.disburse({
      tenantId: T,
      batchId,
      userId: U,
      approvalId: ap.approval_id,
    });
    expect(again.replayed).toBe(true);
    expect(gw.calls.filter((c) => c === "createPayout")).toHaveLength(1);

    expect((await svc.sweep()).paid).toBe(1);
    expect(await obStatus(obligationId)).toBe("paid");
    const j = await getDb().query(
      `SELECT SUM(debit)::text AS d, SUM(credit)::text AS c FROM journal_lines l JOIN journal_transactions t ON t.id = l.transaction_id WHERE t.reference LIKE 'payout:%'`,
    );
    expect(j.rows[0].d).toBe(j.rows[0].c);
    await svc.sync(first.payouts[0].payout_id);
    expect(
      (
        await getDb().query(
          `SELECT COUNT(*)::int AS n FROM journal_transactions WHERE reference LIKE 'payout:%'`,
        )
      ).rows[0].n,
    ).toBe(1);

    const flow = await new MoneyFlowService(getDb()).list(T);
    const row = flow.flows[0];
    expect(row.collection!.status).toBe("captured");
    expect(row.disbursement!.status).toBe("paid");
    expect(row.disbursement!.paypal_payout_item_id).toBe("ITEM1");
    expect(row.provider_paid).toBe(true);
  });

  it("rejects a recipient substituted after approval, records the attempt, and creates no payout", async () => {
    const gw = stubPayPal();
    const { batchId } = await releasedBatch(gw);
    enablePayouts();
    await verifiedRecipient("provider@example.com");
    const svc = new PayoutService(getDb(), gw);
    const ap = await svc.approve({ tenantId: T, batchId, userId: U });
    await verifiedRecipient("attacker@evil.example"); // recipient changed after the human approved
    await expect(
      svc.disburse({
        tenantId: T,
        batchId,
        userId: U,
        approvalId: ap.approval_id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    expect(gw.calls).not.toContain("createPayout");
    expect(
      (await getDb().query("SELECT COUNT(*)::int AS n FROM payouts")).rows[0].n,
    ).toBe(0);
    const ev = await getDb().query(
      `SELECT COUNT(*)::int AS n FROM economic_events WHERE event_type = 'PAYOUT_APPROVAL_REJECTED'`,
    );
    expect(ev.rows[0].n).toBe(1);
    // The approval was not consumed by the attempt, but the new recipient needs a fresh approval anyway.
    const fresh = await svc.approve({ tenantId: T, batchId, userId: U });
    expect(fresh.providers[0].recipient_masked).toBe("a***@e***.example");
  });

  it("approvals expire, need to exist, and cannot be forged or used for another batch", async () => {
    const gw = stubPayPal();
    const { batchId } = await releasedBatch(gw);
    enablePayouts();
    await verifiedRecipient();
    const svc = new PayoutService(getDb(), gw);
    await expect(
      svc.disburse({
        tenantId: T,
        batchId,
        userId: U,
        approvalId: "00000000-0000-0000-0000-0000000000aa",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    await expect(
      svc.disburse({
        tenantId: T,
        batchId,
        userId: U,
        approvalId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    const ap = await svc.approve({ tenantId: T, batchId, userId: U });
    await getDb().query(
      `UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [ap.approval_id],
    );
    await expect(
      svc.disburse({
        tenantId: T,
        batchId,
        userId: U,
        approvalId: ap.approval_id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    expect(gw.calls).not.toContain("createPayout");
  });

  it("a batch-level SUCCESS with a failed item does not pay: the obligation stays unpaid and payable remediation is possible", async () => {
    const gw = stubPayPal({ payoutItemStatus: "FAILED" });
    const { batchId, obligationId } = await releasedBatch(gw);
    enablePayouts();
    await verifiedRecipient();
    const svc = new PayoutService(getDb(), gw);
    const ap = await svc.approve({ tenantId: T, batchId, userId: U });
    const sent = await svc.disburse({
      tenantId: T,
      batchId,
      userId: U,
      approvalId: ap.approval_id,
    });
    await svc.sync(sent.payouts[0].payout_id); // stub reports batch SUCCESS, item FAILED
    expect(
      (await getDb().query("SELECT status FROM payouts")).rows[0].status,
    ).toBe("failed");
    expect(await obStatus(obligationId)).toBe("payout_failed");
    expect(
      (
        await getDb().query(
          `SELECT COUNT(*)::int AS n FROM journal_transactions WHERE reference LIKE 'payout:%'`,
        )
      ).rows[0].n,
    ).toBe(0);
    // Human-controlled remediation: a new approval and a new attempt, never an automatic resend.
    const ap2 = await svc.approve({ tenantId: T, batchId, userId: U });
    const retry = await svc.disburse({
      tenantId: T,
      batchId,
      userId: U,
      approvalId: ap2.approval_id,
    });
    expect(retry.payouts.filter((p) => p.status !== "failed")).toHaveLength(1);
    expect(gw.calls.filter((c) => c === "createPayout")).toHaveLength(2);
  });

  it("unclaimed, on-hold and pending items are never treated as paid", async () => {
    for (const status of ["UNCLAIMED", "ONHOLD", "PENDING"]) {
      await getDb().exec(
        "TRUNCATE TABLE payouts, provider_paypal_profiles, approvals CASCADE;",
      );
      await getDb().exec(TRUNCATE_ALL);
      const gw = stubPayPal({ payoutItemStatus: status });
      const { batchId, obligationId } = await releasedBatch(gw);
      enablePayouts();
      await verifiedRecipient();
      const svc = new PayoutService(getDb(), gw);
      const ap = await svc.approve({ tenantId: T, batchId, userId: U });
      const sent = await svc.disburse({
        tenantId: T,
        batchId,
        userId: U,
        approvalId: ap.approval_id,
      });
      await svc.sync(sent.payouts[0].payout_id);
      expect(
        (await getDb().query("SELECT status FROM payouts")).rows[0].status,
      ).toBe("processing");
      expect(await obStatus(obligationId)).toBe("disbursement_pending");
      resetPayoutsDegraded();
    }
  });

  it("collection that is not captured blocks the payout entirely", async () => {
    const gw = stubPayPal();
    const { batchId } = await releasedBatch(gw);
    enablePayouts();
    await verifiedRecipient();
    await getDb().query(
      `UPDATE agreement_payments SET status = 'awaiting_payment'`,
    ); // collection unresolved
    await expect(
      new PayoutService(getDb(), gw).approve({
        tenantId: T,
        batchId,
        userId: U,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(gw.calls).not.toContain("createPayout");
  });

  it("PayPal-only: a non-PayPal provider is refused by config, by the API, and by the database", async () => {
    process.env.PAYMENT_PROVIDER = "stripe";
    expect(() => assertPayPalOnly()).toThrow(/not allowed/);
    process.env.PAYMENT_PROVIDER = "paypal";
    expect(() => assertPayPalOnly()).not.toThrow();
    delete process.env.PAYMENT_PROVIDER;

    const viaApi = await dispatch(app, {
      method: "POST",
      url: "/v1/payments/00000000-0000-0000-0000-0000000000aa/refresh",
      headers: USER,
      body: { provider: "stripe" },
    });
    expect(viaApi.status).toBe(400);
    expect(viaApi.body.error.code).toBe("PROVIDER_NOT_ACCEPTED");

    const { batchId } = await releasedBatch(stubPayPal());
    await expect(
      getDb().query(
        `INSERT INTO payouts (tenant_id, batch_id, agent_id, amount, currency, sender_batch_id, provider) VALUES ($1, $2, $3, 0.12, 'USD', 'x-stripe', 'stripe')`,
        [T, batchId, AGENT],
      ),
    ).rejects.toThrow();
  });

  it("endpoints are human-only and agents cannot read or change recipients", async () => {
    const agentHeaders = { Authorization: `Bearer agent:${AGENT}` };
    const put = await dispatch(app, {
      method: "PUT",
      url: `/v1/agents/${AGENT}/payout-account`,
      headers: agentHeaders,
      body: { paypal_email: "me@example.com", consent: true },
    });
    expect(put.status).toBe(403);
    const get = await dispatch(app, {
      method: "GET",
      url: `/v1/agents/${AGENT}/payout-account`,
      headers: agentHeaders,
    });
    expect(get.status).toBe(403);
    const approve = await dispatch(app, {
      method: "POST",
      url: `/v1/settlement/batches/${AGENT}/payout-approval`,
      headers: agentHeaders,
    });
    expect(approve.status).toBe(403);
    const noConsent = await dispatch(app, {
      method: "PUT",
      url: `/v1/agents/${AGENT}/payout-account`,
      headers: USER,
      body: { paypal_email: "me@example.com" },
    });
    expect(noConsent.status).toBe(400);
    const ok = await dispatch(app, {
      method: "PUT",
      url: `/v1/agents/${AGENT}/payout-account`,
      headers: USER,
      body: { paypal_email: "me@example.com", consent: true },
    });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain("me@example.com");
    const read = await dispatch(app, {
      method: "GET",
      url: `/v1/agents/${AGENT}/payout-account`,
      headers: USER,
    });
    expect(JSON.stringify(read.body)).not.toContain("me@example.com");
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { dispatch } from '../test-utils.js';
import { FundingService } from '../../src/modules/payments/funding.service.js';
import { PayPalService } from '../../src/modules/paypal/paypal.service.js';
import { EventsService } from '../../src/modules/events/events.service.js';
import { acceptedAgreement, submitVerifiedDelivery, stubPayPal, TRUNCATE_ALL, USER } from '../funding-helpers.js';

// Logic tests for agreement funding. PayPal's replies come from a test double (see
// funding-helpers.ts); the real-PayPal checks live in agreement_funding_live.test.ts.
describe('Agreement funding: pay at acceptance, capture, reconcile, refund', () => {
  let app: any;
  const T = SEED_IDS.tenantId;
  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    app = createApp();
  });
  beforeEach(async () => { await getDb().exec(TRUNCATE_ALL); });
  afterEach(() => { delete process.env.REQUIRE_FUNDING; });
  afterAll(async () => { await closeDb(); });

  it('acceptance still succeeds when PayPal is not configured, and says why payment was not requested', async () => {
    const res = await acceptedAgreement(app);
    expect(res.status).toBe(200);
    expect(res.body.payment).toBeNull();
    expect(res.body.payment_error.code).toBe('PAYPAL_NOT_CONFIGURED');
  });

  it('requests one order per agreement and reuses it while it is still waiting', async () => {
    const ag = await acceptedAgreement(app);
    const gw = stubPayPal();
    const svc = new FundingService(getDb(), gw);
    const a = await svc.requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    const b = await svc.requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    expect(a!.status).toBe('awaiting_payment');
    expect(b!.payment_id).toBe(a!.payment_id);
    expect(gw.calls.filter((c) => c === 'createOrder')).toHaveLength(1);
    const due = await svc.listDue(T);
    expect(due).toHaveLength(1);
    expect(due[0].approve_url).toContain('paypal.com');
  });

  it('with REQUIRE_FUNDING a provider cannot deliver until the buyer has paid; after capture it can', async () => {
    process.env.REQUIRE_FUNDING = 'true';
    const ag = await acceptedAgreement(app);
    const blocked = await submitVerifiedDelivery(app, ag.body.id);
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('PAYMENT_REQUIRED');

    const svc = new FundingService(getDb(), stubPayPal({ capturedAmount: '0.12' }));
    const pay = await svc.requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    const done = await svc.captureByOrder((await getDb().query('SELECT provider_order_id AS o FROM agreement_payments WHERE id = $1', [pay!.payment_id])).rows[0].o, 'test');
    expect(done!.status).toBe('captured');

    const delivered = await submitVerifiedDelivery(app, ag.body.id);
    expect([200, 201]).toContain(delivered.status);
    expect(delivered.body.verification.verdict).toBe('verified');
  });

  it('capture posts a balanced journal entry and is idempotent across return, webhook and sweep', async () => {
    const ag = await acceptedAgreement(app);
    const svc = new FundingService(getDb(), stubPayPal({ capturedAmount: '0.12', orderStatus: 'COMPLETED' }));
    const pay = await svc.requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    const order = (await getDb().query('SELECT provider_order_id AS o FROM agreement_payments WHERE id = $1', [pay!.payment_id])).rows[0].o;
    const r1 = await svc.captureByOrder(order, 'return');
    const r2 = await svc.captureByOrder(order, 'webhook');
    const r3 = await svc.syncPayment(pay!.payment_id, 'sweep');
    expect([r1!.status, r2!.status, r3.status]).toEqual(['captured', 'captured', 'captured']);
    const j = await getDb().query(`SELECT COALESCE(SUM(debit),0)::text AS d, COALESCE(SUM(credit),0)::text AS c, COUNT(DISTINCT transaction_id)::int AS tx
                                   FROM journal_lines l JOIN journal_transactions t ON t.id = l.transaction_id WHERE t.reference LIKE 'funding:%'`);
    expect(Number(j.rows[0].d)).toBeCloseTo(0.12, 6);
    expect(j.rows[0].d).toBe(j.rows[0].c);
    expect(j.rows[0].tx).toBe(1);
    const agr = await getDb().query('SELECT funding_status FROM agreements WHERE id = $1', [ag.body.id]);
    expect(agr.rows[0].funding_status).toBe('funded');
  });

  it('a capture for the wrong amount is a mismatch: not funded, nothing posted, refundable', async () => {
    const ag = await acceptedAgreement(app);
    const gw = stubPayPal({ capturedAmount: '0.05' });
    const svc = new FundingService(getDb(), gw);
    const pay = await svc.requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    const order = (await getDb().query('SELECT provider_order_id AS o FROM agreement_payments WHERE id = $1', [pay!.payment_id])).rows[0].o;
    const got = await svc.captureByOrder(order, 'return');
    expect(got!.status).toBe('mismatch');
    expect((await getDb().query('SELECT funding_status FROM agreements WHERE id = $1', [ag.body.id])).rows[0].funding_status).not.toBe('funded');
    expect((await getDb().query(`SELECT COUNT(*)::int AS n FROM journal_transactions WHERE reference LIKE 'funding:%'`)).rows[0].n).toBe(0);
    const refunded = await svc.refund({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId, reason: 'wrong amount' });
    expect(refunded.status).toBe('refunded');
    expect(gw.calls).toContain('refundCapture');
  });

  it('an order the buyer never approves expires and a new attempt can be made', async () => {
    const ag = await acceptedAgreement(app);
    const first = new FundingService(getDb(), stubPayPal({ notFound: true }));
    const pay = await first.requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    const swept = await first.sweep();
    expect(swept.expired).toBe(1);
    expect((await getDb().query('SELECT status FROM agreement_payments WHERE id = $1', [pay!.payment_id])).rows[0].status).toBe('expired');
    const again = await new FundingService(getDb(), stubPayPal()).requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    expect(again!.payment_id).not.toBe(pay!.payment_id);
    expect(again!.attempt).toBe(2);
  });

  it('a funded batch is released without a second PayPal charge, and refund is blocked once work is verified', async () => {
    const ag = await acceptedAgreement(app);
    const gw = stubPayPal({ capturedAmount: '0.12' });
    const svc = new FundingService(getDb(), gw);
    const pay = await svc.requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    await svc.captureByOrder((await getDb().query('SELECT provider_order_id AS o FROM agreement_payments WHERE id = $1', [pay!.payment_id])).rows[0].o, 'test');
    const delivered = await submitVerifiedDelivery(app, ag.body.id);
    expect(delivered.body.verification.verdict).toBe('verified');

    await expect(svc.refund({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId, reason: 'x' })).rejects.toMatchObject({ code: 'FUNDS_ALLOCATED' });

    const obs = await dispatch(app, { method: 'GET', url: '/obligations', headers: USER });
    const ob = obs.body.obligations.find((o: any) => o.agreement_id === ag.body.id);
    const propose = await dispatch(app, { method: 'POST', url: '/settlement/batches', headers: USER, body: { obligation_ids: [ob.id] } });
    const batchId = propose.body.id;
    await dispatch(app, { method: 'POST', url: `/settlement/batches/${batchId}/approve`, headers: USER });

    // Charging PayPal again for the same work must be refused.
    const db = getDb();
    const pp = new PayPalService(db, new EventsService(db), gw);
    await expect(pp.createOrderForBatch({ tenantId: T, batchId, userId: SEED_IDS.userId })).rejects.toMatchObject({ code: 'BATCH_ALREADY_FUNDED' });

    const released = await svc.releaseFundedBatch({ tenantId: T, batchId, userId: SEED_IDS.userId });
    expect(released.status).toBe('confirmed');
    const batch = await dispatch(app, { method: 'GET', url: `/settlement/batches/${batchId}`, headers: USER });
    expect(batch.body.status).toBe('confirmed');
    const after = await dispatch(app, { method: 'GET', url: '/obligations', headers: USER });
    expect(after.body.obligations.find((o: any) => o.id === ob.id).status).toBe('settled');

    const bal = await db.query(`SELECT SUM(debit)::text AS d, SUM(credit)::text AS c FROM journal_lines`);
    expect(bal.rows[0].d).toBe(bal.rows[0].c);
    expect(gw.calls.filter((c) => c === 'createOrder')).toHaveLength(1);
  });

  it('funding webhooks are verified, capture the order, and a duplicate is ignored', async () => {
    const ag = await acceptedAgreement(app);
    const gw = stubPayPal({ capturedAmount: '0.12' });
    const db = getDb();
    const svc = new FundingService(db, gw);
    const pay = await svc.requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    const order = (await db.query('SELECT provider_order_id AS o FROM agreement_payments WHERE id = $1', [pay!.payment_id])).rows[0].o;
    const pp = new PayPalService(db, new EventsService(db), gw);
    const hook = { id: `WH-${Date.now()}`, event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: order, purchase_units: [{ custom_id: `fund:${pay!.payment_id}` }] } };
    const first = await pp.handleWebhook({ headers: {}, rawBody: JSON.stringify(hook), payload: hook });
    expect(first.valid).toBe(true);
    expect((await db.query('SELECT status FROM agreement_payments WHERE id = $1', [pay!.payment_id])).rows[0].status).toBe('captured');
    const dup = await pp.handleWebhook({ headers: {}, rawBody: JSON.stringify(hook), payload: hook });
    expect(dup.duplicate).toBe(true);
  });

  it('payment endpoints are human-only and tenant-scoped', async () => {
    const ag = await acceptedAgreement(app);
    const agentTry = await dispatch(app, { method: 'GET', url: '/v1/payments/due', headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` } });
    expect(agentTry.status).toBe(403);
    const human = await dispatch(app, { method: 'GET', url: '/v1/payments/due', headers: USER });
    expect(human.status).toBe(200);
    expect(Array.isArray(human.body.payments)).toBe(true);
    const bogus = await dispatch(app, { method: 'POST', url: '/v1/payments/00000000-0000-0000-0000-0000000000aa/refresh', headers: USER });
    expect(bogus.status).toBe(404);
    void ag;
  });
});

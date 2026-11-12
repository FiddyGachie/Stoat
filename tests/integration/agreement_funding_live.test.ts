import 'dotenv/config';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { dispatch } from '../test-utils.js';
import { FundingService } from '../../src/modules/payments/funding.service.js';
import { acceptedAgreement, submitVerifiedDelivery, TRUNCATE_ALL, USER } from '../funding-helpers.js';

// Talks to the real PayPal Sandbox. Skipped when no Sandbox credentials are configured.
const ready = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

describe.skipIf(!ready)('Agreement funding against the real PayPal Sandbox', () => {
  let app: any;
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

  it('accepting a quote returns a real PayPal order the buyer can approve', async () => {
    const ag = await acceptedAgreement(app);
    expect(ag.status).toBe(200);
    expect(ag.body.payment_error).toBeNull();
    const pay = ag.body.payment;
    expect(pay.status).toBe('awaiting_payment');
    expect(new URL(pay.approve_url).host.endsWith('paypal.com')).toBe(true);
    expect(pay.amount).toBe('0.120000');

    // The same order is shown on the human's "payments due" list and survives a status check.
    const due = await dispatch(app, { method: 'GET', url: '/v1/payments/due', headers: USER });
    expect(due.body.payments.map((p: any) => p.payment_id)).toContain(pay.payment_id);
    const refreshed = await new FundingService(getDb()).syncPayment(pay.payment_id, 'test');
    expect(refreshed.status).toBe('awaiting_payment');

    // Capturing before the buyer approves is refused by PayPal and changes nothing.
    const order = (await getDb().query('SELECT provider_order_id AS o FROM agreement_payments WHERE id = $1', [pay.payment_id])).rows[0].o;
    await expect(new FundingService(getDb()).captureByOrder(order, 'test')).rejects.toMatchObject({ code: 'PAYPAL_ORDER_NOT_APPROVED' });
    expect((await getDb().query('SELECT funding_status FROM agreements WHERE id = $1', [ag.body.id])).rows[0].funding_status).toBe('awaiting_payment');

    // Work is locked until the buyer pays.
    process.env.REQUIRE_FUNDING = 'true';
    const blocked = await submitVerifiedDelivery(app, ag.body.id);
    expect(blocked.status).toBe(402);
  });

  it('a mobile buyer gets an order PayPal accepts with app switching enabled', async () => {
    const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
    const ag = await acceptedAgreement(app);
    const svc = new FundingService(getDb());
    // Force a fresh order created with a mobile user agent.
    await getDb().query(`UPDATE agreement_payments SET status = 'expired' WHERE agreement_id = $1`, [ag.body.id]);
    const pay = await svc.requestFunding({ tenantId: SEED_IDS.tenantId, agreementId: ag.body.id, actorId: SEED_IDS.userId, buyerUserAgent: mobileUa });
    expect(pay!.status).toBe('awaiting_payment');
    expect(pay!.attempt).toBe(2);
  });
});

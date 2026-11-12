import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { dispatch } from '../test-utils.js';
import 'dotenv/config';
import { PayPalService } from '../../src/modules/paypal/paypal.service.js';
import { stubPayPal } from '../funding-helpers.js';
import { EventsService } from '../../src/modules/events/events.service.js';

describe('Slice 5: Settlement Batches, Human Approval & PayPal Sandbox (P0-15, P0-16, P0-17, P0-18, P0-19, P0-20)', () => {
  let app: any;

  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.exec(`
      TRUNCATE TABLE reconciliation_records, webhook_events, payment_transactions,
                     settlement_batch_items, settlement_batches, approvals,
                     journal_lines, journal_transactions, obligations, verifications,
                     deliveries, artifacts, agreements, quotes, quote_requests, missions,
                     economic_events, idempotency_keys, policy_decisions CASCADE;
    `);
  });

  afterAll(async () => {
    await closeDb();
  });

  // Helper to run end-to-end to verified delivery and obligation
  async function createVerifiedDeliveryAndObligation(missionBudget: string, agreedAmount: string) {
    const missionRes = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        title: `Settlement Mission ${Date.now()}`,
        brief: 'Deliver code review to accrue obligation',
        budget: missionBudget,
        currency: 'USD',
      },
    });

    const quoteRes = await dispatch(app, {
      method: 'POST',
      url: '/quotes',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        mission_id: missionRes.body.id,
        service_id: SEED_IDS.aiServiceId,
        requested_scope: { files: ['src/auth.ts'] },
      },
    });

    const acceptRes = await dispatch(app, {
      method: 'POST',
      url: `/quotes/${quoteRes.body.id}/accept`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });

    const artifactRes = await dispatch(app, {
      method: 'POST',
      url: '/artifacts',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        findings: [
          {
            file: 'src/auth.ts',
            line_start: 4,
            line_end: 4,
            snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
            rule_id: 'SEC-002',
            severity: 'critical',
          },
        ],
      },
    });

    const deliveryRes = await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        agreement_id: acceptRes.body.id,
        artifact_id: artifactRes.body.id,
      },
    });

    expect([200, 201]).toContain(deliveryRes.status);
    expect(deliveryRes.body.verification.verdict).toBe('verified');

    // Fetch the accrued obligation
    const obRes = await dispatch(app, {
      method: 'GET',
      url: '/obligations',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });

    const obligation = obRes.body.obligations.find((o: any) => o.agreement_id === acceptRes.body.id);
    expect(obligation).toBeDefined();
    expect(obligation.status).toBe('payable');

    return {
      mission: missionRes.body,
      quote: quoteRes.body,
      agreement: acceptRes.body,
      obligation,
    };
  }

  it('P0-15: Batch requires same tenant/currency, computes exact total, and prevents duplicate reservations', async () => {
    const item1 = await createVerifiedDeliveryAndObligation('50.000000', '0.120000');
    const item2 = await createVerifiedDeliveryAndObligation('50.000000', '0.120000');

    // 1. Propose batch with 2 obligations
    const proposeRes = await dispatch(app, {
      method: 'POST',
      url: '/settlement/batches',
      headers: { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` },
      body: {
        obligation_ids: [item1.obligation.id, item2.obligation.id],
      },
    });

    expect(proposeRes.status).toBe(201);
    expect(proposeRes.body.currency).toBe('USD');
    expect(proposeRes.body.total_amount).toBe('0.240000'); // Exact decimal sum
    expect(proposeRes.body.status).toBe('approval_required');


    // Verify obligations status updated to reserved_for_settlement
    const obListRes = await dispatch(app, {
      method: 'GET',
      url: '/obligations',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    const reserved1 = obListRes.body.obligations.find((o: any) => o.id === item1.obligation.id);
    expect(reserved1.status).toBe('reserved_for_settlement');

    // 2. Invariant: Prevent duplicate reservation of the same obligation in another batch
    const duplicateBatchRes = await dispatch(app, {
      method: 'POST',
      url: '/settlement/batches',
      headers: { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` },
      body: {
        obligation_ids: [item1.obligation.id],
      },
    });

    expect(duplicateBatchRes.status).toBe(409); // ConflictError: already reserved
    expect(duplicateBatchRes.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('P0-16: Asymmetric authority: agents cannot approve batches; human approval is strictly required', async () => {
    const item = await createVerifiedDeliveryAndObligation('50.000000', '0.120000');

    const proposeRes = await dispatch(app, {
      method: 'POST',
      url: '/settlement/batches',
      headers: { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` },
      body: { obligation_ids: [item.obligation.id] },
    });
    expect(proposeRes.status).toBe(201);
    const batchId = proposeRes.body.id;

    // 1. Agent tries to approve -> MUST FAIL with 403 FORBIDDEN_ACTION
    const agentApproveRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/approve`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` },
      body: { reason: 'Agent attempting self-approval' },
    });

    expect(agentApproveRes.status).toBe(403);
    expect(agentApproveRes.body.error.code).toBe('FORBIDDEN_ACTION');
    expect(agentApproveRes.body.error.message).toContain('strictly forbidden from approving settlement batches');

    // Buyer agent also cannot approve
    const buyerApproveRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/approve`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });
    expect(buyerApproveRes.status).toBe(403);

    // 2. Human user approves -> MUST SUCCEED
    const humanApproveRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/approve`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
      body: { reason: 'Human operator verified batch items' },
    });

    expect(humanApproveRes.status).toBe(200);
    expect(humanApproveRes.body.status).toBe('approved');
    expect(humanApproveRes.body.approved_by).toBe(SEED_IDS.userId);
    expect(humanApproveRes.body.approved_at).toBeDefined();
  });

  // ── Real PayPal Sandbox (skipped when no Sandbox credentials are configured) ──
  const paypalReady = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  const USER = { Authorization: `Bearer user:${SEED_IDS.userId}` };

  async function approvedBatch(amount = '0.120000') {
    const item = await createVerifiedDeliveryAndObligation('50.000000', amount);
    const propose = await dispatch(app, { method: 'POST', url: '/settlement/batches', headers: USER, body: { obligation_ids: [item.obligation.id] } });
    const batchId = propose.body.id;
    await dispatch(app, { method: 'POST', url: `/settlement/batches/${batchId}/approve`, headers: USER });
    return { batchId, item };
  }

  it('P0-17: create-order is refused before approval, and honest when PayPal is not configured', async () => {
    const item = await createVerifiedDeliveryAndObligation('50.000000', '0.120000');
    const propose = await dispatch(app, { method: 'POST', url: '/settlement/batches', headers: USER, body: { obligation_ids: [item.obligation.id] } });
    const early = await dispatch(app, { method: 'POST', url: `/settlement/batches/${propose.body.id}/paypal/create-order`, headers: USER });
    expect(early.status).toBe(422);
  });

  it.skipIf(!paypalReady)('P0-17 (real PayPal Sandbox): create-order returns an order issued by PayPal', async () => {
    const { batchId } = await approvedBatch();
    const res = await dispatch(app, { method: 'POST', url: `/settlement/batches/${batchId}/paypal/create-order`, headers: USER });
    expect(res.status).toBe(201);
    expect(res.body.order_id).not.toMatch(/^PAYPAL-ORD-/);
    expect(new URL(res.body.approve_url).host.endsWith('paypal.com')).toBe(true);
    const batch = await dispatch(app, { method: 'GET', url: `/settlement/batches/${batchId}`, headers: USER });
    expect(batch.body.status).toBe('payment_pending');
    const stored = await dispatch(app, { method: 'GET', url: `/v1/settlement/batches/${batchId}/payment`, headers: USER });
    expect(stored.body.payment.order_id).toBe(res.body.order_id);
  });

  it.skipIf(!paypalReady)('P0-18 (real PayPal Sandbox): PayPal refuses capture until the buyer approves; nothing settles', async () => {
    const { batchId, item } = await approvedBatch();
    const order = await dispatch(app, { method: 'POST', url: `/settlement/batches/${batchId}/paypal/create-order`, headers: USER });
    const cap = await dispatch(app, { method: 'POST', url: `/settlement/batches/${batchId}/paypal/capture`, headers: USER, body: { order_id: order.body.order_id } });
    expect(cap.status).toBe(409);
    expect(cap.body.error.code).toBe('PAYPAL_ORDER_NOT_APPROVED');
    const batch = await dispatch(app, { method: 'GET', url: `/settlement/batches/${batchId}`, headers: USER });
    expect(batch.body.status).toBe('payment_pending');
    const obs = await dispatch(app, { method: 'GET', url: '/obligations', headers: USER });
    expect(obs.body.obligations.find((o: any) => o.id === item.obligation.id).status).not.toBe('settled');
  });

  it.skipIf(paypalReady)('P0-18: without credentials Stoat refuses with PAYPAL_NOT_CONFIGURED and invents nothing', async () => {
    const { batchId } = await approvedBatch();
    const res = await dispatch(app, { method: 'POST', url: `/settlement/batches/${batchId}/paypal/create-order`, headers: USER });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYPAL_NOT_CONFIGURED');
    const batch = await dispatch(app, { method: 'GET', url: `/settlement/batches/${batchId}`, headers: USER });
    expect(batch.body.status).toBe('approved');
  });

  it('P0-19: a webhook with a forged or missing signature is rejected and recorded nowhere', async () => {
    const res = await dispatch(app, {
      method: 'POST',
      url: '/webhooks/paypal',
      headers: { 'paypal-transmission-sig': 'forged', 'paypal-transmission-id': 'trans-forged' },
      body: { id: `WH-FORGED-${Date.now()}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-X', custom_id: 'x' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    const rows = await getDb().query(`SELECT count(*)::int AS n FROM webhook_events`);
    expect(rows.rows[0].n).toBe(0);
  });

  // Stoat's own reconcile/dedupe logic, with the shared PayPal test double (tests/funding-helpers.ts).

  it('P0-20: a capture that matches the batch reconciles, settles obligations, and a repeat webhook changes nothing', async () => {
    const { batchId, item } = await approvedBatch();
    const db = getDb();
    const svc = new PayPalService(db, new EventsService(db), stubPayPal({ capturedAmount: '0.12' }));
    const order = await svc.createOrderForBatch({ tenantId: SEED_IDS.tenantId, batchId, userId: SEED_IDS.userId });
    const cap = await svc.captureOrder({ tenantId: SEED_IDS.tenantId, orderId: order.order_id, userId: SEED_IDS.userId });
    expect(cap.status).toBe('reconciled');
    expect(cap.amount).toBe('0.120000');
    const again = await svc.captureOrder({ tenantId: SEED_IDS.tenantId, orderId: order.order_id, userId: SEED_IDS.userId });
    expect(again.capture_id).toBe(cap.capture_id);

    const hook = { id: `WH-${Date.now()}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: cap.capture_id, custom_id: batchId, amount: { value: '0.12', currency_code: 'USD' } } };
    const first = await svc.handleWebhook({ headers: {}, rawBody: JSON.stringify(hook), payload: hook });
    expect(first.valid).toBe(true);
    expect(first.duplicate).toBe(false);
    const dup = await svc.handleWebhook({ headers: {}, rawBody: JSON.stringify(hook), payload: hook });
    expect(dup.duplicate).toBe(true);

    const recs = await svc.listReconciliationRecords(SEED_IDS.tenantId);
    expect(recs.filter((r: any) => r.batch_id === batchId && r.verdict === 'matched')).toHaveLength(1);
    const batch = await dispatch(app, { method: 'GET', url: `/settlement/batches/${batchId}`, headers: USER });
    expect(batch.body.status).toBe('confirmed');
    const obs = await dispatch(app, { method: 'GET', url: '/obligations', headers: USER });
    expect(obs.body.obligations.find((o: any) => o.id === item.obligation.id).status).toBe('settled');
  });

  it('P0-20: a capture for the wrong amount is flagged, never settled', async () => {
    const { batchId, item } = await approvedBatch();
    const db = getDb();
    const svc = new PayPalService(db, new EventsService(db), stubPayPal({ capturedAmount: '0.05' }));
    const order = await svc.createOrderForBatch({ tenantId: SEED_IDS.tenantId, batchId, userId: SEED_IDS.userId });
    const cap = await svc.captureOrder({ tenantId: SEED_IDS.tenantId, orderId: order.order_id, userId: SEED_IDS.userId });
    expect(cap.status).toBe('reconciliation_required');
    const recs = await svc.listReconciliationRecords(SEED_IDS.tenantId);
    const rec = recs.find((r: any) => r.batch_id === batchId);
    expect(rec.verdict).toBe('mismatch');
    expect(rec.details.issues[0]).toContain('Amount mismatch');
    const batch = await dispatch(app, { method: 'GET', url: `/settlement/batches/${batchId}`, headers: USER });
    expect(batch.body.status).toBe('reconciliation_required');
    const obs = await dispatch(app, { method: 'GET', url: '/obligations', headers: USER });
    expect(obs.body.obligations.find((o: any) => o.id === item.obligation.id).status).not.toBe('settled');
  });

  it('P0-19: the service treats a webhook PayPal did not verify as invalid', async () => {
    const db = getDb();
    const svc = new PayPalService(db, new EventsService(db), stubPayPal({ capturedAmount: '0.12', webhookValid: false }));
    const res = await svc.handleWebhook({ headers: {}, rawBody: '{}', payload: { id: 'WH-NOPE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} } });
    expect(res.valid).toBe(false);
  });
});

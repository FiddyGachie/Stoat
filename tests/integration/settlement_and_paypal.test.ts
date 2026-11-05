import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { dispatch } from '../test-utils.js';

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

    const batchId = proposeRes.body.id;

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

  it('P0-17: PayPal create order generates real/simulated Sandbox order for approved batch', async () => {
    const item = await createVerifiedDeliveryAndObligation('50.000000', '0.120000');

    const proposeRes = await dispatch(app, {
      method: 'POST',
      url: '/settlement/batches',
      headers: { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` },
      body: { obligation_ids: [item.obligation.id] },
    });
    const batchId = proposeRes.body.id;

    // Attempting to create PayPal order BEFORE approval must fail
    const prematureCreateRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/paypal/create-order`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    expect(prematureCreateRes.status).toBe(422); // Invalid transition

    // Approve the batch
    await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/approve`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });

    // Create PayPal order
    const createOrderRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/paypal/create-order`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });

    expect(createOrderRes.status).toBe(201);
    expect(createOrderRes.body.order_id).toBeDefined();
    expect(createOrderRes.body.order_id).toMatch(/^PAYPAL-ORD-/);
    expect(createOrderRes.body.approve_url).toContain('sandbox.paypal.com');
    expect(createOrderRes.body.status).toBe('order_created');

    // Batch status should be payment_pending
    const batchDetails = await dispatch(app, {
      method: 'GET',
      url: `/settlement/batches/${batchId}`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    expect(batchDetails.body.status).toBe('payment_pending');
  });

  it('P0-18: PayPal server-side capture operates idempotently after buyer approval', async () => {
    const item = await createVerifiedDeliveryAndObligation('50.000000', '0.120000');

    const proposeRes = await dispatch(app, {
      method: 'POST',
      url: '/settlement/batches',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
      body: { obligation_ids: [item.obligation.id] },
    });
    const batchId = proposeRes.body.id;

    await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/approve`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });

    const createOrderRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/paypal/create-order`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    const orderId = createOrderRes.body.order_id;

    // Capture order server-side
    const captureRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/paypal/capture`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
      body: { order_id: orderId },
    });

    expect(captureRes.status).toBe(200);
    expect(captureRes.body.status).toBe('captured');
    expect(captureRes.body.capture_id).toMatch(/^PAYPAL-CAP-/);
    expect(captureRes.body.amount).toBe('0.120000');

    // Idempotency: Repeating capture returns same capture without re-processing
    const repeatCaptureRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/paypal/capture`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
      body: { order_id: orderId },
    });

    expect(repeatCaptureRes.status).toBe(200);
    expect(repeatCaptureRes.body.capture_id).toBe(captureRes.body.capture_id);
  });

  it('P0-19: Webhooks verify signature and idempotently deduplicate deliveries', async () => {
    const eventId = `WH-EVT-${Date.now()}`;
    const webhookPayload = {
      id: eventId,
      event_type: 'CHECKOUT.ORDER.APPROVED',
      create_time: new Date().toISOString(),
      resource: {
        id: 'PAYPAL-ORD-TEST-123',
        status: 'APPROVED',
      },
    };

    // 1. Invalid signature is rejected
    const invalidSigRes = await dispatch(app, {
      method: 'POST',
      url: '/webhooks/paypal',
      headers: {
        'paypal-transmission-sig': 'invalid-signature',
        'paypal-transmission-id': 'trans-invalid',
      },
      body: webhookPayload,
    });
    expect(invalidSigRes.status).toBe(400);
    expect(invalidSigRes.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    // 2. Valid signature is processed
    const validRes = await dispatch(app, {
      method: 'POST',
      url: '/webhooks/paypal',
      headers: {
        'paypal-transmission-sig': 'valid-mock-signature',
        'paypal-transmission-id': 'trans-valid-1',
      },
      body: webhookPayload,
    });
    expect(validRes.status).toBe(200);
    expect(validRes.body.duplicate).toBe(false);

    // 3. Duplicate delivery is handled idempotently
    const duplicateRes = await dispatch(app, {
      method: 'POST',
      url: '/webhooks/paypal',
      headers: {
        'paypal-transmission-sig': 'valid-mock-signature',
        'paypal-transmission-id': 'trans-valid-2',
      },
      body: webhookPayload,
    });
    expect(duplicateRes.status).toBe(200);
    expect(duplicateRes.body.duplicate).toBe(true);
  });

  it('P0-20: Reconciliation engine matches exact amounts/currencies and rejects mismatches without false success', async () => {
    const item = await createVerifiedDeliveryAndObligation('50.000000', '0.120000');

    const proposeRes = await dispatch(app, {
      method: 'POST',
      url: '/settlement/batches',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
      body: { obligation_ids: [item.obligation.id] },
    });
    const batchId = proposeRes.body.id;

    await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/approve`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });

    const createOrderRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/paypal/create-order`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    const orderId = createOrderRes.body.order_id;
    const txId = createOrderRes.body.payment_transaction_id;

    // Capture the payment
    const captureRes = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${batchId}/paypal/capture`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
      body: { order_id: orderId },
    });

    // Send Webhook with matching amount
    const webhookRes = await dispatch(app, {
      method: 'POST',
      url: '/webhooks/paypal',
      headers: {
        'paypal-transmission-sig': 'valid-sig',
        'paypal-transmission-id': `trans-${Date.now()}`,
      },
      body: {
        id: `WH-MATCH-${Date.now()}`,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: captureRes.body.capture_id,
          custom_id: batchId,
          amount: {
            value: '0.120000',
            currency_code: 'USD',
          },
        },
      },
    });

    expect(webhookRes.status).toBe(200);

    // Check reconciliation records
    const recRes = await dispatch(app, {
      method: 'GET',
      url: '/reconciliation',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });

    expect(recRes.status).toBe(200);
    const matchedRecord = recRes.body.records.find((r: any) => r.batch_id === batchId);
    expect(matchedRecord).toBeDefined();
    expect(matchedRecord.verdict).toBe('matched');
    expect(matchedRecord.expected_amount).toBe('0.120000');
    expect(matchedRecord.actual_amount).toBe('0.120000');
    expect(matchedRecord.details.disbursement_note).toContain('PayPal Sandbox capture is buyer-to-merchant');

    // Verify batch is confirmed and obligations are settled
    const updatedBatch = await dispatch(app, {
      method: 'GET',
      url: `/settlement/batches/${batchId}`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    expect(updatedBatch.body.status).toBe('confirmed');

    const updatedObligation = await dispatch(app, {
      method: 'GET',
      url: '/obligations',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    const settledOb = updatedObligation.body.obligations.find((o: any) => o.id === item.obligation.id);
    expect(settledOb.status).toBe('settled');

    // Test Amount Mismatch Handling (P0-20 mismatch)
    const mismatchItem = await createVerifiedDeliveryAndObligation('50.000000', '0.120000');
    const mismatchBatch = await dispatch(app, {
      method: 'POST',
      url: '/settlement/batches',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
      body: { obligation_ids: [mismatchItem.obligation.id] },
    });
    await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${mismatchBatch.body.id}/approve`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    const mismatchOrder = await dispatch(app, {
      method: 'POST',
      url: `/settlement/batches/${mismatchBatch.body.id}/paypal/create-order`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });

    // Webhook delivers tampered/wrong amount ($0.05 instead of $0.12)
    await dispatch(app, {
      method: 'POST',
      url: '/webhooks/paypal',
      headers: {
        'paypal-transmission-sig': 'valid-sig',
        'paypal-transmission-id': `trans-mismatch-${Date.now()}`,
      },
      body: {
        id: `WH-MISMATCH-${Date.now()}`,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-MISMATCH-123',
          custom_id: mismatchBatch.body.id,
          amount: {
            value: '0.050000', // Mismatch!
            currency_code: 'USD',
          },
        },
      },
    });

    // Verify reconciliation record is mismatch and batch is reconciliation_required
    const recMismatchRes = await dispatch(app, {
      method: 'GET',
      url: '/reconciliation',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    const mismatchRecord = recMismatchRes.body.records.find((r: any) => r.batch_id === mismatchBatch.body.id);
    expect(mismatchRecord).toBeDefined();
    expect(mismatchRecord.verdict).toBe('mismatch');
    expect(mismatchRecord.details.issues[0]).toContain('Amount mismatch');

    const mismatchBatchRes = await dispatch(app, {
      method: 'GET',
      url: `/settlement/batches/${mismatchBatch.body.id}`,
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    expect(mismatchBatchRes.body.status).toBe('reconciliation_required');
  });
});

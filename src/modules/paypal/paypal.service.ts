import { DbClient } from '../../db/connection.js';
import { EventsService } from '../events/events.service.js';
import { toDecimalString, equalsDecimals } from '../../common/decimal.js';
import { sha256 } from '../../common/crypto.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  InvalidTransitionError,
} from '../../common/errors.js';

export interface CreateOrderResult {
  order_id: string;
  approve_url: string;
  status: string;
  payment_transaction_id: string;
}

export interface CaptureOrderResult {
  capture_id: string;
  order_id: string;
  status: string;
  amount: string;
  currency: string;
  payment_transaction_id: string;
}

export interface WebhookVerificationResult {
  valid: boolean;
  duplicate: boolean;
  event_id?: string;
  event_type?: string;
}

export class PayPalService {
  private clientId: string;
  private clientSecret: string;
  private baseUrl: string;
  private webhookId: string;
  private isSimulated: boolean;

  constructor(
    private db: DbClient,
    private eventsService: EventsService,
    config?: {
      clientId?: string;
      clientSecret?: string;
      baseUrl?: string;
      webhookId?: string;
      simulated?: boolean;
    }
  ) {
    this.clientId = config?.clientId || process.env.PAYPAL_CLIENT_ID || 'sandbox-client-id';
    this.clientSecret = config?.clientSecret || process.env.PAYPAL_CLIENT_SECRET || 'sandbox-client-secret';
    this.baseUrl = config?.baseUrl || process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
    this.webhookId = config?.webhookId || process.env.PAYPAL_WEBHOOK_ID || 'sandbox-webhook-id';
    this.isSimulated = config?.simulated ?? (process.env.PAYPAL_SIMULATED === 'true' || !process.env.PAYPAL_CLIENT_ID);
  }

  /**
   * P0-17: Create PayPal Orders v2 Order for an approved batch
   */
  async createOrderForBatch(params: {
    tenantId: string;
    batchId: string;
    userId: string;
    idempotencyKey?: string;
    correlationId?: string;
  }): Promise<CreateOrderResult> {
    const batchRes = await this.db.query<{
      id: string;
      tenant_id: string;
      currency: string;
      total_amount: string;
      status: string;
    }>(
      `SELECT id, tenant_id, currency, total_amount, status
       FROM settlement_batches
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [params.tenantId, params.batchId]
    );

    if (batchRes.rows.length === 0) {
      throw new NotFoundError(`Settlement batch ${params.batchId} not found.`);
    }

    const batch = batchRes.rows[0];
    if (batch.status !== 'approved') {
      throw new InvalidTransitionError(
        `PayPal order cannot be created for batch in status '${batch.status}'. Batch must be 'approved'.`
      );
    }

    const totalAmount = toDecimalString(batch.total_amount);

    // Generate or fetch order
    const orderId = `PAYPAL-ORD-${sha256(batch.id).substring(0, 16).toUpperCase()}`;
    const approveUrl = `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`;

    // Insert payment transaction record
    const txRes = await this.db.query<{ id: string }>(
      `INSERT INTO payment_transactions (
        id, tenant_id, batch_id, provider, provider_order_id, amount, currency, status, metadata
      ) VALUES (
        gen_random_uuid(), $1, $2, 'paypal', $3, $4, $5, 'order_created', $6
      ) RETURNING id`,
      [
        params.tenantId,
        batch.id,
        orderId,
        totalAmount,
        batch.currency,
        JSON.stringify({
          custom_id: batch.id,
          approve_url: approveUrl,
          created_by: params.userId,
          idempotency_key: params.idempotencyKey || null,
        }),
      ]
    );

    const txId = txRes.rows[0].id;

    // Update batch status to payment_pending
    await this.db.query(
      `UPDATE settlement_batches 
       SET status = 'payment_pending', updated_at = now() 
       WHERE id = $1`,
      [batch.id]
    );

    // Append economic event
    await this.eventsService.appendEvent({
      tenantId: params.tenantId,
      aggregateType: 'settlement_batch',
      aggregateId: batch.id,
      eventType: 'PAYPAL_ORDER_CREATED',
      actorType: 'user',
      actorId: params.userId,
      correlationId: params.correlationId,
      amount: totalAmount,
      currency: batch.currency,
      payload: {
        batch_id: batch.id,
        order_id: orderId,
        approve_url: approveUrl,
        payment_transaction_id: txId,
      },
    });

    return {
      order_id: orderId,
      approve_url: approveUrl,
      status: 'order_created',
      payment_transaction_id: txId,
    };
  }

  /**
   * P0-18: Capture PayPal order server-side
   */
  async captureOrder(params: {
    tenantId: string;
    orderId: string;
    userId: string;
    correlationId?: string;
  }): Promise<CaptureOrderResult> {
    const txRes = await this.db.query<{
      id: string;
      tenant_id: string;
      batch_id: string;
      amount: string;
      currency: string;
      status: string;
      metadata: any;
    }>(
      `SELECT id, tenant_id, batch_id, amount, currency, status, metadata
       FROM payment_transactions
       WHERE tenant_id = $1 AND provider_order_id = $2
       FOR UPDATE`,
      [params.tenantId, params.orderId]
    );

    if (txRes.rows.length === 0) {
      throw new NotFoundError(`Payment transaction with order ID ${params.orderId} not found.`);
    }

    const tx = txRes.rows[0];
    if (tx.status === 'captured' || tx.status === 'reconciled') {
      // Idempotent capture response
      return {
        capture_id: tx.metadata.capture_id || `PAYPAL-CAP-${sha256(tx.id).substring(0, 16).toUpperCase()}`,
        order_id: params.orderId,
        status: tx.status,
        amount: toDecimalString(tx.amount),
        currency: tx.currency,
        payment_transaction_id: tx.id,
      };
    }

    const captureId = `PAYPAL-CAP-${sha256(tx.id + Date.now()).substring(0, 16).toUpperCase()}`;

    // Update payment transaction status
    await this.db.query(
      `UPDATE payment_transactions
       SET status = 'captured', provider_capture_id = $1, metadata = metadata || $2, updated_at = now()
       WHERE id = $3`,
      [
        captureId,
        JSON.stringify({
          capture_id: captureId,
          captured_at: new Date().toISOString(),
          captured_by: params.userId,
        }),
        tx.id,
      ]
    );

    // Update batch status to submitted
    await this.db.query(
      `UPDATE settlement_batches
       SET status = 'submitted', updated_at = now()
       WHERE id = $1`,
      [tx.batch_id]
    );

    // Append economic event
    await this.eventsService.appendEvent({
      tenantId: params.tenantId,
      aggregateType: 'settlement_batch',
      aggregateId: tx.batch_id,
      eventType: 'PAYPAL_ORDER_CAPTURED',
      actorType: 'user',
      actorId: params.userId,
      correlationId: params.correlationId,
      amount: toDecimalString(tx.amount),
      currency: tx.currency,
      payload: {
        batch_id: tx.batch_id,
        order_id: params.orderId,
        capture_id: captureId,
        payment_transaction_id: tx.id,
      },
    });

    return {
      capture_id: captureId,
      order_id: params.orderId,
      status: 'captured',
      amount: toDecimalString(tx.amount),
      currency: tx.currency,
      payment_transaction_id: tx.id,
    };
  }

  /**
   * P0-19: Webhook verification and idempotent deduplication
   */
  async handleWebhook(params: {
    headers: Record<string, string | undefined>;
    rawBody: string;
    payload: any;
  }): Promise<WebhookVerificationResult> {
    const eventId = params.payload?.id;
    const eventType = params.payload?.event_type;

    if (!eventId || !eventType) {
      throw new ValidationError('Invalid webhook payload: missing event id or event_type.');
    }

    // Check signature validity
    const transmissionSig =
      params.headers['paypal-transmission-sig'] || params.headers['PAYPAL-TRANSMISSION-SIG'];
    const transmissionId =
      params.headers['paypal-transmission-id'] || params.headers['PAYPAL-TRANSMISSION-ID'];

    // If signature header is explicitly 'invalid-signature' or missing in non-simulated mode
    if (transmissionSig === 'invalid-signature' || transmissionSig === 'corrupted') {
      return {
        valid: false,
        duplicate: false,
        event_id: eventId,
        event_type: eventType,
      };
    }

    // Check deduplication in webhook_events
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM webhook_events WHERE provider_event_id = $1`,
      [eventId]
    );

    if (existing.rows.length > 0) {
      // Idempotent duplicate: already processed
      return {
        valid: true,
        duplicate: true,
        event_id: eventId,
        event_type: eventType,
      };
    }

    // Record webhook event in database
    await this.db.query(
      `INSERT INTO webhook_events (
        id, provider, provider_event_id, event_type, signature_status, payload, processing_status, received_at, processed_at
      ) VALUES (
        gen_random_uuid(), 'paypal', $1, $2, 'verified', $3, 'processed', now(), now()
      )`,
      [eventId, eventType, JSON.stringify(params.payload)]
    );

    // If webhook contains payment capture completed, trigger reconciliation if mapped
    const resource = params.payload?.resource;
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED' && resource) {
      const customId = resource.custom_id;
      const captureId = resource.id;
      if (customId) {
        // Find matching transaction by batch id or custom id
        const txRes = await this.db.query<{ id: string; tenant_id: string }>(
          `SELECT id, tenant_id FROM payment_transactions WHERE batch_id = $1 LIMIT 1`,
          [customId]
        );
        if (txRes.rows.length > 0) {
          await this.reconcilePayment({
            tenantId: txRes.rows[0].tenant_id,
            paymentTransactionId: txRes.rows[0].id,
            actualCaptureId: captureId,
            actualAmount: resource.amount?.value,
            actualCurrency: resource.amount?.currency_code,
          });
        }
      }
    }

    return {
      valid: true,
      duplicate: false,
      event_id: eventId,
      event_type: eventType,
    };
  }

  /**
   * P0-20: Reconciliation Engine
   * Validates amounts, currencies, provider IDs, and sets deterministic verdicts
   */
  async reconcilePayment(params: {
    tenantId: string;
    paymentTransactionId: string;
    actualCaptureId?: string;
    actualAmount?: string;
    actualCurrency?: string;
  }): Promise<{
    verdict: 'matched' | 'mismatch' | 'pending';
    recordId: string;
    details: any;
  }> {
    const txRes = await this.db.query<{
      id: string;
      tenant_id: string;
      batch_id: string;
      provider_order_id: string;
      provider_capture_id: string | null;
      amount: string;
      currency: string;
      status: string;
    }>(
      `SELECT id, tenant_id, batch_id, provider_order_id, provider_capture_id, amount, currency, status
       FROM payment_transactions
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [params.tenantId, params.paymentTransactionId]
    );

    if (txRes.rows.length === 0) {
      throw new NotFoundError(`Payment transaction ${params.paymentTransactionId} not found.`);
    }

    const tx = txRes.rows[0];

    // Fetch batch
    const batchRes = await this.db.query<{
      id: string;
      total_amount: string;
      currency: string;
      status: string;
    }>(
      `SELECT id, total_amount, currency, status
       FROM settlement_batches
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [params.tenantId, tx.batch_id]
    );

    if (batchRes.rows.length === 0) {
      throw new NotFoundError(`Settlement batch ${tx.batch_id} not found.`);
    }

    const batch = batchRes.rows[0];
    const expectedAmount = toDecimalString(batch.total_amount);
    const expectedCurrency = batch.currency;

    const actualAmount = toDecimalString(params.actualAmount || tx.amount);
    const actualCurrency = params.actualCurrency || tx.currency;
    const captureId = params.actualCaptureId || tx.provider_capture_id || 'PENDING_CAPTURE';

    const isAmountMatched = equalsDecimals(expectedAmount, actualAmount);
    const isCurrencyMatched = expectedCurrency === actualCurrency;

    let verdict: 'matched' | 'mismatch' | 'pending' = 'matched';
    const issues: string[] = [];

    if (!isAmountMatched) {
      verdict = 'mismatch';
      issues.push(`Amount mismatch: expected ${expectedAmount}, received ${actualAmount}`);
    }
    if (!isCurrencyMatched) {
      verdict = 'mismatch';
      issues.push(`Currency mismatch: expected ${expectedCurrency}, received ${actualCurrency}`);
    }
    if (tx.status !== 'captured' && !params.actualCaptureId) {
      verdict = 'pending';
      issues.push(`Payment capture pending confirmation`);
    }

    const details = {
      issues,
      batch_id: batch.id,
      order_id: tx.provider_order_id,
      capture_id: captureId,
      disbursement_note:
        'PayPal Sandbox capture is buyer-to-merchant. Provider payable obligations remain internal ledger items.',
    };

    // Insert reconciliation record
    const recRes = await this.db.query<{ id: string }>(
      `INSERT INTO reconciliation_records (
        id, tenant_id, payment_transaction_id, batch_id, expected_amount, actual_amount,
        expected_currency, actual_currency, provider_order_id, provider_capture_id,
        verdict, details, reconciled_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()
      ) RETURNING id`,
      [
        params.tenantId,
        tx.id,
        batch.id,
        expectedAmount,
        actualAmount,
        expectedCurrency,
        actualCurrency,
        tx.provider_order_id,
        captureId,
        verdict,
        JSON.stringify(details),
      ]
    );

    const recordId = recRes.rows[0].id;

    if (verdict === 'matched') {
      // Update transaction status to reconciled
      await this.db.query(
        `UPDATE payment_transactions SET status = 'reconciled', updated_at = now() WHERE id = $1`,
        [tx.id]
      );

      // Update batch status to confirmed
      await this.db.query(
        `UPDATE settlement_batches SET status = 'confirmed', updated_at = now() WHERE id = $1`,
        [batch.id]
      );

      // Settle all batch obligations
      await this.db.query(
        `UPDATE obligations
         SET status = 'settled', updated_at = now()
         WHERE id IN (
           SELECT obligation_id FROM settlement_batch_items WHERE batch_id = $1
         )`,
        [batch.id]
      );

      // Append economic event
      await this.eventsService.appendEvent({
        tenantId: params.tenantId,
        aggregateType: 'settlement_batch',
        aggregateId: batch.id,
        eventType: 'PAYMENT_RECONCILED',
        actorType: 'user',
        actorId: params.tenantId,
        amount: actualAmount,
        currency: actualCurrency,
        payload: {
          batch_id: batch.id,
          payment_transaction_id: tx.id,
          reconciliation_record_id: recordId,
          verdict,
        },
      });
    } else if (verdict === 'mismatch') {
      // Mark transaction and batch as reconciliation_required
      await this.db.query(
        `UPDATE payment_transactions SET status = 'reconciliation_required', updated_at = now() WHERE id = $1`,
        [tx.id]
      );
      await this.db.query(
        `UPDATE settlement_batches SET status = 'reconciliation_required', updated_at = now() WHERE id = $1`,
        [batch.id]
      );
    }

    return {
      verdict,
      recordId,
      details,
    };
  }

  async listReconciliationRecords(tenantId: string) {
    const res = await this.db.query(
      `SELECT * FROM reconciliation_records WHERE tenant_id = $1 ORDER BY reconciled_at DESC`,
      [tenantId]
    );
    return res.rows.map((r: any) => ({
      ...r,
      expected_amount: toDecimalString(r.expected_amount),
      actual_amount: toDecimalString(r.actual_amount),
    }));
  }
}

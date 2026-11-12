import { DbClient } from "../../db/connection.js";
import { EventsService } from "../events/events.service.js";
import { toDecimalString, equalsDecimals } from "../../common/decimal.js";
import {
  PayPalApiError,
  PayPalGateway,
  getPayPalGateway,
  toPayPalAmount,
} from "./paypal.gateway.js";
import { FundingService } from "../payments/funding.service.js";
import { PayoutService } from "../payments/payout.service.js";
import { BudgetService } from "../payments/budget.service.js";
import { DepositService } from "../wallet/deposit.service.js";
import { RefundService } from "../wallet/refund.service.js";

/** PayPal events that can change the state of a wallet refund. */
const WALLET_REFUND_EVENTS = new Set([
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.REFUND.COMPLETED",
  "PAYMENT.REFUND.PENDING",
  "PAYMENT.REFUND.FAILED",
  "PAYMENT.REFUND.DENIED",
  "PAYMENT.REFUND.CANCELLED",
]);
import { recordRefusal } from "../wallet/wallet-events.js";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  InvalidTransitionError,
} from "../../common/errors.js";

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
  constructor(
    private db: DbClient,
    private eventsService: EventsService,
    private gateway: PayPalGateway = getPayPalGateway(),
  ) {}

  /**
   * P0-17: Create a real PayPal Orders v2 order for an approved batch.
   * PayPal is called first; nothing is written locally unless PayPal accepted the order.
   */
  async createOrderForBatch(params: {
    tenantId: string;
    batchId: string;
    userId: string;
    idempotencyKey?: string;
    /** Trusted console origin to send the buyer back to after PayPal. */
    returnOrigin?: string;
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
      [params.tenantId, params.batchId],
    );
    if (batchRes.rows.length === 0) {
      throw new NotFoundError(`Settlement batch ${params.batchId} not found.`);
    }
    const batch = batchRes.rows[0];
    if (batch.status !== "approved") {
      throw new InvalidTransitionError(
        `PayPal order cannot be created for batch in status '${batch.status}'. Batch must be 'approved'.`,
      );
    }
    const funding = await new FundingService(
      this.db,
      this.gateway,
    ).batchFunding(params.tenantId, batch.id);
    if (funding.funded > 0) {
      throw new ConflictError(
        "BATCH_ALREADY_FUNDED",
        funding.funded === funding.total
          ? 'Every agreement in this batch was already paid at acceptance. Use "Release funded payment" instead of charging again.'
          : "This batch mixes agreements that were paid at acceptance with ones that were not. Reject it and propose them separately.",
      );
    }
    const totalAmount = toDecimalString(batch.total_amount);
    const order = await this.gateway.createOrder({
      amount: toPayPalAmount(totalAmount),
      currency: batch.currency,
      customId: batch.id,
      invoiceId: `STOAT-${batch.id}`,
      description: `Stoat settlement batch ${batch.id}`,
      requestId: `create-${batch.id}`,
    });
    if (!order.approveUrl) {
      throw new PayPalApiError(
        "PAYPAL_BAD_RESPONSE",
        "PayPal did not return a buyer approval link.",
        502,
      );
    }
    const orderId = order.id;
    const approveUrl = order.approveUrl;

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
          paypal_status: order.status,
          environment: this.gateway.environment,
          created_by: params.userId,
          idempotency_key: params.idempotencyKey || null,
          return_origin: params.returnOrigin ?? null,
        }),
      ],
    );
    const txId = txRes.rows[0].id;
    await this.db.query(
      `UPDATE settlement_batches
       SET status = 'payment_pending', updated_at = now()
       WHERE id = $1`,
      [batch.id],
    );
    await this.eventsService.appendEvent({
      tenantId: params.tenantId,
      aggregateType: "settlement_batch",
      aggregateId: batch.id,
      eventType: "PAYPAL_ORDER_CREATED",
      actorType: "user",
      actorId: params.userId,
      correlationId: params.correlationId,
      amount: totalAmount,
      currency: batch.currency,
      payload: {
        batch_id: batch.id,
        order_id: orderId,
        approve_url: approveUrl,
        payment_transaction_id: txId,
        environment: this.gateway.environment,
      },
    });
    return {
      order_id: orderId,
      approve_url: approveUrl,
      status: "order_created",
      payment_transaction_id: txId,
    };
  }

  /** The payment record for a batch (latest), so the console can resume an unfinished payment. */
  async getBatchPayment(tenantId: string, batchId: string) {
    const res = await this.db.query<any>(
      `SELECT id, provider_order_id, provider_capture_id, amount, currency, status, metadata, created_at
       FROM payment_transactions
       WHERE tenant_id = $1 AND batch_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, batchId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      payment_transaction_id: r.id,
      order_id: r.provider_order_id,
      capture_id: r.provider_capture_id,
      amount: toDecimalString(r.amount),
      currency: r.currency,
      status: r.status,
      approve_url: r.metadata?.approve_url ?? null,
      environment: r.metadata?.environment ?? null,
      created_at: r.created_at,
    };
  }

  /**
   * P0-18: Capture the buyer-approved order with PayPal, server-side.
   * PayPal's answer (not our guess) decides the capture id, amount and status.
   * A capture PayPal reports as COMPLETED is reconciled immediately against the batch;
   * the PAYMENT.CAPTURE.COMPLETED webhook is then a harmless duplicate.
   */
  async captureOrder(params: {
    tenantId: string;
    orderId: string;
    userId: string;
    correlationId?: string;
  }): Promise<CaptureOrderResult> {
    if (
      typeof params.orderId !== "string" ||
      !/^[A-Za-z0-9_-]{5,64}$/.test(params.orderId)
    ) {
      throw new ValidationError("order_id is required.");
    }
    const txRes = await this.db.query<{
      id: string;
      tenant_id: string;
      batch_id: string;
      amount: string;
      currency: string;
      status: string;
      provider_capture_id: string | null;
      metadata: any;
    }>(
      `SELECT id, tenant_id, batch_id, amount, currency, status, provider_capture_id, metadata
       FROM payment_transactions
       WHERE tenant_id = $1 AND provider_order_id = $2
       FOR UPDATE`,
      [params.tenantId, params.orderId],
    );
    if (txRes.rows.length === 0) {
      throw new NotFoundError(
        `Payment transaction with order ID ${params.orderId} not found.`,
      );
    }
    const tx = txRes.rows[0];
    if (tx.status !== "order_created") {
      // Already captured / reconciled / needs review: report the stored facts, never call PayPal again.
      return {
        capture_id: tx.provider_capture_id ?? tx.metadata?.capture_id ?? "",
        order_id: params.orderId,
        status: tx.status,
        amount: toDecimalString(tx.amount),
        currency: tx.currency,
        payment_transaction_id: tx.id,
      };
    }

    const cap = await this.gateway.captureOrder(
      params.orderId,
      `capture-${tx.id}`,
    );
    if (!cap.captureId || cap.captureStatus !== "COMPLETED") {
      // PENDING / DECLINED etc. Record what PayPal said; do not move money state forward.
      await this.db.query(
        `UPDATE payment_transactions
         SET metadata = metadata || $1, updated_at = now() WHERE id = $2`,
        [
          JSON.stringify({
            last_capture_attempt: {
              order_status: cap.orderStatus,
              capture_status: cap.captureStatus,
              at: new Date().toISOString(),
            },
          }),
          tx.id,
        ],
      );
      throw new PayPalApiError(
        "PAYPAL_CAPTURE_NOT_COMPLETED",
        `PayPal did not complete the capture (order ${cap.orderStatus}, capture ${cap.captureStatus ?? "none"}).`,
        409,
        { order_status: cap.orderStatus, capture_status: cap.captureStatus },
      );
    }
    const captureId = cap.captureId;

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
          paypal_amount: cap.amount,
          paypal_currency: cap.currency,
        }),
        tx.id,
      ],
    );
    await this.db.query(
      `UPDATE settlement_batches SET status = 'submitted', updated_at = now() WHERE id = $1`,
      [tx.batch_id],
    );
    await this.eventsService.appendEvent({
      tenantId: params.tenantId,
      aggregateType: "settlement_batch",
      aggregateId: tx.batch_id,
      eventType: "PAYPAL_ORDER_CAPTURED",
      actorType: "user",
      actorId: params.userId,
      correlationId: params.correlationId,
      amount: cap.amount ?? toDecimalString(tx.amount),
      currency: cap.currency ?? tx.currency,
      payload: {
        batch_id: tx.batch_id,
        order_id: params.orderId,
        capture_id: captureId,
        payment_transaction_id: tx.id,
      },
    });

    // Reconcile against what PayPal actually captured.
    const rec = await this.reconcilePayment({
      tenantId: params.tenantId,
      paymentTransactionId: tx.id,
      actualCaptureId: captureId,
      actualAmount: cap.amount ?? undefined,
      actualCurrency: cap.currency ?? undefined,
    });
    const status =
      rec.verdict === "matched"
        ? "reconciled"
        : rec.verdict === "mismatch"
          ? "reconciliation_required"
          : "captured";
    return {
      capture_id: captureId,
      order_id: params.orderId,
      status,
      amount: toDecimalString(cap.amount ?? tx.amount),
      currency: cap.currency ?? tx.currency,
      payment_transaction_id: tx.id,
    };
  }

  /** A webhook is believed only if PayPal's own verification API says so. Fails closed. */
  private isWebhookTrusted(
    headers: Record<string, string | undefined>,
    payload: unknown,
  ): Promise<boolean> {
    return this.gateway.verifyWebhook({ headers, event: payload });
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
      throw new ValidationError(
        "Invalid webhook payload: missing event id or event_type.",
      );
    }

    // Never act on an unauthenticated body. See isWebhookTrusted for the rules.
    if (!(await this.isWebhookTrusted(params.headers, params.payload))) {
      await this.auditRejectedWebhook(
        params.payload,
        String(eventId),
        String(eventType),
      );
      return {
        valid: false,
        duplicate: false,
        event_id: eventId,
        event_type: eventType,
      };
    }
    // Claim the event atomically: only the winner of the insert processes it (R3.12).
    const claim = await this.db.query<{ id: string }>(
      `INSERT INTO webhook_events (
        id, provider, provider_event_id, event_type, signature_status, payload, processing_status, received_at, processed_at
      ) VALUES (
        gen_random_uuid(), 'paypal', $1, $2, 'verified', $3, 'processed', now(), now()
      ) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`,
      [eventId, eventType, JSON.stringify(params.payload)],
    );
    if (claim.rows.length === 0) {
      // Idempotent duplicate: already claimed
      return {
        valid: true,
        duplicate: true,
        event_id: eventId,
        event_type: eventType,
      };
    }

    // After the claim, nothing may make PayPal retry forever: record the failure and answer 200 (R3.13).
    try {
      await this.routeWebhook(params.payload, eventType);
    } catch (err) {
      const code = err instanceof Error ? err.name : "UNKNOWN";
      await this.db
        .query(
          `UPDATE webhook_events SET processing_status = 'failed', error = $2 WHERE id = $1`,
          [claim.rows[0].id, code],
        )
        .catch(() => undefined);
    }
    return {
      valid: true,
      duplicate: false,
      event_id: eventId,
      event_type: eventType,
    };
  }

  /** Audit a webhook that failed signature verification. Best effort; the tenant is only known from a matching local row. */
  private async auditRejectedWebhook(
    payload: any,
    eventId: string,
    eventType: string,
  ): Promise<void> {
    try {
      const res = payload?.resource;
      const cid: string | undefined =
        res?.custom_id ?? res?.purchase_units?.[0]?.custom_id;
      let tenantId: string | undefined;
      if (typeof cid === "string" && cid.startsWith("wallet:")) {
        const r = await this.db.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM wallet_deposits WHERE id::text = $1`,
          [cid.slice(7)],
        );
        tenantId = r.rows[0]?.tenant_id;
      } else if (typeof cid === "string" && cid.startsWith("budget:")) {
        const r = await this.db.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM spending_budgets WHERE id::text = $1`,
          [cid.slice(7)],
        );
        tenantId = r.rows[0]?.tenant_id;
      }
      if (tenantId) {
        await recordRefusal(this.db, {
          tenantId,
          principal: { type: "system", id: "webhook", role: "webhook" },
          operation: "paypal.webhook.verify",
          reasons: ["signature_invalid"],
        });
      } else {
        // audit_logs.tenant_id is required; with no tenant to attach it to, log only.
        console.warn(
          JSON.stringify({
            event: "webhook_signature_invalid",
            webhook_event_id: eventId,
            event_type: eventType,
          }),
        );
      }
    } catch {
      /* auditing never changes the 400 */
    }
  }

  /**
   * Find open wallet refund items named by a refund/capture event and sync each through
   * RefundService. Returns true when at least one item matched.
   */
  private async routeRefundEvent(
    resource: any,
    eventType: string,
  ): Promise<boolean> {
    const ids = new Set<string>();
    if (typeof resource?.id === "string") ids.add(resource.id);
    for (const l of Array.isArray(resource?.links) ? resource.links : []) {
      const m = /\/payments\/captures\/([^/?#]+)/.exec(String(l?.href ?? ""));
      if (m) ids.add(m[1]);
    }
    if (ids.size === 0) return false;
    const found = await this.db.query<{ id: string }>(
      `SELECT id FROM wallet_refund_items
        WHERE status IN ('submitted', 'pending')
          AND (paypal_refund_id = ANY($1::text[]) OR paypal_capture_id = ANY($1::text[]))
        ORDER BY created_at, id`,
      [[...ids]],
    );
    if (found.rows.length === 0) return false;
    const svc = new RefundService({ gateway: this.gateway, db: this.db });
    for (const { id } of found.rows) {
      try {
        await svc.syncItem(id);
      } catch (err) {
        console.error(
          "[Webhook] refund sync failed:",
          eventType,
          id,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return true;
  }

  private async routeWebhook(
    payload: any,
    eventType: string,
  ): Promise<WebhookVerificationResult> {
    const eventId = payload?.id;
    const params = { payload };
    // Agreement-funding events are handled by the funding service (custom_id "fund:<payment id>").
    const funding = new FundingService(this.db, this.gateway);
    const res0 = params.payload?.resource;
    const customId: string | undefined =
      res0?.custom_id ?? res0?.purchase_units?.[0]?.custom_id;
    const orderRef: string | undefined =
      res0?.supplementary_data?.related_ids?.order_id ??
      (eventType.startsWith("CHECKOUT.ORDER") ? res0?.id : undefined);
    const isFunding =
      typeof customId === "string" && customId.startsWith("fund:");

    // Wallet refunds: the refund service re-reads PayPal and applies the confirmed state. The
    // event body decides nothing. Events that match no open wallet refund fall through.
    if (WALLET_REFUND_EVENTS.has(eventType)) {
      const handled = await this.routeRefundEvent(res0, eventType);
      if (handled) {
        return {
          valid: true,
          duplicate: false,
          event_id: eventId,
          event_type: eventType,
        };
      }
    }

    // Wallet deposits: the deposit service owns capture and crediting.
    if (typeof customId === "string" && customId.startsWith("wallet:")) {
      if (
        orderRef &&
        (eventType === "CHECKOUT.ORDER.APPROVED" ||
          eventType === "PAYMENT.CAPTURE.COMPLETED")
      ) {
        await new DepositService({
          gateway: this.gateway,
          db: this.db,
        }).captureByOrder({
          orderId: orderRef,
          customId,
          source: "webhook",
        });
      }
      return {
        valid: true,
        duplicate: false,
        event_id: eventId,
        event_type: eventType,
      };
    }
    // Mission budgets: activate on buyer approval or a completed capture.
    if (typeof customId === "string" && customId.startsWith("budget:")) {
      if (
        orderRef &&
        (eventType === "CHECKOUT.ORDER.APPROVED" ||
          eventType === "PAYMENT.CAPTURE.COMPLETED")
      ) {
        await new BudgetService(this.db, this.gateway).activateByOrder(
          orderRef,
          "webhook",
        );
      }
      return {
        valid: true,
        duplicate: false,
        event_id: eventId,
        event_type: eventType,
      };
    }

    if (isFunding && orderRef) {
      try {
        if (eventType === "CHECKOUT.ORDER.APPROVED")
          await funding.captureByOrder(orderRef, "webhook");
        else if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
          const row = await this.db.query<{ id: string }>(
            `SELECT id FROM agreement_payments WHERE provider_order_id = $1`,
            [orderRef],
          );
          if (row.rows[0]) await funding.syncPayment(row.rows[0].id, "webhook");
        }
      } catch {
        // The sweep retries anything the webhook could not finish; the event itself is recorded.
      }
      return {
        valid: true,
        duplicate: false,
        event_id: eventId,
        event_type: eventType,
      };
    }
    if (eventType.startsWith("PAYMENT.PAYOUTS")) {
      const batchRef: string | undefined =
        res0?.payout_batch_id ?? res0?.batch_header?.payout_batch_id;
      if (batchRef) {
        try {
          await new PayoutService(this.db, this.gateway).syncByProviderBatch(
            batchRef,
            res0?.sender_batch_id ??
              res0?.batch_header?.sender_batch_header?.sender_batch_id,
          );
        } catch {
          /* the sweep retries */
        }
      }
      return {
        valid: true,
        duplicate: false,
        event_id: eventId,
        event_type: eventType,
      };
    }
    // If webhook contains payment capture completed, trigger reconciliation if mapped
    const resource = params.payload?.resource;
    if (eventType === "PAYMENT.CAPTURE.COMPLETED" && resource) {
      const customId = resource.custom_id;
      const captureId = resource.id;
      if (customId) {
        // Find matching transaction by batch id or custom id
        const txRes = await this.db.query<{ id: string; tenant_id: string }>(
          `SELECT id, tenant_id FROM payment_transactions WHERE batch_id = $1 LIMIT 1`,
          [customId],
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
    verdict: "matched" | "mismatch" | "pending";
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
      [params.tenantId, params.paymentTransactionId],
    );

    if (txRes.rows.length === 0) {
      throw new NotFoundError(
        `Payment transaction ${params.paymentTransactionId} not found.`,
      );
    }

    const tx = txRes.rows[0];
    if (tx.status === "reconciled") {
      const prior = await this.db.query<{ id: string; details: any }>(
        `SELECT id, details FROM reconciliation_records WHERE payment_transaction_id = $1 AND verdict = 'matched' ORDER BY reconciled_at DESC LIMIT 1`,
        [tx.id],
      );
      if (prior.rows[0])
        return {
          verdict: "matched",
          recordId: prior.rows[0].id,
          details: prior.rows[0].details,
        };
    }
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
      [params.tenantId, tx.batch_id],
    );

    if (batchRes.rows.length === 0) {
      throw new NotFoundError(`Settlement batch ${tx.batch_id} not found.`);
    }

    const batch = batchRes.rows[0];
    const expectedAmount = toDecimalString(batch.total_amount);
    const expectedCurrency = batch.currency;

    const actualAmount = toDecimalString(params.actualAmount || tx.amount);
    const actualCurrency = params.actualCurrency || tx.currency;
    const captureId =
      params.actualCaptureId || tx.provider_capture_id || "PENDING_CAPTURE";

    const isAmountMatched = equalsDecimals(expectedAmount, actualAmount);
    const isCurrencyMatched = expectedCurrency === actualCurrency;

    let verdict: "matched" | "mismatch" | "pending" = "matched";
    const issues: string[] = [];

    if (!isAmountMatched) {
      verdict = "mismatch";
      issues.push(
        `Amount mismatch: expected ${expectedAmount}, received ${actualAmount}`,
      );
    }
    if (!isCurrencyMatched) {
      verdict = "mismatch";
      issues.push(
        `Currency mismatch: expected ${expectedCurrency}, received ${actualCurrency}`,
      );
    }
    if (tx.status !== "captured" && !params.actualCaptureId) {
      verdict = "pending";
      issues.push(`Payment capture pending confirmation`);
    }

    const details = {
      issues,
      batch_id: batch.id,
      order_id: tx.provider_order_id,
      capture_id: captureId,
      disbursement_note:
        "PayPal Sandbox capture is buyer-to-merchant. Provider payable obligations remain internal ledger items.",
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
      ],
    );

    const recordId = recRes.rows[0].id;

    if (verdict === "matched") {
      // Update transaction status to reconciled
      await this.db.query(
        `UPDATE payment_transactions SET status = 'reconciled', updated_at = now() WHERE id = $1`,
        [tx.id],
      );

      // Update batch status to confirmed
      await this.db.query(
        `UPDATE settlement_batches SET status = 'confirmed', updated_at = now() WHERE id = $1`,
        [batch.id],
      );

      // Settle all batch obligations
      await this.db.query(
        `UPDATE obligations
         SET status = 'settled', updated_at = now()
         WHERE id IN (
           SELECT obligation_id FROM settlement_batch_items WHERE batch_id = $1
         )`,
        [batch.id],
      );

      // Append economic event
      await this.eventsService.appendEvent({
        tenantId: params.tenantId,
        aggregateType: "settlement_batch",
        aggregateId: batch.id,
        eventType: "PAYMENT_RECONCILED",
        actorType: "user",
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
    } else if (verdict === "mismatch") {
      // Mark transaction and batch as reconciliation_required
      await this.db.query(
        `UPDATE payment_transactions SET status = 'reconciliation_required', updated_at = now() WHERE id = $1`,
        [tx.id],
      );
      await this.db.query(
        `UPDATE settlement_batches SET status = 'reconciliation_required', updated_at = now() WHERE id = $1`,
        [batch.id],
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
      [tenantId],
    );
    return res.rows.map((r: any) => ({
      ...r,
      expected_amount: toDecimalString(r.expected_amount),
      actual_amount: toDecimalString(r.actual_amount),
    }));
  }
}

/**
 * Agreement funding: the buyer pays through PayPal when a quote is accepted.
 *
 * Protocol (every step is idempotent and safe to repeat):
 *   1. Acceptance      -> requestFunding(): a real PayPal order is created for the agreement price.
 *   2. Buyer approval  -> the buyer approves in PayPal (the PayPal app opens on mobile).
 *   3. Capture         -> exactly one of three triggers captures it, whichever arrives first:
 *                         the return redirect, the CHECKOUT.ORDER.APPROVED webhook, or the sweep.
 *   4. Reconciliation  -> the amount and currency PayPal reports must equal the agreement price.
 *                         Match: agreement is 'funded' and a balanced journal entry is posted.
 *                         Mismatch: nothing is released; an operator must refund.
 *   5. Delivery gate   -> with REQUIRE_FUNDING=true providers cannot deliver until funded.
 *   6. Release         -> after verification a human-approved batch moves the held funds to
 *                         "allocated to providers". Paying providers out is not implemented.
 *   7. Refund          -> a human can refund funds that were never allocated to an obligation.
 *
 * Money state comes only from PayPal's replies. Nothing here invents an id or an amount.
 */
import { randomUUID } from "node:crypto";
import { DbClient, transaction } from "../../db/connection.js";
import { EventsService } from "../events/events.service.js";
import { toDecimalString, equalsDecimals } from "../../common/decimal.js";
import {
  ConflictError,
  NotFoundError,
  StoatError,
  ValidationError,
} from "../../common/errors.js";
import { postTwoLineJournal } from "../ledger/postings.js";
import { enqueueProviderReview } from "../../jobs/enqueue.js";
import {
  GatewayCapture,
  PayPalApiError,
  PayPalGateway,
  getPayPalGateway,
  toPayPalAmount,
} from "../paypal/paypal.gateway.js";

/** PayPal orders that are never approved lapse; treat them as expired after this long. */
const ORDER_TTL_MS = 3 * 60 * 60 * 1000;

export class PaymentRequiredError extends StoatError {
  constructor(agreementId: string) {
    super(
      "PAYMENT_REQUIRED",
      `Agreement ${agreementId} has not been paid yet. The buyer must approve the PayPal payment before work can be delivered.`,
      402,
      { agreement_id: agreementId },
    );
  }
}

export interface FundingView {
  payment_id: string;
  agreement_id: string;
  status: string;
  amount: string;
  currency: string;
  approve_url: string | null;
  environment: string | null;
  attempt: number;
  capture_id: string | null;
  created_at: string;
}

type PaymentRow = {
  id: string;
  tenant_id: string;
  agreement_id: string;
  provider_order_id: string;
  provider_capture_id: string | null;
  amount: string;
  currency: string;
  status: string;
  approve_url: string | null;
  environment: string | null;
  attempt: number;
  created_at: Date | string;
};

const toView = (r: PaymentRow): FundingView => ({
  payment_id: r.id,
  agreement_id: r.agreement_id,
  status: r.status,
  amount: toDecimalString(r.amount),
  currency: r.currency,
  approve_url: r.status === "awaiting_payment" ? r.approve_url : null,
  environment: r.environment,
  attempt: r.attempt,
  capture_id: r.provider_capture_id,
  created_at: new Date(r.created_at).toISOString(),
});

export class FundingService {
  constructor(
    private db: DbClient,
    private gateway: PayPalGateway = getPayPalGateway(),
  ) {}

  // ── 1. Request payment ───────────────────────────────────────────────────
  async requestFunding(p: {
    tenantId: string;
    agreementId: string;
    actorId: string;
    buyerUserAgent?: string;
    /** Trusted console origin to send the buyer back to after PayPal. */
    returnOrigin?: string;
    correlationId?: string;
  }): Promise<FundingView | null> {
    const ag = await this.db.query<{
      id: string;
      price: string;
      currency: string;
      funding_status: string;
    }>(
      `SELECT id, price, currency, funding_status FROM agreements WHERE tenant_id = $1 AND id = $2`,
      [p.tenantId, p.agreementId],
    );
    if (!ag.rows[0]) throw new NotFoundError("Agreement", p.agreementId);
    const agreement = ag.rows[0];
    if (!(Number(agreement.price) > 0)) return null; // nothing to charge

    const live = await this.db.query<PaymentRow>(
      `SELECT * FROM agreement_payments WHERE agreement_id = $1 AND status IN ('awaiting_payment','captured','mismatch')`,
      [p.agreementId],
    );
    if (live.rows[0]) {
      const row = live.rows[0];
      if (row.status !== "awaiting_payment") return toView(row);
      // Still waiting. Reuse it unless PayPal says it lapsed.
      const synced = await this.syncPayment(row.id, "request");
      if (synced.status === "awaiting_payment") return synced;
      if (synced.status !== "expired" && synced.status !== "failed")
        return synced;
    }

    const attemptRes = await this.db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agreement_payments WHERE agreement_id = $1`,
      [p.agreementId],
    );
    const attempt = Number(attemptRes.rows[0].n) + 1;
    const paymentId = randomUUID();
    const orderInput = {
      amount: toPayPalAmount(String(agreement.price)),
      currency: agreement.currency,
      customId: `fund:${paymentId}`,
      invoiceId: `STOAT-FUND-${agreement.id}-${attempt}`,
      description: `Stoat agreement ${agreement.id}`,
      requestId: `fund-create-${paymentId}`,
      buyerUserAgent: p.buyerUserAgent,
    };
    // PayPal's Sandbox occasionally rejects or drops a valid request. Retrying with the same
    // PayPal-Request-Id is safe: PayPal returns the original order instead of making a second.
    let order;
    try {
      order = await this.gateway.createOrder(orderInput);
    } catch (err) {
      if (
        !(err instanceof PayPalApiError) ||
        !["PAYPAL_REQUEST_REJECTED", "PAYPAL_UNREACHABLE"].includes(err.code)
      )
        throw err;
      await new Promise((r) => setTimeout(r, 750));
      order = await this.gateway.createOrder(orderInput);
    }
    if (!order.approveUrl)
      throw new PayPalApiError(
        "PAYPAL_BAD_RESPONSE",
        "PayPal did not return a buyer approval link.",
        502,
      );

    try {
      return await transaction(async (tx) => {
        const ins = await tx.query<PaymentRow>(
          `INSERT INTO agreement_payments (id, tenant_id, agreement_id, provider_order_id, amount, currency,
             status, approve_url, environment, attempt, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_payment', $7, $8, $9, $10) RETURNING *`,
          [
            paymentId,
            p.tenantId,
            agreement.id,
            order.id,
            toDecimalString(agreement.price),
            agreement.currency,
            order.approveUrl,
            this.gateway.environment,
            attempt,
            JSON.stringify({
              paypal_status: order.status,
              requested_by: p.actorId,
              return_origin: p.returnOrigin ?? null,
            }),
          ],
        );
        await tx.query(
          `UPDATE agreements SET funding_status = 'awaiting_payment', updated_at = now() WHERE id = $1`,
          [agreement.id],
        );
        await new EventsService(tx).appendEvent({
          tenantId: p.tenantId,
          aggregateType: "agreement",
          aggregateId: agreement.id,
          eventType: "FUNDING_REQUESTED",
          actorType: "user",
          actorId: p.actorId,
          correlationId: p.correlationId,
          amount: toDecimalString(agreement.price),
          currency: agreement.currency,
          payload: {
            agreement_id: agreement.id,
            payment_id: paymentId,
            order_id: order.id,
            attempt,
            environment: this.gateway.environment,
          },
        });
        return toView(ins.rows[0]);
      });
    } catch (err: any) {
      if (err?.code === "23505") {
        // Lost a race with another request: return the winner.
        const winner = await this.getForAgreement(p.tenantId, p.agreementId);
        if (winner) return winner;
      }
      throw err;
    }
  }

  async getForAgreement(
    tenantId: string,
    agreementId: string,
  ): Promise<FundingView | null> {
    const res = await this.db.query<PaymentRow>(
      `SELECT * FROM agreement_payments WHERE tenant_id = $1 AND agreement_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [tenantId, agreementId],
    );
    return res.rows[0] ? toView(res.rows[0]) : null;
  }

  async listDue(
    tenantId: string,
  ): Promise<(FundingView & { provider_id: string; mission_id: string })[]> {
    const res = await this.db.query<
      PaymentRow & { provider_id: string; mission_id: string }
    >(
      `SELECT p.*, a.provider_id, a.mission_id
       FROM agreement_payments p JOIN agreements a ON a.id = p.agreement_id
       WHERE p.tenant_id = $1 AND p.status = 'awaiting_payment'
       ORDER BY p.created_at`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      ...toView(r),
      provider_id: r.provider_id,
      mission_id: r.mission_id,
    }));
  }

  // ── 2/3. Capture and sync ────────────────────────────────────────────────
  private async byOrder(orderId: string): Promise<PaymentRow | null> {
    const res = await this.db.query<PaymentRow>(
      `SELECT * FROM agreement_payments WHERE provider_order_id = $1`,
      [orderId],
    );
    return res.rows[0] ?? null;
  }

  /** True if this PayPal order belongs to an agreement payment. */
  async ownsOrder(orderId: string): Promise<boolean> {
    return !!(await this.byOrder(orderId));
  }

  /**
   * Capture a buyer-approved order. Safe to call from the return redirect, a webhook or the sweep.
   * Throws PAYPAL_ORDER_NOT_APPROVED if the buyer has not approved yet.
   */
  async captureByOrder(
    orderId: string,
    source: string,
  ): Promise<FundingView | null> {
    const row = await this.byOrder(orderId);
    if (!row) return null;
    if (row.status !== "awaiting_payment") return toView(row);
    const cap = await this.gateway.captureOrder(
      orderId,
      `fund-capture-${row.id}`,
    );
    return this.recordCapture(row.id, cap, source);
  }

  /** Ask PayPal where an awaiting payment stands and move our state to match. */
  async syncPayment(paymentId: string, source: string): Promise<FundingView> {
    const cur = await this.db.query<PaymentRow>(
      `SELECT * FROM agreement_payments WHERE id = $1`,
      [paymentId],
    );
    if (!cur.rows[0]) throw new NotFoundError("Payment", paymentId);
    const row = cur.rows[0];
    if (row.status !== "awaiting_payment") return toView(row);
    await this.db.query(
      `UPDATE agreement_payments SET last_checked_at = now() WHERE id = $1`,
      [row.id],
    );
    let order: GatewayCapture;
    try {
      order = await this.gateway.getOrder(row.provider_order_id);
    } catch (err) {
      if (err instanceof PayPalApiError && err.details?.paypal_status === 404)
        return this.markExpired(row, "order not found at PayPal");
      throw err;
    }
    if (order.orderStatus === "COMPLETED" && order.captureId) {
      return (await this.recordCapture(row.id, order, source)) ?? toView(row);
    }
    if (order.orderStatus === "APPROVED") {
      const cap = await this.gateway.captureOrder(
        row.provider_order_id,
        `fund-capture-${row.id}`,
      );
      return (await this.recordCapture(row.id, cap, source)) ?? toView(row);
    }
    if (order.orderStatus === "VOIDED")
      return this.markExpired(row, "order voided");
    if (Date.now() - new Date(row.created_at).getTime() > ORDER_TTL_MS)
      return this.markExpired(row, "not approved in time");
    return toView(row);
  }

  private async markExpired(
    row: PaymentRow,
    reason: string,
  ): Promise<FundingView> {
    return transaction(async (tx) => {
      const upd = await tx.query<PaymentRow>(
        `UPDATE agreement_payments SET status = 'expired', failure_reason = $2, updated_at = now()
         WHERE id = $1 AND status = 'awaiting_payment' RETURNING *`,
        [row.id, reason],
      );
      if (!upd.rows[0]) {
        const again = await tx.query<PaymentRow>(
          `SELECT * FROM agreement_payments WHERE id = $1`,
          [row.id],
        );
        return toView(again.rows[0]);
      }
      await tx.query(
        `UPDATE agreements SET funding_status = 'unfunded', updated_at = now() WHERE id = $1`,
        [row.agreement_id],
      );
      await new EventsService(tx).appendEvent({
        tenantId: row.tenant_id,
        aggregateType: "agreement",
        aggregateId: row.agreement_id,
        eventType: "FUNDING_EXPIRED",
        actorType: "system",
        actorId: row.tenant_id,
        amount: toDecimalString(row.amount),
        currency: row.currency,
        payload: {
          payment_id: row.id,
          order_id: row.provider_order_id,
          reason,
        },
      });
      return toView(upd.rows[0]);
    });
  }

  // ── 4. Record and reconcile a capture ────────────────────────────────────
  private async recordCapture(
    paymentId: string,
    cap: GatewayCapture,
    source: string,
  ): Promise<FundingView | null> {
    if (cap.captureStatus === "PENDING") {
      await this.db.query(
        `UPDATE agreement_payments SET metadata = metadata || $2, updated_at = now() WHERE id = $1`,
        [
          paymentId,
          JSON.stringify({
            capture_pending: true,
            checked_at: new Date().toISOString(),
          }),
        ],
      );
      const r = await this.db.query<PaymentRow>(
        `SELECT * FROM agreement_payments WHERE id = $1`,
        [paymentId],
      );
      return toView(r.rows[0]);
    }
    return transaction(async (tx) => {
      const lock = await tx.query<
        PaymentRow & { price: string; agreement_currency: string }
      >(
        `SELECT p.*, a.price, a.currency AS agreement_currency
         FROM agreement_payments p JOIN agreements a ON a.id = p.agreement_id
         WHERE p.id = $1 FOR UPDATE OF p`,
        [paymentId],
      );
      const row = lock.rows[0];
      if (!row) return null;
      if (row.status !== "awaiting_payment") return toView(row); // another trigger already handled it

      const events = new EventsService(tx);
      if (
        cap.captureStatus === "DECLINED" ||
        cap.captureStatus === "FAILED" ||
        !cap.captureId
      ) {
        const upd = await tx.query<PaymentRow>(
          `UPDATE agreement_payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`,
          [row.id, `capture ${cap.captureStatus ?? "missing"}`],
        );
        await tx.query(
          `UPDATE agreements SET funding_status = 'unfunded', updated_at = now() WHERE id = $1`,
          [row.agreement_id],
        );
        await events.appendEvent({
          tenantId: row.tenant_id,
          aggregateType: "agreement",
          aggregateId: row.agreement_id,
          eventType: "FUNDING_FAILED",
          actorType: "system",
          actorId: row.tenant_id,
          amount: toDecimalString(row.amount),
          currency: row.currency,
          payload: {
            payment_id: row.id,
            order_id: row.provider_order_id,
            capture_status: cap.captureStatus,
            source,
          },
        });
        return toView(upd.rows[0]);
      }

      const matched =
        cap.amount != null &&
        equalsDecimals(cap.amount, row.amount) &&
        cap.currency === row.currency;
      const upd = await tx.query<PaymentRow>(
        `UPDATE agreement_payments
         SET status = $2, provider_capture_id = $3, captured_amount = $4, captured_currency = $5,
             captured_at = now(), failure_reason = $6, updated_at = now(),
             metadata = metadata || $7
         WHERE id = $1 RETURNING *`,
        [
          row.id,
          matched ? "captured" : "mismatch",
          cap.captureId,
          cap.amount,
          cap.currency,
          matched
            ? null
            : `expected ${row.amount} ${row.currency}, PayPal captured ${cap.amount} ${cap.currency}`,
          JSON.stringify({ captured_via: source }),
        ],
      );
      if (matched) {
        await tx.query(
          `UPDATE agreements SET funding_status = 'funded', updated_at = now() WHERE id = $1`,
          [row.agreement_id],
        );
        const ev = await events.appendEvent({
          tenantId: row.tenant_id,
          aggregateType: "agreement",
          aggregateId: row.agreement_id,
          eventType: "FUNDING_CAPTURED",
          actorType: "system",
          actorId: row.tenant_id,
          amount: toDecimalString(row.amount),
          currency: row.currency,
          payload: {
            payment_id: row.id,
            order_id: row.provider_order_id,
            capture_id: cap.captureId,
            source,
          },
        });
        await postTwoLineJournal(tx, {
          tenantId: row.tenant_id,
          eventId: ev.id,
          reference: `funding:${row.id}`,
          currency: row.currency,
          amount: toDecimalString(row.amount),
          debitCode: "1101",
          creditCode: "2101",
        });
        // Paid: a hosted provider can start now. (Idempotent; external providers are not queued.)
        await enqueueProviderReview(tx, {
          tenantId: row.tenant_id,
          agreementId: row.agreement_id,
        });
      } else {
        await events.appendEvent({
          tenantId: row.tenant_id,
          aggregateType: "agreement",
          aggregateId: row.agreement_id,
          eventType: "FUNDING_MISMATCH",
          actorType: "system",
          actorId: row.tenant_id,
          amount: cap.amount ?? "0",
          currency: cap.currency ?? row.currency,
          payload: {
            payment_id: row.id,
            expected: toDecimalString(row.amount),
            expected_currency: row.currency,
            received: cap.amount,
            received_currency: cap.currency,
            capture_id: cap.captureId,
          },
        });
      }
      return toView(upd.rows[0]);
    });
  }

  // ── 6. Release funded batches ────────────────────────────────────────────
  /** How many of a batch's agreements are funded, and how many there are in total. */
  async batchFunding(
    tenantId: string,
    batchId: string,
  ): Promise<{ total: number; funded: number }> {
    const res = await this.db.query<{ total: string; funded: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE a.funding_status = 'funded')::text AS funded
       FROM settlement_batch_items i
       JOIN obligations o ON o.id = i.obligation_id
       JOIN agreements a ON a.id = o.agreement_id
       WHERE i.batch_id = $1 AND o.tenant_id = $2`,
      [batchId, tenantId],
    );
    return {
      total: Number(res.rows[0].total),
      funded: Number(res.rows[0].funded),
    };
  }

  /** Settle an approved batch whose agreements were all paid at acceptance. No second charge. */
  async releaseFundedBatch(p: {
    tenantId: string;
    batchId: string;
    userId: string;
    correlationId?: string;
  }) {
    return transaction(async (tx) => {
      const b = await tx.query<{
        id: string;
        status: string;
        total_amount: string;
        currency: string;
      }>(
        `SELECT id, status, total_amount, currency FROM settlement_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [p.tenantId, p.batchId],
      );
      if (!b.rows[0]) throw new NotFoundError("Settlement batch", p.batchId);
      const batch = b.rows[0];
      if (batch.status !== "approved") {
        throw new StoatError(
          "INVALID_TRANSITION",
          `Batch is '${batch.status}'. It must be 'approved' before funds can be released.`,
          422,
        );
      }
      const items = await tx.query<{
        obligation_id: string;
        ob_amount: string;
        price: string;
        funding_status: string;
        pay_amount: string | null;
        pay_status: string | null;
        charge_id: string | null;
        charge_amount: string | null;
      }>(
        `SELECT i.obligation_id, o.amount AS ob_amount, a.price, a.funding_status,
                p.captured_amount AS pay_amount, p.status AS pay_status,
                wc.id AS charge_id, wc.amount AS charge_amount
         FROM settlement_batch_items i
         JOIN obligations o ON o.id = i.obligation_id
         JOIN agreements a ON a.id = o.agreement_id
         LEFT JOIN agreement_payments p ON p.agreement_id = a.id AND p.status = 'captured'
         LEFT JOIN wallet_charges wc ON wc.obligation_id = o.id
         WHERE i.batch_id = $1`,
        [batch.id],
      );
      const walletItems = items.rows.filter((r) => r.charge_id !== null).length;
      if (walletItems > 0 && walletItems < items.rows.length) {
        throw new ValidationError(
          "This batch mixes wallet-funded and directly paid agreements. Reject it and propose them separately.",
        );
      }
      const walletFunded =
        items.rows.length > 0 && walletItems === items.rows.length;
      if (walletFunded) {
        if (
          items.rows.some(
            (r) => !equalsDecimals(r.charge_amount ?? "0", r.ob_amount),
          )
        ) {
          throw new StoatError(
            "FUNDING_AMOUNT_MISMATCH",
            "A wallet charge differs from its obligation amount.",
            422,
          );
        }
      } else {
        if (
          items.rows.length === 0 ||
          items.rows.some(
            (r) => r.funding_status !== "funded" || r.pay_status !== "captured",
          )
        ) {
          throw new ValidationError(
            "Every agreement in this batch must be paid through PayPal before funds can be released.",
          );
        }
        if (
          items.rows.some(
            (r) => !equalsDecimals(r.pay_amount ?? "0", r.ob_amount),
          )
        ) {
          throw new StoatError(
            "FUNDING_AMOUNT_MISMATCH",
            "An obligation differs from the amount the buyer paid. Refund and re-propose.",
            422,
          );
        }
      }
      const total = toDecimalString(batch.total_amount);
      const events = new EventsService(tx);
      const ev = await events.appendEvent({
        tenantId: p.tenantId,
        aggregateType: "settlement_batch",
        aggregateId: batch.id,
        eventType: "FUNDED_BATCH_RELEASED",
        actorType: "user",
        actorId: p.userId,
        correlationId: p.correlationId,
        amount: total,
        currency: batch.currency,
        payload: {
          batch_id: batch.id,
          obligations: items.rows.map((r) => r.obligation_id),
          funding: walletFunded ? "wallet" : "direct",
        },
      });
      // Wallet charges already moved 2103 -> 2102 at verification; only direct funding posts 2101 -> 2102.
      if (!walletFunded) {
        await postTwoLineJournal(tx, {
          tenantId: p.tenantId,
          eventId: ev.id,
          reference: `release:${batch.id}`,
          currency: batch.currency,
          amount: total,
          debitCode: "2101",
          creditCode: "2102",
        });
      }
      await tx.query(
        `UPDATE settlement_batches SET status = 'confirmed', updated_at = now() WHERE id = $1`,
        [batch.id],
      );
      await tx.query(
        `UPDATE obligations SET status = 'settled', updated_at = now()
         WHERE id IN (SELECT obligation_id FROM settlement_batch_items WHERE batch_id = $1)`,
        [batch.id],
      );
      return {
        batch_id: batch.id,
        status: "confirmed",
        released: total,
        currency: batch.currency,
        note: "Funds are allocated to providers. Paying providers out is not implemented.",
      };
    });
  }

  // ── 7. Refund ────────────────────────────────────────────────────────────
  async refund(p: {
    tenantId: string;
    agreementId: string;
    actorId: string;
    reason: string;
    correlationId?: string;
  }): Promise<FundingView> {
    const res = await this.db.query<PaymentRow>(
      `SELECT * FROM agreement_payments WHERE tenant_id = $1 AND agreement_id = $2 AND status IN ('captured','mismatch')`,
      [p.tenantId, p.agreementId],
    );
    const row = res.rows[0];
    if (!row)
      throw new NotFoundError("Captured payment for agreement", p.agreementId);
    const ob = await this.db.query(
      `SELECT id, status FROM obligations WHERE tenant_id = $1 AND agreement_id = $2`,
      [p.tenantId, p.agreementId],
    );
    if (ob.rows.length > 0) {
      throw new ConflictError(
        "FUNDS_ALLOCATED",
        "Work on this agreement was verified and an obligation exists, so the funds are owed to the provider and cannot be refunded here.",
      );
    }
    const cap = await this.db.query<{
      captured_amount: string;
      captured_currency: string;
    }>(
      `SELECT captured_amount, captured_currency FROM agreement_payments WHERE id = $1`,
      [row.id],
    );
    const amount = toPayPalAmount(String(cap.rows[0].captured_amount));
    const refundRes = await this.gateway.refundCapture({
      captureId: row.provider_capture_id!,
      amount,
      currency: cap.rows[0].captured_currency,
      requestId: `fund-refund-${row.id}`,
      note: p.reason || "Refund of Stoat agreement payment",
    });
    return transaction(async (tx) => {
      const upd = await tx.query<PaymentRow>(
        `UPDATE agreement_payments SET status = 'refunded', provider_refund_id = $2, refunded_at = now(), updated_at = now(),
                metadata = metadata || $3
         WHERE id = $1 AND status IN ('captured','mismatch') RETURNING *`,
        [
          row.id,
          refundRes.refundId,
          JSON.stringify({
            refund_reason: p.reason,
            refund_status: refundRes.status,
          }),
        ],
      );
      if (!upd.rows[0]) {
        const again = await tx.query<PaymentRow>(
          `SELECT * FROM agreement_payments WHERE id = $1`,
          [row.id],
        );
        return toView(again.rows[0]);
      }
      const wasBooked = row.status === "captured";
      await tx.query(
        `UPDATE agreements SET funding_status = 'refunded', updated_at = now() WHERE id = $1`,
        [row.agreement_id],
      );
      const ev = await new EventsService(tx).appendEvent({
        tenantId: p.tenantId,
        aggregateType: "agreement",
        aggregateId: row.agreement_id,
        eventType: "FUNDING_REFUNDED",
        actorType: "user",
        actorId: p.actorId,
        correlationId: p.correlationId,
        amount: toDecimalString(row.amount),
        currency: row.currency,
        payload: {
          payment_id: row.id,
          refund_id: refundRes.refundId,
          reason: p.reason,
        },
      });
      if (wasBooked)
        await postTwoLineJournal(tx, {
          tenantId: p.tenantId,
          eventId: ev.id,
          reference: `funding-refund:${row.id}`,
          currency: row.currency,
          amount: toDecimalString(row.amount),
          debitCode: "2101",
          creditCode: "1101",
        });
      return toView(upd.rows[0]);
    });
  }

  // ── Sweep ────────────────────────────────────────────────────────────────
  /** Safety net run by the worker: finishes anything the return redirect or webhook missed. */
  async sweep(limit = 25): Promise<{
    checked: number;
    captured: number;
    expired: number;
    errors: number;
  }> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM agreement_payments
       WHERE status = 'awaiting_payment' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '20 seconds')
       ORDER BY created_at LIMIT $1`,
      [limit],
    );
    const out = { checked: 0, captured: 0, expired: 0, errors: 0 };
    for (const r of due.rows) {
      try {
        const v = await this.syncPayment(r.id, "sweep");
        out.checked++;
        if (v.status === "captured") out.captured++;
        if (v.status === "expired") out.expired++;
      } catch {
        out.errors++;
      }
    }
    return out;
  }
}

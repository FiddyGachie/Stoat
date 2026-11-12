/**
 * Money Flow read model (SPEC v2.1 FR-044): for each agreement, the two PayPal legs side by side.
 * Collection (Orders v2) and disbursement (Payouts) are separate rows of fact. Nothing here is
 * inferred: every status shown is what PayPal reported and Stoat stored.
 */
import { DbClient } from "../../db/connection.js";
import { toDecimalString } from "../../common/decimal.js";
import { payoutsCapability } from "../paypal/capabilities.js";

export class MoneyFlowService {
  constructor(private db: DbClient) {}

  async list(tenantId: string, limit = 200) {
    const res = await this.db.query<any>(
      `SELECT a.id AS agreement_id, a.price, a.currency, a.status AS agreement_status, a.funding_status,
              a.provider_id, ag.name AS provider_name, a.commercial_proposal_id, a.accepted_at,
              d.id AS delivery_id, d.status AS delivery_status, art.content_hash AS artifact_hash,
              v.verdict AS verification_verdict, v.verifier_version,
              o.id AS obligation_id, o.status AS obligation_status, o.amount AS obligation_amount,
              c.id AS collection_id, c.provider_order_id, c.provider_capture_id, c.status AS collection_status,
              c.amount AS collection_amount, c.captured_amount, c.captured_currency, c.environment, c.captured_at,
              p.id AS payout_id, p.status AS payout_status, p.provider_batch_id, p.provider_item_id, p.provider_item_status,
              p.sender_batch_id, p.sender_item_id, p.recipient_masked, p.amount AS payout_amount, p.currency AS payout_currency,
              p.failure_reason, p.paid_at,
              wc.id AS wallet_charge_id, wc.amount AS wallet_charge_amount, wc.currency AS wallet_charge_currency,
              wc.reason_code AS wallet_charge_reason, wc.created_at AS wallet_charged_at
       FROM agreements a
       JOIN agents ag ON ag.id = a.provider_id
       LEFT JOIN LATERAL (SELECT * FROM deliveries x WHERE x.agreement_id = a.id ORDER BY (x.status = 'verified') DESC, x.created_at DESC LIMIT 1) d ON TRUE
       LEFT JOIN artifacts art ON art.id = d.artifact_id
       LEFT JOIN LATERAL (SELECT verdict, verifier_version FROM verifications y WHERE y.delivery_id = d.id ORDER BY y.verified_at DESC LIMIT 1) v ON TRUE
       LEFT JOIN obligations o ON o.agreement_id = a.id AND o.tenant_id = a.tenant_id
       LEFT JOIN LATERAL (SELECT * FROM agreement_payments z WHERE z.agreement_id = a.id ORDER BY z.created_at DESC LIMIT 1) c ON TRUE
       LEFT JOIN wallet_charges wc ON wc.agreement_id = a.id AND wc.tenant_id = a.tenant_id
       LEFT JOIN LATERAL (SELECT * FROM payouts q WHERE q.obligation_ids @> to_jsonb(o.id::text) ORDER BY q.created_at DESC LIMIT 1) p ON TRUE
       WHERE a.tenant_id = $1
       ORDER BY a.accepted_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    const cap = payoutsCapability();
    return {
      payouts_capability: {
        status: cap.status,
        enabled: cap.enabled,
        reason: cap.reason ?? null,
      },
      flows: res.rows.map((r) => ({
        agreement_id: r.agreement_id,
        provider_id: r.provider_id,
        provider_name: r.provider_name,
        amount: toDecimalString(r.price),
        currency: r.currency,
        agreement_status: r.agreement_status,
        negotiated: !!r.commercial_proposal_id,
        accepted_at: r.accepted_at,
        delivery: r.delivery_id
          ? {
              id: r.delivery_id,
              status: r.delivery_status,
              artifact_hash: r.artifact_hash,
              verdict: r.verification_verdict,
              verifier_version: r.verifier_version,
            }
          : null,
        obligation: r.obligation_id
          ? {
              id: r.obligation_id,
              status: r.obligation_status,
              amount: toDecimalString(r.obligation_amount),
            }
          : null,
        collection: r.collection_id
          ? {
              direction: "BUYER_COLLECTION",
              provider: "PAYPAL",
              status: r.collection_status,
              funding_status: r.funding_status,
              paypal_order_id: r.provider_order_id,
              paypal_capture_id: r.provider_capture_id,
              amount: toDecimalString(r.collection_amount),
              currency: r.currency,
              captured_amount: r.captured_amount
                ? toDecimalString(r.captured_amount)
                : null,
              environment: r.environment,
              captured_at: r.captured_at,
              reconciliation:
                r.collection_status === "captured"
                  ? "matched"
                  : r.collection_status === "mismatch"
                    ? "reconciliation_required"
                    : "pending",
            }
          : null,
        wallet_charge: r.wallet_charge_id
          ? {
              id: r.wallet_charge_id,
              amount: toDecimalString(r.wallet_charge_amount),
              currency: r.wallet_charge_currency,
              reason_code: r.wallet_charge_reason,
              charged_at: r.wallet_charged_at,
            }
          : null,
        disbursement: r.payout_id
          ? {
              direction: "PROVIDER_DISBURSEMENT",
              provider: "PAYPAL",
              status: r.payout_status,
              payout_id: r.payout_id,
              paypal_payout_batch_id: r.provider_batch_id,
              paypal_payout_item_id: r.provider_item_id,
              item_status: r.provider_item_status,
              sender_batch_id: r.sender_batch_id,
              sender_item_id: r.sender_item_id,
              recipient_masked: r.recipient_masked,
              amount: toDecimalString(r.payout_amount),
              currency: r.payout_currency,
              failure_reason: r.failure_reason,
              paid_at: r.paid_at,
              reconciliation:
                r.payout_status === "paid"
                  ? "matched"
                  : r.payout_status === "failed" ||
                      r.payout_status === "returned"
                    ? "exception"
                    : "pending",
            }
          : null,
        provider_paid:
          r.payout_status === "paid" && r.obligation_status === "paid",
      })),
    };
  }
}

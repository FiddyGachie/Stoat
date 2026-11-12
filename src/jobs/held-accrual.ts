import type { DbClient } from "../db/connection.js";
import { transaction } from "../db/connection.js";
import { HoldActiveError } from "../modules/agentic/commerce-errors.js";
import { heldAccrualMaxDays } from "../modules/agentic/agentic-config.js";
import { LedgerService } from "../modules/ledger/ledger.service.js";
import { notifyInTx } from "../modules/wallet/notification.service.js";

export interface HeldAccrualPayload {
  tenant_id?: string;
  agreement_id?: string;
  delivery_id?: string;
  queued_at?: string;
  correlation_id?: string;
}

export interface DeferredJob {
  deferSeconds: number;
  note: string;
}

export async function handleHeldAccrual(
  db: DbClient,
  payload: HeldAccrualPayload,
): Promise<string | DeferredJob> {
  const agreementId = payload.agreement_id;
  const deliveryId = payload.delivery_id;
  const tenantId = payload.tenant_id;
  if (!tenantId || !agreementId || !deliveryId || !payload.queued_at) {
    throw new Error("held_accrual requires tenant_id, agreement_id, delivery_id and queued_at.");
  }
  const queuedAt = Date.parse(payload.queued_at);
  if (!Number.isFinite(queuedAt)) {
    throw new Error("held_accrual queued_at must be a valid timestamp.");
  }

  const r = await db.query<{
    tenant_id: string;
    status: string;
    delivery_status: string;
    verdict: string | null;
    obligation_id: string | null;
  }>(
    `SELECT a.tenant_id, a.status, d.status AS delivery_status, v.verdict,
            o.id AS obligation_id
     FROM agreements a
     JOIN deliveries d ON d.agreement_id = a.id AND d.tenant_id = a.tenant_id
     LEFT JOIN verifications v ON v.delivery_id = d.id
     LEFT JOIN obligations o ON o.agreement_id = a.id AND o.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.id = $2 AND d.id = $3`,
    [tenantId, agreementId, deliveryId],
  );
  const delivery = r.rows[0];
  if (!delivery) return "agreement or delivery no longer exists";
  if (
    delivery.status === "cancelled" ||
    delivery.delivery_status !== "verified" ||
    delivery.verdict !== "verified" ||
    delivery.obligation_id
  ) {
    return "delivery is no longer eligible for accrual";
  }

  try {
    await new LedgerService(db).accrueObligationForDelivery({
      tenantId: delivery.tenant_id,
      agreementId,
      deliveryId,
      correlationId: payload.correlation_id,
    });
    return "held obligation accrued";
  } catch (error) {
    if (!(error instanceof HoldActiveError)) throw error;
  }

  const maxAgeMs = heldAccrualMaxDays() * 24 * 60 * 60 * 1000;
  if (Date.now() - queuedAt >= maxAgeMs) {
    await transaction(async (tx) => {
      await notifyInTx(tx, {
        tenantId: delivery.tenant_id,
        kind: "held_accrual_stuck",
        recipient: { admins: true },
        title: "Verified delivery accrual remains held",
        body: "A verified delivery has remained blocked by an active Hold beyond the configured limit. Review the Hold and agreement.",
        entityType: "agreement",
        entityId: agreementId,
        eventId: `held_accrual_stuck:${agreementId}:${deliveryId}`,
      });
    });
    return "held accrual exceeded its maximum age; Admins were notified";
  }

  return { deferSeconds: 60, note: "accrual remains blocked by an active Hold" };
}

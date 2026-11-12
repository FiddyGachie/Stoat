/**
 * Compatibility mapper for the legacy `/v1/budgets` API (Requirement 17.10).
 *
 * `/v1/budgets` keeps its status codes and field names. A budget that the wallet migration
 * linked to a deposit (`spending_budgets.wallet_deposit_id`) and that belongs to a mission is
 * "wallet-backed" while its tenant runs in wallet funding mode. For those budgets the
 * `complete`, `decide` and `decision` routes delegate to the wallet module (mission completion
 * and Remainder_Decision) and the answer is mapped back to the legacy shape:
 *
 *   wallet state            legacy status
 *   active / depleted       same
 *   awaiting_decision       awaiting_decision
 *   closed (refund)         refunded
 *   closed (keep)           retained
 *
 *   legacy `retain`  <->  wallet `keep`
 *
 * Every other budget (direct-mode tenants, budgets without a mission) stays on BudgetService.
 * Nothing here moves money itself: refunds are planned and sent by RefundService, and the
 * caller is always a human principal (the routes enforce that).
 */
import { randomUUID } from "node:crypto";
import type { DbClient } from "../../db/connection.js";
import {
  ConflictError,
  StoatError,
  ValidationError,
} from "../../common/errors.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import type { PayPalGateway } from "../paypal/paypal.gateway.js";
import { getFundingMode } from "../wallet/funding-mode.js";
import { completeMission } from "../wallet/mission-completion.service.js";
import { RefundService } from "../wallet/refund.service.js";
import type { BudgetView, DecisionView } from "./budget.service.js";

interface Link {
  mission_id: string;
}

/** The mission a wallet-backed budget is bound to, or null when the legacy path applies. */
export async function walletBackedLink(
  db: DbClient,
  tenantId: string,
  budgetId: string,
): Promise<Link | null> {
  const r = await db.query<{
    mission_id: string | null;
    wallet_deposit_id: string | null;
  }>(
    `SELECT mission_id, wallet_deposit_id FROM spending_budgets
      WHERE id = $1 AND tenant_id = $2`,
    [budgetId, tenantId],
  );
  const row = r.rows[0];
  if (!row?.mission_id || !row.wallet_deposit_id) return null;
  if ((await getFundingMode(db, tenantId)) !== "wallet") return null;
  return { mission_id: row.mission_id };
}

/** Wallet funding state of a mission mapped to the legacy status vocabulary. */
export async function legacyStatusForMission(
  db: DbClient,
  missionId: string,
): Promise<string | null> {
  const f = await db.query<{ state: string }>(
    `SELECT state FROM mission_funding WHERE mission_id = $1`,
    [missionId],
  );
  const state = f.rows[0]?.state;
  if (!state) return null;
  if (state !== "closed") return state;
  const d = await db.query<{ decision: string }>(
    `SELECT decision FROM remainder_decisions WHERE mission_id = $1`,
    [missionId],
  );
  // A mission with no recorded decision closed with nothing left: keep the stored legacy status.
  if (!d.rows[0]) return null;
  return d.rows[0].decision === "refund" ? "refunded" : "retained";
}

/** Replace the status of wallet-backed budgets with the wallet's view. Others pass through. */
export async function overlayWalletStatus(
  db: DbClient,
  tenantId: string,
  views: BudgetView[],
): Promise<BudgetView[]> {
  const candidates = views.filter(
    (v) =>
      v.mission_id &&
      [
        "active",
        "depleted",
        "awaiting_decision",
        "refunded",
        "retained",
      ].includes(v.status),
  );
  if (candidates.length === 0) return views;
  if ((await getFundingMode(db, tenantId)) !== "wallet") return views;
  const linked = await db.query<{ id: string }>(
    `SELECT id FROM spending_budgets
      WHERE tenant_id = $1 AND wallet_deposit_id IS NOT NULL AND id = ANY($2::uuid[])`,
    [tenantId, candidates.map((c) => c.id)],
  );
  const linkedIds = new Set(linked.rows.map((r) => r.id));
  const out: BudgetView[] = [];
  for (const v of views) {
    if (!linkedIds.has(v.id) || !v.mission_id) {
      out.push(v);
      continue;
    }
    const status = await legacyStatusForMission(db, v.mission_id);
    out.push(status ? { ...v, status } : v);
  }
  return out;
}

/** Map a wallet DecisionView to the legacy decision shape. */
export function toLegacyDecision(
  d: import("../wallet/refund.service.js").DecisionView,
  budgetId: string,
  note: string | null,
): DecisionView {
  const item = d.refund?.items[0] ?? null;
  return {
    id: d.id,
    budget_id: budgetId,
    decision: d.decision === "keep" ? "retain" : "refund",
    decided_by: d.decided_by,
    decided_at: d.decided_at,
    paypal_refund_id: item?.paypal_refund_id ?? null,
    refund_status: item?.paypal_status ?? d.refund?.status ?? null,
    note,
  };
}

export async function completeBudgetViaWallet(
  db: DbClient,
  p: {
    tenantId: string;
    missionId: string;
    principal: AuthenticatedPrincipal;
    correlationId?: string;
  },
): Promise<void> {
  await completeMission(db, {
    tenantId: p.tenantId,
    missionId: p.missionId,
    actor: { type: "owner", userId: p.principal.id },
    correlationId: p.correlationId,
  });
}

export async function decideBudgetViaWallet(
  db: DbClient,
  gateway: PayPalGateway | undefined,
  p: {
    tenantId: string;
    budgetId: string;
    missionId: string;
    principal: AuthenticatedPrincipal;
    decision: unknown;
    note?: string;
    idempotencyKey?: string;
    correlationId?: string;
  },
): Promise<DecisionView> {
  if (p.decision !== "refund" && p.decision !== "retain") {
    throw new ValidationError("The decision must be refund or retain.", {
      field: "decision",
    });
  }
  const refunds = new RefundService({ gateway, db });
  if (await refunds.getDecision(p.tenantId, p.missionId)) {
    throw new ConflictError(
      "DECISION_ALREADY_MADE",
      "A decision has already been recorded for this budget.",
    );
  }
  const status = await legacyStatusForMission(db, p.missionId);
  if (status !== "awaiting_decision") {
    throw new StoatError(
      "BUDGET_INVALID_STATE",
      `Budget is '${status ?? "unknown"}'. Only 'awaiting_decision' budgets can receive a remainder decision.`,
      422,
    );
  }
  const d = await refunds.decideRemainder({
    tenantId: p.tenantId,
    owner: p.principal,
    missionId: p.missionId,
    decision: p.decision === "retain" ? "keep" : "refund",
    idempotencyKey: p.idempotencyKey ?? `legacy-budget-decide:${p.budgetId}`,
    correlationId: p.correlationId ?? randomUUID(),
  });
  return toLegacyDecision(d, p.budgetId, p.note ?? null);
}

export async function getBudgetDecisionViaWallet(
  db: DbClient,
  gateway: PayPalGateway | undefined,
  p: { tenantId: string; budgetId: string; missionId: string },
): Promise<DecisionView | null> {
  const d = await new RefundService({ gateway, db }).getDecision(
    p.tenantId,
    p.missionId,
  );
  return d ? toLegacyDecision(d, p.budgetId, null) : null;
}

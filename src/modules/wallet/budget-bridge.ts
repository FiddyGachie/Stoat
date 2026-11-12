/**
 * Budget → wallet bridge (wallet funding mode).
 *
 * A spending budget the buyer approved at PayPal is money already captured into the platform's
 * PayPal business account. In wallet mode that money must fund missions through the Owner's
 * wallet (Reservation at acceptance, Charge at verification), never through a new PayPal order
 * per agreement. This module moves one captured budget into the wallet, exactly as migration 008
 * did for legacy budgets:
 *
 *   - one captured wallet_deposits row (migrated_from_budget_id = budget), credited with the
 *     budget's remaining balance;
 *   - one balanced opening entry Dr 2101 (funds held for agreements) / Cr 2103 (wallet funds),
 *     tagged with the wallet, so the trial balance stays zero and no 1101 cash line is touched;
 *   - spending_budgets.wallet_deposit_id links the two; mission funding is recomputed.
 *
 * No PayPal call is made. Amounts come only from the captured budget row. Idempotent: a budget
 * already linked is returned unchanged. Runs inside the caller's transaction.
 */
import type { DbClient } from "../../db/connection.js";
import { Decimal } from "decimal.js";
import { getOrCreateWallet } from "./wallet.service.js";
import { postJournal } from "./wallet-ledger.js";
import { appendWalletEvent } from "./wallet-events.js";
import { recomputeWalletMissions } from "./mission-funding.service.js";
import { notifyInTx } from "./notification.service.js";
import { formatMoney } from "./wallet-math.js";

export type BridgeOutcome =
  | { bridged: true; budgetId: string; depositId: string; walletId: string; credited: string }
  | { bridged: false; budgetId: string; reason: string };

const BRIDGEABLE = ["active", "depleted", "awaiting_decision"];

export async function bridgeBudgetToWallet(
  tx: DbClient,
  budgetId: string,
  opts: { actorId?: string; correlationId?: string } = {},
): Promise<BridgeOutcome> {
  const r = await tx.query<any>(
    `SELECT b.*,
            CASE b.owner_type
              WHEN 'user'  THEN (SELECT u.id FROM users u WHERE u.id = b.owner_id AND u.tenant_id = b.tenant_id)
              WHEN 'agent' THEN (SELECT a.owner_user_id FROM agents a
                                  WHERE a.id = b.owner_id AND a.tenant_id = b.tenant_id)
            END AS owner_user_id
       FROM spending_budgets b WHERE b.id = $1 FOR UPDATE OF b`,
    [budgetId],
  );
  const b = r.rows[0];
  if (!b) return { bridged: false, budgetId, reason: "not_found" };
  if (b.wallet_deposit_id) return { bridged: false, budgetId, reason: "already_bridged" };
  if (!BRIDGEABLE.includes(b.status)) return { bridged: false, budgetId, reason: `status_${b.status}` };
  if (!b.paypal_capture_id) return { bridged: false, budgetId, reason: "not_captured" };
  if (!b.owner_user_id) return { bridged: false, budgetId, reason: "owner_not_resolvable" };
  const env = b.paypal_environment === "live" ? "live" : "sandbox";
  const credited = new Decimal(String(b.balance));
  if (credited.lt(0)) return { bridged: false, budgetId, reason: "negative_balance" };

  const wallet = await getOrCreateWallet(tx, {
    tenantId: b.tenant_id,
    ownerUserId: b.owner_user_id,
    currency: b.currency,
    environment: env,
  });
  await tx.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [wallet.id]);

  // paypal_order_id stays NULL on the deposit so a later PayPal return for this order keeps
  // routing to the budget (the order ID is kept in metadata). The capture ID is kept: refunds of
  // the wallet remainder are made against this capture.
  const dep = await tx.query<{ id: string }>(
    `INSERT INTO wallet_deposits
       (tenant_id, wallet_id, owner_user_id, mission_id, is_top_up, provider, amount, currency, status,
        idempotency_key, request_hash, paypal_request_id, paypal_order_id, paypal_capture_id,
        captured_amount, captured_currency, credited_amount, captured_at, paypal_environment,
        migrated_from_budget_id, metadata)
     VALUES ($1, $2, $3, $4, FALSE, 'paypal', $5, $6, 'captured',
             'budget-bridge:' || $7::text, 'budget-bridge:' || $7::text, 'budget-bridge:' || $7::text,
             NULL, $8, $5, $6, $9, COALESCE($10, now()), $11, $14::uuid,
             jsonb_build_object('bridged_from', 'spending_budgets', 'paypal_order_id', $12::text,
                                'legacy_status', $13::text))
     RETURNING id`,
    [
      b.tenant_id, wallet.id, b.owner_user_id, b.mission_id, String(b.amount), b.currency,
      b.id, b.paypal_capture_id, credited.toFixed(6), b.activated_at, env,
      b.paypal_order_id, b.status, b.id,
    ],
  );
  const depositId = dep.rows[0].id;
  await tx.query(
    `UPDATE spending_budgets SET wallet_deposit_id = $2, updated_at = now() WHERE id = $1`,
    [b.id, depositId],
  );

  const ev = await appendWalletEvent(tx, {
    tenantId: b.tenant_id,
    aggregateType: "wallet_deposit",
    aggregateId: depositId,
    eventType: "BUDGET_MOVED_TO_WALLET",
    actorRole: opts.actorId ? "admin" : "system",
    actorId: opts.actorId ?? b.tenant_id,
    correlationId: opts.correlationId,
    amount: credited.toFixed(6),
    currency: b.currency,
    paypal: { captureId: b.paypal_capture_id, orderId: b.paypal_order_id },
    details: { budget_id: b.id, wallet_id: wallet.id, mission_id: b.mission_id ?? null },
  });

  if (credited.gt(0)) {
    // Reclassify held funds: Dr 2101 / Cr 2103 (wallet). Cash (1101) was booked at capture.
    await postJournal(tx, {
      tenantId: b.tenant_id,
      eventId: ev.id,
      reference: `wallet:budget-bridge:${b.id}`,
      currency: b.currency,
      lines: [
        { accountCode: "2101", side: "debit", amount: credited.toFixed(6) },
        { accountCode: "2103", side: "credit", amount: credited.toFixed(6), walletId: wallet.id },
      ],
    });
    await notifyInTx(tx, {
      tenantId: b.tenant_id,
      kind: "deposit_captured",
      recipient: { userId: b.owner_user_id },
      title: "Budget added to your wallet",
      body: `${formatMoney(credited.toFixed(6))} ${b.currency} from your approved spending budget now funds your missions.`,
      eventId: `budget_bridge:${b.id}:owner`,
      entityType: "wallet_deposit",
      entityId: depositId,
      missionId: b.mission_id ?? null,
    });
  }

  await recomputeWalletMissions(tx, wallet.id, b.mission_id ?? null);
  return { bridged: true, budgetId: b.id, depositId, walletId: wallet.id, credited: credited.toFixed(6) };
}

/** Bridge every captured, not-yet-linked budget of a tenant. Used when switching to wallet mode. */
export async function bridgeTenantBudgets(
  tx: DbClient,
  tenantId: string,
  opts: { actorId?: string; correlationId?: string } = {},
): Promise<BridgeOutcome[]> {
  const ids = await tx.query<{ id: string }>(
    `SELECT id FROM spending_budgets
      WHERE tenant_id = $1 AND wallet_deposit_id IS NULL AND status = ANY($2::text[])
      ORDER BY created_at, id`,
    [tenantId, BRIDGEABLE],
  );
  const out: BridgeOutcome[] = [];
  for (const { id } of ids.rows) out.push(await bridgeBudgetToWallet(tx, id, opts));
  return out;
}

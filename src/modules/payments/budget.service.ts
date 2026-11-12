/**
 * BudgetService — pre-approved spending budgets with real PayPal holds and micro-debit accounting.
 *
 * Protocol:
 *   1. createBudget()     → user/agent sets a spending cap; a real PayPal order is created.
 *   2. [buyer approves]   → PayPal processes the payment in the buyer's app.
 *   3. activateBudget()   → called on PayPal webhook / return redirect; captures the order,
 *                           reconciles the amount, marks budget 'active', balance = amount.
 *   4. debit()            → agent or platform debits micro-amounts against the balance.
 *                           No new PayPal call per debit. Fails atomically if balance < amount.
 *   5. completeMission()  → called when mission finishes. If balance > 0 → 'awaiting_decision'.
 *      depleteCheck()     → called after every debit; if balance = 0 → 'depleted', mission stops.
 *   6. decideRemainder()  → user calls with 'refund' (PayPal refund of remainder) or 'retain'.
 *
 * Money rule: amounts come exclusively from PayPal captures. The balance is a counter, not money.
 */
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
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
import { getFundingMode } from "../wallet/funding-mode.js";
import { bridgeBudgetToWallet } from "../wallet/budget-bridge.js";
import {
  PayPalGateway,
  PayPalApiError,
  getPayPalGateway,
  toPayPalAmount,
} from "../paypal/paypal.gateway.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BudgetView {
  id: string;
  tenant_id: string;
  owner_id: string;
  owner_type: string;
  mission_id: string | null;
  amount: string;
  currency: string;
  balance: string;
  total_debited: string;
  utilization_pct: number;
  status: string;
  approve_url: string | null;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  paypal_environment: string | null;
  activated_at: string | null;
  closed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DebitView {
  id: string;
  budget_id: string;
  actor_type: string;
  actor_id: string;
  reason: string;
  reference_type: string | null;
  reference_id: string | null;
  amount: string;
  currency: string;
  balance_after: string;
  agent_run_id: string | null;
  created_at: string;
}

export interface DecisionView {
  id: string;
  budget_id: string;
  decision: "refund" | "retain";
  decided_by: string;
  decided_at: string;
  paypal_refund_id: string | null;
  refund_status: string | null;
  note: string | null;
}

type BudgetRow = {
  id: string;
  tenant_id: string;
  owner_id: string;
  owner_type: string;
  mission_id: string | null;
  amount: string;
  currency: string;
  balance: string;
  total_debited: string;
  status: string;
  approve_url: string | null;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  paypal_environment: string | null;
  activated_at: Date | string | null;
  closed_at: Date | string | null;
  failure_reason: string | null;
  return_origin: string | null;
  paypal_request_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type DebitRow = {
  id: string;
  budget_id: string;
  actor_type: string;
  actor_id: string;
  reason: string;
  reference_type: string | null;
  reference_id: string | null;
  amount: string;
  currency: string;
  balance_after: string;
  agent_run_id: string | null;
  created_at: Date | string;
};

const toView = (r: BudgetRow): BudgetView => {
  const amt = new Decimal(r.amount);
  const debited = new Decimal(r.total_debited);
  // Percentage with two decimals, rounded half up; the field stays a JSON number as before.
  const utilization = amt.gt(0)
    ? debited
        .div(amt)
        .times(100)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toNumber()
    : 0;
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    owner_id: r.owner_id,
    owner_type: r.owner_type,
    mission_id: r.mission_id,
    amount: toDecimalString(r.amount),
    currency: r.currency,
    balance: toDecimalString(r.balance),
    total_debited: toDecimalString(r.total_debited),
    utilization_pct: utilization,
    status: r.status,
    approve_url: r.status === "pending_approval" ? r.approve_url : null,
    paypal_order_id: r.paypal_order_id,
    paypal_capture_id: r.paypal_capture_id,
    paypal_environment: r.paypal_environment,
    activated_at: r.activated_at
      ? new Date(r.activated_at).toISOString()
      : null,
    closed_at: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    failure_reason: r.failure_reason,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
};

/** True for a finite decimal string/number strictly greater than zero (no float arithmetic). */
const isPositiveDecimal = (v: unknown): boolean => {
  try {
    if (typeof v !== "string" && typeof v !== "number") return false;
    const d = new Decimal(v);
    return d.isFinite() && d.gt(0);
  } catch {
    return false;
  }
};

const toDebitView = (r: DebitRow): DebitView => ({
  id: r.id,
  budget_id: r.budget_id,
  actor_type: r.actor_type,
  actor_id: r.actor_id,
  reason: r.reason,
  reference_type: r.reference_type,
  reference_id: r.reference_id,
  amount: toDecimalString(r.amount),
  currency: r.currency,
  balance_after: toDecimalString(r.balance_after),
  agent_run_id: r.agent_run_id,
  created_at: new Date(r.created_at).toISOString(),
});

// ── Service ───────────────────────────────────────────────────────────────────

export class BudgetService {
  constructor(
    private db: DbClient,
    private gateway: PayPalGateway = getPayPalGateway(),
  ) {}

  // ── 1. Create & get ────────────────────────────────────────────────────────

  async createBudget(p: {
    tenantId: string;
    ownerId: string;
    ownerType: "user" | "agent";
    missionId?: string;
    amount: string;
    currency?: string;
    returnOrigin?: string;
    buyerUserAgent?: string;
    correlationId?: string;
  }): Promise<BudgetView> {
    if (!isPositiveDecimal(p.amount))
      throw new ValidationError("Budget amount must be greater than zero.");
    const currency = p.currency ?? "USD";
    const budgetId = randomUUID();
    const requestId = `budget-order-${budgetId}`;
    const paypalAmount = toPayPalAmount(p.amount);

    // Create the PayPal order to hold the funds.
    const order = await this.gateway.createOrder({
      amount: paypalAmount,
      currency,
      customId: `budget:${budgetId}`,
      invoiceId: `STOAT-BUDGET-${budgetId}`,
      description: `Stoat spending budget${p.missionId ? ` for mission ${p.missionId.slice(0, 8)}` : ""}`,
      requestId,
      buyerUserAgent: p.buyerUserAgent,
    });
    if (!order.approveUrl) {
      throw new PayPalApiError(
        "PAYPAL_BAD_RESPONSE",
        "PayPal did not return a buyer approval link.",
        502,
      );
    }

    return transaction(async (tx) => {
      const ins = await tx.query<BudgetRow>(
        `INSERT INTO spending_budgets
           (id, tenant_id, owner_id, owner_type, mission_id, amount, currency,
            balance, total_debited, status, approve_url, paypal_order_id,
            paypal_environment, paypal_request_id, return_origin, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 'pending_approval', $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          budgetId,
          p.tenantId,
          p.ownerId,
          p.ownerType,
          p.missionId ?? null,
          toDecimalString(p.amount),
          currency,
          order.approveUrl,
          order.id,
          this.gateway.environment,
          requestId,
          p.returnOrigin ?? null,
          JSON.stringify({
            paypal_status: order.status,
            requested_by: p.ownerId,
          }),
        ],
      );
      await new EventsService(tx).appendEvent({
        tenantId: p.tenantId,
        aggregateType: "spending_budget",
        aggregateId: budgetId,
        eventType: "BUDGET_CREATED",
        actorType: "user",
        actorId: p.ownerId,
        correlationId: p.correlationId,
        amount: toDecimalString(p.amount),
        currency,
        payload: {
          budget_id: budgetId,
          paypal_order_id: order.id,
          mission_id: p.missionId ?? null,
        },
      });
      return toView(ins.rows[0]);
    });
  }

  async getBudget(tenantId: string, budgetId: string): Promise<BudgetView> {
    const res = await this.db.query<BudgetRow>(
      `SELECT * FROM spending_budgets WHERE tenant_id = $1 AND id = $2`,
      [tenantId, budgetId],
    );
    if (!res.rows[0]) throw new NotFoundError("SpendingBudget", budgetId);
    return toView(res.rows[0]);
  }

  async listBudgets(
    tenantId: string,
    opts?: { ownerId?: string; missionId?: string; status?: string },
  ): Promise<BudgetView[]> {
    const res = await this.db.query<BudgetRow>(
      `SELECT * FROM spending_budgets
       WHERE tenant_id = $1
         AND ($2::uuid IS NULL OR owner_id = $2)
         AND ($3::uuid IS NULL OR mission_id = $3)
         AND ($4::text IS NULL OR status = $4)
         AND ($4::text = 'cancelled' OR NOT (COALESCE(metadata, '{}'::jsonb) ? 'deleted_at'))
       ORDER BY created_at DESC LIMIT 200`,
      [
        tenantId,
        opts?.ownerId ?? null,
        opts?.missionId ?? null,
        opts?.status ?? null,
      ],
    );
    return res.rows.map(toView);
  }

  // ── 2. Activate on PayPal capture ─────────────────────────────────────────

  /** Called by the return redirect, webhook, or sweep when PayPal confirms buyer approval. */
  async activateByOrder(
    orderId: string,
    source: string,
  ): Promise<BudgetView | null> {
    const res = await this.db.query<BudgetRow>(
      `SELECT * FROM spending_budgets WHERE paypal_order_id = $1`,
      [orderId],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.status !== "pending_approval") return toView(row);

    const cap = await this.gateway.captureOrder(
      orderId,
      `budget-capture-${row.id}`,
    );
    if (
      !cap.captureId ||
      cap.captureStatus === "DECLINED" ||
      cap.captureStatus === "FAILED"
    ) {
      return transaction(async (tx) => {
        const upd = await tx.query<BudgetRow>(
          `UPDATE spending_budgets SET status = 'failed', failure_reason = $2, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [row.id, `capture ${cap.captureStatus ?? "missing"}`],
        );
        await new EventsService(tx).appendEvent({
          tenantId: row.tenant_id,
          aggregateType: "spending_budget",
          aggregateId: row.id,
          eventType: "BUDGET_ACTIVATION_FAILED",
          actorType: "system",
          actorId: row.tenant_id,
          amount: toDecimalString(row.amount),
          currency: row.currency,
          payload: {
            paypal_order_id: orderId,
            capture_status: cap.captureStatus,
            source,
          },
        });
        return toView(upd.rows[0]);
      });
    }

    // Reconcile: PayPal amount must match what the user pre-approved.
    const matched =
      cap.amount != null &&
      equalsDecimals(cap.amount, row.amount) &&
      cap.currency === row.currency;
    if (!matched) {
      return transaction(async (tx) => {
        const upd = await tx.query<BudgetRow>(
          `UPDATE spending_budgets SET status = 'failed',
            failure_reason = $2, paypal_capture_id = $3, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [
            row.id,
            `amount mismatch: expected ${row.amount} ${row.currency}, PayPal captured ${cap.amount} ${cap.currency}`,
            cap.captureId,
          ],
        );
        await new EventsService(tx).appendEvent({
          tenantId: row.tenant_id,
          aggregateType: "spending_budget",
          aggregateId: row.id,
          eventType: "BUDGET_AMOUNT_MISMATCH",
          actorType: "system",
          actorId: row.tenant_id,
          amount: cap.amount ?? "0",
          currency: cap.currency ?? row.currency,
          payload: { expected: row.amount, received: cap.amount, source },
        });
        return toView(upd.rows[0]);
      });
    }

    return transaction(async (tx) => {
      const upd = await tx.query<BudgetRow>(
        `UPDATE spending_budgets
         SET status = 'active', balance = amount, paypal_capture_id = $2,
             paypal_environment = $3, activated_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
        [row.id, cap.captureId, this.gateway.environment],
      );
      if (!upd.rows[0]) {
        const again = await tx.query<BudgetRow>(
          `SELECT * FROM spending_budgets WHERE id = $1`,
          [row.id],
        );
        return toView(again.rows[0]);
      }
      const ev = await new EventsService(tx).appendEvent({
        tenantId: row.tenant_id,
        aggregateType: "spending_budget",
        aggregateId: row.id,
        eventType: "BUDGET_ACTIVATED",
        actorType: "system",
        actorId: row.tenant_id,
        amount: toDecimalString(row.amount),
        currency: row.currency,
        payload: {
          paypal_order_id: orderId,
          capture_id: cap.captureId,
          source,
        },
      });
      // Double-entry: buyer pays → funds held in escrow account 2101
      await postTwoLineJournal(tx, {
        tenantId: row.tenant_id,
        eventId: ev.id,
        reference: `budget-hold:${row.id}`,
        currency: row.currency,
        amount: toDecimalString(row.amount),
        debitCode: "1101",
        creditCode: "2101",
      });
      // Wallet mode: the approved budget funds missions through the Owner's wallet
      // (Reservation at acceptance), never through a PayPal order per agreement.
      if ((await getFundingMode(tx, row.tenant_id)) === "wallet") {
        await bridgeBudgetToWallet(tx, row.id, { correlationId: undefined });
        const again = await tx.query<BudgetRow>(`SELECT * FROM spending_budgets WHERE id = $1`, [row.id]);
        return toView(again.rows[0]);
      }
      return toView(upd.rows[0]);
    });
  }

  /** Sync an awaiting budget with PayPal (called by the sweep worker). */
  async syncBudget(budgetId: string): Promise<BudgetView> {
    const res = await this.db.query<BudgetRow>(
      `SELECT * FROM spending_budgets WHERE id = $1`,
      [budgetId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundError("SpendingBudget", budgetId);
    if (row.status !== "pending_approval") return toView(row);
    if (!row.paypal_order_id) return toView(row);
    const order = await this.gateway.getOrder(row.paypal_order_id);
    if (order.orderStatus === "APPROVED" || order.orderStatus === "COMPLETED") {
      return (
        (await this.activateByOrder(row.paypal_order_id, "sync")) ?? toView(row)
      );
    }
    return toView(row);
  }

  /** Owner-scoped sync: a person asks Stoat to check PayPal for a pending budget. */
  async syncBudgetForTenant(tenantId: string, budgetId: string): Promise<BudgetView> {
    await this.getBudget(tenantId, budgetId); // 404 when missing or another tenant's
    return this.syncBudget(budgetId);
  }

  /**
   * Safety net (30 s sweep): activate budgets whose PayPal order the buyer already approved
   * but whose return redirect never reached Stoat. PayPal's order status decides; idempotent.
   */
  async sweep(limit = 25): Promise<{ checked: number; activated: number; errors: number }> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM spending_budgets
        WHERE status = 'pending_approval' AND paypal_order_id IS NOT NULL
          AND created_at > now() - interval '3 days'
        ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    let activated = 0;
    let errors = 0;
    for (const { id } of due.rows) {
      try {
        const v = await this.syncBudget(id);
        if (v.status !== "pending_approval") activated += 1;
      } catch {
        errors += 1;
      }
    }
    return { checked: due.rows.length, activated, errors };
  }

  // ── 3. Debit (micro-payment counter) ──────────────────────────────────────

  /**
   * Atomically debit `amount` from the active budget.
   * No PayPal call — the funds are already held. This is an accounting entry only.
   * Returns the updated budget + the debit record.
   * Throws BUDGET_INSUFFICIENT if balance < amount.
   * Throws BUDGET_NOT_ACTIVE if the budget is not in 'active' state.
   */
  async debit(p: {
    tenantId: string;
    budgetId: string;
    actorType: "agent" | "system" | "user";
    actorId: string;
    amount: string;
    reason: string;
    referenceType?: string;
    referenceId?: string;
    agentRunId?: string;
    idempotencyKey?: string;
    correlationId?: string;
  }): Promise<{ budget: BudgetView; debit: DebitView }> {
    if (!isPositiveDecimal(p.amount))
      throw new ValidationError("Debit amount must be greater than zero.");
    return transaction(async (tx) => {
      // Lock the budget row for update
      const lock = await tx.query<BudgetRow>(
        `SELECT * FROM spending_budgets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [p.tenantId, p.budgetId],
      );
      const row = lock.rows[0];
      if (!row) throw new NotFoundError("SpendingBudget", p.budgetId);
      if (row.status !== "active") {
        throw new StoatError(
          "BUDGET_NOT_ACTIVE",
          `Budget ${p.budgetId} is '${row.status}'. Only active budgets can be debited.`,
          422,
        );
      }
      const balance = new Decimal(row.balance);
      const debitAmt = new Decimal(p.amount);
      if (debitAmt.gt(balance)) {
        throw new StoatError(
          "BUDGET_INSUFFICIENT",
          `Insufficient budget: requested ${p.amount} ${row.currency} but only ${toDecimalString(row.balance)} ${row.currency} remains.`,
          422,
        );
      }
      const balanceAfter = balance.minus(debitAmt);
      const debitId = randomUUID();
      const ikey = p.idempotencyKey ?? `debit-${debitId}`;

      const debitRes = await tx.query<DebitRow>(
        `INSERT INTO budget_debits
           (id, tenant_id, budget_id, actor_type, actor_id, reason,
            reference_type, reference_id, amount, currency, balance_after,
            agent_run_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          debitId,
          p.tenantId,
          p.budgetId,
          p.actorType,
          p.actorId,
          p.reason,
          p.referenceType ?? null,
          p.referenceId ?? null,
          toDecimalString(p.amount),
          row.currency,
          toDecimalString(balanceAfter),
          p.agentRunId ?? null,
          ikey,
        ],
      );

      // If balance reaches 0, mark depleted so the mission stops
      const newStatus = balanceAfter.isZero() ? "depleted" : "active";
      const upd = await tx.query<BudgetRow>(
        `UPDATE spending_budgets
         SET balance = $2, total_debited = total_debited + $3,
             status = $4, closed_at = CASE WHEN $4 = 'depleted' THEN now() ELSE closed_at END,
             updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          p.budgetId,
          toDecimalString(balanceAfter),
          toDecimalString(p.amount),
          newStatus,
        ],
      );

      const events = new EventsService(tx);
      await events.appendEvent({
        tenantId: p.tenantId,
        aggregateType: "spending_budget",
        aggregateId: p.budgetId,
        eventType:
          newStatus === "depleted" ? "BUDGET_DEPLETED" : "BUDGET_DEBITED",
        actorType: p.actorType,
        actorId: p.actorId,
        correlationId: p.correlationId,
        amount: toDecimalString(p.amount),
        currency: row.currency,
        payload: {
          debit_id: debitId,
          reason: p.reason,
          balance_after: toDecimalString(balanceAfter),
          reference_type: p.referenceType,
          reference_id: p.referenceId,
        },
      });

      return {
        budget: toView(upd.rows[0]),
        debit: toDebitView(debitRes.rows[0]),
      };
    });
  }

  // ── 4. Complete mission ────────────────────────────────────────────────────

  /**
   * Mark a budget as completed (mission finished without fund depletion).
   * This transitions it to 'awaiting_decision' and creates the decision prompt event.
   * An LLM agent should then query the user whether to refund or retain.
   */
  async completeMission(p: {
    tenantId: string;
    budgetId: string;
    actorId: string;
    correlationId?: string;
  }): Promise<BudgetView> {
    return transaction(async (tx) => {
      const lock = await tx.query<BudgetRow>(
        `SELECT * FROM spending_budgets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [p.tenantId, p.budgetId],
      );
      const row = lock.rows[0];
      if (!row) throw new NotFoundError("SpendingBudget", p.budgetId);
      if (!["active"].includes(row.status)) {
        throw new StoatError(
          "BUDGET_INVALID_STATE",
          `Budget is '${row.status}'; only active budgets can be completed.`,
          422,
        );
      }
      const upd = await tx.query<BudgetRow>(
        `UPDATE spending_budgets
         SET status = 'awaiting_decision', closed_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [row.id],
      );
      await new EventsService(tx).appendEvent({
        tenantId: p.tenantId,
        aggregateType: "spending_budget",
        aggregateId: row.id,
        eventType: "BUDGET_MISSION_COMPLETE",
        actorType: "system",
        actorId: p.actorId,
        correlationId: p.correlationId,
        amount: toDecimalString(row.balance),
        currency: row.currency,
        payload: {
          remaining_balance: toDecimalString(row.balance),
          total_debited: toDecimalString(row.total_debited),
          prompt:
            "Mission completed with remaining balance. Please choose: refund or retain.",
        },
      });
      return toView(upd.rows[0]);
    });
  }

  // ── 5. Decide remainder ────────────────────────────────────────────────────

  /**
   * Process the user's decision on the remaining balance:
   * - 'refund':  issue a partial PayPal refund for the remaining balance.
   * - 'retain':  keep the balance on account for future missions (no PayPal call).
   */
  async decideRemainder(p: {
    tenantId: string;
    budgetId: string;
    decision: "refund" | "retain";
    decidedBy: string;
    note?: string;
    correlationId?: string;
  }): Promise<{ budget: BudgetView; decision: DecisionView }> {
    // Phase 1: validate and persist the intent. A no-PayPal decision finalizes right here.
    const plan = await transaction(
      async (
        tx,
      ): Promise<
        | { done: { budget: BudgetView; decision: DecisionView } }
        | { row: BudgetRow; decisionId: string }
      > => {
        const lock = await tx.query<BudgetRow>(
          `SELECT * FROM spending_budgets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [p.tenantId, p.budgetId],
        );
        const row = lock.rows[0];
        if (!row) throw new NotFoundError("SpendingBudget", p.budgetId);
        if (row.status !== "awaiting_decision") {
          throw new StoatError(
            "BUDGET_INVALID_STATE",
            `Budget is '${row.status}'. Only 'awaiting_decision' budgets can receive a remainder decision.`,
            422,
          );
        }
        const existing = await tx.query<{
          id: string;
          decision: string;
          refund_status: string | null;
          paypal_refund_id: string | null;
        }>(
          `SELECT id, decision, refund_status, paypal_refund_id FROM budget_decisions WHERE budget_id = $1`,
          [row.id],
        );
        const prior = existing.rows[0];
        if (prior) {
          // An intent whose PayPal call never finished may be resumed with the same choice.
          const resumable =
            prior.decision === "refund" &&
            p.decision === "refund" &&
            prior.refund_status === "submitted" &&
            !prior.paypal_refund_id;
          if (!resumable) {
            throw new ConflictError(
              "DECISION_ALREADY_MADE",
              "A decision has already been recorded for this budget.",
            );
          }
          return { row, decisionId: prior.id };
        }

        const callPayPal =
          p.decision === "refund" && new Decimal(row.balance).gt(0);
        if (callPayPal && !row.paypal_capture_id) {
          throw new StoatError(
            "BUDGET_NO_CAPTURE",
            "Cannot refund: no PayPal capture ID on record for this budget.",
            422,
          );
        }
        if (!callPayPal) {
          return {
            done: await this.finalizeDecision(tx, row, p, {
              decisionId: null,
              refundId: null,
              refundStatus: null,
            }),
          };
        }
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO budget_decisions
             (tenant_id, budget_id, decision, decided_by, paypal_refund_id, refund_status, note)
           VALUES ($1, $2, 'refund', $3, NULL, 'submitted', $4)
           RETURNING id`,
          [p.tenantId, row.id, p.decidedBy, p.note ?? null],
        );
        return { row, decisionId: ins.rows[0].id };
      },
    );

    if ("done" in plan) return plan.done;

    // Phase 2: PayPal call, no transaction open.
    const { row, decisionId } = plan;
    let refundRes: { refundId: string; status: string };
    try {
      refundRes = await this.gateway.refundCapture({
        captureId: row.paypal_capture_id as string,
        amount: toPayPalAmount(toDecimalString(row.balance)),
        currency: row.currency,
        requestId: `budget-refund-${row.id}`,
        note: p.note ?? "Stoat spending budget remainder refund",
      });
    } catch (err) {
      // Release the intent so the Owner can retry; the request ID keeps a retry idempotent.
      await this.db.query(
        `DELETE FROM budget_decisions
          WHERE id = $1 AND refund_status = 'submitted' AND paypal_refund_id IS NULL`,
        [decisionId],
      );
      throw err;
    }

    // Phase 3: record the outcome.
    return transaction(async (tx) => {
      const lock = await tx.query<BudgetRow>(
        `SELECT * FROM spending_budgets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [p.tenantId, p.budgetId],
      );
      const locked = lock.rows[0];
      if (!locked) throw new NotFoundError("SpendingBudget", p.budgetId);
      if (locked.status !== "awaiting_decision") {
        // Another request finished first; return what it recorded.
        const dec = await this.getDecisionIn(tx, p.tenantId, p.budgetId);
        if (!dec) {
          throw new StoatError(
            "BUDGET_INVALID_STATE",
            `Budget is '${locked.status}'.`,
            422,
          );
        }
        return { budget: toView(locked), decision: dec };
      }
      return this.finalizeDecision(tx, locked, p, {
        decisionId,
        refundId: refundRes.refundId,
        refundStatus: refundRes.status,
      });
    });
  }

  /** Write the decision, budget status, event and ledger entry inside the caller's transaction. */
  private async finalizeDecision(
    tx: DbClient,
    row: BudgetRow,
    p: {
      tenantId: string;
      decision: "refund" | "retain";
      decidedBy: string;
      note?: string;
      correlationId?: string;
    },
    r: {
      decisionId: string | null;
      refundId: string | null;
      refundStatus: string | null;
    },
  ): Promise<{ budget: BudgetView; decision: DecisionView }> {
    const refunded = p.decision === "refund" && new Decimal(row.balance).gt(0);
    const newStatus = p.decision === "refund" ? "refunded" : "retained";
    const upd = await tx.query<BudgetRow>(
      `UPDATE spending_budgets
       SET status = $2, balance = CASE WHEN $3 = 'refunded' THEN 0 ELSE balance END,
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [row.id, newStatus, newStatus],
    );

    type DecRow = { id: string; decided_at: string };
    const decRow: DecRow = r.decisionId
      ? (
          await tx.query<DecRow>(
            `UPDATE budget_decisions
                SET paypal_refund_id = $2, refund_status = $3
              WHERE id = $1 RETURNING id, decided_at`,
            [r.decisionId, r.refundId, r.refundStatus],
          )
        ).rows[0]
      : (
          await tx.query<DecRow>(
            `INSERT INTO budget_decisions
               (tenant_id, budget_id, decision, decided_by, paypal_refund_id, refund_status, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, decided_at`,
            [
              p.tenantId,
              row.id,
              p.decision,
              p.decidedBy,
              r.refundId,
              r.refundStatus,
              p.note ?? null,
            ],
          )
        ).rows[0];

    const ev = await new EventsService(tx).appendEvent({
      tenantId: p.tenantId,
      aggregateType: "spending_budget",
      aggregateId: row.id,
      eventType:
        p.decision === "refund" ? "BUDGET_REFUNDED" : "BUDGET_RETAINED",
      actorType: "user",
      actorId: p.decidedBy,
      correlationId: p.correlationId,
      amount: toDecimalString(row.balance),
      currency: row.currency,
      payload: {
        decision: p.decision,
        refund_id: r.refundId,
        note: p.note ?? null,
      },
    });

    if (refunded) {
      // Reverse the held funds in the ledger (debit escrow, credit cash)
      await postTwoLineJournal(tx, {
        tenantId: p.tenantId,
        eventId: ev.id,
        reference: `budget-refund:${row.id}`,
        currency: row.currency,
        amount: toDecimalString(row.balance),
        debitCode: "2101",
        creditCode: "1101",
      });
    }

    const decision: DecisionView = {
      id: decRow.id,
      budget_id: row.id,
      decision: p.decision,
      decided_by: p.decidedBy,
      decided_at: new Date(decRow.decided_at).toISOString(),
      paypal_refund_id: r.refundId,
      refund_status: r.refundStatus,
      note: p.note ?? null,
    };
    return { budget: toView(upd.rows[0]), decision };
  }

  private async getDecisionIn(
    db: DbClient,
    tenantId: string,
    budgetId: string,
  ): Promise<DecisionView | null> {
    const res = await db.query<{
      id: string;
      budget_id: string;
      decision: string;
      decided_by: string;
      decided_at: string;
      paypal_refund_id: string | null;
      refund_status: string | null;
      note: string | null;
    }>(
      `SELECT d.* FROM budget_decisions d
       JOIN spending_budgets b ON b.id = d.budget_id
       WHERE b.tenant_id = $1 AND d.budget_id = $2`,
      [tenantId, budgetId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      budget_id: r.budget_id,
      decision: r.decision as "refund" | "retain",
      decided_by: r.decided_by,
      decided_at: new Date(r.decided_at).toISOString(),
      paypal_refund_id: r.paypal_refund_id,
      refund_status: r.refund_status,
      note: r.note,
    };
  }

  // ── 6. Get debits ─────────────────────────────────────────────────────────

  async getDebits(
    tenantId: string,
    budgetId: string,
    limit = 100,
  ): Promise<DebitView[]> {
    const res = await this.db.query<DebitRow>(
      `SELECT * FROM budget_debits WHERE tenant_id = $1 AND budget_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [tenantId, budgetId, limit],
    );
    return res.rows.map(toDebitView);
  }

  async getDecision(
    tenantId: string,
    budgetId: string,
  ): Promise<DecisionView | null> {
    const res = await this.db.query<{
      id: string;
      budget_id: string;
      decision: string;
      decided_by: string;
      decided_at: string;
      paypal_refund_id: string | null;
      refund_status: string | null;
      note: string | null;
    }>(
      `SELECT d.* FROM budget_decisions d
       JOIN spending_budgets b ON b.id = d.budget_id
       WHERE b.tenant_id = $1 AND d.budget_id = $2`,
      [tenantId, budgetId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      budget_id: r.budget_id,
      decision: r.decision as "refund" | "retain",
      decided_by: r.decided_by,
      decided_at: new Date(r.decided_at).toISOString(),
      paypal_refund_id: r.paypal_refund_id,
      refund_status: r.refund_status,
      note: r.note,
    };
  }

  // ── 7. Analytics aggregates ────────────────────────────────────────────────

  async getAnalytics(tenantId: string): Promise<{
    by_status: {
      status: string;
      count: number;
      total_amount: string;
      total_debited: string;
      currency: string;
    }[];
    utilization_histogram: { bucket: string; count: number }[];
    daily_debits: {
      day: string;
      currency: string;
      total: string;
      count: number;
    }[];
    top_debit_reasons: {
      reason: string;
      count: number;
      total: string;
      currency: string;
    }[];
  }> {
    const [byStatus, histogram, daily, reasons] = await Promise.all([
      this.db.query<{
        status: string;
        count: string;
        total_amount: string;
        total_debited: string;
        currency: string;
      }>(
        `SELECT status, COUNT(*)::text AS count, SUM(amount)::text AS total_amount,
                SUM(total_debited)::text AS total_debited, currency
         FROM spending_budgets WHERE tenant_id = $1
         GROUP BY status, currency ORDER BY status`,
        [tenantId],
      ),
      this.db.query<{ bucket: string; count: string }>(
        `SELECT
           CASE WHEN (total_debited / NULLIF(amount, 0) * 100) < 25 THEN '0-25%'
                WHEN (total_debited / NULLIF(amount, 0) * 100) < 50 THEN '25-50%'
                WHEN (total_debited / NULLIF(amount, 0) * 100) < 75 THEN '50-75%'
                WHEN (total_debited / NULLIF(amount, 0) * 100) < 100 THEN '75-99%'
                ELSE '100%'
           END AS bucket, COUNT(*)::text AS count
         FROM spending_budgets WHERE tenant_id = $1 AND status NOT IN ('pending_approval','cancelled')
         GROUP BY bucket ORDER BY bucket`,
        [tenantId],
      ),
      this.db.query<{
        day: string;
        currency: string;
        total: string;
        count: string;
      }>(
        `SELECT date_trunc('day', created_at)::text AS day, currency,
                SUM(amount)::text AS total, COUNT(*)::text AS count
         FROM budget_debits WHERE tenant_id = $1
           AND created_at >= now() - interval '30 days'
         GROUP BY day, currency ORDER BY day`,
        [tenantId],
      ),
      this.db.query<{
        reason: string;
        count: string;
        total: string;
        currency: string;
      }>(
        `SELECT reason, COUNT(*)::text AS count, SUM(amount)::text AS total, currency
         FROM budget_debits WHERE tenant_id = $1
         GROUP BY reason, currency ORDER BY SUM(amount) DESC LIMIT 10`,
        [tenantId],
      ),
    ]);
    return {
      by_status: byStatus.rows.map((r) => ({
        status: r.status,
        count: Number(r.count),
        total_amount: toDecimalString(r.total_amount ?? "0"),
        total_debited: toDecimalString(r.total_debited ?? "0"),
        currency: r.currency,
      })),
      utilization_histogram: histogram.rows.map((r) => ({
        bucket: r.bucket,
        count: Number(r.count),
      })),
      daily_debits: daily.rows.map((r) => ({
        day: r.day,
        currency: r.currency,
        total: toDecimalString(r.total ?? "0"),
        count: Number(r.count),
      })),
      top_debit_reasons: reasons.rows.map((r) => ({
        reason: r.reason,
        count: Number(r.count),
        total: toDecimalString(r.total ?? "0"),
        currency: r.currency,
      })),
    };
  }

  // ── 7b. Edit / delete a budget still waiting for PayPal approval ──────────

  /**
   * Shared guard: only the budget's owner or a tenant Admin may touch it, and PayPal is asked
   * first. If the buyer already approved the order, the sync activates the budget and the
   * caller is refused, so a real payment is never discarded.
   */
  private async pendingForChange(p: {
    tenantId: string;
    budgetId: string;
    actorId: string;
    actorRole?: string;
  }): Promise<BudgetRow> {
    const res = await this.db.query<BudgetRow>(
      `SELECT * FROM spending_budgets WHERE tenant_id = $1 AND id = $2`,
      [p.tenantId, p.budgetId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundError("SpendingBudget", p.budgetId);
    const isAdmin = p.actorRole === "operator" || p.actorRole === "supervisor";
    if (row.owner_id !== p.actorId && !isAdmin) {
      throw new StoatError("BUDGET_NOT_OWNED", "Only the budget's owner or an Admin can change it.", 403);
    }
    if (row.status !== "pending_approval") {
      throw new StoatError(
        "BUDGET_NOT_PENDING",
        `Budget is '${row.status}'. Only budgets waiting for PayPal approval can be edited or deleted.`,
        409,
      );
    }
    if (row.paypal_order_id) {
      let after: BudgetView;
      try {
        after = await this.syncBudget(row.id);
      } catch (err: any) {
        // PayPal no longer knows the order (abandoned orders expire): nothing was approved or
        // captured, so the budget is safe to change. Any other failure means we cannot verify.
        const gone =
          err?.details?.paypal_status === 404 ||
          ["RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID"].includes(String(err?.details?.paypal_issue ?? ""));
        if (!gone) {
          throw new StoatError(
            "BUDGET_PAYPAL_UNVERIFIED",
            "Could not confirm with PayPal that this budget was never approved, so it was left unchanged. Try again shortly.",
            503,
          );
        }
        return row;
      }
      if (after.status !== "pending_approval") {
        throw new StoatError(
          "BUDGET_ALREADY_APPROVED",
          `PayPal reports this budget was approved; it is now '${after.status}' and cannot be edited or deleted.`,
          409,
        );
      }
    }
    return row;
  }

  /** Mark a cancelled pending budget as removed from the list (row and history are kept). */
  private async retire(
    p: { tenantId: string; budgetId: string; actorId: string; correlationId?: string },
    extra: Record<string, unknown>,
  ): Promise<BudgetView> {
    await this.cancelBudget(p);
    const upd = await this.db.query<BudgetRow>(
      `UPDATE spending_budgets SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [p.budgetId, JSON.stringify({ deleted_at: new Date().toISOString(), deleted_by: p.actorId, ...extra })],
    );
    return toView(upd.rows[0]);
  }

  /** Delete = cancel a budget PayPal never approved and hide it. No money has moved. */
  async deletePendingBudget(p: {
    tenantId: string;
    budgetId: string;
    actorId: string;
    actorRole?: string;
    correlationId?: string;
  }): Promise<BudgetView> {
    await this.pendingForChange(p);
    return this.retire(p, { deleted_reason: "deleted_by_user" });
  }

  /**
   * Edit = create a fresh PayPal order with the new terms, then retire the old budget.
   * PayPal is called before anything changes, so a failed order leaves the old budget intact.
   */
  async editPendingBudget(p: {
    tenantId: string;
    budgetId: string;
    actorId: string;
    actorRole?: string;
    amount: string;
    currency?: string;
    missionId?: string | null;
    returnOrigin?: string;
    buyerUserAgent?: string;
    correlationId?: string;
  }): Promise<{ budget: BudgetView; replaced: BudgetView }> {
    const old = await this.pendingForChange(p);
    const next = await this.createBudget({
      tenantId: p.tenantId,
      ownerId: old.owner_id,
      ownerType: old.owner_type === "agent" ? "agent" : "user",
      missionId: p.missionId === undefined ? (old.mission_id ?? undefined) : (p.missionId ?? undefined),
      amount: p.amount,
      currency: p.currency ?? old.currency,
      returnOrigin: p.returnOrigin ?? old.return_origin ?? undefined,
      buyerUserAgent: p.buyerUserAgent,
      correlationId: p.correlationId,
    });
    const replaced = await this.retire(
      { tenantId: p.tenantId, budgetId: old.id, actorId: p.actorId, correlationId: p.correlationId },
      { deleted_reason: "replaced_by_edit", replaced_by: next.id },
    );
    return { budget: next, replaced };
  }

  // ── 8. Cancel ─────────────────────────────────────────────────────────────

  async cancelBudget(p: {
    tenantId: string;
    budgetId: string;
    actorId: string;
    correlationId?: string;
  }): Promise<BudgetView> {
    return transaction(async (tx) => {
      const lock = await tx.query<BudgetRow>(
        `SELECT * FROM spending_budgets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [p.tenantId, p.budgetId],
      );
      const row = lock.rows[0];
      if (!row) throw new NotFoundError("SpendingBudget", p.budgetId);
      if (!["pending_approval"].includes(row.status)) {
        throw new StoatError(
          "BUDGET_CANNOT_CANCEL",
          `Budget is '${row.status}'. Only pending budgets can be cancelled.`,
          422,
        );
      }
      const upd = await tx.query<BudgetRow>(
        `UPDATE spending_budgets SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`,
        [row.id],
      );
      await new EventsService(tx).appendEvent({
        tenantId: p.tenantId,
        aggregateType: "spending_budget",
        aggregateId: row.id,
        eventType: "BUDGET_CANCELLED",
        actorType: "user",
        actorId: p.actorId,
        correlationId: p.correlationId,
        amount: toDecimalString(row.amount),
        currency: row.currency,
        payload: { budget_id: row.id },
      });
      return toView(upd.rows[0]);
    });
  }
}

/**
 * Provider disbursement through the PayPal Payouts API (SPEC v2.1 FR-040, FR-041, FR-043).
 *
 * Money path: buyer pays at acceptance (FundingService) -> work verified -> human approves the
 * collection batch and it is released -> a human APPROVES the provider payout (a separate
 * approval, bound to exact amounts, obligations and recipients) -> a human sends it -> one PayPal
 * payout per provider -> PayPal confirms the item -> only then is the obligation 'paid'.
 *
 * Rules enforced here:
 *  - Capability gate: payouts run only when PAYPAL_PAYOUTS_ENABLED and the spike status allow it.
 *  - Fail closed: collection must be captured and reconciled for every agreement in the batch.
 *  - Approval is one-time, expires, and binds amount, currency, obligations and recipient hash.
 *    A changed recipient or obligation set is rejected and audited as a substitution attempt.
 *  - The recipient is snapshotted (encrypted) on the payout row at approval time.
 *  - Persist sender ids before calling PayPal. Never resend an unconfirmed create: PayPal rejects a
 *    repeated sender_batch_id instead of returning the original, and a blind resend could pay twice.
 *  - Item status, not batch status, decides. UNCLAIMED / PENDING / ONHOLD are never 'paid'.
 */
import { createHash, randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { DbClient, transaction } from "../../db/connection.js";
import { EventsService } from "../events/events.service.js";
import { toDecimalString } from "../../common/decimal.js";
import {
  ConflictError,
  ForbiddenActionError,
  NotFoundError,
  StoatError,
  ValidationError,
} from "../../common/errors.js";
import { postTwoLineJournal } from "../ledger/postings.js";
import {
  GatewayPayout,
  PayPalApiError,
  PayPalGateway,
  getPayPalGateway,
  toPayPalAmount,
} from "../paypal/paypal.gateway.js";
import {
  assertPayoutsEnabled,
  markPayoutsDegraded,
} from "../paypal/capabilities.js";
import { RecipientService } from "./recipient.service.js";
import { assertSettlementNotHeld } from "../watchdog/hold-guard.js";

const APPROVAL_TTL_MS = 15 * 60 * 1000;
const sha = (v: unknown) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");

export interface PayoutView {
  payout_id: string;
  batch_id: string;
  agent_id: string;
  recipient_masked: string | null;
  amount: string;
  currency: string;
  status: string;
  provider_batch_id: string | null;
  provider_item_id: string | null;
  sender_batch_id: string;
  sender_item_id: string | null;
  provider_item_status: string | null;
  failure_reason: string | null;
  obligation_count: number;
  paid_at: string | null;
}

type PayoutRow = {
  id: string;
  tenant_id: string;
  batch_id: string;
  agent_id: string;
  recipient_masked: string | null;
  recipient_snapshot_ciphertext: string | null;
  recipient_snapshot_hash: string | null;
  amount: string;
  currency: string;
  status: string;
  sender_batch_id: string;
  sender_item_id: string | null;
  provider_batch_id: string | null;
  provider_item_id: string | null;
  provider_item_status: string | null;
  failure_reason: string | null;
  obligation_ids: string[] | string;
  paid_at: Date | string | null;
};

const ids = (r: PayoutRow): string[] =>
  (typeof r.obligation_ids === "string"
    ? JSON.parse(r.obligation_ids)
    : r.obligation_ids) ?? [];

const view = (r: PayoutRow): PayoutView => ({
  payout_id: r.id,
  batch_id: r.batch_id,
  agent_id: r.agent_id,
  recipient_masked: r.recipient_masked,
  amount: toDecimalString(r.amount),
  currency: r.currency,
  status: r.status,
  provider_batch_id: r.provider_batch_id,
  provider_item_id: r.provider_item_id,
  sender_batch_id: r.sender_batch_id,
  sender_item_id: r.sender_item_id,
  provider_item_status: r.provider_item_status,
  failure_reason: r.failure_reason,
  obligation_count: ids(r).length,
  paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null,
});

/** Map PayPal's per-item transaction status to ours. UNCLAIMED / PENDING / ONHOLD are not final. */
function mapItem(
  status: string,
): "paid" | "processing" | "failed" | "returned" {
  switch (status) {
    case "SUCCESS":
      return "paid";
    case "FAILED":
    case "BLOCKED":
    case "DENIED":
    case "CANCELED":
      return "failed";
    case "RETURNED":
    case "REFUNDED":
    case "REVERSED":
      return "returned";
    default:
      return "processing";
  }
}

interface PlanProvider {
  agent_id: string;
  name: string;
  amount: string;
  currency: string;
  obligation_ids: string[];
  profile: {
    id: string;
    type: string;
    hash: string;
    masked: string;
    ciphertext: string;
    status: string;
  } | null;
}

export class PayoutService {
  private recipients: RecipientService;
  constructor(
    private db: DbClient,
    private gateway: PayPalGateway = getPayPalGateway(),
  ) {
    this.recipients = new RecipientService(db);
  }

  // ── Planning ─────────────────────────────────────────────────────────────
  /** Everything a payout depends on, computed from the database. Used for the preview, the approval and the send. */
  private async plan(tenantId: string, batchId: string) {
    const b = await this.db.query<{ status: string; currency: string }>(
      `SELECT status, currency FROM settlement_batches WHERE tenant_id = $1 AND id = $2`,
      [tenantId, batchId],
    );
    if (!b.rows[0]) throw new NotFoundError("Settlement batch", batchId);
    const rows = await this.db.query<{
      obligation_id: string;
      provider_id: string;
      name: string;
      amount: string;
      currency: string;
      funding_status: string;
      pay_status: string | null;
      charge_id: string | null;
    }>(
      `SELECT o.id AS obligation_id, o.provider_id, ag.name, i.amount, o.currency, a.funding_status, p.status AS pay_status,
              wc.id AS charge_id
       FROM settlement_batch_items i
       JOIN obligations o ON o.id = i.obligation_id
       JOIN agents ag ON ag.id = o.provider_id
       JOIN agreements a ON a.id = o.agreement_id
       LEFT JOIN agreement_payments p ON p.agreement_id = a.id AND p.status = 'captured'
       LEFT JOIN wallet_charges wc ON wc.obligation_id = o.id
       WHERE i.batch_id = $1 AND o.tenant_id = $2 ORDER BY o.provider_id, o.id`,
      [batchId, tenantId],
    );
    const byProvider = new Map<string, PlanProvider>();
    for (const r of rows.rows) {
      const cur = byProvider.get(r.provider_id) ?? {
        agent_id: r.provider_id,
        name: r.name,
        amount: "0",
        currency: r.currency,
        obligation_ids: [],
        profile: null,
      };
      cur.obligation_ids.push(r.obligation_id);
      byProvider.set(r.provider_id, cur);
    }
    // Exact sums (no floating point) per provider
    const exact = await this.db.query<{ provider_id: string; total: string }>(
      `SELECT o.provider_id, SUM(i.amount)::text AS total FROM settlement_batch_items i JOIN obligations o ON o.id = i.obligation_id
       WHERE i.batch_id = $1 AND o.tenant_id = $2 GROUP BY o.provider_id`,
      [batchId, tenantId],
    );
    for (const e of exact.rows)
      byProvider.get(e.provider_id)!.amount = toDecimalString(e.total);
    for (const prov of byProvider.values()) {
      const pr = await this.recipients.loadForPayout(tenantId, prov.agent_id);
      prov.profile = pr
        ? {
            id: pr.id,
            type: pr.recipient_type,
            hash: pr.hash,
            masked: pr.masked,
            ciphertext: pr.ciphertext,
            status: pr.verification_status,
          }
        : null;
    }
    const providers = [...byProvider.values()].sort((x, y) =>
      x.agent_id.localeCompare(y.agent_id),
    );
    const collectionReady =
      rows.rows.length > 0 &&
      rows.rows.every(
        (r) =>
          r.charge_id !== null ||
          (r.funding_status === "funded" && r.pay_status === "captured"),
      );
    const allIds = providers.flatMap((p) => p.obligation_ids).sort();
    return {
      batchStatus: b.rows[0].status,
      currency: b.rows[0].currency,
      providers,
      collectionReady,
      obligationIdsHash: sha(allIds.join(",")),
      recipientSnapshotHash: sha(
        providers.map((p) => [
          p.agent_id,
          p.profile?.hash ?? null,
          p.amount,
          p.currency,
        ]),
      ),
      total: toDecimalString(
        providers.reduce((acc, p) => acc.plus(p.amount), new Decimal(0)),
      ),
    };
  }

  private async gate(tenantId: string, batchId: string) {
    assertPayoutsEnabled();
    const plan = await this.plan(tenantId, batchId);
    await assertSettlementNotHeld(this.db, tenantId, batchId, true);
    if (plan.batchStatus !== "confirmed") {
      throw new StoatError(
        "INVALID_TRANSITION",
        `Batch is '${plan.batchStatus}'. Release the funded payment first; providers are paid from a confirmed batch.`,
        422,
      );
    }
    if (!plan.collectionReady) {
      throw new ValidationError(
        "Payouts are only sent when the buyer's PayPal collection is captured and reconciled for every agreement in the batch.",
      );
    }
    return plan;
  }

  /** Read model for the console: providers in a batch, their masked recipient and latest payout. */
  async batchProviders(tenantId: string, batchId: string) {
    const plan = await this.plan(tenantId, batchId);
    const payouts = await this.listForBatch(tenantId, batchId);
    return plan.providers.map((p) => ({
      agent_id: p.agent_id,
      name: p.name,
      amount: p.amount,
      currency: p.currency,
      recipient_masked: p.profile?.masked ?? null,
      recipient_status: p.profile?.status ?? "missing",
      obligation_count: p.obligation_ids.length,
      payout: payouts.filter((x) => x.agent_id === p.agent_id).pop() ?? null,
    }));
  }

  async listForBatch(tenantId: string, batchId: string): Promise<PayoutView[]> {
    const res = await this.db.query<PayoutRow>(
      `SELECT * FROM payouts WHERE tenant_id = $1 AND batch_id = $2 ORDER BY created_at`,
      [tenantId, batchId],
    );
    return res.rows.map(view);
  }

  // ── Approval (separate from the collection approval) ─────────────────────
  async approve(p: {
    tenantId: string;
    batchId: string;
    userId: string;
    correlationId?: string;
  }) {
    const plan = await this.gate(p.tenantId, p.batchId);
    const bad = plan.providers.filter(
      (x) => !x.profile || x.profile.status !== "verified",
    );
    if (bad.length > 0) {
      throw new StoatError(
        "PAYOUT_ACCOUNT_MISSING",
        `Add and verify a PayPal recipient for: ${bad.map((b) => b.name).join(", ")}.`,
        422,
        { agents: bad.map((b) => b.agent_id) },
      );
    }
    const pv = await this.db.query<{ version: number }>(
      `SELECT version FROM policy_versions WHERE tenant_id = $1 AND is_active = TRUE ORDER BY version DESC LIMIT 1`,
      [p.tenantId],
    );
    const policyVersion = pv.rows[0] ? `v${pv.rows[0].version}` : "none";
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO approvals (tenant_id, approver_id, action, target_type, target_id, policy_snapshot, status, reason,
                              transaction_direction, amount, currency, recipient_snapshot_hash, obligation_ids_hash, policy_version, expires_at)
       VALUES ($1, $2, 'approve_provider_disbursement', 'settlement_batch', $3, $4, 'approved', 'Provider payout approved in the console',
               'PROVIDER_DISBURSEMENT', $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        p.tenantId,
        p.userId,
        p.batchId,
        JSON.stringify({ providers: plan.providers.length }),
        plan.total,
        plan.currency,
        plan.recipientSnapshotHash,
        plan.obligationIdsHash,
        policyVersion,
        expiresAt.toISOString(),
      ],
    );
    await new EventsService(this.db).appendEvent({
      tenantId: p.tenantId,
      aggregateType: "settlement_batch",
      aggregateId: p.batchId,
      eventType: "PAYOUT_APPROVED",
      actorType: "user",
      actorId: p.userId,
      correlationId: p.correlationId,
      amount: plan.total,
      currency: plan.currency,
      payload: {
        approval_id: ins.rows[0].id,
        recipient_snapshot_hash: plan.recipientSnapshotHash,
        obligation_ids_hash: plan.obligationIdsHash,
        policy_version: policyVersion,
      },
    });
    return {
      approval_id: ins.rows[0].id,
      expires_at: expiresAt.toISOString(),
      total: plan.total,
      currency: plan.currency,
      providers: plan.providers.map((x) => ({
        agent_id: x.agent_id,
        name: x.name,
        amount: x.amount,
        recipient_masked: x.profile!.masked,
      })),
    };
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  async disburse(p: {
    tenantId: string;
    batchId: string;
    userId: string;
    approvalId: string;
    correlationId?: string;
  }) {
    const plan = await this.gate(p.tenantId, p.batchId);
    const ap = await this.db
      .query<any>(`SELECT * FROM approvals WHERE tenant_id = $1 AND id = $2`, [
        p.tenantId,
        String(p.approvalId ?? ""),
      ])
      .catch(() => ({ rows: [] as any[] }));
    const approval = ap.rows[0];
    if (
      !approval ||
      approval.target_id !== p.batchId ||
      approval.action !== "approve_provider_disbursement" ||
      approval.transaction_direction !== "PROVIDER_DISBURSEMENT" ||
      approval.status !== "approved"
    ) {
      throw new ForbiddenActionError(
        "A valid provider-payout approval is required. Approve the payout first.",
      );
    }
    if (approval.used_at) {
      const existing = await this.db.query<PayoutRow>(
        `SELECT * FROM payouts WHERE approval_id = $1 ORDER BY created_at`,
        [approval.id],
      );
      if (existing.rows.length > 0)
        return { payouts: existing.rows.map(view), errors: [], replayed: true };
      throw new ConflictError(
        "APPROVAL_ALREADY_USED",
        "This approval was already used. Approve the payout again.",
      );
    }
    if (new Date(approval.expires_at).getTime() < Date.now()) {
      throw new ForbiddenActionError(
        "The payout approval expired. Approve the payout again.",
      );
    }
    // The approval covers exactly what the human saw. Anything different is a substitution attempt.
    const changed =
      approval.recipient_snapshot_hash !== plan.recipientSnapshotHash ||
      approval.obligation_ids_hash !== plan.obligationIdsHash ||
      !new Decimal(approval.amount).equals(plan.total) ||
      approval.currency !== plan.currency;
    if (changed) {
      await new EventsService(this.db).appendEvent({
        tenantId: p.tenantId,
        aggregateType: "settlement_batch",
        aggregateId: p.batchId,
        eventType: "PAYOUT_APPROVAL_REJECTED",
        actorType: "user",
        actorId: p.userId,
        correlationId: p.correlationId,
        amount: plan.total,
        currency: plan.currency,
        payload: {
          approval_id: approval.id,
          reason: "recipient, obligations or amount changed after approval",
        },
      });
      throw new ForbiddenActionError(
        "The recipient, amount or obligations changed after approval. This attempt was recorded. Approve the payout again.",
      );
    }
    const claim = await this.db.query(
      `UPDATE approvals SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
      [approval.id],
    );
    if (claim.rows.length === 0)
      throw new ConflictError(
        "APPROVAL_ALREADY_USED",
        "This approval was already used.",
      );

    const live = await this.db.query<PayoutRow>(
      `SELECT * FROM payouts WHERE batch_id = $1 AND status IN ('requested','processing','paid')`,
      [p.batchId],
    );
    const results: PayoutView[] = live.rows.map(view);
    const errors: { agent_id: string; code: string; message: string }[] = [];
    for (const prov of plan.providers) {
      if (live.rows.some((x) => x.agent_id === prov.agent_id)) continue;
      try {
        results.push(await this.sendOne(p, approval.id, prov));
      } catch (err: any) {
        errors.push({
          agent_id: prov.agent_id,
          code: err?.code ?? "PAYOUT_FAILED",
          message: err?.message ?? "Payout failed.",
        });
      }
    }
    return { payouts: results, errors, replayed: false };
  }

  private async sendOne(
    p: { tenantId: string; batchId: string; userId: string },
    approvalId: string,
    prov: PlanProvider,
  ): Promise<PayoutView> {
    toPayPalAmount(prov.amount); // refuse amounts PayPal cannot send exactly before anything is persisted
    const attemptRes = await this.db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payouts WHERE batch_id = $1 AND agent_id = $2`,
      [p.batchId, prov.agent_id],
    );
    const attempt = Number(attemptRes.rows[0].n) + 1;
    const payoutId = randomUUID();
    const senderBatchId = `stoat-${p.batchId}-${prov.agent_id}-${attempt}`;
    // Persist intent and PayPal identifiers BEFORE any network call.
    const ins = await this.db.query<PayoutRow>(
      `INSERT INTO payouts (id, tenant_id, batch_id, agent_id, amount, currency, status, sender_batch_id, sender_item_id, requested_by,
                            recipient_profile_id, recipient_type, recipient_snapshot_ciphertext, recipient_snapshot_hash, recipient_masked,
                            approval_id, obligation_ids)
       VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [
        payoutId,
        p.tenantId,
        p.batchId,
        prov.agent_id,
        prov.amount,
        prov.currency,
        senderBatchId,
        payoutId,
        p.userId,
        prov.profile!.id,
        prov.profile!.type,
        prov.profile!.ciphertext,
        prov.profile!.hash,
        prov.profile!.masked,
        approvalId,
        JSON.stringify(prov.obligation_ids),
      ],
    );
    await this.setObligations(
      this.db,
      prov.obligation_ids,
      "disbursement_pending",
    );
    return this.submit(ins.rows[0]);
  }

  private async setObligations(
    db: DbClient,
    obligationIds: string[],
    status: string,
  ) {
    if (obligationIds.length === 0) return;
    await db.query(
      `UPDATE obligations SET status = $1, updated_at = now() WHERE id = ANY($2::uuid[])`,
      [status, obligationIds],
    );
  }

  /** Create the payout at PayPal. The recipient is decrypted only here, for this one request. */
  private async submit(row: PayoutRow): Promise<PayoutView> {
    let g: GatewayPayout;
    try {
      g = await this.gateway.createPayout({
        senderBatchId: row.sender_batch_id,
        emailSubject: "You have a payment from Stoat",
        items: [
          {
            senderItemId: row.sender_item_id!,
            receiver: this.recipients.reveal(
              row.recipient_snapshot_ciphertext!,
            ),
            amount: toPayPalAmount(row.amount),
            currency: row.currency,
            note: `Stoat settlement ${row.batch_id}`,
          },
        ],
      });
    } catch (err: any) {
      if (err instanceof PayPalApiError && err.code !== "PAYPAL_UNREACHABLE") {
        if (err.code === "PAYPAL_PAYOUTS_NOT_ENABLED")
          markPayoutsDegraded(err.message);
        await this.db.query(
          `UPDATE payouts SET status = 'failed', failure_reason = $2, error_code = $3, updated_at = now() WHERE id = $1 AND status = 'requested'`,
          [row.id, err.message.slice(0, 500), err.code],
        );
        await this.setObligations(this.db, ids(row), "payout_failed");
      } else {
        // Outcome unknown: never resend. Wait for PayPal's webhook; an operator checks PayPal Activity if it never comes.
        await this.setObligations(this.db, ids(row), "payout_unknown");
      }
      throw err;
    }
    await this.db.query(
      `UPDATE payouts SET provider_batch_id = $2, updated_at = now() WHERE id = $1`,
      [row.id, g.batchId],
    );
    return this.apply(row.id, g);
  }

  // ── Follow PayPal's answer ───────────────────────────────────────────────
  async sync(payoutId: string): Promise<PayoutView> {
    const r = await this.db.query<PayoutRow>(
      `SELECT * FROM payouts WHERE id = $1`,
      [payoutId],
    );
    if (!r.rows[0]) throw new NotFoundError("Payout", payoutId);
    const row = r.rows[0];
    if (row.status === "failed" || row.status === "returned") return view(row);
    await this.db.query(
      `UPDATE payouts SET last_checked_at = now() WHERE id = $1`,
      [row.id],
    );
    if (!row.provider_batch_id) {
      return view({
        ...row,
        failure_reason:
          "Waiting for PayPal to confirm this payout. If this persists, check PayPal Activity before retrying.",
      });
    }
    return this.apply(
      row.id,
      await this.gateway.getPayout(row.provider_batch_id),
    );
  }

  async syncByProviderBatch(
    providerBatchId: string,
    senderBatchId?: string,
  ): Promise<number> {
    if (senderBatchId) {
      await this.db.query(
        `UPDATE payouts SET provider_batch_id = $1 WHERE sender_batch_id = $2 AND provider_batch_id IS NULL`,
        [providerBatchId, senderBatchId],
      );
    }
    const r = await this.db.query<{ id: string }>(
      `SELECT id FROM payouts WHERE provider_batch_id = $1`,
      [providerBatchId],
    );
    for (const x of r.rows) await this.sync(x.id);
    return r.rows.length;
  }

  private async apply(payoutId: string, g: GatewayPayout): Promise<PayoutView> {
    return transaction(async (tx) => {
      const lock = await tx.query<PayoutRow>(
        `SELECT * FROM payouts WHERE id = $1 FOR UPDATE`,
        [payoutId],
      );
      const row = lock.rows[0];
      // Inspect the ITEM. A batch-level SUCCESS says nothing about this provider's money.
      const item =
        g.items.find((i) => i.senderItemId === row.sender_item_id) ??
        (g.items.length === 1 ? g.items[0] : undefined);
      if (!item) return view(row);
      const next = mapItem(item.status);
      if (next === row.status) {
        const same = await tx.query<PayoutRow>(
          `UPDATE payouts SET provider_item_status = $2, provider_item_id = $3, updated_at = now() WHERE id = $1 RETURNING *`,
          [payoutId, item.status, item.itemId],
        );
        return view(same.rows[0]);
      }
      if (row.status === "paid" && next !== "returned") return view(row); // paid only moves on to returned
      if (row.status === "failed" || row.status === "returned")
        return view(row);

      const upd = await tx.query<PayoutRow>(
        `UPDATE payouts SET status = $2, provider_item_status = $3, provider_item_id = $4, failure_reason = $5,
                paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          payoutId,
          next,
          item.status,
          item.itemId,
          next === "failed" || next === "returned"
            ? (item.reason ?? item.status)
            : null,
        ],
      );
      const amount = toDecimalString(row.amount);
      const eventType =
        next === "paid"
          ? "PAYOUT_PAID"
          : next === "failed"
            ? "PAYOUT_FAILED"
            : next === "returned"
              ? "PAYOUT_RETURNED"
              : "PAYOUT_PROCESSING";
      const ev = await new EventsService(tx).appendEvent({
        tenantId: row.tenant_id,
        aggregateType: "settlement_batch",
        aggregateId: row.batch_id,
        eventType,
        actorType: "system",
        actorId: row.tenant_id,
        amount,
        currency: row.currency,
        payload: {
          payout_id: row.id,
          agent_id: row.agent_id,
          provider_batch_id: g.batchId,
          provider_item_id: item.itemId,
          item_status: item.status,
        },
      });
      const obligationStatus =
        next === "paid"
          ? "paid"
          : next === "failed"
            ? "payout_failed"
            : next === "returned"
              ? "returned"
              : "disbursement_pending";
      await this.setObligations(tx, ids(row), obligationStatus);
      // Cash leaves the merchant account only when PayPal says this item succeeded.
      if (next === "paid") {
        await postTwoLineJournal(tx, {
          tenantId: row.tenant_id,
          eventId: ev.id,
          reference: `payout:${row.id}`,
          currency: row.currency,
          amount,
          debitCode: "2102",
          creditCode: "1101",
        });
      } else if (next === "returned" && row.status === "paid") {
        await postTwoLineJournal(tx, {
          tenantId: row.tenant_id,
          eventId: ev.id,
          reference: `payout-return:${row.id}`,
          currency: row.currency,
          amount,
          debitCode: "1101",
          creditCode: "2102",
        });
      }
      return view(upd.rows[0]);
    });
  }

  /** Follow processing payouts to their final state. Unsent ones are never retried automatically. */
  async sweep(
    limit = 25,
  ): Promise<{ checked: number; paid: number; errors: number }> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM payouts
       WHERE status IN ('requested','processing') AND provider_batch_id IS NOT NULL
         AND (last_checked_at IS NULL OR last_checked_at < now() - interval '30 seconds')
       ORDER BY created_at LIMIT $1`,
      [limit],
    );
    const out = { checked: 0, paid: 0, errors: 0 };
    for (const r of due.rows) {
      try {
        const v = await this.sync(r.id);
        out.checked++;
        if (v.status === "paid") out.paid++;
      } catch {
        out.errors++;
      }
    }
    return out;
  }
}

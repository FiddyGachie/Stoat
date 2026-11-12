import type { AuthenticatedPrincipal } from "../../common/types.js";
import {
  ForbiddenActionError,
  NotFoundError,
  ValidationError,
} from "../../common/errors.js";
import { transaction, type DbClient } from "../../db/connection.js";
import { appendCommerceEvent } from "../agentic/commerce-events.js";
import { recordRefusal } from "../agentic/redact.js";
import { assertDatabaseRateLimit } from "../agentic/rate-limit.js";
import { holdRateLimit } from "../agentic/agentic-config.js";
import { HoldSubjectInvalidError } from "../agentic/commerce-errors.js";
import { validateProposalDraft } from "../proposals/proposal-validation.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const ADMIN_ROLES = new Set(["operator", "supervisor"]);

export type HoldSubjectType =
  | "reservation"
  | "settlement_item"
  | "settlement_batch"
  | "payout";
export type HoldPlacer =
  | { type: "system" }
  | { type: "agent"; agentId: string; runId: string }
  | { type: "user"; userId: string };

export interface HoldRow {
  id: string;
  tenant_id: string;
  scope_type: HoldSubjectType;
  scope_id: string;
  reason: string;
  reason_code: string;
  placed_by: string;
  placed_by_type: "user" | "agent" | "system";
  alert_id: string | null;
  agent_run_id: string | null;
  status: "active" | "released";
  placed_at: Date | string;
  released_by: string | null;
  released_at: Date | string | null;
  release_reason: string | null;
}

const SUBJECT_TYPES = new Set<HoldSubjectType>([
  "reservation",
  "settlement_item",
  "settlement_batch",
  "payout",
]);

function isAdmin(actor: AuthenticatedPrincipal): boolean {
  return actor.type === "user" && ADMIN_ROLES.has(String(actor.role));
}

function invalidSubject(): never {
  throw new HoldSubjectInvalidError();
}

async function validateAndLockSubject(
  tx: DbClient,
  tenantId: string,
  subjectType: HoldSubjectType,
  subjectId: string,
): Promise<string | null> {
  if (subjectType === "reservation") {
    const found = await tx.query<{
      wallet_id: string;
      status: string;
      owner_user_id: string;
    }>(
      `SELECT r.wallet_id, r.status, w.owner_user_id
       FROM wallet_reservations r JOIN wallets w
         ON w.id = r.wallet_id AND w.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, subjectId],
    );
    if (!found.rows[0] || found.rows[0].status !== "active") invalidSubject();
    await tx.query(
      "SELECT id FROM wallets WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
      [found.rows[0].wallet_id, tenantId],
    );
    const locked = await tx.query(
      "SELECT id FROM wallet_reservations WHERE id = $1 AND tenant_id = $2 AND status = 'active' FOR UPDATE",
      [subjectId, tenantId],
    );
    if (!locked.rows[0]) invalidSubject();
    return found.rows[0].owner_user_id;
  }
  if (subjectType === "settlement_batch") {
    const batch = await tx.query<{ status: string }>(
      "SELECT status FROM settlement_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, subjectId],
    );
    if (
      !batch.rows[0] ||
      ["confirmed", "rejected", "cancelled", "failed"].includes(
        batch.rows[0].status,
      )
    )
      invalidSubject();
    return null;
  }
  if (subjectType === "settlement_item") {
    const item = await tx.query<{ batch_id: string; status: string }>(
      `SELECT i.batch_id, b.status FROM settlement_batch_items i
       JOIN settlement_batches b ON b.id = i.batch_id AND b.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1 AND i.id = $2`,
      [tenantId, subjectId],
    );
    if (
      !item.rows[0] ||
      ["confirmed", "rejected", "cancelled", "failed"].includes(
        item.rows[0].status,
      )
    )
      invalidSubject();
    const batch = await tx.query<{ status: string }>(
      "SELECT status FROM settlement_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, item.rows[0].batch_id],
    );
    if (
      !batch.rows[0] ||
      ["confirmed", "rejected", "cancelled", "failed"].includes(
        batch.rows[0].status,
      )
    )
      invalidSubject();
    const locked = await tx.query<{ id: string }>(
      `SELECT i.id FROM settlement_batch_items i
       JOIN settlement_batches b ON b.id = i.batch_id AND b.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1 AND i.id = $2 AND b.status NOT IN ('confirmed','rejected','cancelled','failed')
       FOR UPDATE OF i`,
      [tenantId, subjectId],
    );
    if (!locked.rows[0]) invalidSubject();
    return null;
  }
  const payout = await tx.query<{ batch_id: string; status: string }>(
    "SELECT batch_id, status FROM payouts WHERE tenant_id = $1 AND id = $2",
    [tenantId, subjectId],
  );
  if (
    !payout.rows[0] ||
    ["paid", "failed", "returned"].includes(payout.rows[0].status)
  )
    invalidSubject();
  const lockedPayout = await tx.query<{ status: string }>(
    "SELECT status FROM payouts WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
    [tenantId, subjectId],
  );
  if (
    !lockedPayout.rows[0] ||
    ["paid", "failed", "returned"].includes(lockedPayout.rows[0].status)
  )
    invalidSubject();
  return null;
}

export class HoldService {
  constructor(private readonly db: DbClient) {}

  async placeHold(input: {
    tenantId: string;
    subjectType: string;
    subjectId: string;
    reasonCode: string;
    alertId?: string;
    placer: HoldPlacer;
    correlationId?: string;
  }): Promise<HoldRow> {
    const placerId =
      input.placer.type === "system"
        ? NIL_UUID
        : input.placer.type === "agent"
          ? input.placer.agentId
          : input.placer.userId;
    if (!SUBJECT_TYPES.has(input.subjectType as HoldSubjectType)) {
      await this.auditInvalid(input, placerId, "invalid_subject_type");
      invalidSubject();
    }
    if (!input.reasonCode || input.reasonCode.length > 100) {
      throw new ValidationError("reason_code must be 1 to 100 characters.", {
        fields: ["reason_code"],
      });
    }
    if (input.placer.type === "agent") {
      try {
        await assertDatabaseRateLimit({
          db: this.db,
          tenantId: input.tenantId,
          actorId: placerId,
          scope: "hold",
          limit: holdRateLimit(),
          windowMs: 60 * 60 * 1000,
        });
      } catch (error) {
        await recordRefusal(this.db, {
          tenantId: input.tenantId,
          principal: { type: "agent", id: placerId, role: "watchdog" },
          operation: "watchdog.hold.place",
          reasons: ["RATE_LIMITED"],
          correlationId: input.correlationId,
          resource: { type: input.subjectType, id: input.subjectId },
        });
        throw error;
      }
    }
    try {
      return await transaction(async (tx) => {
        const ownerId = await validateAndLockSubject(
          tx,
          input.tenantId,
          input.subjectType as HoldSubjectType,
          input.subjectId,
        );
        const existing = await tx.query<HoldRow>(
          `SELECT * FROM holds WHERE tenant_id = $1 AND scope_type = $2
           AND scope_id = $3 AND status = 'active'`,
          [input.tenantId, input.subjectType, input.subjectId],
        );
        if (existing.rows[0]) return existing.rows[0];
        const placed = await tx.query<HoldRow>(
          `INSERT INTO holds
             (tenant_id, scope_type, scope_id, reason, reason_code, placed_by,
              placed_by_type, alert_id, agent_run_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            input.tenantId,
            input.subjectType,
            input.subjectId,
            input.reasonCode,
            input.reasonCode,
            placerId,
            input.placer.type,
            input.alertId ?? null,
            input.placer.type === "agent" ? input.placer.runId : null,
          ],
        );
        await appendCommerceEvent(tx, {
          tenantId: input.tenantId,
          aggregateType: "hold",
          aggregateId: placed.rows[0].id,
          eventType: "HOLD_PLACED",
          actorType: input.placer.type,
          actorId: placerId,
          correlationId: input.correlationId,
          details: {
            subject_type: input.subjectType,
            subject_id: input.subjectId,
            reason_code: input.reasonCode,
            alert_id: input.alertId ?? null,
            owner_user_id: ownerId,
          },
        });
        return placed.rows[0];
      });
    } catch (error) {
      if (error instanceof HoldSubjectInvalidError) {
        await this.auditInvalid(input, placerId, "subject_invalid");
        throw error;
      }
      if ((error as { code?: string })?.code === "23505") {
        const existing = await this.db.query<HoldRow>(
          `SELECT * FROM holds WHERE tenant_id = $1 AND scope_type = $2
           AND scope_id = $3 AND status = 'active'`,
          [input.tenantId, input.subjectType, input.subjectId],
        );
        if (existing.rows[0]) return existing.rows[0];
      }
      throw error;
    }
  }

  async releaseHold(input: {
    tenantId: string;
    holdId: string;
    releaser: AuthenticatedPrincipal;
    reason: string;
    correlationId?: string;
  }): Promise<HoldRow> {
    if (input.releaser.type !== "user") {
      await recordRefusal(this.db, {
        tenantId: input.tenantId,
        principal: {
          type: input.releaser.type,
          id: input.releaser.id,
          role: String(input.releaser.role),
        },
        operation: "watchdog.hold.release",
        reasons: ["agent_principal"],
        correlationId: input.correlationId,
        resource: { type: "hold", id: input.holdId },
      });
      throw new ForbiddenActionError();
    }
    const reason = input.reason?.trim();
    if (!reason || reason.length > 500) {
      throw new ValidationError("reason must be 1 to 500 characters.", {
        fields: ["reason"],
      });
    }
    return transaction(async (tx) => {
      const holdResult = await tx.query<HoldRow>(
        "SELECT * FROM holds WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [input.tenantId, input.holdId],
      );
      const hold = holdResult.rows[0];
      if (!hold) throw new NotFoundError("Hold");
      let ownerId: string | null = null;
      if (hold.scope_type === "reservation") {
        const owner = await tx.query<{ owner_user_id: string }>(
          `SELECT w.owner_user_id FROM wallet_reservations r JOIN wallets w
           ON w.id = r.wallet_id AND w.tenant_id = r.tenant_id
           WHERE r.tenant_id = $1 AND r.id = $2`,
          [input.tenantId, hold.scope_id],
        );
        ownerId = owner.rows[0]?.owner_user_id ?? null;
      }
      if (!isAdmin(input.releaser) && input.releaser.id !== ownerId) {
        throw new ForbiddenActionError();
      }
      if (hold.status === "released") return hold;
      const released = await tx.query<HoldRow>(
        `UPDATE holds SET status = 'released', released_by = $2, released_at = now(),
           release_reason = $3 WHERE id = $1 RETURNING *`,
        [hold.id, input.releaser.id, reason],
      );
      await appendCommerceEvent(tx, {
        tenantId: input.tenantId,
        aggregateType: "hold",
        aggregateId: hold.id,
        eventType: "HOLD_RELEASED",
        actorType: "user",
        actorId: input.releaser.id,
        correlationId: input.correlationId,
        details: {
          reason,
          subject_type: hold.scope_type,
          subject_id: hold.scope_id,
        },
      });
      return released.rows[0];
    });
  }

  /**
   * Agents (and anyone else) can only ask for a release. This creates a pending
   * `hold_release` Proposal and never touches the Hold; release stays a human act.
   */
  async requestRelease(input: {
    tenantId: string;
    holdId: string;
    agentId: string;
    runId: string;
    rationale: string;
    ttlHours?: number;
    correlationId?: string;
  }): Promise<{ proposalId: string; status: "pending" }> {
    const draft = validateProposalDraft({
      type: "hold_release",
      payload: { hold_id: input.holdId },
      rationale: input.rationale?.trim(),
    });
    if (!draft.ok) {
      throw new ValidationError("Invalid hold_release proposal.", {
        fields: ["rationale", "hold_id"],
        reason_codes: draft.reasonCodes,
      });
    }
    const { rationale, subjectKey, payload, schemaVersion } = draft;
    return transaction(async (tx) => {
      const hold = await tx.query<{ status: string }>(
        "SELECT status FROM holds WHERE tenant_id = $1 AND id = $2",
        [input.tenantId, input.holdId],
      );
      if (!hold.rows[0] || hold.rows[0].status !== "active")
        throw new NotFoundError("Hold");
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type = 'hold_release'
         AND subject_key = $2 AND status = 'pending'`,
        [input.tenantId, subjectKey],
      );
      if (existing.rows[0])
        return { proposalId: existing.rows[0].id, status: "pending" as const };
      const created = await tx.query<{ id: string }>(
        `INSERT INTO proposals
           (tenant_id, proposal_type, schema_version, subject_key, payload, rationale, source,
            proposer_agent_id, agent_run_id, validation_decision, decider_scope, expires_at)
         VALUES ($1,'hold_release',$9,$2,$3,$4,'tool',$5,$6,$7,'admin',
                 now() + ($8 || ' hours')::interval)
         RETURNING id`,
        [
          input.tenantId,
          subjectKey,
          JSON.stringify(payload),
          rationale,
          input.agentId,
          input.runId,
          JSON.stringify({ valid: true, reason_codes: [] }),
          String(input.ttlHours ?? 72),
          schemaVersion,
        ],
      );
      await tx.query(
        `INSERT INTO proposal_decisions (tenant_id, proposal_id, principal_type, principal_id, decision)
         VALUES ($1,$2,'agent',$3,'submitted')`,
        [input.tenantId, created.rows[0].id, input.agentId],
      );
      await appendCommerceEvent(tx, {
        tenantId: input.tenantId,
        aggregateType: "proposal",
        aggregateId: created.rows[0].id,
        eventType: "PROPOSAL_SUBMITTED",
        actorType: "agent",
        actorId: input.agentId,
        correlationId: input.correlationId,
        details: { proposal_type: "hold_release", hold_id: input.holdId },
      });
      return { proposalId: created.rows[0].id, status: "pending" as const };
    });
  }

  private auditInvalid(
    input: {
      tenantId: string;
      subjectType: string;
      subjectId: string;
      correlationId?: string;
      placer: HoldPlacer;
    },
    placerId: string,
    reason: string,
  ): Promise<{ id: string }> {
    return recordRefusal(this.db, {
      tenantId: input.tenantId,
      principal: {
        type: input.placer.type,
        id: placerId,
        role: input.placer.type === "agent" ? "watchdog" : input.placer.type,
      },
      operation: "watchdog.hold.place",
      reasons: [reason],
      correlationId: input.correlationId,
      resource: { type: "hold_subject", id: input.subjectId },
    });
  }
}

export { assertNotHeld, type HeldSubject } from "./hold-guard.js";

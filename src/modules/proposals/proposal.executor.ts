import { transaction, type DbClient } from "../../db/connection.js";
import type { AuthenticatedPrincipal, UserRole } from "../../common/types.js";
import { appendCommerceEvent } from "../agentic/commerce-events.js";
import { EventsService } from "../events/events.service.js";
import { SettlementService } from "../settlement/settlement.service.js";
import { MandateService } from "../mandates/mandate.service.js";
import { HoldService } from "../watchdog/hold.service.js";
import { RefundService } from "../wallet/refund.service.js";
import { notifyInTx } from "../wallet/notification.service.js";
import type { ProposalType } from "./proposal.schemas.js";

export const PROPOSAL_EXECUTE_MAX_ATTEMPTS = 3;

const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "57P01", "57P03"]);
const TRANSIENT_NET = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
]);

/** Serialization failure, deadlock or connection trouble (R9.13). Everything else is permanent. */
export function isTransientError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== "string") return false;
  return (
    TRANSIENT_SQLSTATES.has(code) ||
    TRANSIENT_NET.has(code) ||
    code.startsWith("08")
  );
}

interface ApprovedProposal {
  id: string;
  tenant_id: string;
  proposal_type: ProposalType;
  status: string;
  payload: Record<string, unknown>;
  proposer_agent_id: string;
  decided_by: string | null;
  execution_attempts: number;
}

export interface ExecuteProposalInput {
  tenantId: string;
  proposalId: string;
  correlationId?: string;
}

export type ExecuteProposalOutcome =
  | { status: "skipped"; note: string }
  | { status: "executed"; code: string }
  | { status: "execution_failed"; code: string };

async function approverPrincipal(
  db: DbClient,
  tenantId: string,
  userId: string,
): Promise<AuthenticatedPrincipal> {
  const r = await db.query<{ id: string; role: string; email: string }>(
    "SELECT id, role, email FROM users WHERE tenant_id = $1 AND id = $2",
    [tenantId, userId],
  );
  const u = r.rows[0];
  if (!u) {
    throw Object.assign(new Error("The approver no longer exists."), {
      code: "APPROVER_NOT_FOUND",
    });
  }
  return {
    id: u.id,
    tenantId,
    type: "user",
    role: u.role as UserRole,
    scopes: [],
    name: u.email,
  };
}

/**
 * Run the owning service for one approved Proposal. Amounts, currencies and recipients are always
 * recomputed from stored records by the owning service; the display hint is never read (R9.5).
 */
async function runAction(
  db: DbClient,
  p: ApprovedProposal,
  correlationId?: string,
): Promise<{ code: string; result: Record<string, unknown> }> {
  const tenantId = p.tenant_id;
  switch (p.proposal_type) {
    case "topup_suggestion":
      // No server-side money action: the Owner tops up themselves (R9.6).
      return { code: "NO_ACTION", result: {} };

    case "payout_batch": {
      // Creates the batch in approval_required. Nothing is approved, captured or sent (R9.6).
      const ids = (p.payload.obligation_ids as string[]) ?? [];
      const batch = await transaction((tx) =>
        new SettlementService(tx, new EventsService(tx)).proposeBatch({
          tenantId,
          proposedBy: p.proposer_agent_id,
          actorType: "agent",
          obligationIds: ids,
          correlationId,
        }),
      );
      return {
        code: "BATCH_CREATED",
        result: { batch_id: batch.id, batch_status: batch.status },
      };
    }

    case "remainder_refund": {
      // Records the approving Owner's decision through the existing path. 'keep' makes no PayPal
      // call, so approval itself never moves money (R9.6).
      if (!p.decided_by) throw permanent("APPROVER_NOT_FOUND");
      const owner = await approverPrincipal(db, tenantId, p.decided_by);
      const decision = await new RefundService({ db }).decideRemainder({
        tenantId,
        owner,
        missionId: String(p.payload.mission_id),
        decision: "keep",
        idempotencyKey: `proposal:${p.id}`,
        correlationId,
      });
      return {
        code: "REMAINDER_DECIDED",
        result: { decision_id: (decision as { id?: string }).id ?? null },
      };
    }

    case "mandate_change": {
      const mandateId = String(p.payload.mandate_id);
      const action = String(p.payload.action);
      const mandates = new MandateService(db);
      if (action === "revoke") {
        if (!p.decided_by) throw permanent("APPROVER_NOT_FOUND");
        const actor = await approverPrincipal(db, tenantId, p.decided_by);
        await mandates.revoke({ tenantId, actor, mandateId, correlationId });
        return { code: "MANDATE_REVOKED", result: { mandate_id: mandateId } };
      }
      if (action === "suspend") {
        await mandates.suspendForWatchdog({
          tenantId,
          mandateId,
          alertId: p.id,
          correlationId,
        });
        return { code: "MANDATE_SUSPENDED", result: { mandate_id: mandateId } };
      }
      // review_terms changes no record; the approval is the Owner's acknowledgement.
      return { code: "NO_ACTION", result: { mandate_id: mandateId } };
    }

    case "hold_release": {
      if (!p.decided_by) throw permanent("APPROVER_NOT_FOUND");
      const releaser = await approverPrincipal(db, tenantId, p.decided_by);
      await new HoldService(db).releaseHold({
        tenantId,
        holdId: String(p.payload.hold_id),
        releaser,
        reason: `Approved Proposal ${p.id}`,
        correlationId,
      });
      return {
        code: "HOLD_RELEASED",
        result: { hold_id: String(p.payload.hold_id) },
      };
    }
  }
}

function permanent(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code.length > 0
    ? code.slice(0, 80)
    : "EXECUTION_ERROR";
}

/**
 * Execute one approved Proposal after its approval has committed (R9.5, R9.13).
 * Transient errors rethrow so the job runner backs off; the third failure, or any permanent
 * error, sets `execution_failed`, notifies Admins and returns normally.
 */
export async function executeProposal(
  db: DbClient,
  input: ExecuteProposalInput,
): Promise<ExecuteProposalOutcome> {
  const claimed = await db.query<ApprovedProposal>(
    `UPDATE proposals SET execution_attempts = execution_attempts + 1, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'approved'
      RETURNING id, tenant_id, proposal_type, status, payload, proposer_agent_id,
                decided_by, execution_attempts`,
    [input.tenantId, input.proposalId],
  );
  const proposal = claimed.rows[0];
  if (!proposal) return { status: "skipped", note: "not in approved state" };

  try {
    const done = await runAction(db, proposal, input.correlationId);
    const finished = await transaction(async (tx) => {
      const upd = await tx.query(
        `UPDATE proposals SET status = 'executed', executed_at = now(),
           execution_result_code = $3, execution_result = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'approved'`,
        [
          proposal.tenant_id,
          proposal.id,
          done.code,
          JSON.stringify(done.result),
        ],
      );
      if (!upd.rowCount) return false;
      await tx.query(
        `INSERT INTO proposal_decisions
           (tenant_id, proposal_id, principal_type, principal_id, decision, reason_codes)
         VALUES ($1,$2,'system',$2,'executed',$3)`,
        [proposal.tenant_id, proposal.id, JSON.stringify([done.code])],
      );
      await appendCommerceEvent(tx, {
        tenantId: proposal.tenant_id,
        aggregateType: "proposal",
        aggregateId: proposal.id,
        eventType: "PROPOSAL_EXECUTED",
        actorType: "system",
        actorId: proposal.id,
        correlationId: input.correlationId,
        details: { proposal_type: proposal.proposal_type, result_code: done.code },
      });
      return true;
    });
    return finished
      ? { status: "executed", code: done.code }
      : { status: "skipped", note: "already finished" };
  } catch (error) {
    if (
      isTransientError(error) &&
      proposal.execution_attempts < PROPOSAL_EXECUTE_MAX_ATTEMPTS
    ) {
      throw error;
    }
    const code = isTransientError(error) ? "TRANSIENT_RETRIES_EXHAUSTED" : errorCode(error);
    await transaction(async (tx) => {
      const upd = await tx.query(
        `UPDATE proposals SET status = 'execution_failed', execution_result_code = $3,
           execution_result = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'approved'`,
        [
          proposal.tenant_id,
          proposal.id,
          code,
          JSON.stringify({ attempts: proposal.execution_attempts }),
        ],
      );
      if (!upd.rowCount) return;
      await tx.query(
        `INSERT INTO proposal_decisions
           (tenant_id, proposal_id, principal_type, principal_id, decision, reason_codes)
         VALUES ($1,$2,'system',$2,'execution_failed',$3)`,
        [proposal.tenant_id, proposal.id, JSON.stringify([code])],
      );
      await appendCommerceEvent(tx, {
        tenantId: proposal.tenant_id,
        aggregateType: "proposal",
        aggregateId: proposal.id,
        eventType: "PROPOSAL_EXECUTION_FAILED",
        actorType: "system",
        actorId: proposal.id,
        correlationId: input.correlationId,
        details: { proposal_type: proposal.proposal_type, result_code: code },
      });
      await notifyInTx(tx, {
        tenantId: proposal.tenant_id,
        kind: "proposal_execution_failed",
        recipient: { admins: true },
        title: "An approved Proposal could not be executed",
        body: `Proposal ${proposal.id} failed with result code ${code}.`,
        entityType: "proposal",
        entityId: proposal.id,
        eventId: `proposal_execution_failed:${proposal.id}`,
      });
    });
    return { status: "execution_failed", code };
  }
}

/** Sweep safety net: queue `proposal_execute` for approved Proposals with no queued or running job. */
export async function requeueApprovedProposals(db: DbClient): Promise<number> {
  const r = await db.query(
    `INSERT INTO jobs (tenant_id, type, payload, status, priority, max_attempts)
     SELECT p.tenant_id, 'proposal_execute',
            jsonb_build_object('tenant_id', p.tenant_id::text, 'proposal_id', p.id::text),
            'queued', 5, ${PROPOSAL_EXECUTE_MAX_ATTEMPTS}
       FROM proposals p
      WHERE p.status = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.tenant_id = p.tenant_id AND j.type = 'proposal_execute'
             AND j.payload->>'proposal_id' = p.id::text
             AND j.status IN ('queued','running'))
      LIMIT 200`,
  );
  return r.rowCount ?? 0;
}

import { createHash } from "node:crypto";
import {
  ForbiddenActionError,
  NotFoundError,
  StoatError,
  ValidationError,
} from "../../common/errors.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import { transaction, type DbClient } from "../../db/connection.js";
import { appendCommerceEvent } from "../agentic/commerce-events.js";
import {
  AgentOutputInvalidError,
  ProposalExpiredError,
  ProposalInvalidError,
  ProposalTooLargeError,
} from "../agentic/commerce-errors.js";
import { assertDatabaseRateLimit } from "../agentic/rate-limit.js";
import { recordRefusal } from "../agentic/redact.js";
import {
  proposalMaxBytes,
  proposalRateLimit,
  proposalTtlHours,
} from "../agentic/agentic-config.js";
import { assertNotHeld, type HeldSubject } from "../watchdog/hold-guard.js";
import { HoldActiveError } from "../agentic/commerce-errors.js";
import {
  DECIDER,
  MAX_PAYOUT_BATCH_OBLIGATIONS,
  PROPOSER_ROLES,
  isProposalType,
  schemaVersionFor,
  type ProposalType,
} from "./proposal.schemas.js";
import { validateProposalDraft } from "./proposal-validation.js";

const HOUR_MS = 60 * 60 * 1000;

export interface ProposalProvenance {
  source: "model" | "tool";
  /** Required for `model`. */
  promptHash?: string;
  /** Required for `model`. */
  modelId?: string;
  parameters?: Record<string, unknown>;
}

export interface SubmitProposalInput {
  tenantId: string;
  submitter: AuthenticatedPrincipal;
  type: unknown;
  payload: unknown;
  rationale: unknown;
  agentRunId: string;
  provenance: ProposalProvenance;
  correlationId?: string;
  /** Override for tests; defaults to checking for a configured model key. */
  modelConfigured?: boolean;
}

export interface ProposalRow {
  id: string;
  tenant_id: string;
  proposal_type: ProposalType;
  schema_version: string;
  status: string;
  subject_key: string;
  payload: Record<string, unknown>;
  rationale: string;
  source: "model" | "tool";
  proposer_agent_id: string;
  agent_run_id: string;
  decider_scope: "owner" | "admin";
  owner_user_id: string | null;
  expires_at: Date | string;
  created_at: Date | string;
}

export interface SubmitProposalResult {
  proposal: ProposalRow;
  /** False when an existing pending Proposal for the same subject was returned (R8.11). */
  created: boolean;
}

interface DomainResult {
  reasonCodes: string[];
  ownerUserId: string | null;
}

function modelKeyConfigured(): boolean {
  return Boolean(process.env.FIREWORKS_API_KEY ?? process.env.LLM_API_KEY);
}

export async function domainValidate(
  tx: DbClient,
  tenantId: string,
  type: ProposalType,
  payload: Record<string, unknown>,
): Promise<DomainResult> {
  const reasons: string[] = [];
  let ownerUserId: string | null = null;

  const checkWallet = async (walletId: string) => {
    const wallet = await tx.query<{ owner_user_id: string; status: string }>(
      "SELECT owner_user_id, status FROM wallets WHERE tenant_id = $1 AND id = $2",
      [tenantId, walletId],
    );
    if (!wallet.rows[0]) {
      reasons.push("wallet_not_found");
      return null;
    }
    ownerUserId = wallet.rows[0].owner_user_id;
    return wallet.rows[0];
  };
  const checkMission = async (missionId: string): Promise<boolean> => {
    const mission = await tx.query(
      "SELECT 1 FROM missions WHERE tenant_id = $1 AND id = $2",
      [tenantId, missionId],
    );
    if (!mission.rows[0]) reasons.push("mission_not_found");
    return Boolean(mission.rows[0]);
  };

  if (type === "topup_suggestion") {
    const wallet = await checkWallet(String(payload.wallet_id));
    if (wallet && wallet.status !== "active") reasons.push("wallet_not_active");
    if (payload.mission_id) await checkMission(String(payload.mission_id));
  } else if (type === "remainder_refund") {
    await checkWallet(String(payload.wallet_id));
    if (await checkMission(String(payload.mission_id))) {
      const decided = await tx.query(
        "SELECT 1 FROM remainder_decisions WHERE tenant_id = $1 AND mission_id = $2",
        [tenantId, payload.mission_id],
      );
      if (decided.rows[0]) reasons.push("remainder_already_decided");
    }
  } else if (type === "mandate_change") {
    const mandate = await tx.query<{ owner_user_id: string; status: string }>(
      "SELECT owner_user_id, status FROM mandates WHERE tenant_id = $1 AND id = $2",
      [tenantId, payload.mandate_id],
    );
    if (!mandate.rows[0]) reasons.push("mandate_not_found");
    else {
      ownerUserId = mandate.rows[0].owner_user_id;
      if (!["active", "suspended"].includes(mandate.rows[0].status))
        reasons.push("mandate_not_changeable");
    }
  } else if (type === "hold_release") {
    const hold = await tx.query<{ status: string }>(
      "SELECT status FROM holds WHERE tenant_id = $1 AND id = $2",
      [tenantId, payload.hold_id],
    );
    if (!hold.rows[0]) reasons.push("hold_not_found");
    else if (hold.rows[0].status !== "active") reasons.push("hold_not_active");
  } else {
    const ids = (payload.obligation_ids as string[]) ?? [];
    if (ids.length > MAX_PAYOUT_BATCH_OBLIGATIONS)
      reasons.push("too_many_obligations");
    const found = await tx.query<{
      id: string;
      status: string;
      currency: string;
    }>(
      "SELECT id, status, currency FROM obligations WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, ids],
    );
    if (found.rows.length !== new Set(ids).size)
      reasons.push("obligation_not_found");
    if (found.rows.some((o) => o.status !== "payable"))
      reasons.push("obligation_not_payable");
    if (new Set(found.rows.map((o) => o.currency)).size > 1)
      reasons.push("currency_mismatch");
    const active = await tx.query(
      `SELECT 1 FROM settlement_batch_items i
       JOIN settlement_batches b ON b.id = i.batch_id AND b.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1 AND i.obligation_id = ANY($2::uuid[])
         AND b.status NOT IN ('rejected','cancelled','failed') LIMIT 1`,
      [tenantId, ids],
    );
    if (active.rows[0]) reasons.push("obligation_already_batched");
    const subjects: HeldSubject[] = ids.length
      ? (
          await tx.query<{ id: string }>(
            `SELECT i.id FROM settlement_batch_items i
             WHERE i.tenant_id = $1 AND i.obligation_id = ANY($2::uuid[])`,
            [tenantId, ids],
          )
        ).rows.map((r) => ({ type: "settlement_item", id: r.id }))
      : [];
    try {
      await assertNotHeld(tx, tenantId, subjects);
    } catch (error) {
      if (!(error instanceof HoldActiveError)) throw error;
      reasons.push("subject_held");
    }
  }
  return { reasonCodes: [...new Set(reasons)].sort(), ownerUserId };
}

const HUMAN_ADMIN_ROLES = new Set(["operator", "supervisor"]);
const MAX_COMMENT = 500;

export interface DecideProposalInput {
  tenantId: string;
  proposalId: string;
  decider: AuthenticatedPrincipal;
  decision: "approve" | "reject";
  /** Optional comment on approval (max 500); mandatory reason on rejection (1 to 500). */
  comment?: string;
  correlationId?: string;
}

export interface DecideProposalResult {
  proposal: ProposalRow;
  status: string;
  /** True when the Proposal was no longer pending; nothing was executed or logged (R9.11). */
  already_decided: boolean;
}

type DecideOutcome =
  | { kind: "done"; result: DecideProposalResult; enqueue: boolean }
  | { kind: "refuse"; reason: string }
  | { kind: "invalid"; reasonCodes: string[] }
  | { kind: "expired" };

export class ProposalService {
  constructor(private readonly db: DbClient) {}

  private async refuseDecision(
    tenantId: string,
    decider: AuthenticatedPrincipal,
    operation: string,
    reason: string,
    proposalId: string,
    correlationId?: string,
  ): Promise<void> {
    await recordRefusal(this.db, {
      tenantId,
      principal: {
        type: decider.type,
        id: decider.id,
        role: String(decider.role),
      },
      operation,
      reasons: [reason],
      correlationId,
      resource: { type: "proposal", id: proposalId },
    });
  }

  /**
   * Approve or reject a pending Proposal (R9.3 to R9.12, R9.14, R9.16).
   * The row is locked, so exactly one concurrent decision wins. No network call is made
   * inside the transaction; `proposal_execute` is enqueued after commit.
   */
  async decide(input: DecideProposalInput): Promise<DecideProposalResult> {
    const op = `proposal.${input.decision}`;
    const { decider, tenantId, proposalId } = input;

    // R9.8: agents never decide. Checked before touching the row.
    if (decider.type !== "user" || decider.tenantId !== tenantId) {
      await this.refuseDecision(
        tenantId,
        decider,
        op,
        decider.type === "agent" ? "AGENT_PRINCIPAL" : "TENANT_MISMATCH",
        proposalId,
        input.correlationId,
      );
      throw new ForbiddenActionError();
    }

    const comment = input.comment?.trim() ?? "";
    if (input.decision === "reject") {
      if (comment.length < 1 || comment.length > MAX_COMMENT) {
        throw new ValidationError(
          "A rejection reason of 1 to 500 characters is required.",
          { fields: ["reason"] },
        );
      }
    } else if (comment.length > MAX_COMMENT) {
      throw new ValidationError("The comment must be at most 500 characters.", {
        fields: ["comment"],
      });
    }

    const outcome = await transaction<DecideOutcome>(async (tx) => {
      const found = await tx.query<
        ProposalRow & { payload: Record<string, unknown> }
      >("SELECT * FROM proposals WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [
        tenantId,
        proposalId,
      ]);
      const row = found.rows[0];
      if (!row) throw new NotFoundError("Proposal");

      // R9.11: terminal or non-pending state is returned unchanged, no event.
      if (row.status !== "pending") {
        return {
          kind: "done",
          enqueue: false,
          result: { proposal: row, status: row.status, already_decided: true },
        };
      }

      // R9.7, R9.9: authority matrix.
      const isOwnerScope = row.decider_scope === "owner";
      const permitted = isOwnerScope
        ? row.owner_user_id !== null && row.owner_user_id === decider.id
        : HUMAN_ADMIN_ROLES.has(String(decider.role));
      if (!permitted) return { kind: "refuse", reason: "NOT_AUTHORIZED" };
      if (row.proposer_agent_id === decider.id)
        return { kind: "refuse", reason: "SELF_APPROVAL" };

      const logDecision = (
        decision: string,
        principalType: "user" | "system",
        reasonCodes: string[],
        text?: string,
      ) =>
        tx.query(
          `INSERT INTO proposal_decisions
             (tenant_id, proposal_id, principal_type, principal_id, decision, reason_codes, comment)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            tenantId,
            row.id,
            principalType,
            decider.id,
            decision,
            JSON.stringify(reasonCodes),
            text ?? null,
          ],
        );
      const event = (eventType: string, details: Record<string, unknown>) =>
        appendCommerceEvent(tx, {
          tenantId,
          aggregateType: "proposal",
          aggregateId: row.id,
          eventType,
          actorType: "user",
          actorId: decider.id,
          correlationId: input.correlationId,
          details: { proposal_type: row.proposal_type, ...details },
        });

      if (input.decision === "reject") {
        const updated = await tx.query<ProposalRow>(
          `UPDATE proposals SET status = 'rejected', decided_by = $3, decided_role = $4,
             decided_at = now(), rejection_reason = $5, updated_at = now()
           WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          [tenantId, row.id, decider.id, String(decider.role), comment],
        );
        await logDecision("rejected", "user", [], comment);
        await event("PROPOSAL_REJECTED", {});
        return {
          kind: "done",
          enqueue: false,
          result: {
            proposal: updated.rows[0],
            status: "rejected",
            already_decided: false,
          },
        };
      }

      // R9.12: expiry is evaluated at decision time regardless of stored status.
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await tx.query(
          `UPDATE proposals SET status = 'expired', updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, row.id],
        );
        await logDecision("expired", "system", ["expired_at_approval"]);
        await event("PROPOSAL_EXPIRED", {});
        return { kind: "expired" };
      }

      // R9.3, R9.4: re-run domain validation.
      const domain = await domainValidate(
        tx,
        tenantId,
        row.proposal_type,
        row.payload,
      );
      if (domain.reasonCodes.length > 0) {
        await tx.query(
          `UPDATE proposals SET status = 'invalid', updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, row.id],
        );
        await logDecision("invalid", "system", domain.reasonCodes);
        await event("PROPOSAL_INVALID", { reason_codes: domain.reasonCodes });
        return { kind: "invalid", reasonCodes: domain.reasonCodes };
      }

      const updated = await tx.query<ProposalRow>(
        `UPDATE proposals SET status = 'approved', decided_by = $3, decided_role = $4,
           decided_at = now(), decision_comment = $5, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [
          tenantId,
          row.id,
          decider.id,
          String(decider.role),
          comment === "" ? null : comment,
        ],
      );
      await logDecision("approved", "user", [], comment || undefined);
      await event("PROPOSAL_APPROVED", {});
      return {
        kind: "done",
        enqueue: true,
        result: {
          proposal: updated.rows[0],
          status: "approved",
          already_decided: false,
        },
      };
    });

    if (outcome.kind === "refuse") {
      await this.refuseDecision(
        tenantId,
        decider,
        op,
        outcome.reason,
        proposalId,
        input.correlationId,
      );
      throw new ForbiddenActionError();
    }
    if (outcome.kind === "expired") throw new ProposalExpiredError();
    if (outcome.kind === "invalid")
      throw new ProposalInvalidError(outcome.reasonCodes);

    // R9.14: enqueue after commit, never inside the approval transaction.
    if (outcome.enqueue) {
      await this.db.query(
        `INSERT INTO jobs (tenant_id, type, payload, status, priority, max_attempts)
         SELECT $1::uuid, 'proposal_execute',
                jsonb_build_object('tenant_id', $1::text, 'proposal_id', $2::text,
                                   'correlation_id', $3::text),
                'queued', 5, 3
         WHERE NOT EXISTS (
           SELECT 1 FROM jobs WHERE tenant_id = $1::uuid AND type = 'proposal_execute'
             AND payload->>'proposal_id' = $2::text AND status IN ('queued','running'))`,
        [tenantId, proposalId, input.correlationId ?? null],
      );
    }
    return outcome.result;
  }

  /** Set every pending Proposal past its expiry to `expired` (R8.12, R9.16). Returns the count. */
  async expireDue(tenantId?: string): Promise<number> {
    const due = await this.db.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM proposals
       WHERE status = 'pending' AND expires_at <= now()
         AND ($1::uuid IS NULL OR tenant_id = $1::uuid)
       ORDER BY expires_at LIMIT 500`,
      [tenantId ?? null],
    );
    let count = 0;
    for (const item of due.rows) {
      const done = await transaction(async (tx) => {
        const locked = await tx.query<{
          status: string;
          proposer_agent_id: string;
        }>(
          "SELECT status, proposer_agent_id FROM proposals WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
          [item.tenant_id, item.id],
        );
        if (locked.rows[0]?.status !== "pending") return false;
        await tx.query(
          `UPDATE proposals SET status = 'expired', updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [item.tenant_id, item.id],
        );
        await tx.query(
          `INSERT INTO proposal_decisions
             (tenant_id, proposal_id, principal_type, principal_id, decision, reason_codes)
           VALUES ($1,$2,'system',$3,'expired','["expired"]')`,
          [item.tenant_id, item.id, item.id],
        );
        await appendCommerceEvent(tx, {
          tenantId: item.tenant_id,
          aggregateType: "proposal",
          aggregateId: item.id,
          eventType: "PROPOSAL_EXPIRED",
          actorType: "system",
          actorId: item.id,
          details: {},
        });
        return true;
      });
      if (done) count += 1;
    }
    return count;
  }

  private async refuse(
    input: SubmitProposalInput,
    reason: string,
    resourceId: string,
  ): Promise<void> {
    await recordRefusal(this.db, {
      tenantId: input.tenantId,
      principal: {
        type: input.submitter.type,
        id: input.submitter.id,
        role: String(input.submitter.role),
      },
      operation: "proposal.submit",
      reasons: [reason],
      correlationId: input.correlationId,
      resource: { type: "proposal", id: resourceId },
    });
  }

  async submit(input: SubmitProposalInput): Promise<SubmitProposalResult> {
    const nil = "00000000-0000-0000-0000-000000000000";

    // R8.16: agents only.
    if (input.submitter.type !== "agent") {
      await this.refuse(input, "NOT_AGENT_PRINCIPAL", nil);
      throw new ForbiddenActionError();
    }
    if (input.submitter.tenantId !== input.tenantId) {
      await this.refuse(input, "TENANT_MISMATCH", nil);
      throw new ForbiddenActionError();
    }
    // R8.2: role matrix.
    if (
      !isProposalType(input.type) ||
      !PROPOSER_ROLES[input.type].includes(String(input.submitter.role))
    ) {
      await this.refuse(
        input,
        isProposalType(input.type) ? "ROLE_NOT_PERMITTED" : "UNKNOWN_TYPE",
        nil,
      );
      if (!isProposalType(input.type)) {
        throw new ValidationError("Unknown proposal type.", {
          fields: ["type"],
        });
      }
      throw new ForbiddenActionError();
    }
    const type: ProposalType = input.type;

    // R8.14: no canned output for model-backed drafts.
    if (input.provenance.source === "model") {
      if (!(input.modelConfigured ?? modelKeyConfigured())) {
        throw new StoatError(
          "LLM_NOT_CONFIGURED",
          "No model API key is configured. Stoat never substitutes canned output for a model-backed proposal.",
          503,
        );
      }
      if (!input.provenance.promptHash || !input.provenance.modelId) {
        throw new ValidationError(
          "Model-backed proposals require a prompt hash and model ID.",
          {
            fields: ["prompt_hash", "model_id"],
          },
        );
      }
    }

    // R8.10: rate limit (audit on refusal).
    try {
      await assertDatabaseRateLimit({
        db: this.db,
        tenantId: input.tenantId,
        actorId: input.submitter.id,
        scope: "proposal",
        limit: proposalRateLimit(),
        windowMs: HOUR_MS,
      });
    } catch (error) {
      await this.refuse(input, "RATE_LIMITED", nil);
      throw error;
    }

    const maxBytes = proposalMaxBytes();
    const draft = validateProposalDraft({
      type,
      payload: input.payload,
      rationale: input.rationale,
      maxBytes,
    });
    if (!draft.ok && draft.tooLarge) {
      await this.refuse(input, "PROPOSAL_TOO_LARGE", nil);
      throw new ProposalTooLargeError(maxBytes);
    }

    let storedInvalid: {
      proposal: ProposalRow;
      schema: string;
      reasonCodes: string[];
    } | null = null;
    let outcome: SubmitProposalResult | null = null;

    try {
      await transaction(async (tx) => {
        const run = await tx.query<{ agent_id: string }>(
          "SELECT agent_id FROM agent_runs WHERE tenant_id = $1 AND id = $2",
          [input.tenantId, input.agentRunId],
        );
        if (!run.rows[0] || run.rows[0].agent_id !== input.submitter.id) {
          throw new ValidationError(
            "The agent run does not belong to this agent.",
            {
              fields: ["agent_run_id"],
            },
          );
        }

        let reasonCodes: string[] = [];
        let ownerUserId: string | null = null;
        let payloadToStore: unknown;
        let subjectKey: string;
        let displayHint: string | null = null;
        let rationale: string;
        let schemaVersion = schemaVersionFor(type) as string;
        let valid = draft.ok;

        if (draft.ok) {
          const domain = await domainValidate(
            tx,
            input.tenantId,
            type,
            draft.payload,
          );
          reasonCodes = domain.reasonCodes;
          ownerUserId = domain.ownerUserId;
          valid = reasonCodes.length === 0;
          payloadToStore = draft.payload;
          subjectKey = draft.subjectKey;
          displayHint = draft.displayAmountHint;
          rationale = draft.rationale;
          schemaVersion = draft.schemaVersion;
          if (valid) {
            const existing = await tx.query<ProposalRow>(
              `SELECT * FROM proposals WHERE tenant_id = $1 AND proposal_type = $2
               AND subject_key = $3 AND status = 'pending'`,
              [input.tenantId, type, subjectKey],
            );
            if (existing.rows[0]) {
              outcome = { proposal: existing.rows[0], created: false };
              return;
            }
          }
        } else {
          reasonCodes = draft.reasonCodes;
          payloadToStore = draft.redactedPayload; // key names only (R8.3, R8.17)
          subjectKey = createHash("sha256")
            .update(
              `invalid:${type}:${input.agentRunId}:${draft.redactedPayload.keys.join(",")}`,
            )
            .digest("hex");
          rationale = "Rejected: failed schema validation.";
          schemaVersion = draft.schema ?? schemaVersion;
        }

        const decision = {
          valid,
          reason_codes: reasonCodes,
          schema: schemaVersion,
        };
        const inserted = await tx.query<ProposalRow>(
          `INSERT INTO proposals
             (tenant_id, proposal_type, schema_version, status, subject_key, payload,
              display_amount_hint, rationale, source, proposer_agent_id, agent_run_id,
              prompt_hash, model_id, parameters, validation_decision, decider_scope,
              owner_user_id, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                   now() + ($18 || ' hours')::interval)
           RETURNING *`,
          [
            input.tenantId,
            type,
            schemaVersion,
            valid ? "pending" : "invalid",
            subjectKey,
            JSON.stringify(payloadToStore),
            valid ? displayHint : null,
            rationale,
            input.provenance.source,
            input.submitter.id,
            input.agentRunId,
            input.provenance.source === "model"
              ? input.provenance.promptHash
              : null,
            input.provenance.source === "model"
              ? input.provenance.modelId
              : null,
            JSON.stringify(input.provenance.parameters ?? {}),
            JSON.stringify(decision),
            DECIDER[type],
            ownerUserId,
            String(proposalTtlHours()),
          ],
        );
        const row = inserted.rows[0];
        await tx.query(
          `INSERT INTO proposal_decisions
             (tenant_id, proposal_id, principal_type, principal_id, decision, reason_codes)
           VALUES ($1,$2,'agent',$3,$4,$5)`,
          [
            input.tenantId,
            row.id,
            input.submitter.id,
            valid ? "submitted" : "invalid",
            JSON.stringify(reasonCodes),
          ],
        );
        await appendCommerceEvent(tx, {
          tenantId: input.tenantId,
          aggregateType: "proposal",
          aggregateId: row.id,
          eventType: valid ? "PROPOSAL_SUBMITTED" : "PROPOSAL_INVALID",
          actorType: "agent",
          actorId: input.submitter.id,
          correlationId: input.correlationId,
          details: {
            proposal_type: type,
            schema: schemaVersion,
            source: input.provenance.source,
            reason_codes: reasonCodes,
            ...(valid ? {} : { code: "AGENT_OUTPUT_INVALID" }),
          },
        });
        if (valid) outcome = { proposal: row, created: true };
        else
          storedInvalid = { proposal: row, schema: schemaVersion, reasonCodes };
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "23505") {
        // Lost a race with an identical pending Proposal: return the winner (R8.11).
        const subject = draft.ok ? draft.subjectKey : null;
        if (subject) {
          const existing = await this.db.query<ProposalRow>(
            `SELECT * FROM proposals WHERE tenant_id = $1 AND proposal_type = $2
             AND subject_key = $3 AND status = 'pending'`,
            [input.tenantId, type, subject],
          );
          if (existing.rows[0])
            return { proposal: existing.rows[0], created: false };
        }
      }
      throw error;
    }

    if (storedInvalid) {
      const { proposal, schema, reasonCodes } = storedInvalid as {
        proposal: ProposalRow;
        schema: string;
        reasonCodes: string[];
      };
      // Names the schema and the stored Proposal; echoes no payload (R8.3).
      throw new AgentOutputInvalidError(
        `The proposal failed validation against ${schema}.`,
        { schema, proposal_id: proposal.id, reason_codes: reasonCodes },
      );
    }
    return outcome as unknown as SubmitProposalResult;
  }
}

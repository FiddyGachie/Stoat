import type { Express, NextFunction, Request, Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { getDb, type DbClient } from "../../db/connection.js";
import {
  ForbiddenActionError,
  NotFoundError,
  ValidationError,
} from "../../common/errors.js";
import { agenticGuard } from "../agentic/agentic-guard.js";
import { requireFlag } from "../agentic/feature-flags.js";
import { recordRefusal } from "../agentic/redact.js";
import { ProposalService } from "./proposal.service.js";
import { executeProposal } from "./proposal.executor.js";

export const PROPOSAL_ROUTE_PATHS = [
  "/v1/proposals",
  "/v1/proposals/pending-count",
  "/v1/proposals/:id",
  "/v1/proposals/:id/approve",
  "/v1/proposals/:id/reject",
] as const;

const DECIDERS = ["buyer", "operator", "supervisor"] as const;
const ADMIN = ["operator", "supervisor"] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isAdmin = (req: Request) =>
  req.principal?.type === "user" &&
  (ADMIN as readonly string[]).includes(String(req.principal.role));

const handle =
  (action: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await action(req));
    } catch (error) {
      next(error);
    }
  };

function uuidParam(value: unknown, name: string): string {
  const s = String(value ?? "");
  if (!UUID_RE.test(s))
    throw new ValidationError(`${name} must be a UUID.`, { fields: [name] });
  return s;
}

function page(req: Request): { limit: number; offset: number } {
  const limit = Math.min(
    Math.max(Math.trunc(Number(req.query.limit ?? 50)) || 50, 1),
    200,
  );
  const offset = Math.max(Math.trunc(Number(req.query.offset ?? 0)) || 0, 0);
  return { limit, offset };
}

/** Columns exposed to humans. Never a recipient or payee identifier (R9.2). */
const VIEW_COLUMNS = `id, proposal_type, schema_version, status, payload, display_amount_hint,
  rationale, source, proposer_agent_id, agent_run_id, prompt_hash, model_id, parameters,
  validation_decision, decider_scope, owner_user_id, expires_at, decided_by, decided_role,
  decided_at, decision_comment, rejection_reason, execution_attempts, executed_at,
  execution_result_code, created_at, updated_at`;

/** Scope: Owners see their own Proposals; Admins see every Proposal in the tenant. */
function scope(req: Request, params: unknown[]): string {
  if (isAdmin(req)) return "tenant_id = $1";
  params.push(req.principal!.id);
  return `tenant_id = $1 AND decider_scope = 'owner' AND owner_user_id = $${params.length}`;
}

interface Row {
  id: string;
  proposal_type: string;
  payload: Record<string, unknown>;
  display_amount_hint: string | null;
}

/** Recompute what the executor would act on from stored records; the hint is never trusted (R9.2). */
async function buildPreview(
  db: DbClient,
  tenantId: string,
  p: Row,
): Promise<Record<string, unknown>> {
  switch (p.proposal_type) {
    case "payout_batch": {
      const ids = (p.payload.obligation_ids as string[]) ?? [];
      const r = await db.query<{
        n: string;
        total: string | null;
        c: string[];
      }>(
        `SELECT count(*)::text AS n, sum(amount)::text AS total, array_agg(DISTINCT currency) AS c
           FROM obligations WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, ids],
      );
      const row = r.rows[0];
      return {
        action: "create_payout_batch_pending_admin_approval",
        obligation_count: Number(row?.n ?? 0),
        amount: row?.total ?? "0",
        currency: row?.c?.length === 1 ? row.c[0] : null,
        moves_money_on_approval: false,
      };
    }
    case "topup_suggestion":
    case "remainder_refund": {
      const w = await db.query<{ currency: string }>(
        "SELECT currency FROM wallets WHERE tenant_id = $1 AND id = $2",
        [tenantId, p.payload.wallet_id],
      );
      return {
        action:
          p.proposal_type === "topup_suggestion"
            ? "owner_tops_up_wallet"
            : "record_remainder_decision_keep",
        currency: w.rows[0]?.currency ?? null,
        suggested_amount_hint: p.display_amount_hint,
        moves_money_on_approval: false,
      };
    }
    case "mandate_change":
      return {
        action: `mandate_${String(p.payload.action)}`,
        mandate_id: p.payload.mandate_id,
        moves_money_on_approval: false,
      };
    default:
      return {
        action: "release_hold",
        hold_id: p.payload.hold_id,
        moves_money_on_approval: false,
      };
  }
}

export function registerProposalRoutes(app: Express): void {
  const P = PROPOSAL_ROUTE_PATHS;

  app.get(
    P[0],
    agenticGuard("proposal.list", { roles: DECIDERS }),
    requireFlag("proposals"),
    handle(async (req) => {
      const { limit, offset } = page(req);
      const params: unknown[] = [req.principal!.tenantId];
      let where = scope(req, params);
      if (typeof req.query.status === "string" && req.query.status) {
        params.push(req.query.status);
        where += ` AND status = $${params.length}`;
      }
      if (typeof req.query.type === "string" && req.query.type) {
        params.push(req.query.type);
        where += ` AND proposal_type = $${params.length}`;
      }
      params.push(limit, offset);
      const r = await getDb().query(
        `SELECT ${VIEW_COLUMNS} FROM proposals WHERE ${where}
          ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { proposals: r.rows };
    }),
  );

  // Registered before '/:id' so it is not captured as an id.
  app.get(
    P[1],
    agenticGuard("proposal.pending_count", { roles: DECIDERS }),
    requireFlag("proposals"),
    handle(async (req) => {
      const params: unknown[] = [req.principal!.tenantId];
      let where = scope(req, params);
      if (isAdmin(req)) where += " AND decider_scope = 'admin'";
      const r = await getDb().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM proposals
          WHERE ${where} AND status = 'pending' AND expires_at > now()`,
        params,
      );
      return { count: Number(r.rows[0]?.n ?? 0) };
    }),
  );

  app.get(
    P[2],
    agenticGuard("proposal.get", { roles: DECIDERS }),
    requireFlag("proposals"),
    handle(async (req) => {
      const id = uuidParam(req.params.id, "id");
      const params: unknown[] = [req.principal!.tenantId];
      const where = scope(req, params);
      params.push(id);
      const r = await getDb().query<Row>(
        `SELECT ${VIEW_COLUMNS} FROM proposals WHERE ${where} AND id = $${params.length}`,
        params,
      );
      const proposal = r.rows[0];
      if (!proposal) throw new NotFoundError("Proposal");
      const preview = await buildPreview(
        getDb(),
        req.principal!.tenantId,
        proposal,
      );
      const decisions = await getDb().query(
        `SELECT principal_type, decision, reason_codes, created_at
           FROM proposal_decisions WHERE tenant_id = $1 AND proposal_id = $2
          ORDER BY created_at`,
        [req.principal!.tenantId, id],
      );
      return {
        proposal,
        preview,
        validation_decision: (proposal as unknown as Record<string, unknown>)
          .validation_decision,
        provenance: {
          source: (proposal as unknown as Record<string, unknown>).source,
          prompt_hash: (proposal as unknown as Record<string, unknown>)
            .prompt_hash,
          model_id: (proposal as unknown as Record<string, unknown>).model_id,
          agent_run_id: (proposal as unknown as Record<string, unknown>)
            .agent_run_id,
          replayed:
            (
              (proposal as unknown as Record<string, unknown>).parameters as {
                replayed?: boolean;
              } | null
            )?.replayed === true,
        },
        decisions: decisions.rows,
      };
    }),
  );

  const decideRoute =
    (decision: "approve" | "reject") => async (req: Request) => {
      const tenantId = req.principal!.tenantId;
      const proposalId = uuidParam(req.params.id, "id");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = decision === "reject" ? body.reason : body.comment;
      const comment = typeof raw === "string" ? raw : undefined;
      const result = await new ProposalService(getDb()).decide({
        tenantId,
        proposalId,
        decider: req.principal!,
        decision,
        comment,
        correlationId: req.correlationId,
      });
      if (decision === "approve" && !result.already_decided) {
        // Latency only; the queued job is the backstop and both share the locked path.
        try {
          await executeProposal(getDb(), {
            tenantId,
            proposalId,
            correlationId: req.correlationId,
          });
        } catch {
          // transient failure: the job retries
        }
      }
      const fresh = await getDb().query(
        `SELECT ${VIEW_COLUMNS} FROM proposals WHERE tenant_id = $1 AND id = $2`,
        [tenantId, proposalId],
      );
      return {
        proposal: fresh.rows[0] ?? result.proposal,
        status:
          (fresh.rows[0] as { status?: string } | undefined)?.status ??
          result.status,
        already_decided: result.already_decided,
      };
    };

  app.post(
    P[3],
    agenticGuard("proposal.approve", { roles: DECIDERS }),
    requireFlag("proposals"),
    handle(decideRoute("approve")),
  );
  app.post(
    P[4],
    agenticGuard("proposal.reject", { roles: DECIDERS }),
    requireFlag("proposals"),
    handle(decideRoute("reject")),
  );

  // Agent submit: only agent principals; ProposalService re-checks and audits refusals.
  app.post(
    P[0],
    authMiddleware(),
    async (req: Request, _res: Response, next: NextFunction) => {
      const p = req.principal;
      if (!p) return next(new ForbiddenActionError());
      if (p.type === "agent") return next();
      try {
        await recordRefusal(getDb(), {
          tenantId: p.tenantId,
          principal: { type: p.type, id: p.id, role: String(p.role) },
          operation: "proposal.submit",
          reasons: ["NOT_AGENT_PRINCIPAL"],
          correlationId:
            req.correlationId && UUID_RE.test(req.correlationId)
              ? req.correlationId
              : undefined,
          resource: { type: "proposal", id: p.id },
        });
      } catch {
        // refusal logging must not mask the 403
      }
      next(new ForbiddenActionError("Only agents may submit Proposals."));
    },
    requireFlag("proposals"),
    handle(async (req) => {
      const p = req.principal!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const runId = uuidParam(body.agent_run_id, "agent_run_id");
      const run = await getDb().query(
        "SELECT id FROM agent_runs WHERE id = $1 AND tenant_id = $2 AND agent_id = $3",
        [runId, p.tenantId, p.id],
      );
      if (!run.rows[0])
        throw new ValidationError("agent_run_id is not a run of this agent.", {
          fields: ["agent_run_id"],
        });
      const prov = (body.provenance ?? {}) as Record<string, unknown>;
      const source = prov.source === "model" ? "model" : "tool";
      const result = await new ProposalService(getDb()).submit({
        tenantId: p.tenantId,
        submitter: p,
        type: body.type,
        payload: body.payload,
        rationale: body.rationale,
        agentRunId: runId,
        provenance: {
          source,
          promptHash:
            typeof prov.prompt_hash === "string" ? prov.prompt_hash : undefined,
          modelId:
            typeof prov.model_id === "string" ? prov.model_id : undefined,
          parameters:
            prov.parameters && typeof prov.parameters === "object"
              ? (prov.parameters as Record<string, unknown>)
              : undefined,
        },
        correlationId: req.correlationId,
      });
      return { proposal: result.proposal, created: result.created };
    }, 201),
  );
}

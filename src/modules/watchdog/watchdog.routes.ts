import type { Express, NextFunction, Request, Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { getDb } from "../../db/connection.js";
import {
  ForbiddenActionError,
  NotFoundError,
  ValidationError,
} from "../../common/errors.js";
import { agenticGuard } from "../agentic/agentic-guard.js";
import { requireFlag } from "../agentic/feature-flags.js";
import { recordRefusal } from "../agentic/redact.js";
import { HoldService } from "./hold.service.js";
import { ExplainService } from "./explain.service.js";
import { DETECTOR_NAMES, type DetectorResponse } from "./detectors/index.js";
import { WatchdogService, loadThresholds } from "./watchdog.service.js";

export const WATCHDOG_ROUTE_PATHS = [
  "/v1/watchdog/alerts",
  "/v1/watchdog/alerts/:id",
  "/v1/watchdog/alerts/:id/explain",
  "/v1/watchdog/holds",
  "/v1/watchdog/holds/:id",
  "/v1/watchdog/holds/:id/release",
  "/v1/admin/watchdog/thresholds",
  "/v1/admin/watchdog/thresholds/:detector",
] as const;

const ADMIN = ["operator", "supervisor"] as const;
const READERS = ["buyer", "operator", "supervisor"] as const;
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

const OWNED_HOLD_SQL = `(
  h.scope_type = 'reservation' AND EXISTS (
    SELECT 1 FROM wallet_reservations r JOIN wallets w
      ON w.id = r.wallet_id AND w.tenant_id = r.tenant_id
    WHERE r.tenant_id = h.tenant_id AND r.id = h.scope_id AND w.owner_user_id = $2))`;

async function getExplanation(tenantId: string, alertId: string) {
  const found = await getDb().query<Record<string, unknown>>(
    `SELECT id, payload, model, prompt_hash, parameters, agent_run_id, created_at
       FROM llm_proposals
      WHERE tenant_id = $1 AND proposal_type = 'alert_explanation' AND decision_reference = $2`,
    [tenantId, alertId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const parameters =
    typeof row.parameters === "string"
      ? JSON.parse(row.parameters)
      : row.parameters;
  return {
    ...row,
    model_written: true,
    replayed: (parameters as { replayed?: boolean } | null)?.replayed === true,
  };
}

export function registerWatchdogRoutes(app: Express): void {
  const P = WATCHDOG_ROUTE_PATHS;

  app.get(
    P[0],
    agenticGuard("watchdog.alert.list", { roles: READERS }),
    requireFlag("watchdog"),
    handle(async (req) => {
      const { limit, offset } = page(req);
      const params: unknown[] = [req.principal!.tenantId];
      let where = "tenant_id = $1";
      if (!isAdmin(req)) {
        params.push(req.principal!.id);
        where += ` AND owner_user_id = $${params.length}`;
      }
      for (const [col, key] of [
        ["status", "status"],
        ["severity", "severity"],
        ["detector", "detector"],
      ] as const) {
        const v = req.query[key];
        if (typeof v === "string" && v) {
          params.push(v);
          where += ` AND ${col} = $${params.length}`;
        }
      }
      params.push(limit, offset);
      const result = await getDb().query(
        `SELECT * FROM watchdog_alerts WHERE ${where}
          ORDER BY first_seen_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { alerts: result.rows };
    }),
  );

  app.get(
    P[1],
    agenticGuard("watchdog.alert.get", { roles: READERS }),
    requireFlag("watchdog"),
    handle(async (req) => {
      const tenantId = req.principal!.tenantId;
      const id = uuidParam(req.params.id, "id");
      const result = await getDb().query<{ owner_user_id: string | null }>(
        "SELECT * FROM watchdog_alerts WHERE tenant_id = $1 AND id = $2",
        [tenantId, id],
      );
      const alert = result.rows[0];
      if (
        !alert ||
        (!isAdmin(req) && alert.owner_user_id !== req.principal!.id)
      ) {
        throw new NotFoundError("Alert");
      }
      return { alert, explanation: await getExplanation(tenantId, id) };
    }),
  );

  app.post(
    P[2],
    agenticGuard("watchdog.alert.explain", { roles: ADMIN }),
    requireFlag("watchdog"),
    requireFlag("watchdog_explanations"),
    handle(async (req) => {
      const tenantId = req.principal!.tenantId;
      const id = uuidParam(req.params.id, "id");
      const alert = await getDb().query(
        "SELECT id FROM watchdog_alerts WHERE tenant_id = $1 AND id = $2",
        [tenantId, id],
      );
      if (!alert.rows[0]) throw new NotFoundError("Alert");
      const stored = await getExplanation(tenantId, id);
      if (stored) return { explanation: stored };
      await new ExplainService(getDb()).explain({
        tenantId,
        alertId: id,
        correlationId: req.correlationId,
      });
      return { explanation: await getExplanation(tenantId, id) };
    }),
  );

  app.get(
    P[3],
    agenticGuard("watchdog.hold.list", { roles: READERS }),
    requireFlag("watchdog"),
    handle(async (req) => {
      const { limit, offset } = page(req);
      const params: unknown[] = [req.principal!.tenantId];
      let where = "h.tenant_id = $1";
      if (!isAdmin(req)) {
        params.push(req.principal!.id);
        where += ` AND ${OWNED_HOLD_SQL}`;
      }
      if (typeof req.query.status === "string" && req.query.status) {
        params.push(req.query.status);
        where += ` AND h.status = $${params.length}`;
      }
      params.push(limit, offset);
      const result = await getDb().query(
        `SELECT h.* FROM holds h WHERE ${where}
          ORDER BY h.placed_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { holds: result.rows };
    }),
  );

  // Constrained placement: a Watchdog agent principal or an Admin. HoldService validates the
  // subject type and state, is idempotent and rate-limits agents.
  app.post(
    P[3],
    authMiddleware(),
    async (req: Request, _res: Response, next: NextFunction) => {
      const p = req.principal;
      if (!p) return next(new ForbiddenActionError());
      const allowed =
        (p.type === "agent" && p.role === "watchdog") || isAdmin(req);
      if (allowed) return next();
      try {
        await recordRefusal(getDb(), {
          tenantId: p.tenantId,
          principal: { type: p.type, id: p.id, role: String(p.role) },
          operation: "watchdog.hold.place",
          reasons: ["role_not_allowed"],
          correlationId:
            req.correlationId && UUID_RE.test(req.correlationId)
              ? req.correlationId
              : undefined,
          resource: {
            type: "hold_subject",
            id: String(req.body?.subject_id ?? p.id),
          },
        });
      } catch {
        // refusal logging must not mask the 403
      }
      next(
        new ForbiddenActionError(
          "Only a Watchdog agent or an Admin may place a Hold.",
        ),
      );
    },
    requireFlag("watchdog"),
    handle(async (req) => {
      const p = req.principal!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const subjectId = uuidParam(body.subject_id, "subject_id");
      const reasonCode =
        typeof body.reason_code === "string" ? body.reason_code : "";
      const alertId =
        body.alert_id == null
          ? undefined
          : uuidParam(body.alert_id, "alert_id");
      let placer: Parameters<HoldService["placeHold"]>[0]["placer"];
      if (p.type === "agent") {
        const runId = uuidParam(body.agent_run_id, "agent_run_id");
        const run = await getDb().query(
          "SELECT id FROM agent_runs WHERE id = $1 AND tenant_id = $2 AND agent_id = $3",
          [runId, p.tenantId, p.id],
        );
        if (!run.rows[0])
          throw new ValidationError(
            "agent_run_id is not a run of this agent.",
            { fields: ["agent_run_id"] },
          );
        placer = { type: "agent", agentId: p.id, runId };
      } else {
        placer = { type: "user", userId: p.id };
      }
      const hold = await new HoldService(getDb()).placeHold({
        tenantId: p.tenantId,
        subjectType: String(body.subject_type ?? ""),
        subjectId,
        reasonCode,
        alertId,
        placer,
        correlationId: req.correlationId,
      });
      return { hold };
    }, 201),
  );

  app.get(
    P[4],
    agenticGuard("watchdog.hold.get", { roles: READERS }),
    requireFlag("watchdog"),
    handle(async (req) => {
      const params: unknown[] = [
        req.principal!.tenantId,
        req.principal!.id,
        uuidParam(req.params.id, "id"),
      ];
      const owned = isAdmin(req) ? "" : ` AND ${OWNED_HOLD_SQL}`;
      const result = await getDb().query(
        `SELECT h.* FROM holds h WHERE h.tenant_id = $1 AND h.id = $3${owned}`,
        params,
      );
      if (!result.rows[0]) throw new NotFoundError("Hold");
      return { hold: result.rows[0] };
    }),
  );

  // Agents are refused (403 + Audit_Log) by agenticGuard; HoldService re-checks owner or Admin.
  app.post(
    P[5],
    agenticGuard("watchdog.hold.release", { roles: READERS }),
    requireFlag("watchdog"),
    handle(async (req) => ({
      hold: await new HoldService(getDb()).releaseHold({
        tenantId: req.principal!.tenantId,
        holdId: uuidParam(req.params.id, "id"),
        releaser: req.principal!,
        reason: String(req.body?.reason ?? ""),
        correlationId: req.correlationId,
      }),
    })),
  );

  app.get(
    P[6],
    agenticGuard("watchdog.threshold.list", { roles: ADMIN }),
    requireFlag("watchdog"),
    handle(async (req) => {
      const thresholds = await loadThresholds(getDb(), req.principal!.tenantId);
      return { detectors: DETECTOR_NAMES, thresholds };
    }),
  );

  app.put(
    P[7],
    agenticGuard("watchdog.threshold.set", { roles: ADMIN }),
    requireFlag("watchdog"),
    handle(async (req) => {
      const body = (req.body ?? {}) as {
        params?: Record<string, unknown>;
        response?: DetectorResponse;
      };
      const threshold = await new WatchdogService(getDb()).setThreshold({
        tenantId: req.principal!.tenantId,
        detector: String(req.params.detector),
        params: body.params,
        response: body.response,
        admin: req.principal!,
        correlationId: req.correlationId,
      });
      return { detector: String(req.params.detector), threshold };
    }),
  );
}

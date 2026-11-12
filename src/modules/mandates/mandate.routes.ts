import type { Express, NextFunction, Request, Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { getDb } from "../../db/connection.js";
import { agenticGuard } from "../agentic/agentic-guard.js";
import { requireFlag } from "../agentic/feature-flags.js";
import { recordRefusal } from "../agentic/redact.js";
import { ForbiddenActionError } from "../../common/errors.js";
import { MandateService } from "./mandate.service.js";
import { MandateBuyerService } from "./mandate-buyer.service.js";

export const MANDATE_ROUTE_PATHS = [
  "/v1/mandates",
  "/v1/mandates/:id",
  "/v1/mandates/:id/lift-suspension",
  "/v1/missions/:id/mandate-selection",
] as const;

const service = () => new MandateService(getDb());
const handle = (
  action: (req: Request) => Promise<unknown>,
  status = 200,
) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(status).json(await action(req));
  } catch (error) {
    next(error);
  }
};

export function registerMandateRoutes(app: Express): void {
  const requireBuyerAgent = (req: Request, _res: Response, next: NextFunction) => {
    const principal = req.principal;
    if (!principal) return next(new ForbiddenActionError());
    if (principal.type !== "agent" || principal.role !== "buyer") {
      void recordRefusal(getDb(), {
        tenantId: principal.tenantId,
        principal: { type: principal.type, id: principal.id, role: String(principal.role) },
        operation: "mandate.select_and_accept",
        reasons: [principal.type === "agent" ? "role_not_allowed" : "human_principal"],
        correlationId: req.correlationId,
        resource: { type: "mission", id: String(req.params.id) },
      }).then(
        () => next(new ForbiddenActionError("Only a Buyer agent may autonomously select a quote.")),
        next,
      );
      return;
    }
    next();
  };

  app.post(
    MANDATE_ROUTE_PATHS[3],
    authMiddleware(),
    requireBuyerAgent,
    requireFlag("mandates"),
    handle((req) =>
      new MandateBuyerService(getDb()).selectAndAccept({
        tenantId: req.principal!.tenantId,
        missionId: String(req.params.id),
        buyerAgentId: req.principal!.id,
        mandateId: String(req.body?.mandate_id ?? ""),
        idempotencyKey: String(req.headers["idempotency-key"] ?? ""),
        correlationId: req.correlationId,
      }),
    ),
  );
  app.post(
    MANDATE_ROUTE_PATHS[0],
    agenticGuard("mandate.create", { roles: ["buyer"] }),
    requireFlag("mandates"),
    handle(
      (req) => service().create({
        tenantId: req.principal!.tenantId,
        actor: req.principal!,
        body: req.body,
        idempotencyKey: String(req.headers["idempotency-key"] ?? ""),
        correlationId: req.correlationId,
      }),
      201,
    ),
  );
  app.get(
    MANDATE_ROUTE_PATHS[0],
    agenticGuard("mandate.list", { roles: ["buyer", "operator", "supervisor"] }),
    handle((req) =>
      service().list({
        tenantId: req.principal!.tenantId,
        actor: req.principal!,
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
      }).then((mandates) => ({ mandates })),
    ),
  );
  app.get(
    MANDATE_ROUTE_PATHS[1],
    agenticGuard("mandate.get", { roles: ["buyer", "operator", "supervisor"] }),
    handle((req) =>
      service().get({
        tenantId: req.principal!.tenantId,
        actor: req.principal!,
        mandateId: String(req.params.id),
      }),
    ),
  );
  app.delete(
    MANDATE_ROUTE_PATHS[1],
    agenticGuard("mandate.revoke", { roles: ["buyer"] }),
    handle((req) =>
      service().revoke({
        tenantId: req.principal!.tenantId,
        actor: req.principal!,
        mandateId: String(req.params.id),
        correlationId: req.correlationId,
      }),
    ),
  );
  app.post(
    MANDATE_ROUTE_PATHS[2],
    agenticGuard("mandate.lift_suspension", { roles: ["buyer", "operator", "supervisor"] }),
    handle((req) =>
      service().liftSuspension({
        tenantId: req.principal!.tenantId,
        actor: req.principal!,
        mandateId: String(req.params.id),
        reason: req.body?.reason,
        correlationId: req.correlationId,
      }),
    ),
  );
}

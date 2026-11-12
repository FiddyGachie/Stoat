import type { NextFunction, Request, RequestHandler, Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { getDb } from "../../db/connection.js";
import { ForbiddenActionError } from "../../common/errors.js";
import { recordRefusal } from "./redact.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function agenticGuard(
  operation: string,
  options: { roles?: readonly string[] } = {},
): RequestHandler {
  const allowedRoles = options.roles ?? ["buyer", "operator", "supervisor"];
  const authenticate = authMiddleware();
  return (req: Request, res: Response, next: NextFunction) => {
    authenticate(req, res, (error?: unknown) => {
      if (error) return next(error);
      const principal = req.principal;
      if (!principal) return next(new ForbiddenActionError());
      if (
        principal.type === "agent" ||
        !allowedRoles.includes(String(principal.role))
      ) {
        void recordRefusal(getDb(), {
          tenantId: principal.tenantId,
          principal: {
            type: principal.type,
            id: principal.id,
            role: String(principal.role),
          },
          operation,
          reasons: [
            principal.type === "agent" ? "agent_principal" : "role_not_allowed",
          ],
          correlationId:
            req.correlationId && UUID_RE.test(req.correlationId)
              ? req.correlationId
              : undefined,
          resource: { type: "agentic_operation", id: principal.id },
        })
          .then(() =>
            next(
              new ForbiddenActionError(
                principal.type === "agent"
                  ? "Agents cannot perform this human-only operation."
                  : `Role '${principal.role}' is not authorized for this operation.`,
              ),
            ),
          )
          .catch(next);
        return;
      }
      next();
    });
  };
}

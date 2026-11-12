import type { Express, NextFunction, Request, Response } from "express";
import { getDb } from "../../db/connection.js";
import { agenticGuard } from "../agentic/agentic-guard.js";
import { runIntegrityCheck } from "./integrity-check.js";

export const INTEGRITY_ROUTE_PATHS = [
  "/v1/admin/agentic/integrity-check",
] as const;

/** On-demand integrity check: operators and supervisors only; agents are refused by the guard. */
export function registerIntegrityCheckRoutes(app: Express): void {
  app.post(
    INTEGRITY_ROUTE_PATHS[0],
    agenticGuard("agentic.integrity_check.run", {
      roles: ["operator", "supervisor"],
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res
          .status(200)
          .json(await runIntegrityCheck(getDb(), req.principal!.tenantId));
      } catch (error) {
        next(error);
      }
    },
  );
}

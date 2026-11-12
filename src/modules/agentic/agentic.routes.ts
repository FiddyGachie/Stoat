import type { Express, NextFunction, Request, Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { getDb } from "../../db/connection.js";
import { ValidationError } from "../../common/errors.js";
import {
  getFlags,
  setFlag,
  AGENTIC_FLAGS,
  type AgenticFlag,
} from "./feature-flags.js";
import { payPalStatus } from "../paypal/paypal.gateway.js";
import {
  registerMandateRoutes,
  MANDATE_ROUTE_PATHS,
} from "../mandates/mandate.routes.js";
import {
  registerWatchdogRoutes,
  WATCHDOG_ROUTE_PATHS,
} from "../watchdog/watchdog.routes.js";
import {
  registerProposalRoutes,
  PROPOSAL_ROUTE_PATHS,
} from "../proposals/proposal.routes.js";
import {
  registerAnalyticsRoutes,
  ANALYTICS_ROUTE_PATHS,
} from "../payments-analytics/analytics.routes.js";
import type { AgentRuntimeService } from "../agent-runtime/agent-runtime.service.js";
import {
  registerIntegrityCheckRoutes,
  INTEGRITY_ROUTE_PATHS,
} from "../agent-tools/integrity-check.routes.js";
import { agenticGuard } from "./agentic-guard.js";
import {
  registerAgentToolRoutes,
  AGENT_TOOL_ROUTE_PATHS,
} from "../agent-tools/agent-tools.routes.js";

const ADMIN_ROLES = ["operator", "supervisor"] as const;

export const AGENTIC_ROUTE_PATHS = [
  "/v1/agentic/capabilities",
  "/v1/agentic/flags/:flag",
  ...MANDATE_ROUTE_PATHS,
  ...WATCHDOG_ROUTE_PATHS,
  ...PROPOSAL_ROUTE_PATHS,
  ...ANALYTICS_ROUTE_PATHS,
  ...AGENT_TOOL_ROUTE_PATHS,
  ...INTEGRITY_ROUTE_PATHS,
] as const;

export function registerAgenticRoutes(
  app: Express,
  deps: { runtime?: AgentRuntimeService } = {},
): void {
  registerMandateRoutes(app);
  registerWatchdogRoutes(app);
  registerProposalRoutes(app);
  registerAnalyticsRoutes(app, { runtime: deps.runtime });
  registerAgentToolRoutes(app);
  registerIntegrityCheckRoutes(app);
  app.get(
    AGENTIC_ROUTE_PATHS[0],
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = req.principal!;
        const paypal = payPalStatus();
        res.status(200).json({
          flags: await getFlags(getDb(), principal.tenantId),
          adapter_mode: process.env.LLM_MODE ?? "record",
          paypal_environment: paypal.environment ?? "unknown",
        });
      } catch (error) {
        next(error);
      }
    },
  );
  app.put(
    AGENTIC_ROUTE_PATHS[1],
    agenticGuard("agentic.feature_flag.set", { roles: ADMIN_ROLES }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const flag = String(req.params.flag);
        if (!(AGENTIC_FLAGS as readonly string[]).includes(flag)) {
          throw new ValidationError("Unknown agentic feature flag.", {
            flag,
            allowed: AGENTIC_FLAGS,
          });
        }
        if (typeof req.body?.enabled !== "boolean") {
          throw new ValidationError("enabled must be a boolean.", {
            fields: ["enabled"],
          });
        }
        const flags = await setFlag({
          db: getDb(),
          tenantId: req.principal!.tenantId,
          flag: flag as AgenticFlag,
          enabled: req.body.enabled,
          admin: req.principal!,
          correlationId: req.correlationId,
        });
        res.status(200).json({ flags });
      } catch (error) {
        next(error);
      }
    },
  );
}

import type { Express, NextFunction, Request, Response } from "express";
import { agenticGuard } from "../agentic/agentic-guard.js";
import { requireFlag } from "../agentic/feature-flags.js";
import { payPalStatus } from "../paypal/paypal.gateway.js";
import { NotFoundError, StoatError } from "../../common/errors.js";
import { getDb } from "../../db/connection.js";
import type { AgentRuntimeService } from "../agent-runtime/agent-runtime.service.js";
import { InsightService } from "./insight.service.js";
import { QuestionService } from "./question.service.js";
import { runReadIntent } from "./intent-runner.js";
import { loadChart, isChartName } from "./charts.js";
import {
  loadDataset,
  isDatasetName,
  type DatasetRequest,
  type PaypalEnvironment,
} from "./datasets.js";
import { ANALYTICS_ROLES, scopeFromPrincipal } from "./read-models.js";

// The chart route is listed first so `charts` is never captured as a `:dataset`.
export const ANALYTICS_ROUTE_PATHS = [
  "/v1/analytics/payments/charts/:chart",
  "/v1/analytics/payments/:dataset",
  "/v1/analytics/payments/insights",
  "/v1/analytics/payments/questions",
  "/v1/analytics/payments/intents/:intent",
] as const;

function environment(): PaypalEnvironment {
  const env = payPalStatus().environment;
  return env === "sandbox" || env === "live" ? env : "unknown";
}

function datasetRequest(req: Request): DatasetRequest {
  const q = req.query;
  return {
    scope: scopeFromPrincipal(req.principal!),
    from: q.from,
    to: q.to,
    status: typeof q.status === "string" ? q.status : undefined,
    paypalEnvironment: environment(),
  };
}

export interface AnalyticsRouteDeps {
  /** Test seam for the model transport used by the insight and question agents. */
  runtime?: AgentRuntimeService;
}

export function registerAnalyticsRoutes(
  app: Express,
  deps: AnalyticsRouteDeps = {},
): void {
  app.get(
    ANALYTICS_ROUTE_PATHS[0],
    agenticGuard("payments.analytics.chart", { roles: ANALYTICS_ROLES }),
    requireFlag("payments_analytics"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const chart = String(req.params.chart);
        if (!isChartName(chart)) throw new NotFoundError("Chart");
        res.status(200).json(await loadChart(chart, datasetRequest(req)));
      } catch (error) {
        next(error);
      }
    },
  );
  app.get(
    ANALYTICS_ROUTE_PATHS[1],
    agenticGuard("payments.analytics.dataset", { roles: ANALYTICS_ROLES }),
    requireFlag("payments_analytics"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const name = String(req.params.dataset);
        if (!isDatasetName(name)) throw new NotFoundError("Dataset");
        res.status(200).json(await loadDataset(name, datasetRequest(req)));
      } catch (error) {
        next(error);
      }
    },
  );
  // Insight: the digest is deterministic; the model only writes display text about it (R12.1).
  app.post(
    ANALYTICS_ROUTE_PATHS[2],
    agenticGuard("payments.analytics.insight", { roles: ANALYTICS_ROLES }),
    requireFlag("insights"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const service = new InsightService(getDb(), deps.runtime);
        try {
          const result = await service.generate({
            principal: req.principal!,
            from: body.from,
            to: body.to,
            correlationId: req.correlationId,
          });
          res.status(200).json(result);
        } catch (error) {
          // Invalid model output: keep the digest and say there is no narrative (R12.8).
          if (
            error instanceof StoatError &&
            error.code === "AGENT_OUTPUT_INVALID" &&
            error.details?.digest
          ) {
            res.status(200).json({
              digest: error.details.digest,
              digest_hash: error.details.digest_hash,
              narrative: null,
              notice: "AGENT_OUTPUT_INVALID",
              notice_text: error.details.notice,
            });
            return;
          }
          throw error;
        }
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    ANALYTICS_ROUTE_PATHS[3],
    agenticGuard("payments.analytics.question", { roles: ANALYTICS_ROLES }),
    requireFlag("nl_questions"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const service = new QuestionService(getDb(), deps.runtime);
        res.status(200).json(
          await service.ask({
            principal: req.principal!,
            text: body.text,
            correlationId: req.correlationId,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  // Follow-up intent: runs only because a person selected it; scope comes from the principal.
  app.post(
    ANALYTICS_ROUTE_PATHS[4],
    agenticGuard("payments.analytics.intent", { roles: ANALYTICS_ROLES }),
    requireFlag("nl_questions"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        res.status(200).json(
          await runReadIntent(
            req.principal!,
            String(req.params.intent),
            body.params ?? {},
            { correlationId: req.correlationId, auditDb: getDb() },
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );}

import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { PayPalService } from "../modules/paypal/paypal.service.js";
import { EventsService } from "../modules/events/events.service.js";
import { MissionAdminService } from "../modules/missions/mission-admin.service.js";
import { listMissionResults } from "../modules/missions/mission-results.service.js";
import {
  payPalStatus,
  type PayPalGateway,
} from "../modules/paypal/paypal.gateway.js";
import { FundingService } from "../modules/payments/funding.service.js";
import { BudgetService } from "../modules/payments/budget.service.js";
import { BudgetAgent } from "../modules/payments/budget.agent.js";
import {
  completeBudgetViaWallet,
  decideBudgetViaWallet,
  getBudgetDecisionViaWallet,
  overlayWalletStatus,
  walletBackedLink,
} from "../modules/payments/budget-compat.js";
import { PaymentsAssistService } from "../modules/payments/payments-assist.service.js";
import { consoleReturnBase, trustedConsoleOrigin } from "./console-origin.js";
import { DepositService } from "../modules/wallet/deposit.service.js";
import { PayoutService } from "../modules/payments/payout.service.js";
import { RecipientService } from "../modules/payments/recipient.service.js";
import { NegotiationService } from "../modules/negotiation/negotiation.service.js";
import { LlmAdapter } from "../modules/agent-runtime/llm-adapter.js";
import { ResultsService } from "../modules/results/results.service.js";
import { TreasuryService } from "../modules/treasury/treasury.service.js";
import { MoneyFlowService } from "../modules/payments/money-flow.service.js";
import {
  assertPayPalOnly,
  ordersCapability,
  payoutsCapability,
} from "../modules/paypal/capabilities.js";
import {
  NotFoundError,
  StoatError,
  ValidationError,
} from "../common/errors.js";
import { recordRefusal } from "../modules/wallet/wallet-events.js";

/** After a quote is accepted, ask PayPal for the buyer's payment. Never fails the acceptance itself. */
async function requestAgreementPayment(req: Request, agreementId: string) {
  try {
    // Wallet mode: the Reservation made at acceptance funds the agreement; no PayPal order per agreement.
    if ((await getFundingMode(getDb(), req.principal!.tenantId)) === "wallet") {
      return { payment: null, payment_error: null };
    }
    const payment = await new FundingService(getDb()).requestFunding({
      tenantId: req.principal!.tenantId,
      agreementId,
      actorId: req.principal!.id,
      buyerUserAgent: req.headers["user-agent"],
      returnOrigin: trustedConsoleOrigin(req),
      correlationId: req.correlationId,
    });
    return { payment, payment_error: null };
  } catch (err: any) {
    return {
      payment: null,
      payment_error: {
        code: err?.code ?? "PAYMENT_REQUEST_FAILED",
        message: err?.message ?? "Could not request payment.",
        details: err?.details ?? null,
      },
    };
  }
}
import { authMiddleware, requireHumanPrincipal } from "../middleware/auth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { registerWalletRoutes } from "../modules/wallet/wallet.routes.js";
import type { AgentRuntimeService } from "../modules/agent-runtime/agent-runtime.service.js";
import {
  getFundingMode,
  setFundingMode,
} from "../modules/wallet/funding-mode.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { getDb } from "../db/connection.js";
import { ExchangeService } from "../modules/exchange/exchange.service.js";
import { MissionsService } from "../modules/missions/missions.service.js";
import { QuotesService } from "../modules/quotes/quotes.service.js";
import { AgreementsService } from "../modules/agreements/agreements.service.js";
import { rootRouteHandler } from "./rootRoute.js";
import { AuthService } from "../modules/auth/auth.service.js";
import { assertSignupAllowed } from "../common/login-throttle.js";
import { PerformanceService } from "../modules/performance/performance.service.js";
import { ForbiddenActionError } from "../common/errors.js";
// Helper: extract a single string from req.params (Express v5 types return string|string[])
function param(val: string | string[]): string {
  return Array.isArray(val) ? val[0] : val;
}

async function buyerAgentId(
  tenantId: string,
  principal: NonNullable<Request["principal"]>,
): Promise<string> {
  if (principal.type === "agent" && principal.role === "buyer")
    return principal.id;
  if (principal.type === "user" && principal.role === "buyer") {
    const result = await getDb().query<{ id: string }>(
      `SELECT id FROM agents
       WHERE tenant_id = $1 AND owner_user_id = $2 AND role = 'buyer' AND status = 'active'
       ORDER BY created_at ASC LIMIT 1`,
      [tenantId, principal.id],
    );
    if (result.rows[0]) return result.rows[0].id;
  }
  throw new ForbiddenActionError(
    "An active buyer agent is required for this action.",
  );
}

/** Typed injection seam. Product code passes nothing and gets getPayPalGateway(). */
export interface AppDeps {
  gateway?: PayPalGateway;
  /** Test seam for the Budget_Advisor model transport. */
  advisorRuntime?: AgentRuntimeService;
}

/**
 * Every path registerWalletRoutes mounts (src/modules/wallet/wallet.routes.ts). Kept here, with
 * the path literals, so `verify:ui` can match API_SPEC.yaml against the server; a unit test
 * (tests/unit/api_spec_wallet.test.ts) fails if this list and wallet.routes.ts drift apart.
 */
export const WALLET_ROUTE_PATHS = [
  "/v1/wallet",
  "/v1/wallet/account",
  "/v1/wallet/statement",
  "/v1/wallet/deposits",
  "/v1/wallet/deposits/:id",
  "/v1/wallet/deposits/:id/refresh",
  "/v1/wallet/missions",
  "/v1/wallet/missions/:id",
  "/v1/wallet/missions/:id/complete",
  "/v1/wallet/missions/:id/remainder-prompt",
  "/v1/wallet/missions/:id/top-up",
  "/v1/wallet/missions/:id/remainder-decision",
  "/v1/wallet/refunds",
  "/v1/wallet/refunds/:id",
  "/v1/wallet/refunds/:id/retry",
  "/v1/wallet/events",
  "/v1/notifications",
  "/v1/notifications/unread-count",
  "/v1/notifications/:id/read",
  "/v1/analytics/wallet/charts/:chart",
  "/v1/analytics/wallet/:dataset",
  "/v1/admin/business-account",
  "/v1/admin/trial-balance",
  "/v1/admin/wallets",
  "/v1/admin/wallets/:walletId/statement",
  "/v1/admin/wallets/:walletId/refunds",
  "/v1/admin/users/:userId/wallet-account",
  "/v1/admin/journal/transactions/:id/reverse",
  "/v1/admin/reconciliation/runs",
  "/v1/admin/reconciliation/runs/:id",
  "/v1/admin/reconciliation/exceptions",
] as const;

export function createApp(deps?: AppDeps): Express {
  assertPayPalOnly(); // FR-036: refuse to start with any non-PayPal payment configuration
  const app = express();
  // Behind Render/Vercel the TCP peer is the platform's load balancer. Trust exactly one
  // proxy hop so req.ip is the real client; otherwise every user shares one IP and the
  // per-IP sign-in and sign-up limits would throttle the whole user base together.
  const proxyHops = Number(
    process.env.TRUST_PROXY_HOPS ??
      (process.env.RENDER === "true" || process.env.VERCEL ? 1 : 0),
  );
  app.set("trust proxy", proxyHops);

  app.use(cors());
  app.use(express.json());
  // Deprecated unversioned paths (e.g. /quotes/:id/accept) are served by the /v1 handlers, so they get
  // exactly the same authentication, role checks and human-only guards. There is one implementation.
  const LEGACY_PREFIX =
    /^\/(health|services|missions|quotes|agreements|artifacts|deliveries|agents\/runs|obligations|settlement|webhooks|reconciliation|integrity|mcp)(\/|\?|$)/;
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (LEGACY_PREFIX.test(req.url)) {
      res.setHeader("Deprecation", "true");
      req.url = "/v1" + req.url;
    }
    next();
  });
  // FR-036: callers never choose a payment provider. PayPal is the only rail, so a "provider" field
  // on a money route is rejected rather than ignored.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      req.method !== "GET" &&
      req.body &&
      typeof req.body === "object" &&
      "provider" in req.body &&
      /\/(paypal|payments?|payouts?|payout-account|settlement|refund|webhooks)(\/|$)/.test(
        req.path,
      )
    ) {
      res.status(400).json({
        error: {
          code: "PROVIDER_NOT_ACCEPTED",
          message:
            "Stoat moves money only through PayPal. A payment provider cannot be supplied.",
          correlation_id: req.correlationId ?? "",
        },
      });
      return;
    }
    next();
  });

  // Correlation ID middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const corrHeader = req.headers["x-correlation-id"];
    const corrStr = Array.isArray(corrHeader)
      ? corrHeader[0]
      : (corrHeader as string | undefined);
    req.correlationId =
      corrStr &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        corrStr,
      )
        ? corrStr
        : crypto.randomUUID();
    res.setHeader("X-Correlation-Id", req.correlationId);
    next();
  });

  // Root route — landing page
  app.get("/", rootRouteHandler);

  // ── Account and agent authentication ─────────────────────────────────────
  app.post(
    "/v1/auth/signup",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authService = new AuthService(getDb());
        assertSignupAllowed(req.ip);
        const result = await authService.signup({
          ...(req.body ?? {}),
          correlationId: req.correlationId,
        });
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/v1/auth/login",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authService = new AuthService(getDb());
        const result = await authService.login(
          req.body?.email,
          req.body?.password,
          req.ip,
          req.correlationId,
        );
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/v1/auth/agent/login",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authService = new AuthService(getDb());
        const result = await authService.loginAgent(
          req.body?.agent_id,
          req.body?.secret,
          req.ip,
          req.correlationId,
        );
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/auth/me",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = req.principal!;
        const tenant = await getDb().query<{
          name: string;
          settings: Record<string, unknown> | string;
        }>("SELECT name, settings FROM tenants WHERE id = $1", [
          principal.tenantId,
        ]);
        const settings =
          typeof tenant.rows[0]?.settings === "string"
            ? JSON.parse(tenant.rows[0].settings)
            : tenant.rows[0]?.settings;
        let buyerAgentId: string | undefined;
        if (principal.type === "user" && principal.role === "buyer") {
          const buyerAgent = await getDb().query<{ id: string }>(
            `SELECT id FROM agents
         WHERE tenant_id = $1 AND owner_user_id = $2 AND role = 'buyer' AND status = 'active'
         ORDER BY created_at ASC LIMIT 1`,
            [principal.tenantId, principal.id],
          );
          buyerAgentId = buyerAgent.rows[0]?.id;
        }
        res.status(200).json({
          id: principal.id,
          tenant_id: principal.tenantId,
          tenant_name: tenant.rows[0]?.name ?? "",
          data_source: settings?.data_source ?? "unclassified",
          type: principal.type,
          role: principal.role,
          name: principal.name,
          ...(buyerAgentId ? { buyer_agent_id: buyerAgentId } : {}),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Health & Readiness (FR-022) ──────────────────────────────────────────
  app.get("/v1/health", (_req: Request, res: Response) => {
    const llm = new LlmAdapter(getDb());
    res.status(200).json({
      status: "ok",
      version: "2.1.0",
      // What the agents will actually do. No secret values, only whether a key is present.
      llm: {
        mode: llm.getMode(),
        provider: llm.getProvider(),
        model: llm.getDefaultModel(),
        key_configured: !!(
          process.env.FIREWORKS_API_KEY ||
          process.env.LLM_API_KEY ||
          process.env.ANTHROPIC_API_KEY
        ),
      },
    });
  });

  app.get("/v1/ready", async (_req: Request, res: Response) => {
    try {
      await getDb().query("SELECT 1");
      res.status(200).json({ status: "ready", database: "connected" });
    } catch {
      res.status(503).json({ status: "not_ready", database: "not_connected" });
    }
  });

  // ── OpenAPI contract (FR-020) ────────────────────────────────────────────
  app.get("/v1/openapi.yaml", (_req: Request, res: Response) => {
    import("node:fs").then((fs) => {
      import("node:path").then((path) => {
        import("node:url").then(({ fileURLToPath }) => {
          const dir = path.dirname(fileURLToPath(import.meta.url));
          const apiSpecPath = path.resolve(dir, "../../API_SPEC.yaml");
          if (fs.existsSync(apiSpecPath)) {
            res.setHeader("Content-Type", "application/yaml");
            res.send(fs.readFileSync(apiSpecPath, "utf-8"));
          } else {
            res.status(404).json({
              error: {
                code: "NOT_FOUND",
                message: "OpenAPI spec not found.",
              },
            });
          }
        });
      });
    });
  });

  // ── Services Discovery ───────────────────────────────────────────────────
  app.get(
    "/v1/services",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const exchangeService = new ExchangeService(getDb());
        const category = req.query.category as string | undefined;
        const services = await exchangeService.listServices(
          req.principal!.tenantId,
          category,
        );
        res.status(200).json({ services });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/v1/services",
    authMiddleware("provider"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const exchangeService = new ExchangeService(getDb());
        const service = await exchangeService.publishService({
          tenantId: req.principal!.tenantId,
          providerId: req.principal!.id,
          name: req.body?.name,
          description: req.body?.description,
          category: req.body?.category,
          unitPrice: req.body?.unit_price,
          minPrice: req.body?.min_price,
          executionMode: req.body?.execution_mode,
          currency: req.body?.currency,
          unit: req.body?.unit,
          constraints: req.body?.constraints,
          schema: req.body?.schema,
          verificationProfile: req.body?.verification_profile,
          correlationId: req.correlationId,
        });
        res.status(201).json(service);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Agents ───────────────────────────────────────────────────────────────
  app.get(
    "/v1/agents",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(Number(req.query.limit) || 100, 100);
        const offset = Number(req.query.offset) || 0;
        const principal = req.principal!;
        const res2 = await getDb().query(
          `SELECT id, tenant_id, role, name, status, scopes, created_at
         FROM agents WHERE tenant_id = $1
           AND ($2::uuid IS NULL OR id = $2)
           AND ($3::uuid IS NULL OR owner_user_id = $3)
         ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
          [
            principal.tenantId,
            principal.type === "agent" ? principal.id : null,
            principal.type === "user" && principal.role === "buyer"
              ? principal.id
              : null,
            limit,
            offset,
          ],
        );
        res.status(200).json({
          agents: res2.rows,
          limit,
          offset,
          more: res2.rows.length === limit,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/v1/agents",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = req.principal!;
        const authService = new AuthService(getDb());
        const result = await authService.createAgent(
          principal.tenantId,
          principal.id,
          {
            name: req.body?.name,
            role: req.body?.role,
          },
          req.correlationId,
        );
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Agent performance & earnings (owner dashboards) ──────────────────────
  // Declared before any /v1/agents/:agentId route so "performance" is never read as an id.
  app.get(
    "/v1/agents/performance",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const result = await new PerformanceService(getDb()).list({
          id: p.id,
          tenantId: p.tenantId,
          type: p.type,
          role: p.role,
        });
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );
  app.get(
    "/v1/agents/:agentId/performance",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const result = await new PerformanceService(getDb()).get(
          { id: p.id, tenantId: p.tenantId, type: p.type, role: p.role },
          String(req.params.agentId),
        );
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  ); // ── Agent lifecycle: suspend / reactivate (FR-002 kill switch, human-only) ──
  app.post(
    "/v1/agents/:agentId/status",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = req.principal!;
        const authService = new AuthService(getDb());
        const agent = await authService.setAgentStatus(
          {
            id: principal.id,
            tenantId: principal.tenantId,
            role: principal.role,
          },
          String(req.params.agentId),
          req.body?.status,
          req.correlationId,
        );
        res.status(200).json({ agent });
      } catch (err) {
        next(err);
      }
    },
  );
  // ── Missions ─────────────────────────────────────────────────────────────
  app.post(
    "/v1/missions",
    authMiddleware("buyer"),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const missionsService = new MissionsService(getDb());
        const mission = await missionsService.createMission({
          tenantId: req.principal!.tenantId,
          buyerId: await buyerAgentId(req.principal!.tenantId, req.principal!),
          title: req.body.title,
          brief: req.body.brief,
          budget: req.body.budget,
          currency: req.body.currency,
          deadline: req.body.deadline,
          correlationId: req.correlationId,
        });
        res.status(201).json(mission);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/missions",
    authMiddleware(["buyer", "operator", "supervisor", "viewer"]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const missionsService = new MissionsService(getDb());
        const principal = req.principal!;
        const missions = await missionsService.listMissions(
          principal.tenantId,
          principal.role === "buyer"
            ? await buyerAgentId(principal.tenantId, principal)
            : undefined,
        );
        res.status(200).json({ missions });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/missions/:missionId/quotes",
    authMiddleware(["buyer", "operator", "supervisor", "viewer"]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = req.principal!;
        const buyerId =
          principal.role === "buyer"
            ? await buyerAgentId(principal.tenantId, principal)
            : undefined;
        const quotesService = new QuotesService(getDb());
        const quotes = await quotesService.listMissionQuotes(
          principal.tenantId,
          param(req.params.missionId),
          buyerId,
        );
        res.status(200).json({ quotes });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/missions/:missionId",
    authMiddleware(["buyer", "operator", "supervisor", "viewer"]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const missionsService = new MissionsService(getDb());
        const principal = req.principal!;
        const mission = await missionsService.getMission(
          principal.tenantId,
          param(req.params.missionId),
          principal.role === "buyer"
            ? await buyerAgentId(principal.tenantId, principal)
            : undefined,
        );
        res.status(200).json(mission);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Mission management: edit / delete open missions, replay completed ones, results archive ──
  // People only (owner or Admin). Nothing here moves money; see MissionAdminService.
  app.patch(
    "/v1/missions/:missionId",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const mission = await new MissionAdminService(getDb()).updateMission({
          tenantId: p.tenantId, missionId: param(req.params.missionId), actor: { id: p.id, role: p.role },
          title: body.title, brief: body.brief, budget: body.budget, correlationId: req.correlationId,
        });
        res.status(200).json(mission);
      } catch (err) {
        next(err);
      }
    },
  );
  app.delete(
    "/v1/missions/:missionId",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const out = await new MissionAdminService(getDb()).deleteMission({
          tenantId: p.tenantId, missionId: param(req.params.missionId), actor: { id: p.id, role: p.role }, correlationId: req.correlationId,
        });
        res.status(200).json(out);
      } catch (err) {
        next(err);
      }
    },
  );
  app.post(
    "/v1/missions/:missionId/replay",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const out = await new MissionAdminService(getDb()).replayMission({
          tenantId: p.tenantId, missionId: param(req.params.missionId), actor: { id: p.id, role: p.role }, correlationId: req.correlationId,
        });
        res.status(201).json(out);
      } catch (err) {
        next(err);
      }
    },
  );
  app.get(
    "/v1/mission-results",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const missionId = typeof req.query.mission_id === "string" && /^[0-9a-f-]{36}$/i.test(req.query.mission_id) ? req.query.mission_id : undefined;
        const results = await listMissionResults(getDb(), {
          tenantId: p.tenantId, actor: { id: p.id, role: p.role }, missionId, limit: Number(req.query.limit ?? 100),
        });
        res.status(200).json({ results });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Quotes ───────────────────────────────────────────────────────────────
  app.post(
    "/v1/quotes",
    authMiddleware("buyer"),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const quotesService = new QuotesService(getDb());
        const quote = await quotesService.requestQuote({
          tenantId: req.principal!.tenantId,
          buyerId: await buyerAgentId(req.principal!.tenantId, req.principal!),
          missionId: req.body.mission_id,
          serviceId: req.body.service_id,
          requestedScope: req.body.requested_scope,
          quantity: req.body.quantity,
          currency: req.body.currency,
          deadline: req.body.deadline,
          correlationId: req.correlationId,
        });
        res.status(201).json(quote);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/quotes/:quoteId",
    authMiddleware(["buyer", "operator", "supervisor", "viewer"]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const quotesService = new QuotesService(getDb());
        const principal = req.principal!;
        const quote = await quotesService.getQuote(
          principal.tenantId,
          param(req.params.quoteId),
          principal.role === "buyer"
            ? await buyerAgentId(principal.tenantId, principal)
            : undefined,
        );
        res.status(200).json(quote);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Buyer-agent negotiation (v2.1): compare offers, counteroffer, select ──
  app.post(
    "/v1/missions/:missionId/negotiate",
    authMiddleware("buyer"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const db = getDb();
        const out = await new NegotiationService(db).negotiate({
          tenantId: req.principal!.tenantId,
          missionId: param(req.params.missionId),
          buyerAgentId: await buyerAgentId(
            req.principal!.tenantId,
            req.principal!,
          ),
        });
        res.status(200).json(out);
      } catch (err) {
        next(err);
      }
    },
  );
  app.get(
    "/v1/missions/:missionId/proposals",
    authMiddleware("buyer"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const db = getDb();
        const mission = await db.query(
          "SELECT buyer_id FROM missions WHERE id = $1 AND tenant_id = $2",
          [param(req.params.missionId), req.principal!.tenantId],
        );
        if (
          mission.rows.length === 0 ||
          mission.rows[0].buyer_id !==
            (await buyerAgentId(req.principal!.tenantId, req.principal!))
        )
          throw new NotFoundError("Mission", param(req.params.missionId));
        res.status(200).json({
          proposals: await new NegotiationService(db).listProposals(
            req.principal!.tenantId,
            param(req.params.missionId),
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );
  // ── Quote Acceptance -> Immutable Agreement ──────────────────────────────
  app.post(
    "/v1/quotes/:quoteId/accept",
    authMiddleware("buyer"),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agreementsService = new AgreementsService(getDb());
        const agreement = await agreementsService.acceptQuote({
          tenantId: req.principal!.tenantId,
          buyerId: await buyerAgentId(req.principal!.tenantId, req.principal!),
          quoteId: param(req.params.quoteId),
          proposalId:
            typeof req.body?.proposal_id === "string"
              ? req.body.proposal_id
              : undefined,
          correlationId: req.correlationId,
        });
        res.status(200).json({
          ...agreement,
          ...(await requestAgreementPayment(req, agreement.id)),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/agreements/:agreementId",
    authMiddleware(["buyer", "operator", "supervisor", "viewer"]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agreementsService = new AgreementsService(getDb());
        const principal = req.principal!;
        const agreement = await agreementsService.getAgreement(
          principal.tenantId,
          param(req.params.agreementId),
          principal.role === "buyer"
            ? await buyerAgentId(principal.tenantId, principal)
            : undefined,
        );
        res.status(200).json(agreement);
      } catch (err) {
        next(err);
      }
    },
  );

  // What the provider delivered, verified, in a form the buyer can act on.
  app.get(
    "/v1/agreements/:agreementId/result",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const scope =
          p.type === "agent"
            ? p.role === "buyer"
              ? { buyerAgentId: p.id }
              : p.role === "provider"
                ? { providerAgentId: p.id }
                : { buyerAgentId: "00000000-0000-0000-0000-000000000000" }
            : p.role === "buyer"
              ? { ownerUserId: p.id }
              : {};
        res
          .status(200)
          .json(
            await new ResultsService(getDb()).forAgreement(
              p.tenantId,
              param(req.params.agreementId),
              scope,
            ),
          );
      } catch (err) {
        next(err);
      }
    },
  );
  // ── Artifacts ────────────────────────────────────────────────────────────
  app.post(
    "/v1/artifacts",
    authMiddleware(),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { ArtifactsService } =
          await import("../modules/artifacts/artifacts.service.js");
        const artifactsService = new ArtifactsService(getDb());
        const ct = req.headers["content-type"];
        const result = await artifactsService.uploadArtifact({
          tenantId: req.principal!.tenantId,
          payload: req.body,
          contentType: Array.isArray(ct) ? ct[0] : ct,
        });
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Deliveries ───────────────────────────────────────────────────────────
  app.post(
    "/v1/deliveries",
    authMiddleware("provider"),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { DeliveriesService } =
          await import("../modules/deliveries/deliveries.service.js");
        const deliveriesService = new DeliveriesService(getDb());
        const result = await deliveriesService.submitDelivery({
          tenantId: req.principal!.tenantId,
          agreementId: req.body.agreement_id,
          providerId: req.principal!.id,
          artifactId: req.body.artifact_id,
          agentRunId: req.body.agent_run_id,
          declaredResult: req.body.declared_result,
          correlationId: req.correlationId,
        });
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/deliveries",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(Number(req.query.limit) || 100, 100);
        const offset = Number(req.query.offset) || 0;
        const res2 = await getDb().query(
          `SELECT d.id, d.agreement_id, d.provider_id, d.agent_run_id, d.artifact_id,
                d.declared_result, d.revision_number, d.status, d.created_at,
                v.verdict, v.checks, v.verifier_version, v.reasons, v.verified_at
         FROM deliveries d
         LEFT JOIN verifications v ON v.delivery_id = d.id
         WHERE d.tenant_id = $1
         ORDER BY d.created_at DESC LIMIT $2 OFFSET $3`,
          [req.principal!.tenantId, limit, offset],
        );
        res.status(200).json({
          deliveries: res2.rows,
          limit,
          offset,
          more: res2.rows.length === limit,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/deliveries/:deliveryId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { DeliveriesService } =
          await import("../modules/deliveries/deliveries.service.js");
        const deliveriesService = new DeliveriesService(getDb());
        const result = await deliveriesService.getDelivery(
          req.principal!.tenantId,
          param(req.params.deliveryId),
        );
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/v1/deliveries/:deliveryId/revision",
    authMiddleware("buyer"),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { DeliveriesService } =
          await import("../modules/deliveries/deliveries.service.js");
        const deliveriesService = new DeliveriesService(getDb());
        const result = await deliveriesService.requestRevision({
          tenantId: req.principal!.tenantId,
          buyerId: await buyerAgentId(req.principal!.tenantId, req.principal!),
          deliveryId: param(req.params.deliveryId),
          reasons: req.body.reasons,
          correlationId: req.correlationId,
        });
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Agent Runs & Traces ──────────────────────────────────────────────────
  app.get(
    "/v1/agents/runs",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(Number(req.query.limit) || 100, 100);
        const offset = Number(req.query.offset) || 0;
        const principal = req.principal!;
        let authorizedAgentIds: string[] | null = null;
        if (principal.type === "agent") {
          authorizedAgentIds = [principal.id];
        } else if (principal.role === "buyer") {
          const agents = await getDb().query<{ id: string }>(
            "SELECT id FROM agents WHERE tenant_id = $1 AND owner_user_id = $2",
            [principal.tenantId, principal.id],
          );
          authorizedAgentIds = agents.rows.map((agent) => agent.id);
        }
        const runs = await getDb().query(
          `SELECT id, agent_id, role, mission_id, model, steps_count, cost_usd, status,
                terminal_reason, started_at, completed_at
         FROM agent_runs WHERE tenant_id = $1
           AND ($2::uuid[] IS NULL OR agent_id = ANY($2::uuid[]))
         ORDER BY started_at DESC LIMIT $3 OFFSET $4`,
          [principal.tenantId, authorizedAgentIds, limit, offset],
        );
        res.status(200).json({
          runs: runs.rows,
          limit,
          offset,
          more: runs.rows.length === limit,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/agents/runs/:runId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { AgentRuntimeService } =
          await import("../modules/agent-runtime/agent-runtime.service.js");
        const runtimeService = new AgentRuntimeService(getDb());
        const principal = req.principal!;
        let authorizedAgentIds: string[] | undefined;
        if (principal.type === "agent") {
          authorizedAgentIds = [principal.id];
        } else if (principal.role === "buyer") {
          const agents = await getDb().query<{ id: string }>(
            "SELECT id FROM agents WHERE tenant_id = $1 AND owner_user_id = $2",
            [principal.tenantId, principal.id],
          );
          authorizedAgentIds = agents.rows.map((agent) => agent.id);
        }
        const trace = await runtimeService.getRunTrace(
          principal.tenantId,
          param(req.params.runId),
          authorizedAgentIds,
        );
        res.status(200).json(trace);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Events ───────────────────────────────────────────────────────────────
  app.get(
    "/v1/events",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(Number(req.query.limit) || 100, 100);
        const offset = Number(req.query.offset) || 0;
        const aggregateType = req.query.aggregate_type as string | undefined;
        const aggregateId = req.query.aggregate_id as string | undefined;

        let sql = `SELECT id, aggregate_type, aggregate_id, sequence, event_type,
                        actor_type, actor_id, correlation_id, amount, currency,
                        payload_hash, previous_hash, recorded_at
                 FROM economic_events
                 WHERE tenant_id = $1`;
        const params: unknown[] = [req.principal!.tenantId];

        if (aggregateType) {
          params.push(aggregateType);
          sql += ` AND aggregate_type = $${params.length}`;
        }
        if (aggregateId) {
          params.push(aggregateId);
          sql += ` AND aggregate_id = $${params.length}`;
        }
        params.push(limit, offset);
        sql += ` ORDER BY recorded_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

        const res2 = await getDb().query(sql, params);
        res.status(200).json({
          events: res2.rows,
          limit,
          offset,
          more: res2.rows.length === limit,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Policy Decisions ──────────────────────────────────────────────────────
  app.get(
    "/v1/policy/decisions",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(Number(req.query.limit) || 100, 100);
        const offset = Number(req.query.offset) || 0;
        const res2 = await getDb().query(
          `SELECT id, actor_id, action, resource_type, resource_id,
                policy_version_id, result, reason_codes, evaluated_at
         FROM policy_decisions WHERE tenant_id = $1
         ORDER BY evaluated_at DESC LIMIT $2 OFFSET $3`,
          [req.principal!.tenantId, limit, offset],
        );
        res.status(200).json({
          decisions: res2.rows,
          limit,
          offset,
          more: res2.rows.length === limit,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Holds ────────────────────────────────────────────────────────────────
  app.get(
    "/v1/holds",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(Number(req.query.limit) || 100, 100);
        const offset = Number(req.query.offset) || 0;
        const statusFilter = req.query.status as string | undefined;
        let sql = `SELECT id, scope_type, scope_id, reason, placed_by,
                        released_by, status, placed_at, released_at
                 FROM holds WHERE tenant_id = $1`;
        const params: unknown[] = [req.principal!.tenantId];
        if (statusFilter) {
          params.push(statusFilter);
          sql += ` AND status = $${params.length}`;
        }
        params.push(limit, offset);
        sql += ` ORDER BY placed_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
        const res2 = await getDb().query(sql, params);
        res.status(200).json({
          holds: res2.rows,
          limit,
          offset,
          more: res2.rows.length === limit,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Journal ──────────────────────────────────────────────────────────────
  app.get(
    "/v1/journal/transactions",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(Number(req.query.limit) || 100, 100);
        const offset = Number(req.query.offset) || 0;
        const res2 = await getDb().query(
          `SELECT jt.id, jt.source_event_id, jt.reference, jt.status, jt.effective_at,
                json_agg(json_build_object(
                  'id', jl.id, 'account_id', jl.account_id,
                  'debit', jl.debit, 'credit', jl.credit,
                  'currency', jl.currency, 'sequence', jl.sequence
                ) ORDER BY jl.sequence) AS lines
         FROM journal_transactions jt
         LEFT JOIN journal_lines jl ON jl.transaction_id = jt.id AND jl.tenant_id = jt.tenant_id
         WHERE jt.tenant_id = $1
         GROUP BY jt.id
         ORDER BY jt.effective_at DESC LIMIT $2 OFFSET $3`,
          [req.principal!.tenantId, limit, offset],
        );
        res.status(200).json({
          transactions: res2.rows,
          limit,
          offset,
          more: res2.rows.length === limit,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Aggregate Endpoints for Charts ───────────────────────────────────────
  app.get(
    "/v1/aggregates/obligations-by-status",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const res2 = await getDb().query(
          `SELECT status, COUNT(*) as count, COALESCE(SUM(amount), 0) as total_amount, currency
         FROM obligations WHERE tenant_id = $1 GROUP BY status, currency ORDER BY status`,
          [req.principal!.tenantId],
        );
        res.status(200).json({ data: res2.rows });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/aggregates/mission-spend",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const res2 = await getDb().query(
          `SELECT m.id, m.title, m.budget, m.reserved_budget, m.currency, m.status
         FROM missions m WHERE m.tenant_id = $1 ORDER BY m.created_at DESC LIMIT 100`,
          [req.principal!.tenantId],
        );
        res.status(200).json({ data: res2.rows });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/aggregates/event-volume",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const res2 = await getDb().query(
          `SELECT DATE_TRUNC('hour', recorded_at) as hour, event_type, COUNT(*) as count
         FROM economic_events WHERE tenant_id = $1
         AND recorded_at > now() - INTERVAL '7 days'
         GROUP BY hour, event_type ORDER BY hour DESC`,
          [req.principal!.tenantId],
        );
        res.status(200).json({ data: res2.rows });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/aggregates/capture-reconciliation",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const res2 = await getDb().query(
          `SELECT verdict, COUNT(*) as count, COALESCE(SUM(actual_amount), 0) as total_amount
         FROM reconciliation_records WHERE tenant_id = $1 GROUP BY verdict ORDER BY verdict`,
          [req.principal!.tenantId],
        );
        res.status(200).json({ data: res2.rows });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/aggregates/policy-denials",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const res2 = await getDb().query(
          `SELECT reason_codes, COUNT(*) as count
         FROM policy_decisions WHERE tenant_id = $1 AND result = 'deny'
         GROUP BY reason_codes ORDER BY count DESC LIMIT 20`,
          [req.principal!.tenantId],
        );
        res.status(200).json({ data: res2.rows });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Obligations ──────────────────────────────────────────────────────────
  app.get(
    "/v1/obligations",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { LedgerService } =
          await import("../modules/ledger/ledger.service.js");
        const ledgerService = new LedgerService(getDb());
        const status = req.query.status as string | undefined;
        const obligations = await ledgerService.listObligations(
          req.principal!.tenantId,
          status,
        );
        res.status(200).json({ obligations });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Settlement Batches (FR-016 & P0-15, P0-16) ───────────────────────────
  app.post(
    "/v1/settlement/batches",
    authMiddleware(),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { SettlementService } =
          await import("../modules/settlement/settlement.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const settlementService = new SettlementService(
          db,
          new EventsService(db),
        );
        const batch = await settlementService.proposeBatch({
          tenantId: req.principal!.tenantId,
          proposedBy: req.principal!.id,
          actorType: req.principal!.type,
          obligationIds: req.body.obligation_ids,
          correlationId: req.correlationId,
        });
        res.status(201).json(batch);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/settlement/batches",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { SettlementService } =
          await import("../modules/settlement/settlement.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const settlementService = new SettlementService(
          db,
          new EventsService(db),
        );
        const batches = await settlementService.listBatches(
          req.principal!.tenantId,
        );
        res.status(200).json({ batches });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/settlement/batches/:batchId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { SettlementService } =
          await import("../modules/settlement/settlement.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const settlementService = new SettlementService(
          db,
          new EventsService(db),
        );
        const batch = await settlementService.getBatch(
          req.principal!.tenantId,
          param(req.params.batchId),
        );
        res.status(200).json(batch);
      } catch (err) {
        next(err);
      }
    },
  );

  // Human-only batch approval (FR-017 & P0-16)
  app.post(
    "/v1/settlement/batches/:batchId/approve",
    authMiddleware(),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { SettlementService } =
          await import("../modules/settlement/settlement.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const settlementService = new SettlementService(
          db,
          new EventsService(db),
        );
        const batch = await settlementService.approveBatch({
          tenantId: req.principal!.tenantId,
          batchId: param(req.params.batchId),
          actorType: req.principal!.type,
          actorId: req.principal!.id,
          reason: req.body.reason,
          correlationId: req.correlationId,
        });
        res.status(200).json(batch);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/v1/settlement/batches/:batchId/reject",
    authMiddleware(),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { SettlementService } =
          await import("../modules/settlement/settlement.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const settlementService = new SettlementService(
          db,
          new EventsService(db),
        );
        const batch = await settlementService.rejectBatch({
          tenantId: req.principal!.tenantId,
          batchId: param(req.params.batchId),
          actorType: req.principal!.type,
          actorId: req.principal!.id,
          reason: req.body.reason || "Rejected by operator",
          correlationId: req.correlationId,
        });
        res.status(200).json(batch);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PayPal Orders v2 Sandbox Integration (FR-018 & P0-17, P0-18) ─────────
  app.post(
    "/v1/settlement/batches/:batchId/paypal/create-order",
    authMiddleware(),
    requireHumanPrincipal(),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { PayPalService } =
          await import("../modules/paypal/paypal.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const paypalService = new PayPalService(db, new EventsService(db));
        const order = await paypalService.createOrderForBatch({
          tenantId: req.principal!.tenantId,
          batchId: param(req.params.batchId),
          userId: req.principal!.id,
          returnOrigin: trustedConsoleOrigin(req),
          correlationId: req.correlationId,
        });
        res.status(201).json(order);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/v1/settlement/batches/:batchId/paypal/capture",
    authMiddleware(),
    requireHumanPrincipal(),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { PayPalService } =
          await import("../modules/paypal/paypal.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const paypalService = new PayPalService(db, new EventsService(db), deps?.gateway);
        const capture = await paypalService.captureOrder({
          tenantId: req.principal!.tenantId,
          orderId: req.body.order_id,
          userId: req.principal!.id,
          correlationId: req.correlationId,
        });
        res.status(200).json(capture);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PayPal Webhooks (P0-19) ───────────────────────────────────────────────
  app.post(
    "/v1/webhooks/paypal",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { PayPalService } =
          await import("../modules/paypal/paypal.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const paypalService = new PayPalService(
          db,
          new EventsService(db),
          deps?.gateway,
        );
        const result = await paypalService.handleWebhook({
          headers: req.headers as Record<string, string | undefined>,
          rawBody: JSON.stringify(req.body),
          payload: req.body,
        });
        if (!result.valid) {
          res.status(400).json({
            error: {
              code: "WEBHOOK_SIGNATURE_INVALID",
              message: "Signature verification failed.",
            },
          });
          return;
        }
        res.status(200).json({
          status: "success",
          duplicate: result.duplicate,
          event_id: result.event_id,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PayPal helpers: status, resume-payment lookup, buyer return/cancel redirects ──
  app.get(
    "/v1/paypal/status",
    authMiddleware(),
    (_req: Request, res: Response) => {
      res.status(200).json({
        ...payPalStatus(),
        orders: ordersCapability(),
        payouts: payoutsCapability(),
      });
    },
  );
  app.get(
    "/v1/settlement/batches/:batchId/payment",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const svc = new PayPalService(db, new EventsService(db));
        const payment = await svc.getBatchPayment(
          req.principal!.tenantId,
          param(req.params.batchId),
        );
        res.status(200).json({ payment });
      } catch (err) {
        next(err);
      }
    },
  );
  // ── Provider payouts (PayPal Payouts API, SPEC v2.1) ───────────────────────
  // Only a person manages recipients and payouts. Agents get 403 on all of these.
  const ownsProvider = async (req: Request, agentId: string) => {
    const principal = req.principal!;
    if (principal.role !== "buyer") return; // operators and supervisors act for the whole tenant
    const own = await getDb().query(
      "SELECT 1 FROM agents WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $3",
      [agentId, principal.tenantId, principal.id],
    );
    if (own.rows.length === 0) throw new NotFoundError("Agent", agentId);
  };
  app.put(
    "/v1/agents/:agentId/payout-account",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await ownsProvider(req, param(req.params.agentId));
        res.status(200).json(
          await new RecipientService(getDb()).setProfile({
            tenantId: req.principal!.tenantId,
            agentId: param(req.params.agentId),
            type: req.body?.recipient_type,
            value: req.body?.paypal_email,
            consent: req.body?.consent,
            userId: req.principal!.id,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );
  app.post(
    "/v1/agents/:agentId/payout-account/verify",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await ownsProvider(req, param(req.params.agentId));
        res.status(200).json(
          await new RecipientService(getDb()).verify({
            tenantId: req.principal!.tenantId,
            agentId: param(req.params.agentId),
            userId: req.principal!.id,
            confirmMasked: req.body?.confirm_masked,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );
  app.get(
    "/v1/agents/:agentId/payout-account",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await ownsProvider(req, param(req.params.agentId));
        res.status(200).json({
          recipient: await new RecipientService(getDb()).getMasked(
            req.principal!.tenantId,
            param(req.params.agentId),
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );
  app.get(
    "/v1/settlement/batches/:batchId/payouts",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(200).json({
          providers: await new PayoutService(getDb()).batchProviders(
            req.principal!.tenantId,
            param(req.params.batchId),
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );
  app.post(
    "/v1/settlement/batches/:batchId/payout-approval",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(201).json(
          await new PayoutService(getDb()).approve({
            tenantId: req.principal!.tenantId,
            batchId: param(req.params.batchId),
            userId: req.principal!.id,
            correlationId: req.correlationId,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );
  app.post(
    "/v1/settlement/batches/:batchId/payouts",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(200).json(
          await new PayoutService(getDb()).disburse({
            tenantId: req.principal!.tenantId,
            batchId: param(req.params.batchId),
            userId: req.principal!.id,
            approvalId: req.body?.approval_id,
            correlationId: req.correlationId,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );
  app.post(
    "/v1/payouts/:payoutId/refresh",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const db = getDb();
        const own = await db.query(
          "SELECT id FROM payouts WHERE id = $1 AND tenant_id = $2",
          [param(req.params.payoutId), req.principal!.tenantId],
        );
        if (own.rows.length === 0)
          throw new NotFoundError("Payout", param(req.params.payoutId));
        res.status(200).json({
          payout: await new PayoutService(db).sync(param(req.params.payoutId)),
        });
      } catch (err) {
        next(err);
      }
    },
  );
  // Treasury agent (real model call) plans settlement batches and the PayPal route for each.
  // It only proposes: people still approve each batch, release or collect, and approve payouts.
  app.post(
    "/v1/settlement/treasury-plan",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(200).json(
          await new TreasuryService(getDb()).plan({
            tenantId: req.principal!.tenantId,
            userId: req.principal!.id,
            correlationId: req.correlationId,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );
  app.get(
    "/v1/money-flow",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res
          .status(200)
          .json(
            await new MoneyFlowService(getDb()).list(req.principal!.tenantId),
          );
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Agreement funding (buyer pays through PayPal when a quote is accepted) ──
  app.get(
    "/v1/payments/due",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(200).json({
          payments: await new FundingService(getDb()).listDue(
            req.principal!.tenantId,
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );
  app.get(
    "/v1/agreements/:agreementId/payment",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(200).json({
          payment: await new FundingService(getDb()).getForAgreement(
            req.principal!.tenantId,
            param(req.params.agreementId),
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );
  app.post(
    "/v1/agreements/:agreementId/payment",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (
          (await getFundingMode(getDb(), req.principal!.tenantId)) === "wallet"
        ) {
          // Wallet mode: funded by the Reservation made at acceptance; no per-agreement PayPal order.
          res.status(200).json({ payment: null });
          return;
        }
        const payment = await new FundingService(getDb()).requestFunding({
          tenantId: req.principal!.tenantId,
          agreementId: param(req.params.agreementId),
          actorId: req.principal!.id,
          buyerUserAgent: req.headers["user-agent"],
          returnOrigin: trustedConsoleOrigin(req),
          correlationId: req.correlationId,
        });
        res.status(200).json({ payment });
      } catch (err) {
        next(err);
      }
    },
  );
  // Ask PayPal where a payment stands now (also captures it if the buyer has approved).
  app.post(
    "/v1/payments/:paymentId/refresh",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const db = getDb();
        const own = await db.query(
          "SELECT id FROM agreement_payments WHERE id = $1 AND tenant_id = $2",
          [param(req.params.paymentId), req.principal!.tenantId],
        );
        if (own.rows.length === 0)
          throw new NotFoundError("Payment", param(req.params.paymentId));
        res.status(200).json({
          payment: await new FundingService(db).syncPayment(
            param(req.params.paymentId),
            "console",
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );
  app.post(
    "/v1/agreements/:agreementId/refund",
    authMiddleware(["operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const reason =
          typeof req.body?.reason === "string"
            ? req.body.reason.slice(0, 200)
            : "";
        res.status(200).json({
          payment: await new FundingService(getDb()).refund({
            tenantId: req.principal!.tenantId,
            agreementId: param(req.params.agreementId),
            actorId: req.principal!.id,
            reason,
            correlationId: req.correlationId,
          }),
        });
      } catch (err) {
        next(err);
      }
    },
  );
  app.get(
    "/v1/admin/funding-mode",
    authMiddleware(["operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(200).json({
          funding_mode: await getFundingMode(getDb(), req.principal!.tenantId),
        });
      } catch (err) {
        next(err);
      }
    },
  );
  app.put(
    "/v1/admin/funding-mode",
    authMiddleware(["operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(200).json(
          await setFundingMode({
            tenantId: req.principal!.tenantId,
            mode: req.body?.funding_mode,
            actorId: req.principal!.id,
            correlationId: req.correlationId,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );
  app.post(
    "/v1/settlement/batches/:batchId/release-funded",
    authMiddleware(),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(200).json(
          await new FundingService(getDb()).releaseFundedBatch({
            tenantId: req.principal!.tenantId,
            batchId: param(req.params.batchId),
            userId: req.principal!.id,
            correlationId: req.correlationId,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // PayPal sends the buyer here after approval or cancel. For an agreement payment the return
  // also captures it (idempotent: webhook and sweep do the same), so the buyer never has to
  // press anything else. Then the buyer is handed back to the console.
  const consoleRedirect =
    (outcome: "return" | "cancel") => async (req: Request, res: Response) => {
      const token =
        typeof req.query.token === "string" &&
        /^[A-Za-z0-9_-]{5,64}$/.test(req.query.token)
          ? req.query.token
          : "";
      // Wallet deposits own their order first (R3.8). Redirect target is never request-supplied:
      // consoleReturnBase re-checks the origin remembered with the deposit.
      const depositRow = token
        ? (
            await getDb().query<{
              id: string;
              tenant_id: string;
              return_origin: string | null;
            }>(
              `SELECT id, tenant_id, return_origin FROM wallet_deposits WHERE paypal_order_id = $1`,
              [token],
            )
          ).rows[0]
        : undefined;
      if (token && depositRow) {
        const dq = new URLSearchParams();
        const dsvc = new DepositService({ gateway: deps?.gateway });
        const input = {
          orderId: token,
          tenantId: depositRow.tenant_id,
          correlationId: req.correlationId,
        };
        try {
          const v =
            outcome === "cancel"
              ? await dsvc.cancelByOrder(input)
              : await dsvc.captureByOrder({ ...input, source: "return" });
          if (v) {
            dq.set("wallet_deposit", v.id);
            dq.set("wallet_status", v.status);
          } else {
            dq.set("wallet_status", "error");
          }
        } catch {
          // Capture could not be completed now; the webhook and sweep finish it.
          dq.set("wallet_deposit", depositRow.id);
          dq.set("wallet_status", outcome === "cancel" ? "error" : "pending");
        }
        const dbase = consoleReturnBase(req, depositRow.return_origin);
        res.redirect(302, `${dbase}/?${dq.toString()}#/wallet`);
        return;
      }
      // Spending budget order: PayPal returns every order to PAYPAL_RETURN_URL, so budgets are
      // activated here (capture + reconcile in BudgetService). Webhook and sweep stay idempotent.
      const budgetRow = token
        ? (
            await getDb().query<{ id: string; return_origin: string | null }>(
              `SELECT id, return_origin FROM spending_budgets WHERE paypal_order_id = $1`,
              [token],
            )
          ).rows[0]
        : undefined;
      if (token && budgetRow) {
        const bq = new URLSearchParams();
        bq.set("budget_id", budgetRow.id);
        if (outcome === "cancel") {
          bq.set("budget_status", "pending_approval");
          bq.set("paypal", "cancel");
        } else {
          try {
            const v = await new BudgetService(getDb(), deps?.gateway).activateByOrder(
              token,
              "return",
            );
            bq.set("budget_status", v?.status ?? "pending_approval");
          } catch (err: any) {
            bq.set("budget_status", "pending_approval");
            bq.set("budget_error", String(err?.code ?? "activation_failed").slice(0, 60));
          }
        }
        res.redirect(
          302,
          `${consoleReturnBase(req, budgetRow.return_origin)}/?${bq.toString()}#/payments`,
        );
        return;
      }      // Settlement batch order: the buyer has approved it at PayPal, so capture it now
      // (PayPal's answer decides the result; webhook and the manual button stay idempotent).
      const batchTx = token
        ? (
            await getDb().query<{
              tenant_id: string;
              status: string;
              origin: string | null;
              created_by: string | null;
            }>(
              `SELECT tenant_id, status, metadata->>'return_origin' AS origin, metadata->>'created_by' AS created_by
                 FROM payment_transactions WHERE provider_order_id = $1`,
              [token],
            )
          ).rows[0]
        : undefined;
      if (token && batchTx) {
        const bq = new URLSearchParams();
        if (outcome === "cancel") {
          bq.set("paypal", "cancel");
          bq.set("paypal_order", token);
        } else {
          try {
            if (batchTx.status === "order_created" && batchTx.created_by) {
              const r = await new PayPalService(
                getDb(),
                new EventsService(getDb()),
                deps?.gateway,
              ).captureOrder({
                tenantId: batchTx.tenant_id,
                orderId: token,
                userId: batchTx.created_by,
                correlationId: req.correlationId,
              });
              bq.set("paypal", "captured");
              bq.set("paypal_status", r.status);
            } else {
              bq.set("paypal", batchTx.status === "order_created" ? "return" : "captured");
            }
          } catch (err: any) {
            bq.set("paypal", "return");
            bq.set(
              "paypal_error",
              String(err?.code ?? "CAPTURE_PENDING").slice(0, 60),
            );
          }
          bq.set("paypal_order", token);
        }
        res.redirect(
          302,
          `${consoleReturnBase(req, batchTx.origin)}/?${bq.toString()}#/settlement`,
        );
        return;
      }
      // Send the buyer back to the console they paid from, not a fixed address.
      const remembered = token
        ? (
            await getDb().query<{ o: string | null }>(
              `SELECT metadata->>'return_origin' AS o FROM agreement_payments WHERE provider_order_id = $1
           UNION ALL SELECT metadata->>'return_origin' FROM payment_transactions WHERE provider_order_id = $1 LIMIT 1`,
              [token],
            )
          ).rows[0]?.o
        : undefined;
      const base = consoleReturnBase(req, remembered);
      const q = new URLSearchParams();
      let hash = "#/settlement";
      if (token) {
        const funding = new FundingService(getDb(), deps?.gateway);
        if (await funding.ownsOrder(token)) {
          hash = "#/quotes";
          if (outcome === "cancel") {
            q.set("funding", "cancelled");
          } else {
            try {
              const v = await funding.captureByOrder(token, "return");
              q.set(
                "funding",
                v?.status === "captured"
                  ? "captured"
                  : v?.status === "mismatch"
                    ? "mismatch"
                    : "pending",
              );
            } catch (err: any) {
              q.set(
                "funding",
                err?.code === "PAYPAL_ORDER_NOT_APPROVED"
                  ? "not_approved"
                  : "pending",
              );
            }
          }
        } else {
          q.set("paypal", outcome);
          q.set("paypal_order", token);
        }
      } else {
        q.set("paypal", outcome);
      }
      res.redirect(302, `${base}/?${q.toString()}${hash}`);
    };
  app.get("/v1/paypal/return", consoleRedirect("return"));
  app.get("/v1/paypal/cancel", consoleRedirect("cancel"));

  // ── Reconciliation (P0-20) ────────────────────────────────────────────────
  app.get(
    "/v1/reconciliation",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { PayPalService } =
          await import("../modules/paypal/paypal.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const paypalService = new PayPalService(db, new EventsService(db));
        const records = await paypalService.listReconciliationRecords(
          req.principal!.tenantId,
        );
        res.status(200).json({ records });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Integrity Endpoint (FR-034 & P0-25) ──────────────────────────────────
  app.get(
    "/v1/integrity",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { IntegrityService } =
          await import("../modules/integrity/integrity.service.js");
        const integrityService = new IntegrityService(getDb());
        const report = await integrityService.computeIntegrity(
          req.principal!.tenantId,
        );
        res.status(200).json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── MCP JSON-RPC Endpoint (FR-031 & P0-21, P0-22) ────────────────────────
  app.post(
    "/v1/mcp",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { McpServer } = await import("../mcp/server.js");
        const mcpServer = new McpServer(getDb());
        const response = await mcpServer.handleRequest(
          req.body,
          req.principal!,
        );
        res.status(200).json(response);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Spending Budgets — pre-approved PayPal holds with micro-debit accounting ──
  // POST /v1/budgets — create a new spending budget (creates a real PayPal order)
  app.post(
    "/v1/budgets",
    authMiddleware(["buyer", "operator"]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const svc = new BudgetService(getDb(), deps?.gateway);
        const budget = await svc.createBudget({
          tenantId: p.tenantId,
          ownerId: p.id,
          ownerType: p.type,
          missionId: req.body?.mission_id ?? undefined,
          amount: String(req.body?.amount ?? ""),
          currency: req.body?.currency ?? "USD",
          returnOrigin: trustedConsoleOrigin(req),
          buyerUserAgent: req.headers["user-agent"],
          correlationId: req.correlationId,
        });
        res.status(201).json({ budget });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /v1/budgets — list budgets for current principal
  app.get(
    "/v1/budgets",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const svc = new BudgetService(getDb(), deps?.gateway);
        const listed = await svc.listBudgets(p.tenantId, {
          ownerId: req.query.owner_id
            ? String(req.query.owner_id)
            : p.role === "operator" || p.role === "supervisor"
              ? undefined
              : p.id,
          missionId: req.query.mission_id
            ? String(req.query.mission_id)
            : undefined,
          status: req.query.status ? String(req.query.status) : undefined,
        });
        const budgets = await overlayWalletStatus(getDb(), p.tenantId, listed);
        res.status(200).json({ budgets });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /v1/budgets/analytics — analytics for charts
  app.get(
    "/v1/budgets/analytics",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const svc = new BudgetService(getDb(), deps?.gateway);
        const analytics = await svc.getAnalytics(req.principal!.tenantId);
        res.status(200).json(analytics);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /v1/budgets/:budgetId — single budget
  app.get(
    "/v1/budgets/:budgetId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const svc = new BudgetService(getDb(), deps?.gateway);
        const found = await svc.getBudget(
          req.principal!.tenantId,
          param(req.params.budgetId),
        );
        const [budget] = await overlayWalletStatus(
          getDb(),
          req.principal!.tenantId,
          [found],
        );
        res.status(200).json({ budget });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /v1/budgets/:budgetId/debits — micro-payment debit log
  app.get(
    "/v1/budgets/:budgetId/debits",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const svc = new BudgetService(getDb(), deps?.gateway);
        const debits = await svc.getDebits(
          req.principal!.tenantId,
          param(req.params.budgetId),
        );
        res.status(200).json({ debits });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /v1/budgets/:budgetId/debit — DEPRECATED and money-inert (Money_Boundary).
  // Only the human Owner may call it; it never debits. Charges arise only from verified
  // obligations. Agents and non-owners are refused with one audit row; a body `amount` is invalid.
  app.post(
    "/v1/budgets/:budgetId/debit",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const budgetId = param(req.params.budgetId);
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const found = uuid.test(budgetId)
          ? await getDb().query<{ owner_id: string }>(
              `SELECT owner_id FROM spending_budgets WHERE id = $1 AND tenant_id = $2`,
              [budgetId, p.tenantId],
            )
          : { rows: [] as { owner_id: string }[] };
        const budget = found.rows[0];

        const reasons: string[] = [];
        if (p.type !== "user") reasons.push("agent_principal");
        else if (budget && budget.owner_id !== p.id)
          reasons.push("budget_not_owned");
        if (reasons.length > 0) {
          await recordRefusal(getDb(), {
            tenantId: p.tenantId,
            principal: { type: p.type, id: p.id, role: String(p.role) },
            operation: "budget.debit",
            reasons,
            resource: { type: "spending_budget", id: budgetId },
            correlationId: req.correlationId,
          });
          throw new ForbiddenActionError(
            p.type !== "user"
              ? "Agents cannot debit a budget. Charges arise only from verified obligations."
              : "This budget belongs to another user.",
          );
        }
        if (!budget) throw new NotFoundError("Budget");

        const body = req.body;
        if (
          body &&
          typeof body === "object" &&
          Object.prototype.hasOwnProperty.call(body, "amount")
        ) {
          throw new ValidationError(
            "A debit amount cannot be supplied. Charges arise only from verified obligations.",
            { field: "amount" },
          );
        }

        res.setHeader("Deprecation", "true");
        res.setHeader("Sunset", "Thu, 31 Dec 2026 23:59:59 GMT");
        res.status(200).json({
          deprecated: true,
          debited: false,
          message:
            "This endpoint is deprecated and debits nothing. Charges arise only from verified obligations.",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /v1/budgets/:budgetId/debit-advice — ask the LLM agent whether to proceed
  app.post(
    "/v1/budgets/:budgetId/debit-advice",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const agent = new BudgetAgent(getDb());
        const result = await agent.debitAdvice({
          tenantId: p.tenantId,
          budgetId: param(req.params.budgetId),
          requestedAmount: String(req.body?.amount ?? ""),
          reason: String(req.body?.reason ?? ""),
          correlationId: req.correlationId,
        });
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /v1/budgets/:budgetId/complete — mission completed; ask user to decide on remainder
  app.post(
    "/v1/budgets/:budgetId/complete",
    authMiddleware(["buyer", "operator"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const svc = new BudgetService(getDb(), deps?.gateway);
        const completeId = param(req.params.budgetId);
        const link = await walletBackedLink(getDb(), p.tenantId, completeId);
        let budget;
        if (link) {
          // Wallet-backed: the wallet module completes the mission; same status rule as legacy.
          const [current] = await overlayWalletStatus(getDb(), p.tenantId, [
            await svc.getBudget(p.tenantId, completeId),
          ]);
          if (current.status !== "active") {
            throw new StoatError(
              "BUDGET_INVALID_STATE",
              `Budget is '${current.status}'; only active budgets can be completed.`,
              422,
            );
          }
          await completeBudgetViaWallet(getDb(), {
            tenantId: p.tenantId,
            missionId: link.mission_id,
            principal: p,
            correlationId: req.correlationId,
          });
          [budget] = await overlayWalletStatus(getDb(), p.tenantId, [
            await svc.getBudget(p.tenantId, completeId),
          ]);
        } else {
          budget = await svc.completeMission({
            tenantId: p.tenantId,
            budgetId: completeId,
            actorId: p.id,
            correlationId: req.correlationId,
          });
        }
        // Immediately invoke the LLM agent to generate the remainder prompt
        let agentPrompt = null;
        try {
          const agent = new BudgetAgent(getDb());
          agentPrompt = await agent.remainderPrompt({
            tenantId: p.tenantId,
            budgetId: param(req.params.budgetId),
            missionTitle: req.body?.mission_title ?? undefined,
            correlationId: req.correlationId,
          });
        } catch {
          /* non-fatal: user can still decide manually */
        }
        res.status(200).json({ budget, agent_prompt: agentPrompt });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /v1/budgets/:budgetId/remainder-prompt — fetch LLM-generated prompt for remainder decision
  app.get(
    "/v1/budgets/:budgetId/remainder-prompt",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const agent = new BudgetAgent(getDb());
        const result = await agent.remainderPrompt({
          tenantId: p.tenantId,
          budgetId: param(req.params.budgetId),
          missionTitle: req.query.mission_title
            ? String(req.query.mission_title)
            : undefined,
          correlationId: req.correlationId,
        });
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /v1/budgets/:budgetId/decide — user decides: refund or retain remainder
  app.post(
    "/v1/budgets/:budgetId/decide",
    authMiddleware(["buyer", "operator"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const svc = new BudgetService(getDb(), deps?.gateway);
        const decideId = param(req.params.budgetId);
        const link = await walletBackedLink(getDb(), p.tenantId, decideId);
        if (link) {
          const decision = await decideBudgetViaWallet(getDb(), deps?.gateway, {
            tenantId: p.tenantId,
            budgetId: decideId,
            missionId: link.mission_id,
            principal: p,
            decision: req.body?.decision,
            note: req.body?.note ?? undefined,
            idempotencyKey:
              typeof req.headers["idempotency-key"] === "string"
                ? req.headers["idempotency-key"]
                : undefined,
            correlationId: req.correlationId,
          });
          const [budget] = await overlayWalletStatus(getDb(), p.tenantId, [
            await svc.getBudget(p.tenantId, decideId),
          ]);
          res.status(200).json({ budget, decision });
          return;
        }
        const result = await svc.decideRemainder({
          tenantId: p.tenantId,
          budgetId: decideId,
          decision: req.body?.decision,
          decidedBy: p.id,
          note: req.body?.note ?? undefined,
          correlationId: req.correlationId,
        });
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /v1/budgets/:budgetId/decision — fetch the recorded decision
  app.get(
    "/v1/budgets/:budgetId/decision",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const svc = new BudgetService(getDb(), deps?.gateway);
        const tenantId = req.principal!.tenantId;
        const decisionBudgetId = param(req.params.budgetId);
        const link = await walletBackedLink(
          getDb(),
          tenantId,
          decisionBudgetId,
        );
        const decision = link
          ? await getBudgetDecisionViaWallet(getDb(), deps?.gateway, {
              tenantId,
              budgetId: decisionBudgetId,
              missionId: link.mission_id,
            })
          : await svc.getDecision(tenantId, decisionBudgetId);
        res.status(200).json({ decision });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /v1/budgets/:budgetId/sync — a person asks Stoat to check PayPal for a pending budget.
  // Activates it only when PayPal reports the order APPROVED/COMPLETED (capture + reconcile).
  app.post(
    "/v1/budgets/:budgetId/sync",
    authMiddleware(["buyer", "operator"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const budget = await new BudgetService(getDb(), deps?.gateway).syncBudgetForTenant(
          req.principal!.tenantId,
          param(req.params.budgetId),
        );
        res.status(200).json({ budget });
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH /v1/budgets/:budgetId — edit a budget still waiting for PayPal approval.
  // A new PayPal order is created with the new terms and the old budget is retired.
  app.patch(
    "/v1/budgets/:budgetId",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = await new BudgetService(getDb(), deps?.gateway).editPendingBudget({
          tenantId: p.tenantId,
          budgetId: param(req.params.budgetId),
          actorId: p.id,
          actorRole: p.role,
          amount: String(body.amount ?? ""),
          currency: typeof body.currency === "string" ? body.currency.toUpperCase() : undefined,
          missionId:
            body.mission_id === undefined ? undefined : (body.mission_id as string | null) || null,
          returnOrigin: trustedConsoleOrigin(req),
          buyerUserAgent: req.headers["user-agent"],
          correlationId: req.correlationId,
        });
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /v1/budgets/:budgetId — clear a budget PayPal never approved. It is cancelled and
  // hidden from the list; its history stays. Refused if PayPal reports the order approved.
  app.delete(
    "/v1/budgets/:budgetId",
    authMiddleware(["buyer", "operator", "supervisor"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const budget = await new BudgetService(getDb(), deps?.gateway).deletePendingBudget({
          tenantId: p.tenantId,
          budgetId: param(req.params.budgetId),
          actorId: p.id,
          actorRole: p.role,
          correlationId: req.correlationId,
        });
        res.status(200).json({ budget, deleted: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /v1/budgets/:budgetId/cancel — cancel a pending (not yet active) budget
  app.post(
    "/v1/budgets/:budgetId/cancel",
    authMiddleware(["buyer", "operator"]),
    requireHumanPrincipal(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const svc = new BudgetService(getDb(), deps?.gateway);
        const budget = await svc.cancelBudget({
          tenantId: p.tenantId,
          budgetId: param(req.params.budgetId),
          actorId: p.id,
          correlationId: req.correlationId,
        });
        res.status(200).json({ budget });
      } catch (err) {
        next(err);
      }
    },
  );

  // PayPal return for budget approval (budget order token in query param)
  // The existing consoleRedirect handles generic PayPal returns; we extend it to also
  // activate any budget whose PayPal order matches the token.
  app.get("/v1/paypal/budget-return", async (req: Request, res: Response) => {
    const token =
      typeof req.query.token === "string" &&
      /^[A-Za-z0-9_-]{5,64}$/.test(req.query.token)
        ? req.query.token
        : "";
    const base = consoleReturnBase(req, undefined);
    const q = new URLSearchParams();
    if (token) {
      try {
        const result = await new BudgetService(
          getDb(),
          deps?.gateway,
        ).activateByOrder(token, "budget-return");
        if (result) {
          q.set("budget_id", result.id);
          q.set("budget_status", result.status);
        }
      } catch {
        q.set("budget_error", "activation_failed");
      }
    }
    res.redirect(302, `${base}/?${q.toString()}#/payments`);
  });

  // ── Payments AI Assistant (Fireworks AI) ──────────────────────────────────────
  // POST /v1/payments/ai-assist — natural-language payments queries answered by AI
  app.post(
    "/v1/payments/ai-assist",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const p = req.principal!;
        const svc = new PaymentsAssistService(getDb());
        const result = await svc.assist({
          tenantId: p.tenantId,
          principalId: p.id,
          principalRole: p.role ?? p.type,
          question: String(req.body?.question ?? ""),
          missionId: req.body?.mission_id ?? undefined,
          budgetId: req.body?.budget_id ?? undefined,
          conversationHistory: Array.isArray(req.body?.history)
            ? req.body.history
            : [],
        });
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  registerWalletRoutes(app, {
    gateway: deps?.gateway,
    advisorRuntime: deps?.advisorRuntime,
  });

  // Mount error handler
  app.use(errorHandler);

  return app;
}

import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { authMiddleware } from "../middleware/auth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { getDb } from "../db/connection.js";
import { ExchangeService } from "../modules/exchange/exchange.service.js";
import { MissionsService } from "../modules/missions/missions.service.js";
import { QuotesService } from "../modules/quotes/quotes.service.js";
import { AgreementsService } from "../modules/agreements/agreements.service.js";

// Helper: extract a single string from req.params (Express v5 types return string|string[])
function param(val: string | string[]): string {
  return Array.isArray(val) ? val[0] : val;
}

export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

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

  // ── Health & Readiness (FR-022) ──────────────────────────────────────────
  app.get("/v1/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", version: "2.0.0" });
  });

  // Legacy unversioned for backwards compatibility
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", version: "2.0.0" });
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
            res
              .status(404)
              .json({
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

  // ── Agents ───────────────────────────────────────────────────────────────
  app.get(
    "/v1/agents",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(Number(req.query.limit) || 100, 100);
        const offset = Number(req.query.offset) || 0;
        const res2 = await getDb().query(
          `SELECT id, tenant_id, role, name, status, scopes, created_at
         FROM agents WHERE tenant_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [req.principal!.tenantId, limit, offset],
        );
        res
          .status(200)
          .json({
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

  // ── Missions ─────────────────────────────────────────────────────────────
  app.post(
    "/v1/missions",
    authMiddleware(),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const missionsService = new MissionsService(getDb());
        const mission = await missionsService.createMission({
          tenantId: req.principal!.tenantId,
          buyerId: req.principal!.id,
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
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const missionsService = new MissionsService(getDb());
        const missions = await missionsService.listMissions(
          req.principal!.tenantId,
        );
        res.status(200).json({ missions });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/missions/:missionId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const missionsService = new MissionsService(getDb());
        const mission = await missionsService.getMission(
          req.principal!.tenantId,
          param(req.params.missionId),
        );
        res.status(200).json(mission);
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
          buyerId: req.principal!.id,
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
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const quotesService = new QuotesService(getDb());
        const quote = await quotesService.getQuote(
          req.principal!.tenantId,
          param(req.params.quoteId),
        );
        res.status(200).json(quote);
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
          buyerId: req.principal!.id,
          quoteId: param(req.params.quoteId),
          correlationId: req.correlationId,
        });
        res.status(200).json(agreement);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/agreements/:agreementId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agreementsService = new AgreementsService(getDb());
        const agreement = await agreementsService.getAgreement(
          req.principal!.tenantId,
          param(req.params.agreementId),
        );
        res.status(200).json(agreement);
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
        res
          .status(200)
          .json({
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
          buyerId: req.principal!.id,
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
        const runs = await getDb().query(
          `SELECT id, agent_id, role, mission_id, model, steps_count, cost_usd, status,
                terminal_reason, started_at, completed_at
         FROM agent_runs WHERE tenant_id = $1
         ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
          [req.principal!.tenantId, limit, offset],
        );
        res
          .status(200)
          .json({
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
        const trace = await runtimeService.getRunTrace(
          req.principal!.tenantId,
          param(req.params.runId),
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
        res
          .status(200)
          .json({
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
        res
          .status(200)
          .json({
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
        res
          .status(200)
          .json({
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
        res
          .status(200)
          .json({
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
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { PayPalService } =
          await import("../modules/paypal/paypal.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const paypalService = new PayPalService(db, new EventsService(db));
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
        const paypalService = new PayPalService(db, new EventsService(db));
        const result = await paypalService.handleWebhook({
          headers: req.headers as Record<string, string | undefined>,
          rawBody: JSON.stringify(req.body),
          payload: req.body,
        });
        if (!result.valid) {
          res
            .status(400)
            .json({
              error: {
                code: "WEBHOOK_SIGNATURE_INVALID",
                message: "Signature verification failed.",
              },
            });
          return;
        }
        res
          .status(200)
          .json({
            status: "success",
            duplicate: result.duplicate,
            event_id: result.event_id,
          });
      } catch (err) {
        next(err);
      }
    },
  );

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

  // ── Legacy unversioned routes (backwards compat for existing tests) ───────
  app.get(
    "/services",
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
    "/missions",
    authMiddleware(),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const missionsService = new MissionsService(getDb());
        const mission = await missionsService.createMission({
          tenantId: req.principal!.tenantId,
          buyerId: req.principal!.id,
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
    "/missions",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const missionsService = new MissionsService(getDb());
        const missions = await missionsService.listMissions(
          req.principal!.tenantId,
        );
        res.status(200).json({ missions });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/missions/:missionId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const missionsService = new MissionsService(getDb());
        const mission = await missionsService.getMission(
          req.principal!.tenantId,
          param(req.params.missionId),
        );
        res.status(200).json(mission);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/quotes",
    authMiddleware("buyer"),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const quotesService = new QuotesService(getDb());
        const quote = await quotesService.requestQuote({
          tenantId: req.principal!.tenantId,
          buyerId: req.principal!.id,
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
    "/quotes/:quoteId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const quotesService = new QuotesService(getDb());
        const quote = await quotesService.getQuote(
          req.principal!.tenantId,
          param(req.params.quoteId),
        );
        res.status(200).json(quote);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/quotes/:quoteId/accept",
    authMiddleware("buyer"),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agreementsService = new AgreementsService(getDb());
        const agreement = await agreementsService.acceptQuote({
          tenantId: req.principal!.tenantId,
          buyerId: req.principal!.id,
          quoteId: param(req.params.quoteId),
          correlationId: req.correlationId,
        });
        res.status(200).json(agreement);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/agreements/:agreementId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agreementsService = new AgreementsService(getDb());
        const agreement = await agreementsService.getAgreement(
          req.principal!.tenantId,
          param(req.params.agreementId),
        );
        res.status(200).json(agreement);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/artifacts",
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

  app.post(
    "/deliveries",
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
    "/deliveries/:deliveryId",
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
    "/deliveries/:deliveryId/revision",
    authMiddleware("buyer"),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { DeliveriesService } =
          await import("../modules/deliveries/deliveries.service.js");
        const deliveriesService = new DeliveriesService(getDb());
        const result = await deliveriesService.requestRevision({
          tenantId: req.principal!.tenantId,
          buyerId: req.principal!.id,
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

  app.get(
    "/agents/runs",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const runs = await getDb().query(
          `SELECT id, agent_id, role, mission_id, model, steps_count, cost_usd, status, started_at, completed_at
         FROM agent_runs WHERE tenant_id = $1 ORDER BY started_at DESC`,
          [req.principal!.tenantId],
        );
        res.status(200).json({ runs: runs.rows });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/agents/runs/:runId",
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { AgentRuntimeService } =
          await import("../modules/agent-runtime/agent-runtime.service.js");
        const runtimeService = new AgentRuntimeService(getDb());
        const trace = await runtimeService.getRunTrace(
          req.principal!.tenantId,
          param(req.params.runId),
        );
        res.status(200).json(trace);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/obligations",
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

  app.post(
    "/settlement/batches",
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
    "/settlement/batches",
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
    "/settlement/batches/:batchId",
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

  app.post(
    "/settlement/batches/:batchId/approve",
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
    "/settlement/batches/:batchId/reject",
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

  app.post(
    "/settlement/batches/:batchId/paypal/create-order",
    authMiddleware(),
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
          correlationId: req.correlationId,
        });
        res.status(201).json(order);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/settlement/batches/:batchId/paypal/capture",
    authMiddleware(),
    idempotencyMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { PayPalService } =
          await import("../modules/paypal/paypal.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const paypalService = new PayPalService(db, new EventsService(db));
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

  app.post(
    "/webhooks/paypal",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { PayPalService } =
          await import("../modules/paypal/paypal.service.js");
        const { EventsService } =
          await import("../modules/events/events.service.js");
        const db = getDb();
        const paypalService = new PayPalService(db, new EventsService(db));
        const result = await paypalService.handleWebhook({
          headers: req.headers as Record<string, string | undefined>,
          rawBody: JSON.stringify(req.body),
          payload: req.body,
        });
        if (!result.valid) {
          res
            .status(400)
            .json({
              error: {
                code: "WEBHOOK_SIGNATURE_INVALID",
                message: "Signature verification failed.",
              },
            });
          return;
        }
        res
          .status(200)
          .json({
            status: "success",
            duplicate: result.duplicate,
            event_id: result.event_id,
          });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/reconciliation",
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

  app.get(
    "/integrity",
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

  app.post(
    "/mcp",
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

  // Mount error handler
  app.use(errorHandler);

  return app;
}

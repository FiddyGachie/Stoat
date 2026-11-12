/**
 * Wallet routes (task 8.3) and `walletGuard`.
 *
 * Money boundary (AGENTS.md section 8): no agent reaches any wallet route. `walletGuard`
 * authenticates, refuses an agent_direct_request with 403 FORBIDDEN_ACTION and exactly one audit
 * row (all applicable reasons), then checks the human role. Ownership is decided from the
 * authenticated principal only; any wallet, owner or user ID in a body is ignored. A deposit in
 * another tenant answers like a missing one (404); one owned by someone else in the same tenant
 * answers 403 WALLET_NOT_OWNED with one audit row.
 *
 * Admins (operator, supervisor) read and refresh deposits tenant-wide. They have no route here
 * that reserves, charges or refunds for an Owner; the only Admin money path is the Admin refund
 * route (task 14.3). Server-side Reservation during quote acceptance does not use this guard.
 */
import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/connection.js";
import { authMiddleware } from "../../middleware/auth.js";
import {
  ForbiddenActionError,
  NotFoundError,
  StoatError,
  ValidationError,
} from "../../common/errors.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import type { PayPalGateway } from "../paypal/paypal.gateway.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { DepositService } from "./deposit.service.js";
import type { AgentRuntimeService } from "../agent-runtime/agent-runtime.service.js";
import { BudgetAdvisor } from "./budget-advisor.js";
import { recordRefusal } from "./wallet-events.js";
import {
  configuredEnvironment,
  getBalances,
  getOrCreateWallet,
  listWalletsForOwner,
} from "./wallet.service.js";
import { walletCurrencies } from "./wallet-config.js";
import { getFundingMode } from "./funding-mode.js";
import {
  adminWallets,
  businessAccount,
  decodeOffset,
  encodeOffset,
  trialBalance,
  userAccount,
  walletStatement,
} from "./wallet-reads.service.js";
import {
  safe,
  serializeAdminWallet,
  serializeAnalyticsRow,
  serializeReconciliationException,
  serializeReconciliationRun,
  serializeBusinessAccount,
  serializeStatement,
  serializeTrialBalance,
  serializeUserAccount,
  serializeDecision,
  serializeDeposit,
  serializeEconomicEvent,
  serializeMissionWallet,
  serializeNotification,
  serializeRefund,
  serializeWallet,
} from "./wallet-serializers.js";
import {
  exportDatasetCsvText,
  isAnalyticsChart,
  isAnalyticsDataset,
  queryChart,
  queryDataset,
  type AnalyticsScope,
} from "./analytics.service.js";
import * as notifications from "./notification.service.js";
import { RefundService } from "./refund.service.js";
import {
  ReconciliationService,
  getRun,
  listExceptions,
  listRuns,
} from "./reconciliation.service.js";
import {
  completeMission,
  getMissionWalletView,
} from "./mission-completion.service.js";

const HUMAN_ROLES = ["buyer", "operator", "supervisor"] as const;
const ADMIN_ROLES = new Set(["operator", "supervisor"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WalletRouteDeps {
  gateway?: PayPalGateway;
  /** Test seam: a runtime whose model transport is a test double. Product code passes nothing. */
  advisorRuntime?: AgentRuntimeService;
}

export const isAdminPrincipal = (p: AuthenticatedPrincipal): boolean =>
  p.type === "user" && ADMIN_ROLES.has(String(p.role));

export interface WalletGuardOptions {
  /** Human roles allowed on this route. Default: buyer, operator, supervisor. */
  roles?: readonly string[];
  /**
   * Target wallet of the request when it can be named before the handler runs. Used only to add
   * the `wallet_not_owned` reason (and the target ID) to an agent refusal. Never throws.
   */
  resolveTarget?: (
    req: Request,
    principal: AuthenticatedPrincipal,
  ) => Promise<{ walletId: string; ownerId: string } | null>;
}

const corr = (req: Request): string | undefined =>
  req.correlationId && UUID_RE.test(req.correlationId)
    ? req.correlationId
    : undefined;

/**
 * Authenticate, refuse agents, check the human role. Each refusal writes exactly one audit row.
 * recordRefusal runs here, outside any transaction.
 */
export function walletGuard(
  operation: string,
  options: WalletGuardOptions = {},
): RequestHandler {
  const roles = options.roles ?? HUMAN_ROLES;
  const authenticate = authMiddleware();
  return (req: Request, res: Response, next: NextFunction): void => {
    authenticate(req, res, (err?: unknown) => {
      if (err) return next(err);
      const principal = req.principal;
      if (!principal) return next(new ForbiddenActionError());
      void (async () => {
        const reasons: string[] = [];
        let walletId: string | null = null;
        if (principal.type !== "user") reasons.push("agent_principal");
        else if (!roles.includes(String(principal.role)))
          reasons.push("role_not_allowed");
        if (reasons.length > 0) {
          if (options.resolveTarget) {
            try {
              const t = await options.resolveTarget(req, principal);
              if (t) {
                walletId = t.walletId;
                if (t.ownerId !== principal.id)
                  reasons.push("wallet_not_owned");
              }
            } catch {
              // Target lookup is best effort; the refusal stands without it.
            }
          }
          await recordRefusal(getDb(), {
            tenantId: principal.tenantId,
            principal: {
              type: principal.type,
              id: principal.id,
              role: String(principal.role),
            },
            operation,
            walletId,
            reasons,
            correlationId: corr(req),
          });
          throw new ForbiddenActionError(
            principal.type !== "user"
              ? "Agents cannot use wallet operations. A person must perform this action."
              : `Role '${principal.role}' is not authorized for this wallet operation.`,
          );
        }
        next();
      })().catch(next);
    });
  };
}

/** Deposit of the same tenant as the principal, or null (cross-tenant looks missing). */
async function findDepositInTenant(
  tenantId: string,
  id: string,
): Promise<any | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await getDb().query(
    `SELECT d.*, w.owner_user_id AS wallet_owner_id
       FROM wallet_deposits d JOIN wallets w ON w.id = d.wallet_id
      WHERE d.id = $1 AND d.tenant_id = $2`,
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}

const depositTarget: WalletGuardOptions["resolveTarget"] = async (req, p) => {
  const row = await findDepositInTenant(
    p.tenantId,
    String(req.params.id ?? ""),
  );
  return row ? { walletId: row.wallet_id, ownerId: row.wallet_owner_id } : null;
};

/**
 * Ownership by principal only. Admins may read and refresh deposits of their tenant when
 * `allowAdmin`; everyone else must own the wallet. Refusal writes one audit row.
 */
async function loadDeposit(
  req: Request,
  principal: AuthenticatedPrincipal,
  operation: string,
  allowAdmin: boolean,
): Promise<any> {
  const row = await findDepositInTenant(
    principal.tenantId,
    String(req.params.id ?? ""),
  );
  if (!row) throw new NotFoundError("Deposit");
  if (
    row.wallet_owner_id !== principal.id &&
    !(allowAdmin && isAdminPrincipal(principal))
  ) {
    await recordRefusal(getDb(), {
      tenantId: principal.tenantId,
      principal: {
        type: "user",
        id: principal.id,
        role: String(principal.role),
      },
      operation,
      walletId: row.wallet_id,
      reasons: ["wallet_not_owned"],
      correlationId: corr(req),
    });
    throw new StoatError(
      "WALLET_NOT_OWNED",
      "This wallet belongs to another user.",
      403,
    );
  }
  return row;
}

/**
 * Mission of the principal's tenant. Missing or cross-tenant: 404. Same tenant but another
 * Owner: 403 WALLET_NOT_OWNED with one audit row (Admins may read when `allowAdmin`).
 */
async function loadMission(
  req: Request,
  principal: AuthenticatedPrincipal,
  operation: string,
  allowAdmin: boolean,
) {
  const id = String(req.params.id ?? "");
  const v = UUID_RE.test(id)
    ? await getMissionWalletView(getDb(), {
        tenantId: principal.tenantId,
        missionId: id,
      })
    : null;
  if (!v) throw new NotFoundError("Mission");
  if (
    v.owner_user_id !== principal.id &&
    !(allowAdmin && isAdminPrincipal(principal))
  ) {
    await recordRefusal(getDb(), {
      tenantId: principal.tenantId,
      principal: {
        type: "user",
        id: principal.id,
        role: String(principal.role),
      },
      operation,
      walletId: null,
      reasons: ["wallet_not_owned"],
      correlationId: corr(req),
    });
    throw new StoatError(
      "WALLET_NOT_OWNED",
      "This mission belongs to another user.",
      403,
    );
  }
  return v;
}

// Explicit allowlist serializer (wallet-serializers.ts): no recipient, payee or payment-source
// field exists in any wallet response.
const walletView = async (w: any, tenantId: string) => {
  const [balances, mode] = await Promise.all([
    getBalances(getDb(), w.id),
    getFundingMode(getDb(), tenantId),
  ]);
  return serializeWallet(w, balances, mode);
};
const handler =
  (
    fn: (
      req: Request,
      res: Response,
      principal: AuthenticatedPrincipal,
    ) => Promise<void>,
  ): RequestHandler =>
  (req, res, next) => {
    fn(req, res, req.principal as AuthenticatedPrincipal).catch(next);
  };

export function registerWalletRoutes(
  app: Express,
  deps: WalletRouteDeps = {},
): void {
  const deposits = new DepositService({ gateway: deps.gateway });

  app.get(
    "/v1/wallet",
    walletGuard("wallet.read"),
    handler(async (_req, res, p) => {
      const wallets = await listWalletsForOwner(getDb(), {
        tenantId: p.tenantId,
        ownerUserId: p.id,
      });
      const views = await Promise.all(
        wallets.map((w) => walletView(w, p.tenantId)),
      );
      res.status(200).json({
        funding_mode: await getFundingMode(getDb(), p.tenantId),
        paypal_environment: configuredEnvironment(),
        supported_currencies: walletCurrencies(),
        wallets: views,
      });
    }),
  );

  // Create (or return) the signed-in person's wallet for one supported currency.
  // Idempotent: one wallet per (tenant, owner, currency, environment). No money moves.
  app.post(
    "/v1/wallet",
    walletGuard("wallet.create"),
    handler(async (req, res, p) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const currency =
        typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
      if (!walletCurrencies().includes(currency)) {
        throw new ValidationError("This currency is not supported for wallets.", {
          field: "currency",
          supported: walletCurrencies(),
        });
      }
      const wallet = await getOrCreateWallet(getDb(), {
        tenantId: p.tenantId,
        ownerUserId: p.id,
        currency,
      });
      res.status(201).json(await walletView(wallet, p.tenantId));
    }),
  );

  app.post(
    "/v1/wallet/deposits",
    walletGuard("wallet.deposit.create"),
    handler(async (req, res, p) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const key = req.headers["idempotency-key"];
      // Body identity (wallet_id, owner_id, user_id, tenant_id) is ignored; the principal decides.
      const view = await deposits.createDeposit({
        tenantId: p.tenantId,
        owner: p,
        amount: body.amount,
        currency: body.currency,
        missionId: (body.mission_id as string | null | undefined) ?? null,
        idempotencyKey: Array.isArray(key) ? key[0] : key,
        buyerUserAgent: req.headers["user-agent"],
        correlationId: corr(req) ?? randomUUID(),
        // The service rejects payee-like keys; pass them through so that check sees them.
        ...Object.fromEntries(
          Object.entries(body).filter(([k]) =>
            /payee|recipient|payment[_-]?source|receiver/i.test(k),
          ),
        ),
      });
      res.status(201).json(serializeDeposit(view));
    }),
  );

  // ── Missions (task 12.2) ───────────────────────────────────────────────────
  app.get(
    "/v1/wallet/missions",
    walletGuard("wallet.mission.list"),
    handler(async (_req, res, p) => {
      const admin = isAdminPrincipal(p);
      const r = await getDb().query<{ id: string }>(
        admin
          ? `SELECT m.id FROM missions m WHERE m.tenant_id = $1 AND m.status <> 'deleted' ORDER BY m.created_at DESC, m.id LIMIT 100`
          : `SELECT m.id FROM missions m JOIN agents a ON a.id = m.buyer_id
              WHERE m.tenant_id = $1 AND a.owner_user_id = $2 AND m.status <> 'deleted'
              ORDER BY m.created_at DESC, m.id LIMIT 100`,
        admin ? [p.tenantId] : [p.tenantId, p.id],
      );
      // Read-only views, built concurrently; Promise.all keeps the original order.
      const loaded = await Promise.all(
        r.rows.map((row) =>
          getMissionWalletView(getDb(), { tenantId: p.tenantId, missionId: row.id }),
        ),
      );
      const views = loaded.filter((v) => v !== null).map((v) => serializeMissionWallet(v!));
      res.status(200).json({ missions: views });
    }),
  );

  app.get(
    "/v1/wallet/missions/:id",
    walletGuard("wallet.mission.read"),
    handler(async (req, res, p) => {
      const v = await loadMission(req, p, "wallet.mission.read", true);
      res.status(200).json(serializeMissionWallet(v));
    }),
  );

  app.post(
    "/v1/wallet/missions/:id/complete",
    walletGuard("wallet.mission.complete"),
    handler(async (req, res, p) => {
      const v = await loadMission(req, p, "wallet.mission.complete", false);
      await completeMission(getDb(), {
        tenantId: p.tenantId,
        missionId: v.mission_id,
        actor: { type: "owner", userId: p.id },
        correlationId: corr(req),
      });
      const after = await getMissionWalletView(getDb(), {
        tenantId: p.tenantId,
        missionId: v.mission_id,
      });
      res.status(200).json(serializeMissionWallet(after));
    }),
  );

  // Budget_Advisor text (task 19.1). Display only: the response carries server figures beside the
  // text and nothing here moves money. Owner only; no model key or invalid output yields fixed
  // text labelled not AI-generated.
  app.get(
    "/v1/wallet/missions/:id/remainder-prompt",
    walletGuard("wallet.remainder.prompt"),
    handler(async (req, res, p) => {
      const v = await loadMission(req, p, "wallet.remainder.prompt", false);
      if (v.state !== "awaiting_decision") {
        throw new StoatError(
          "MISSION_NOT_AWAITING_DECISION",
          "The mission has no remainder waiting for a decision.",
          409,
        );
      }
      const result = await new BudgetAdvisor(
        getDb(),
        deps.advisorRuntime,
      ).adviseOrFallback({
        tenantId: p.tenantId,
        purpose: "remainder_prompt",
        view: v,
      });
      res.status(200).json({
        mission_id: v.mission_id,
        paypal_environment: configuredEnvironment(),
        figures: {
          currency: v.currency,
          budget: v.budget,
          available: v.available,
          charged: v.charged,
          reserved: v.reserved,
          shortfall: v.shortfall,
          state: v.state,
        },
        advice: result.advice,
        ai_generated: result.ai_generated,
        label: result.label,
        fallback_reason: result.fallback_reason,
        run_id: result.run_id,
        model: result.model,
        mode: result.mode,
        replayed: result.replayed,
        schema_version: result.schema_version,
        display_only: true,
      });
    }),
  );

  app.post(
    "/v1/wallet/missions/:id/top-up",
    walletGuard("wallet.mission.top_up"),
    handler(async (req, res, p) => {
      const v = await loadMission(req, p, "wallet.mission.top_up", false);
      if (v.mission_status === "completed") {
        throw new StoatError(
          "MISSION_NOT_OPEN",
          "The mission is complete and cannot be topped up.",
          409,
        );
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const key = req.headers["idempotency-key"];
      // Currency defaults to the mission (wallet) currency; a different one fails validation.
      const currency = body.currency === undefined ? v.currency : body.currency;
      if (
        typeof currency !== "string" ||
        currency.toUpperCase() !== v.currency
      ) {
        throw new ValidationError(
          "The top-up currency must match the wallet currency.",
          {
            field: "currency",
          },
        );
      }
      const view = await deposits.createDeposit({
        tenantId: p.tenantId,
        owner: p,
        amount: body.amount,
        currency: v.currency,
        missionId: v.mission_id,
        idempotencyKey: Array.isArray(key) ? key[0] : key,
        buyerUserAgent: req.headers["user-agent"],
        correlationId: corr(req) ?? randomUUID(),
        // Set here on the server, never read from the body.
        isTopUp: true,
        ...Object.fromEntries(
          Object.entries(body).filter(([k]) =>
            /payee|recipient|payment[_-]?source|receiver/i.test(k),
          ),
        ),
      });
      res.status(201).json(serializeDeposit(view));
    }),
  );

  // ── Refunds (task 14.3) ────────────────────────────────────────────────────
  // No wallet, owner or payee in a body is read: the principal and the URL decide. Amounts are
  // validated by RefundService. Every money POST needs an Idempotency-Key.
  const refunds = new RefundService({ gateway: deps.gateway });
  const requireKey = (req: Request): string => {
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (typeof key !== "string" || key.length < 1 || key.length > 200) {
      throw new ValidationError(
        "An Idempotency-Key of 1 to 200 characters is required.",
        { field: "idempotency_key" },
      );
    }
    return key;
  };
  const refundResponse = async (tenantId: string, refundId: string) => {
    const view = await refunds.getRefund(tenantId, refundId);
    const row = (
      await getDb().query(`SELECT * FROM wallet_refunds WHERE id = $1`, [
        refundId,
      ])
    ).rows[0];
    return serializeRefund({ ...row, items: view.items });
  };
  const walletTarget: WalletGuardOptions["resolveTarget"] = async (req, p) => {
    const id = String(req.params.walletId ?? "");
    if (!UUID_RE.test(id)) return null;
    const r = await getDb().query(
      `SELECT id, owner_user_id FROM wallets WHERE id = $1 AND tenant_id = $2`,
      [id, p.tenantId],
    );
    return r.rows[0]
      ? { walletId: r.rows[0].id, ownerId: r.rows[0].owner_user_id }
      : null;
  };
  const refundTarget: WalletGuardOptions["resolveTarget"] = async (req, p) => {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return null;
    const r = await getDb().query(
      `SELECT r.wallet_id, w.owner_user_id FROM wallet_refunds r
         JOIN wallets w ON w.id = r.wallet_id
        WHERE r.id = $1 AND r.tenant_id = $2`,
      [id, p.tenantId],
    );
    return r.rows[0]
      ? { walletId: r.rows[0].wallet_id, ownerId: r.rows[0].owner_user_id }
      : null;
  };

  app.post(
    "/v1/wallet/missions/:id/remainder-decision",
    walletGuard("wallet.remainder.decide"),
    handler(async (req, res, p) => {
      const id = String(req.params.id ?? "");
      if (!UUID_RE.test(id)) throw new NotFoundError("Mission");
      const key = requireKey(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const d = await refunds.decideRemainder({
        tenantId: p.tenantId,
        owner: p,
        missionId: id,
        decision: body.decision as "refund" | "keep",
        amount: body.amount,
        idempotencyKey: key,
        correlationId: corr(req),
      });
      const row = (
        await getDb().query(`SELECT * FROM remainder_decisions WHERE id = $1`, [
          d.id,
        ])
      ).rows[0];
      res
        .status(200)
        .json(
          serializeDecision(
            row,
            d.refund ? await refundResponse(p.tenantId, d.refund.id) : null,
          ),
        );
    }),
  );

  app.post(
    "/v1/wallet/refunds",
    walletGuard("wallet.refund.create"),
    handler(async (req, res, p) => {
      const key = requireKey(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // The wallet is the principal's own, picked by currency; a wallet ID in the body is ignored.
      const wallets = await listWalletsForOwner(getDb(), {
        tenantId: p.tenantId,
        ownerUserId: p.id,
      });
      const wanted =
        typeof body.currency === "string" ? body.currency.toUpperCase() : null;
      const pool = wanted
        ? wallets.filter(
            (w: any) => String(w.currency).toUpperCase() === wanted,
          )
        : wallets;
      if (pool.length === 0) throw new NotFoundError("Wallet");
      if (pool.length > 1) {
        throw new ValidationError(
          "Name the currency of the wallet to refund.",
          {
            field: "currency",
          },
        );
      }
      const view = await refunds.refundUnlinked({
        tenantId: p.tenantId,
        owner: p,
        walletId: pool[0].id,
        amount: body.amount,
        idempotencyKey: key,
        correlationId: corr(req),
      });
      res.status(201).json(await refundResponse(p.tenantId, view.id));
    }),
  );

  app.post(
    "/v1/wallet/refunds/:id/retry",
    walletGuard("wallet.refund.retry", { resolveTarget: refundTarget }),
    handler(async (req, res, p) => {
      const id = String(req.params.id ?? "");
      if (!UUID_RE.test(id)) throw new NotFoundError("Refund");
      requireKey(req);
      const view = await refunds.retryFailed({
        tenantId: p.tenantId,
        actor: p,
        refundId: id,
        correlationId: corr(req),
      });
      res.status(200).json(await refundResponse(p.tenantId, view.id));
    }),
  );

  app.get(
    "/v1/wallet/refunds",
    walletGuard("wallet.refund.list"),
    handler(async (_req, res, p) => {
      const admin = isAdminPrincipal(p);
      const r = await getDb().query<{ id: string }>(
        admin
          ? `SELECT id FROM wallet_refunds WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 100`
          : `SELECT r.id FROM wallet_refunds r JOIN wallets w ON w.id = r.wallet_id
              WHERE r.tenant_id = $1 AND w.owner_user_id = $2
              ORDER BY r.created_at DESC, r.id LIMIT 100`,
        admin ? [p.tenantId] : [p.tenantId, p.id],
      );
      const out = [];
      for (const row of r.rows)
        out.push(await refundResponse(p.tenantId, row.id));
      res.status(200).json({
        paypal_environment: configuredEnvironment(),
        refunds: out,
      });
    }),
  );

  app.get(
    "/v1/wallet/refunds/:id",
    walletGuard("wallet.refund.read", { resolveTarget: refundTarget }),
    handler(async (req, res, p) => {
      const id = String(req.params.id ?? "");
      const t = UUID_RE.test(id) ? await refundTarget(req, p) : null;
      if (!t) throw new NotFoundError("Refund");
      if (t.ownerId !== p.id && !isAdminPrincipal(p)) {
        await recordRefusal(getDb(), {
          tenantId: p.tenantId,
          principal: { type: "user", id: p.id, role: String(p.role) },
          operation: "wallet.refund.read",
          walletId: t.walletId,
          reasons: ["wallet_not_owned"],
          correlationId: corr(req),
        });
        throw new StoatError(
          "WALLET_NOT_OWNED",
          "This wallet belongs to another user.",
          403,
        );
      }
      res.status(200).json(await refundResponse(p.tenantId, id));
    }),
  );

  // The only Admin money path (R12.8, R12.9): human operator or supervisor, stated reason.
  app.post(
    "/v1/admin/wallets/:walletId/refunds",
    walletGuard("wallet.refund.admin", {
      roles: ["operator", "supervisor"],
      resolveTarget: walletTarget,
    }),
    handler(async (req, res, p) => {
      const id = String(req.params.walletId ?? "");
      if (!UUID_RE.test(id)) throw new NotFoundError("Wallet");
      const key = requireKey(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const view = await refunds.adminRefund({
        tenantId: p.tenantId,
        admin: p,
        walletId: id,
        amount: body.amount,
        reason: body.reason,
        idempotencyKey: key,
        correlationId: corr(req),
      });
      res.status(201).json(await refundResponse(p.tenantId, view.id));
    }),
  );

  // ── Admin reversing entry (task 16.2; R9.11, R9.16) ───────────────────────
  // Human operator or supervisor only (walletGuard refuses agents with one audit row), reason
  // required. The ledger swaps every line of the original and re-runs the wallet balance check,
  // which lifts a balance_mismatch block (and appends WALLET_BLOCK_LIFTED) when derived equals
  // stored. The amount is never taken from the request.
  app.post(
    "/v1/admin/journal/transactions/:id/reverse",
    walletGuard("wallet.admin.journal_reverse", {
      roles: ["operator", "supervisor"],
    }),
    handler(async (req, res, p) => {
      const id = String(req.params.id ?? "");
      if (!UUID_RE.test(id)) throw new NotFoundError("JournalTransaction");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length < 1 || reason.length > 500) {
        throw new ValidationError(
          "A reversing entry needs a reason of 1 to 500 characters.",
          { field: "reason" },
        );
      }
      const db = getDb();
      const wallets = await db.query<{ wallet_id: string; status: string }>(
        `SELECT DISTINCT l.wallet_id, w.status
           FROM journal_lines l JOIN wallets w ON w.id = l.wallet_id
          WHERE l.tenant_id = $1 AND l.transaction_id = $2`,
        [p.tenantId, id],
      );
      const correlationId = corr(req) ?? randomUUID();
      const result = await new LedgerService(db).reverseJournalTransaction({
        tenantId: p.tenantId,
        transactionId: id,
        reason,
        actorId: p.id,
        correlationId,
      });
      const walletIds = wallets.rows.map((w) => w.wallet_id);
      const after = walletIds.length
        ? await db.query<{ id: string; status: string }>(
            `SELECT id, status FROM wallets WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
            [p.tenantId, walletIds],
          )
        : { rows: [] as { id: string; status: string }[] };
      const lifted = wallets.rows
        .filter(
          (w) =>
            w.status === "blocked" &&
            after.rows.find((a) => a.id === w.wallet_id)?.status === "active",
        )
        .map((w) => w.wallet_id);
      await db.query(
        `INSERT INTO audit_logs (
           tenant_id, actor_type, actor_id, action, resource_type, resource_id,
           correlation_id, outcome, reason, metadata
         ) VALUES ($1, 'user', $2, 'admin.journal.reverse', 'journal_transaction', $3, $4, 'success', $5, $6)`,
        [
          p.tenantId,
          p.id,
          id,
          correlationId,
          reason,
          JSON.stringify({
            reversal_transaction_id: result.reversalTransaction.id,
            wallet_ids: walletIds,
            blocks_lifted: lifted,
          }),
        ],
      );
      res.status(201).json({
        original_transaction_id: id,
        reversal_transaction_id: result.reversalTransaction.id,
        wallets: after.rows.map((a) => ({
          wallet_id: a.id,
          status: a.status,
          block_lifted: lifted.includes(a.id),
        })),
      });
    }),
  );

  // ── Notifications (task 15.1; R7.17, R7.18, R13.7, R13.10) ─────────────────
  // Recipient only: every query is keyed by the principal's ID. Agents are refused by walletGuard
  // with one audit row. A notification of someone else (or a missing one) answers 404 with no
  // content, so existence is not disclosed.
  app.get(
    "/v1/notifications",
    walletGuard("wallet.notification.list"),
    handler(async (req, res, p) => {
      const raw = req.query.cursor;
      if (raw !== undefined && (typeof raw !== "string" || raw.length > 500)) {
        throw new ValidationError("Invalid cursor.", { field: "cursor" });
      }
      const page = await notifications.list(getDb(), p.id, {
        cursor: raw === undefined || raw === "" ? null : raw,
      });
      res.status(200).json({
        notifications: page.items.map(serializeNotification),
        next_cursor: page.next_cursor,
      });
    }),
  );

  app.get(
    "/v1/notifications/unread-count",
    walletGuard("wallet.notification.unread_count"),
    handler(async (_req, res, p) => {
      res
        .status(200)
        .json({ unread_count: await notifications.unreadCount(getDb(), p.id) });
    }),
  );

  app.post(
    "/v1/notifications/:id/read",
    walletGuard("wallet.notification.read"),
    handler(async (req, res, p) => {
      const id = String(req.params.id ?? "");
      if (!UUID_RE.test(id)) throw new NotFoundError("Notification");
      const view = await notifications.markRead(getDb(), p.id, id);
      res.status(200).json({
        notification: serializeNotification(view),
        unread_count: await notifications.unreadCount(getDb(), p.id),
      });
    }),
  );

  // ── Economic_Event history (task 15.2; R19.5, R19.6, R19.7) ────────────────
  // Owner of the entity, or an Admin of the same tenant. Ascending, 100 per page. A caller who is
  // neither gets one generic 403 and one audit row, identical for a missing, cross-tenant or
  // foreign entity, so nothing says whether the target exists.
  app.get(
    "/v1/wallet/events",
    walletGuard("wallet.events.read"),
    handler(async (req, res, p) => {
      const rawType = req.query.entity_type;
      const rawId = req.query.entity_id;
      const rawCursor = req.query.cursor;
      const type =
        rawType === "deposit" ? "wallet_deposit" : (rawType as string);
      if (
        typeof type !== "string" ||
        !["wallet", "wallet_deposit", "mission"].includes(type)
      ) {
        throw new ValidationError(
          "entity_type must be wallet, wallet_deposit or mission.",
          { field: "entity_type" },
        );
      }
      if (typeof rawId !== "string" || !UUID_RE.test(rawId)) {
        throw new ValidationError("entity_id must be a UUID.", {
          field: "entity_id",
        });
      }
      let after = 0;
      if (rawCursor !== undefined && rawCursor !== "") {
        const text =
          typeof rawCursor === "string" &&
          /^[A-Za-z0-9_-]{1,100}$/.test(rawCursor)
            ? Buffer.from(rawCursor, "base64url").toString("utf8")
            : "";
        const n = /^\d{1,9}$/.test(text) ? Number(text) : NaN;
        if (!Number.isInteger(n)) {
          throw new ValidationError("Invalid cursor.", { field: "cursor" });
        }
        after = n;
      }

      let walletId: string | null = null;
      let ownerId: string | null = null;
      if (type === "mission") {
        const v = await getMissionWalletView(getDb(), {
          tenantId: p.tenantId,
          missionId: rawId,
        });
        ownerId = v?.owner_user_id ?? null;
      } else {
        const r = await getDb().query<{ wallet_id: string; owner: string }>(
          type === "wallet"
            ? `SELECT id AS wallet_id, owner_user_id AS owner FROM wallets
                WHERE id = $1 AND tenant_id = $2`
            : `SELECT d.wallet_id, w.owner_user_id AS owner
                 FROM wallet_deposits d JOIN wallets w ON w.id = d.wallet_id
                WHERE d.id = $1 AND d.tenant_id = $2`,
          [rawId, p.tenantId],
        );
        walletId = r.rows[0]?.wallet_id ?? null;
        ownerId = r.rows[0]?.owner ?? null;
      }
      const admin = isAdminPrincipal(p);
      if (ownerId === null && admin) throw new NotFoundError("Entity");
      if (ownerId !== p.id && !admin) {
        await recordRefusal(getDb(), {
          tenantId: p.tenantId,
          principal: { type: "user", id: p.id, role: String(p.role) },
          operation: "wallet.events.read",
          walletId,
          reasons: ["wallet_not_owned"],
          correlationId: corr(req),
        });
        throw new StoatError(
          "WALLET_NOT_OWNED",
          "You cannot view this event history.",
          403,
        );
      }

      const PAGE = 100;
      const r = await getDb().query(
        `SELECT id, tenant_id, aggregate_type, aggregate_id, sequence, event_type, actor_type,
                actor_id, correlation_id, recorded_at, amount, currency, payload
           FROM economic_events
          WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3 AND sequence > $4
          ORDER BY sequence ASC LIMIT $5`,
        [p.tenantId, type, rawId, after, PAGE + 1],
      );
      const rows = r.rows.slice(0, PAGE);
      const last = rows[rows.length - 1];
      res.status(200).json({
        events: rows.map(serializeEconomicEvent),
        next_cursor:
          r.rows.length > PAGE && last
            ? Buffer.from(String(last.sequence)).toString("base64url")
            : null,
      });
    }),
  );

  // ── Read models (task 16.1; R9.13, R10.1 to R10.11) ────────────────────────
  // Read-only. Ownership comes from the principal; Admin routes use the operator/supervisor
  // guard, so a buyer gets 403 and one audit row with no figure in the body.
  const ADMIN_ONLY = { roles: ["operator", "supervisor"] } as const;
  const offsetOf = (raw: unknown): number => {
    const n = decodeOffset(raw);
    if (n === null)
      throw new ValidationError("Invalid cursor.", { field: "cursor" });
    return n;
  };

  app.get(
    "/v1/wallet/statement",
    walletGuard("wallet.statement.read"),
    handler(async (req, res, p) => {
      const offset = offsetOf(req.query.cursor);
      const raw = req.query.currency;
      if (raw !== undefined && typeof raw !== "string")
        throw new ValidationError("Invalid currency.", { field: "currency" });
      const wanted = raw ? raw.toUpperCase() : null;
      const wallets = (
        await listWalletsForOwner(getDb(), {
          tenantId: p.tenantId,
          ownerUserId: p.id,
        })
      ).filter((w: any) => !wanted || w.currency === wanted);
      if (wallets.length === 0) {
        res.status(200).json({
          wallet_id: null,
          currency: wanted,
          paypal_environment: configuredEnvironment(),
          balance: "0",
          lines: [],
          next_cursor: null,
        });
        return;
      }
      if (wallets.length > 1)
        throw new ValidationError("Name the currency of the statement.", {
          field: "currency",
        });
      res.status(200).json(
        serializeStatement(
          await walletStatement(getDb(), {
            tenantId: p.tenantId,
            walletId: wallets[0].id,
            offset,
          }),
        ),
      );
    }),
  );

  app.get(
    "/v1/wallet/account",
    walletGuard("wallet.account.read"),
    handler(async (_req, res, p) => {
      const a = await userAccount(getDb(), {
        tenantId: p.tenantId,
        ownerUserId: p.id,
        environment: configuredEnvironment(),
      });
      res
        .status(200)
        .json(
          serializeUserAccount(a, await getFundingMode(getDb(), p.tenantId)),
        );
    }),
  );

  app.get(
    "/v1/admin/business-account",
    walletGuard("wallet.admin.business_account", ADMIN_ONLY),
    handler(async (_req, res, p) => {
      res.status(200).json({
        paypal_environment: configuredEnvironment(),
        currencies: serializeBusinessAccount(await businessAccount(p.tenantId)),
      });
    }),
  );

  app.get(
    "/v1/admin/trial-balance",
    walletGuard("wallet.admin.trial_balance", ADMIN_ONLY),
    handler(async (_req, res, p) => {
      res.status(200).json({
        currencies: serializeTrialBalance(
          await trialBalance(getDb(), p.tenantId),
        ),
      });
    }),
  );

  app.get(
    "/v1/admin/wallets",
    walletGuard("wallet.admin.wallet_list", ADMIN_ONLY),
    handler(async (req, res, p) => {
      let limit = 50;
      if (req.query.limit !== undefined) {
        const s = req.query.limit;
        const n =
          typeof s === "string" && /^\d{1,4}$/.test(s) ? Number(s) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > 200)
          throw new ValidationError("limit must be between 1 and 200.", {
            field: "limit",
          });
        limit = n;
      }
      const page = await adminWallets(getDb(), {
        tenantId: p.tenantId,
        limit,
        offset: offsetOf(req.query.cursor),
      });
      res.status(200).json({
        wallets: page.wallets.map((e) =>
          serializeAdminWallet(e.wallet, e.balances),
        ),
        next_cursor: page.next_cursor,
      });
    }),
  );

  app.get(
    "/v1/admin/wallets/:walletId/statement",
    walletGuard("wallet.admin.statement", ADMIN_ONLY),
    handler(async (req, res, p) => {
      const id = String(req.params.walletId ?? "");
      if (!UUID_RE.test(id)) throw new NotFoundError("Wallet");
      res.status(200).json(
        serializeStatement(
          await walletStatement(getDb(), {
            tenantId: p.tenantId,
            walletId: id,
            offset: offsetOf(req.query.cursor),
          }),
        ),
      );
    }),
  );

  app.get(
    "/v1/admin/users/:userId/wallet-account",
    walletGuard("wallet.admin.user_account", ADMIN_ONLY),
    handler(async (req, res, p) => {
      const id = String(req.params.userId ?? "");
      const u = UUID_RE.test(id)
        ? await getDb().query(
            `SELECT id FROM users WHERE id = $1 AND tenant_id = $2`,
            [id, p.tenantId],
          )
        : { rows: [] };
      if (!u.rows[0]) throw new NotFoundError("User");
      const a = await userAccount(getDb(), {
        tenantId: p.tenantId,
        ownerUserId: id,
        environment: null,
      });
      res
        .status(200)
        .json(
          serializeUserAccount(a, await getFundingMode(getDb(), p.tenantId)),
        );
    }),
  );

  // ── Reconciliation (task 17.2; R11.8 to R11.11, R19.4) ─────────────────────
  // Operator or supervisor only, own tenant. walletGuard refuses agents and buyers with one 403
  // and one audit row before any handler runs, so no run is started. The tenant always comes
  // from the principal. Reconciliation never changes a balance, reservation or journal line.
  const reconciliation = new ReconciliationService({ gateway: deps.gateway });
  const pageLimit = (raw: unknown): number => {
    if (raw === undefined) return 50;
    const n =
      typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 200)
      throw new ValidationError("limit must be between 1 and 200.", {
        field: "limit",
      });
    return n;
  };

  app.post(
    "/v1/admin/reconciliation/runs",
    walletGuard("wallet.admin.reconciliation_start", ADMIN_ONLY),
    handler(async (_req, res, p) => {
      const run = await reconciliation.startRun(p.tenantId, "admin", p.id);
      const found = await getRun(getDb(), p.tenantId, run.id);
      res
        .status(201)
        .json(serializeReconciliationRun(found!.run, found!.exceptions));
    }),
  );

  app.get(
    "/v1/admin/reconciliation/runs",
    walletGuard("wallet.admin.reconciliation_list", ADMIN_ONLY),
    handler(async (req, res, p) => {
      const limit = pageLimit(req.query.limit);
      const offset = offsetOf(req.query.cursor);
      const page = await listRuns(getDb(), p.tenantId, limit, offset);
      res.status(200).json({
        runs: page.runs.map((r) => serializeReconciliationRun(r)),
        next_cursor: page.hasMore ? encodeOffset(offset + limit) : null,
      });
    }),
  );

  app.get(
    "/v1/admin/reconciliation/runs/:id",
    walletGuard("wallet.admin.reconciliation_read", ADMIN_ONLY),
    handler(async (req, res, p) => {
      const id = String(req.params.id ?? "");
      const found = UUID_RE.test(id)
        ? await getRun(getDb(), p.tenantId, id)
        : null;
      if (!found) throw new NotFoundError("Reconciliation run");
      res
        .status(200)
        .json(serializeReconciliationRun(found.run, found.exceptions));
    }),
  );

  app.get(
    "/v1/admin/reconciliation/exceptions",
    walletGuard("wallet.admin.reconciliation_exceptions", ADMIN_ONLY),
    handler(async (req, res, p) => {
      const limit = pageLimit(req.query.limit);
      const offset = offsetOf(req.query.cursor);
      const raw = req.query.status;
      if (raw !== undefined && raw !== "open" && raw !== "resolved")
        throw new ValidationError("status must be open or resolved.", {
          field: "status",
        });
      const page = await listExceptions(
        getDb(),
        p.tenantId,
        (raw as "open" | "resolved" | undefined) ?? null,
        limit,
        offset,
      );
      res.status(200).json({
        exceptions: page.exceptions.map(serializeReconciliationException),
        next_cursor: page.hasMore ? encodeOffset(offset + limit) : null,
      });
    }),
  );

  // ── Analytics (task 20.2; R14.8, R14.9, R14.12, R19.4, R19.11) ──────────────
  // Read-only. walletGuard refuses an agent with one 403, one audit row listing all reasons and
  // no data. Scope comes from the principal only: an Owner sees own wallets, an Admin the tenant.
  // Pages hold at most 500 rows; CSV covers all authorized rows. Rows go through the allowlist
  // serializer. The chart route is registered first so "charts" is never read as a dataset.
  const analyticsScope = (p: AuthenticatedPrincipal): AnalyticsScope => ({
    tenantId: p.tenantId,
    userId: p.id,
    admin: isAdminPrincipal(p),
  });
  const queryString = (v: unknown, field: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string")
      throw new ValidationError(`Invalid ${field}.`, { field });
    return v;
  };

  app.get(
    "/v1/analytics/wallet/charts/:chart",
    walletGuard("wallet.analytics.chart"),
    handler(async (req, res, p) => {
      const chart = String(req.params.chart ?? "");
      if (!isAnalyticsChart(chart)) throw new NotFoundError("AnalyticsChart");
      const r = await queryChart(getDb(), analyticsScope(p), chart);
      res.status(200).json({
        chart: r.chart,
        paypal_environment: r.paypal_environment,
        points: r.points.map((pt) => safe({ ...pt })),
      });
    }),
  );

  app.get(
    "/v1/analytics/wallet/:dataset",
    walletGuard("wallet.analytics.dataset"),
    handler(async (req, res, p) => {
      const raw = String(req.params.dataset ?? "");
      const isCsv = raw.endsWith(".csv");
      const name = isCsv ? raw.slice(0, -4) : raw;
      if (!isAnalyticsDataset(name))
        throw new NotFoundError("AnalyticsDataset");
      const scope = analyticsScope(p);

      if (isCsv) {
        const text = await exportDatasetCsvText(getDb(), scope, name);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="wallet-${name}.csv"`,
        );
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send(text);
        return;
      }

      const page = await queryDataset(getDb(), scope, name, {
        cursor: queryString(req.query.cursor, "cursor"),
        limit: queryString(req.query.limit, "limit") as unknown as
          | number
          | undefined,
      });
      const names = page.columns.map((c) => c.name);
      const moneyColumns = page.columns
        .filter((c) => c.type === "money")
        .map((c) => c.name);
      res.status(200).json({
        dataset: page.dataset,
        paypal_environment: page.paypal_environment,
        columns: page.columns,
        rows: page.rows.map((row) =>
          serializeAnalyticsRow(row, names, moneyColumns),
        ),
        next_cursor: page.next_cursor,
      });
    }),
  );

  app.get(
    "/v1/wallet/deposits",
    walletGuard("wallet.deposit.list"),
    handler(async (_req, res, p) => {
      const admin = isAdminPrincipal(p);
      const r = await getDb().query(
        admin
          ? `SELECT * FROM wallet_deposits WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 100`
          : `SELECT d.* FROM wallet_deposits d JOIN wallets w ON w.id = d.wallet_id
              WHERE d.tenant_id = $1 AND w.owner_user_id = $2
              ORDER BY d.created_at DESC, d.id LIMIT 100`,
        admin ? [p.tenantId] : [p.tenantId, p.id],
      );
      res.status(200).json({
        paypal_environment: configuredEnvironment(),
        deposits: r.rows.map(serializeDeposit),
      });
    }),
  );

  app.get(
    "/v1/wallet/deposits/:id",
    walletGuard("wallet.deposit.read", { resolveTarget: depositTarget }),
    handler(async (req, res, p) => {
      const row = await loadDeposit(req, p, "wallet.deposit.read", true);
      res.status(200).json(serializeDeposit(row));
    }),
  );

  app.post(
    "/v1/wallet/deposits/:id/refresh",
    walletGuard("wallet.deposit.refresh", { resolveTarget: depositTarget }),
    handler(async (req, res, p) => {
      const row = await loadDeposit(req, p, "wallet.deposit.refresh", true);
      const view = await deposits.syncDeposit(
        row.id,
        "return",
        corr(req) ?? randomUUID(),
      );
      res.status(200).json(serializeDeposit(view));
    }),
  );
}

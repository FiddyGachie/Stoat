/**
 * Agent tool gateway (agentic-commerce task 14.1, R14.1 to R14.11, R14.13, R14.15).
 *
 * One gateway serves every interface (MCP, REST, portal), so authorization and results are identical
 * wherever a call arrives. Pipeline, in order:
 *
 *   1. human principals and tools outside the role's set are refused (FORBIDDEN_ACTION);
 *   2. arguments are strict-schema validated and capped at 16 KB (VALIDATION_FAILED names the argument);
 *   3. the per-principal rate limit is applied (RATE_LIMITED);
 *   4. tenant and mission scope is authorized in the same query that reads the record, so a missing
 *      record and an out-of-scope record are indistinguishable (one NOT_FOUND, no field returned);
 *   5. `propose_*` files a Proposal through ProposalService.submit; reads return Stoat records only;
 *   6. exactly one Audit_Log row is written per call, for success, refusal and failure alike.
 *
 * Nothing here deposits, reserves, charges, captures, refunds, approves, sends or releases money, and
 * no result contains a payout recipient, recipient email or payee identifier (Money_Boundary,
 * AGENTS.md section 8). Every call runs inside a one-step `agent_runs` row so it has an Agent_Run ID.
 */
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import {
  ForbiddenActionError,
  NotFoundError,
  StoatError,
  ValidationError,
} from "../../common/errors.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import type { DbClient } from "../../db/connection.js";
import { agentToolRateLimit } from "../agentic/agentic-config.js";
import { assertFlag } from "../agentic/feature-flags.js";
import { assertDatabaseRateLimit } from "../agentic/rate-limit.js";
import { redactPayload } from "../proposals/proposal-validation.js";
import { ProposalService } from "../proposals/proposal.service.js";
import { mandateRemaining } from "../mandates/mandate-evaluator.js";
import { getMandateUsage } from "../mandates/mandate-usage.js";
import {
  getPayPalGateway,
  UnconfiguredPayPalGateway,
} from "../paypal/paypal.gateway.js";
import { getBalances } from "../wallet/wallet.service.js";
import {
  TOOL_DEFINITIONS,
  getToolDefinition,
  toolsForRole,
  type ToolDefinition,
} from "./tool-definitions.js";
import {
  isToolName,
  parseToolArguments,
  type ToolArguments,
  type ToolName,
} from "./tool-schemas.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINUTE_MS = 60_000;

/** Roles whose scope is the whole tenant. Buyers and providers are limited to their own missions. */
const TENANT_WIDE_ROLES = new Set([
  "treasury",
  "budget",
  "watchdog",
  "copilot",
]);

/** Value of a PayPal-derived field when PayPal credentials are missing (R14.13). */
export const PAYPAL_NOT_CONFIGURED = "PAYPAL_NOT_CONFIGURED";

/** `none` means no such record exists; the rest label how far PayPal has confirmed the state. */
export type Confirmation =
  | "confirmed"
  | "pending"
  | "unknown"
  | "none"
  | typeof PAYPAL_NOT_CONFIGURED;

export type ToolInterface = "rest" | "mcp" | "portal";

export interface ToolCallInput {
  principal: AuthenticatedPrincipal;
  tool: unknown;
  args: unknown;
  correlationId?: string;
  via?: ToolInterface;
}

export interface ToolCallResult {
  tool: ToolName;
  agent_run_id: string;
  result: Record<string, unknown>;
}

export interface ToolGatewayOptions {
  /** Whether PayPal credentials are configured. Defaults to inspecting the shared gateway. */
  paypalConfigured?: () => boolean;
  proposals?: ProposalService;
}

const REFUSED_CODES = new Set([
  "FORBIDDEN_ACTION",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "FEATURE_DISABLED",
  "PROPOSAL_TOO_LARGE",
]);

function defaultPaypalConfigured(): boolean {
  return !(getPayPalGateway() instanceof UnconfiguredPayPalGateway);
}

const iso = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : new Date(value as string | Date).toISOString();

/** Label a set of per-item PayPal states: any pending wins, then all-confirmed, else unknown. */
function aggregate(
  states: Array<"confirmed" | "pending" | "unknown">,
): Confirmation {
  if (states.length === 0) return "none";
  if (states.includes("pending")) return "pending";
  return states.every((s) => s === "confirmed") ? "confirmed" : "unknown";
}

export class AgentToolGateway {
  private readonly proposals: ProposalService;
  private readonly paypalConfigured: () => boolean;

  constructor(
    private readonly db: DbClient,
    options: ToolGatewayOptions = {},
  ) {
    this.proposals = options.proposals ?? new ProposalService(db);
    this.paypalConfigured = options.paypalConfigured ?? defaultPaypalConfigured;
  }

  /** Tool definitions visible to a principal: its role's set for agents, none for people. */
  listTools(principal: AuthenticatedPrincipal): ToolDefinition[] {
    return principal.type === "agent"
      ? toolsForRole(String(principal.role))
      : [];
  }

  /** Every definition, regardless of role. Used by drift tests and documentation. */
  allTools(): readonly ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  async call(input: ToolCallInput): Promise<ToolCallResult> {
    const { principal } = input;
    const tenantId = principal.tenantId;
    const correlationId =
      input.correlationId && UUID_RE.test(input.correlationId)
        ? input.correlationId
        : randomUUID();
    const def = getToolDefinition(input.tool);
    const toolLabel = def ? def.name : "unknown";

    let runId: string | null = null;
    let validated: ToolArguments | null = null;
    let rawKeys: string[] = [];
    let resourceId = NIL_UUID;
    let code = "OK";
    let reason: string | undefined;
    let result: Record<string, unknown> | undefined;
    let failure: unknown;

    try {
      // Every call to a known tool gets an Agent_Run ID, including calls that are then refused.
      if (def && principal.type === "agent")
        runId = await this.openRun(principal, def, correlationId);
      rawKeys = this.keysOf(input.args);

      if (principal.type !== "agent") {
        reason = "HUMAN_PRINCIPAL";
        throw new ForbiddenActionError(
          "Agent tools are only available to agent principals.",
        );
      }
      if (!def) {
        reason = "UNKNOWN_TOOL";
        throw new ForbiddenActionError();
      }
      if (!def.allowedRoles.includes(String(principal.role))) {
        reason = "TOOL_NOT_IN_ROLE_SET";
        throw new ForbiddenActionError();
      }

      const parsed = parseToolArguments(def.name, input.args);
      if (!parsed.ok) {
        reason = `invalid:${parsed.fields.join(",")}`;
        throw new ValidationError(parsed.message, { fields: parsed.fields });
      }
      validated = parsed.args;
      resourceId = this.targetId(validated);

      try {
        await assertDatabaseRateLimit({
          db: this.db,
          tenantId,
          actorId: principal.id,
          scope: "agent_tool",
          limit: agentToolRateLimit(),
          windowMs: MINUTE_MS,
        });
      } catch (error) {
        reason = "rate_limited";
        throw error;
      }

      if (def.kind === "propose") {
        try {
          await assertFlag(this.db, tenantId, "proposals");
        } catch (error) {
          reason = "flag_disabled:proposals";
          throw error;
        }
        result = await this.propose(
          def,
          principal,
          validated,
          runId as string,
          correlationId,
        );
      } else {
        result = await this.read(def.name, principal, validated);
      }
    } catch (error) {
      failure = error;
      code = error instanceof StoatError ? error.code : "INTERNAL_ERROR";
      if (error instanceof NotFoundError) reason = "not_found_or_out_of_scope";
    }

    const outcome =
      failure === undefined
        ? "success"
        : REFUSED_CODES.has(code)
          ? "refused"
          : "failure";
    await this.closeRun(runId, outcome, code);
    await this.audit({
      principal,
      tool: toolLabel,
      outcome,
      code,
      reason,
      runId,
      resourceId,
      correlationId,
      args: validated,
      rawKeys,
      via: input.via ?? "rest",
    });

    if (failure !== undefined) throw failure;
    return {
      tool: (def as ToolDefinition).name,
      agent_run_id: runId as string,
      result: result ?? {},
    };
  }

  // ── run and audit bookkeeping ──────────────────────────────────────────────

  private async openRun(
    principal: AuthenticatedPrincipal,
    def: ToolDefinition,
    correlationId: string,
  ): Promise<string> {
    const created = await this.db.query<{ id: string }>(
      `INSERT INTO agent_runs
         (tenant_id, agent_id, role, model, limits, steps_count, cost_usd, status, started_at,
          correlation_id, scope, tool_set)
       VALUES ($1, $2, $3, 'none', $4::jsonb, 1, 0, 'running', now(), $5, $6::jsonb, $7)
       RETURNING id`,
      [
        principal.tenantId,
        principal.id,
        String(principal.role),
        JSON.stringify({ max_steps: 1, max_seconds: 60, max_cost_usd: 0 }),
        correlationId,
        JSON.stringify({ subject: "agent_tool", tool: def.name }),
        [def.name],
      ],
    );
    return created.rows[0].id;
  }

  private async closeRun(
    runId: string | null,
    outcome: string,
    code: string,
  ): Promise<void> {
    if (!runId) return;
    await this.db.query(
      `UPDATE agent_runs SET status = $2, terminal_reason = $3, completed_at = now()
       WHERE id = $1 AND status = 'running'`,
      [runId, outcome === "failure" ? "failed_closed" : "completed", code],
    );
  }

  private async audit(a: {
    principal: AuthenticatedPrincipal;
    tool: string;
    outcome: string;
    code: string;
    reason?: string;
    runId: string | null;
    resourceId: string;
    correlationId: string;
    args: ToolArguments | null;
    rawKeys: string[];
    via: ToolInterface;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs
         (tenant_id, actor_type, actor_id, action, resource_type, resource_id,
          correlation_id, outcome, reason, metadata)
       VALUES ($1, $2, $3, $4, 'agent_tool', $5, $6, $7, $8, $9::jsonb)`,
      [
        a.principal.tenantId,
        a.principal.type === "agent" ? "agent" : "user",
        UUID_RE.test(a.principal.id) ? a.principal.id : NIL_UUID,
        `agent_tool.${a.tool}`,
        a.resourceId,
        a.correlationId,
        a.outcome,
        a.reason ?? (a.outcome === "success" ? null : a.code),
        JSON.stringify({
          tool: a.tool,
          principal_role: String(a.principal.role),
          result_code: a.code,
          agent_run_id: a.runId,
          interface: a.via,
          // Validated arguments only. A rejected call stores key names, never values.
          ...(a.args ? { arguments: a.args } : { argument_keys: a.rawKeys }),
        }),
      ],
    );
  }

  private keysOf(args: unknown): string[] {
    const keys = redactPayload(args).keys;
    return keys.slice(0, 50).map((k) => k.slice(0, 64));
  }

  private targetId(args: ToolArguments): string {
    for (const key of [
      "agreement_id",
      "obligation_id",
      "mandate_id",
      "wallet_id",
      "hold_id",
      "mission_id",
    ]) {
      const value = args[key];
      if (typeof value === "string" && UUID_RE.test(value)) return value;
    }
    return NIL_UUID;
  }

  // ── propose_* ──────────────────────────────────────────────────────────────

  private async propose(
    def: ToolDefinition,
    principal: AuthenticatedPrincipal,
    args: ToolArguments,
    runId: string,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { rationale, ...payload } = args;
    const submitted = await this.proposals.submit({
      tenantId: principal.tenantId,
      submitter: principal,
      type: def.proposalType,
      payload,
      rationale,
      agentRunId: runId,
      provenance: { source: "tool" },
      correlationId,
    });
    return {
      proposal_id: submitted.proposal.id,
      status: submitted.proposal.status,
      created: submitted.created,
    };
  }

  // ── read tools ─────────────────────────────────────────────────────────────

  private async read(
    tool: ToolName,
    principal: AuthenticatedPrincipal,
    args: ToolArguments,
  ): Promise<Record<string, unknown>> {
    const scope = {
      tenantId: principal.tenantId,
      agentId: principal.id,
      wide: TENANT_WIDE_ROLES.has(String(principal.role)),
    };
    switch (tool) {
      case "payment_status":
        return this.paymentStatus(scope, args);
      case "mandate_remaining":
        return this.mandateRemainingTool(scope, String(args.mandate_id));
      case "wallet_summary":
        return this.walletSummary(scope, String(args.wallet_id));
      default:
        throw new ForbiddenActionError();
    }
  }

  private async paymentStatus(
    scope: { tenantId: string; agentId: string; wide: boolean },
    args: ToolArguments,
  ): Promise<Record<string, unknown>> {
    const { tenantId } = scope;
    // Authorization and lookup are one query: a missing record and an out-of-scope record both
    // return no row, so the caller cannot tell them apart and no field is read (R14.4, R14.5).
    const found = args.obligation_id
      ? await this.db.query<{
          agreement_id: string;
          mission_id: string;
          status: string;
          provider_id: string;
          obligation_id: string;
        }>(
          `SELECT a.id AS agreement_id, a.mission_id, a.status, o.provider_id, o.id AS obligation_id
           FROM obligations o JOIN agreements a ON a.id = o.agreement_id AND a.tenant_id = o.tenant_id
           WHERE o.tenant_id = $1 AND o.id = $2
             AND ($3::boolean OR o.buyer_id = $4 OR o.provider_id = $4)`,
          [tenantId, args.obligation_id, scope.wide, scope.agentId],
        )
      : await this.db.query<{
          agreement_id: string;
          mission_id: string;
          status: string;
          provider_id: string;
          obligation_id: string | null;
        }>(
          `SELECT a.id AS agreement_id, a.mission_id, a.status, a.provider_id, NULL AS obligation_id
           FROM agreements a
           WHERE a.tenant_id = $1 AND a.id = $2
             AND ($3::boolean OR a.buyer_id = $4 OR a.provider_id = $4)`,
          [tenantId, args.agreement_id, scope.wide, scope.agentId],
        );
    const agreement = found.rows[0];
    if (!agreement) throw new NotFoundError("Record");

    const configured = this.paypalConfigured();
    const paypal = (value: Confirmation): Confirmation =>
      configured ? value : PAYPAL_NOT_CONFIGURED;

    const [reservation, charge, obligation] = await Promise.all([
      this.db.query<{
        wallet_id: string;
        status: string;
        amount: string;
        currency: string;
        closed_at: unknown;
      }>(
        `SELECT wallet_id, status, amount::text AS amount, currency, closed_at
         FROM wallet_reservations WHERE tenant_id = $1 AND agreement_id = $2`,
        [tenantId, agreement.agreement_id],
      ),
      this.db.query<{ amount: string; currency: string; created_at: unknown }>(
        `SELECT amount::text AS amount, currency, created_at
         FROM wallet_charges WHERE tenant_id = $1 AND agreement_id = $2`,
        [tenantId, agreement.agreement_id],
      ),
      this.db.query<{
        id: string;
        status: string;
        amount: string;
        currency: string;
        provider_id: string;
      }>(
        `SELECT id, status, amount::text AS amount, currency, provider_id
         FROM obligations WHERE tenant_id = $1 AND agreement_id = $2`,
        [tenantId, agreement.agreement_id],
      ),
    ]);
    const res = reservation.rows[0];
    const chg = charge.rows[0];
    const obl = obligation.rows[0];

    // Capture: funds enter a wallet only through a PayPal deposit that PayPal reports as captured.
    let capture: Confirmation = "none";
    if (res) {
      const deposits = await this.db.query<{
        confirmed: number;
        pending: number;
      }>(
        `SELECT count(*) FILTER (WHERE status = 'captured' AND paypal_capture_id IS NOT NULL)::int AS confirmed,
                count(*) FILTER (WHERE status IN ('creating','awaiting_approval','awaiting_capture'))::int AS pending
         FROM wallet_deposits WHERE tenant_id = $1 AND wallet_id = $2`,
        [tenantId, res.wallet_id],
      );
      const d = deposits.rows[0];
      capture =
        (d?.confirmed ?? 0) > 0
          ? "confirmed"
          : (d?.pending ?? 0) > 0
            ? "pending"
            : "unknown";
    }

    const refundItems = await this.db.query<{ status: string }>(
      `SELECT i.status FROM wallet_refund_items i
       JOIN wallet_refunds r ON r.id = i.refund_id AND r.tenant_id = i.tenant_id
       WHERE r.tenant_id = $1 AND r.mission_id = $2`,
      [tenantId, agreement.mission_id],
    );
    const refundStates = refundItems.rows.map((row) =>
      row.status === "completed"
        ? ("confirmed" as const)
        : ["planned", "submitted", "pending"].includes(row.status)
          ? ("pending" as const)
          : ("unknown" as const),
    );

    // The payout is matched on the provider internally; no payee identifier or email is selected.
    const payoutRow = obl
      ? (
          await this.db.query<{
            status: string;
            amount: string;
            currency: string;
            paid_at: unknown;
          }>(
            `SELECT p.status, p.amount::text AS amount, p.currency, p.paid_at
             FROM settlement_batch_items si
             JOIN payouts p ON p.batch_id = si.batch_id AND p.tenant_id = si.tenant_id AND p.agent_id = $3
             WHERE si.tenant_id = $1 AND si.obligation_id = $2
             ORDER BY p.created_at DESC LIMIT 1`,
            [tenantId, obl.id, obl.provider_id],
          )
        ).rows[0]
      : undefined;
    const payoutState: Confirmation = !payoutRow
      ? "none"
      : payoutRow.status === "paid"
        ? "confirmed"
        : ["requested", "processing"].includes(payoutRow.status)
          ? "pending"
          : "unknown";

    return {
      agreement_id: agreement.agreement_id,
      agreement_status: agreement.status,
      reservation: res
        ? {
            status: res.status,
            amount: res.amount,
            currency: res.currency,
            closed_at: iso(res.closed_at),
          }
        : null,
      charge: chg
        ? {
            amount: chg.amount,
            currency: chg.currency,
            recorded_at: iso(chg.created_at),
          }
        : null,
      obligation: obl
        ? {
            obligation_id: obl.id,
            status: obl.status,
            amount: obl.amount,
            currency: obl.currency,
          }
        : null,
      // PayPal-derived fields: `state` is PayPal-confirmed, pending or unknown, or PAYPAL_NOT_CONFIGURED.
      capture: { state: paypal(capture) },
      refund: {
        state: paypal(aggregate(refundStates)),
        recorded_items: refundStates.length,
      },
      payout: {
        state: paypal(payoutState),
        recorded_status: payoutRow?.status ?? null,
        amount: payoutRow?.amount ?? null,
        currency: payoutRow?.currency ?? null,
        paid_at: iso(payoutRow?.paid_at),
      },
      paypal_configured: configured,
    };
  }

  private async mandateRemainingTool(
    scope: { tenantId: string; agentId: string; wide: boolean },
    mandateId: string,
  ): Promise<Record<string, unknown>> {
    const found = await this.db.query<{
      id: string;
      status: string;
      currency: string;
      total_cap: string;
      daily_cap: string;
      expires_at: unknown;
    }>(
      `SELECT m.id, m.status, m.currency, m.total_cap::text AS total_cap,
              m.daily_cap::text AS daily_cap, m.expires_at
       FROM mandates m
       WHERE m.tenant_id = $1 AND m.id = $2
         AND ($3::boolean
           OR EXISTS (SELECT 1 FROM agreements a
                      WHERE a.tenant_id = m.tenant_id AND a.mandate_id = m.id AND a.buyer_id = $4)
           OR EXISTS (SELECT 1 FROM missions mm
                      WHERE mm.tenant_id = m.tenant_id AND mm.buyer_id = $4
                        AND (mm.id = ANY(COALESCE(m.mission_scope, '{}'::uuid[]))
                          OR EXISTS (SELECT 1 FROM mission_funding mf
                                     WHERE mf.tenant_id = m.tenant_id AND mf.mission_id = mm.id
                                       AND mf.wallet_id = m.wallet_id))))`,
      [scope.tenantId, mandateId, scope.wide, scope.agentId],
    );
    const mandate = found.rows[0];
    if (!mandate) throw new NotFoundError("Record");
    const usage = await getMandateUsage(this.db, mandate.id);
    const remaining = mandateRemaining({
      totalCap: new Decimal(mandate.total_cap),
      usage: usage.usage,
      dailyCap: new Decimal(mandate.daily_cap),
      todayUsage: usage.todayUsage,
    });
    return {
      mandate_id: mandate.id,
      status: mandate.status,
      remaining: remaining.toFixed(),
      currency: mandate.currency,
      expires_at: iso(mandate.expires_at),
    };
  }

  private async walletSummary(
    scope: { tenantId: string; agentId: string; wide: boolean },
    walletId: string,
  ): Promise<Record<string, unknown>> {
    const found = await this.db.query<{ id: string; status: string }>(
      `SELECT w.id, w.status FROM wallets w
       WHERE w.tenant_id = $1 AND w.id = $2
         AND ($3::boolean
           OR EXISTS (SELECT 1 FROM mission_funding mf JOIN missions m
                        ON m.id = mf.mission_id AND m.tenant_id = mf.tenant_id
                      WHERE mf.tenant_id = w.tenant_id AND mf.wallet_id = w.id AND m.buyer_id = $4)
           OR EXISTS (SELECT 1 FROM wallet_reservations r JOIN missions m
                        ON m.id = r.mission_id AND m.tenant_id = r.tenant_id
                      WHERE r.tenant_id = w.tenant_id AND r.wallet_id = w.id AND m.buyer_id = $4))`,
      [scope.tenantId, walletId, scope.wide, scope.agentId],
    );
    const wallet = found.rows[0];
    if (!wallet) throw new NotFoundError("Record");
    const balances = await getBalances(this.db, wallet.id);
    return {
      wallet_id: wallet.id,
      status: wallet.status,
      available: balances.available,
      currency: balances.currency,
    };
  }
}

export { isToolName };

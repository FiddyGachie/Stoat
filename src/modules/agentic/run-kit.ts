import { randomBytes } from "node:crypto";
import { Decimal } from "decimal.js";
import { sha256 } from "../../common/crypto.js";
import { StoatError } from "../../common/errors.js";
import { transaction, type DbClient } from "../../db/connection.js";
import type { LlmRequestOptions, LlmResponse } from "../agent-runtime/llm-adapter.js";
import type { AgentRuntimeService } from "../agent-runtime/agent-runtime.service.js";
import { notifyInTx } from "../wallet/notification.service.js";
import { agenticDailyModelBudgetUsd } from "./agentic-config.js";

const COUNTED_ROLES = new Set([
  "watchdog_explain",
  "insight",
  "question",
  "buyer_mandate",
  "proposal_budget",
  "proposal_treasury",
]);
const MODEL_TIMEOUT_MS = 30_000;

export interface RunSpec {
  tenantId: string;
  agentId?: string;
  role: string;
  scope: { missionId?: string; mandateId?: string; subject?: string };
  toolSet: readonly string[];
  limits: { maxSteps: number; maxSeconds: number; maxTokens: number; maxCostUsd: number };
  parentRunId?: string;
  correlationId?: string;
}

export type TerminalReason =
  | "completed"
  | "refused"
  | "budget_steps"
  | "budget_time"
  | "budget_tokens"
  | "budget_cost"
  | "invalid_output"
  | "timeout"
  | "failed_closed";

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ModelOutcome<T> {
  value: T;
  response: LlmResponse;
}

export interface RunPrincipal {
  token: string;
  tenantId: string;
  agentId: string;
  agentRunId: string;
  role: string;
  scope: RunSpec["scope"];
  toolSet: readonly string[];
  expiresAt: Date;
}

export interface RunBudget {
  steps: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: Decimal;
}

export interface RunHandle {
  run: { id: string; model: string };
  principal: RunPrincipal;
  budget: RunBudget;
  callModel<T>(
    opts: LlmRequestOptions,
    validate: (data: unknown) => Validation<T>,
  ): Promise<ModelOutcome<T>>;
  child(spec: Partial<RunSpec>): Promise<RunHandle>;
  finish(reason: TerminalReason, costUsd?: number): Promise<void>;
}

async function ensureSystemAgent(db: DbClient, tenantId: string, role: string) {
  const name = role === "watchdog" ? "Stoat Watchdog Agent" : "Stoat Operator Copilot";
  const found = await db.query<{ id: string }>(
    "SELECT id FROM agents WHERE tenant_id = $1 AND role = $2 AND status = 'active' ORDER BY created_at LIMIT 1",
    [tenantId, role],
  );
  if (found.rows[0]) return found.rows[0].id;
  const created = await db.query<{ id: string }>(
    `INSERT INTO agents (tenant_id, role, name, status, scopes, credential_hash)
     VALUES ($1, $2, $3, 'active', '[]'::jsonb, 'disabled') RETURNING id`,
    [tenantId, role, name],
  );
  return created.rows[0].id;
}

async function assertTenantModelBudget(db: DbClient, tenantId: string): Promise<void> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const budget = new Decimal(agenticDailyModelBudgetUsd());
  const result = await db.query<{ cost: string }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::text AS cost FROM agent_runs
     WHERE tenant_id = $1 AND role = ANY($2::text[]) AND created_at >= $3`,
    [tenantId, [...COUNTED_ROLES], midnight.toISOString()],
  );
  if (new Decimal(result.rows[0]?.cost ?? "0").gte(budget)) {
    await transaction((tx) =>
      notifyInTx(tx, {
        tenantId,
        kind: "model_budget_reached",
        recipient: { admins: true },
        title: "Agentic model budget reached",
        body: "The tenant's daily model budget has been reached. No further agentic model calls will run today.",
        entityType: "tenant",
        entityId: tenantId,
        eventId: `model_budget:${tenantId}:${midnight.toISOString().slice(0, 10)}`,
      }),
    );
    throw new StoatError(
      "MODEL_BUDGET_EXCEEDED",
      "The tenant's daily agentic model budget has been reached.",
      429,
    );
  }
}

export async function authenticateRunPrincipal(
  db: DbClient,
  token: string,
  now = new Date(),
): Promise<RunPrincipal | null> {
  const result = await db.query<{
    id: string;
    tenant_id: string;
    agent_id: string;
    role: string;
    scope: RunSpec["scope"];
    tool_set: string[];
    principal_expires_at: Date | string;
  }>(
    `SELECT id, tenant_id, agent_id, role, scope, tool_set, principal_expires_at
     FROM agent_runs
     WHERE principal_hash = $1 AND status = 'running' AND principal_expires_at > $2`,
    [sha256(token), now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    token,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    agentRunId: row.id,
    role: row.role,
    scope: row.scope,
    toolSet: row.tool_set,
    expiresAt: new Date(row.principal_expires_at),
  };
}

export async function openRun(
  runtime: AgentRuntimeService,
  spec: RunSpec,
): Promise<RunHandle> {
  const db = runtime.getDbClient();
  const systemRole =
    spec.role === "watchdog_explain" ? "watchdog" :
      spec.role === "insight" || spec.role === "question" ? "copilot" : undefined;
  const agentId = spec.agentId ?? (systemRole ? await ensureSystemAgent(db, spec.tenantId, systemRole) : "");
  if (!agentId) throw new StoatError("AGENT_NOT_FOUND", "An agent identity is required.", 400);
  const token = randomBytes(32).toString("base64url");
  const maxSeconds = Math.max(1, spec.limits.maxSeconds);
  const expiresAt = new Date(Date.now() + Math.min(maxSeconds, 600) * 1000);
  const run = await runtime.startRun({
    tenantId: spec.tenantId,
    agentId,
    role: spec.role,
    missionId: spec.scope.missionId,
    parentRunId: spec.parentRunId,
    correlationId: spec.correlationId,
    scope: spec.scope,
    toolSet: spec.toolSet,
    principalHash: sha256(token),
    principalExpiresAt: expiresAt,
    limits: {
      max_steps: spec.limits.maxSteps,
      max_seconds: spec.limits.maxSeconds,
      max_cost_usd: spec.limits.maxCostUsd,
      max_tokens: spec.limits.maxTokens,
    },
  });
  const budget: RunBudget = {
    steps: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: new Decimal(0),
  };
  let finished = false;
  const startedAt = Date.now();
  const finish = async (reason: TerminalReason, costUsd = 0) => {
    if (finished) return;
    await db.query(
      `UPDATE agent_runs SET status = $2, terminal_reason = $3,
         cost_usd = cost_usd + $4, completed_at = now(), principal_expires_at = now()
       WHERE id = $1 AND status = 'running'`,
      [
        run.id,
        reason.startsWith("budget_") || reason === "timeout"
          ? "terminated_limit"
          : reason === "failed_closed" || reason === "invalid_output"
            ? "failed_closed"
            : "completed",
        reason,
        costUsd,
      ],
    );
    finished = true;
  };
  const principal: RunPrincipal = {
    token,
    tenantId: spec.tenantId,
    agentId,
    agentRunId: run.id,
    role: spec.role,
    scope: spec.scope,
    toolSet: [...new Set(spec.toolSet)],
    expiresAt,
  };
  const handle: RunHandle = {
    run: { id: run.id, model: run.model },
    principal,
    budget,
    async callModel<T>(
      opts: LlmRequestOptions,
      validate: (data: unknown) => Validation<T>,
    ): Promise<ModelOutcome<T>> {
      if (finished) throw new StoatError("AGENT_RUN_FINISHED", "The agent run has already finished.", 409);
      if (Date.now() - startedAt >= spec.limits.maxSeconds * 1000) {
        await finish("budget_time");
        throw new StoatError("AGENT_BUDGET_EXCEEDED", "The run time budget was reached.", 429, { reason: "budget_time" });
      }
      if (budget.steps >= spec.limits.maxSteps) {
        await finish("budget_steps");
        throw new StoatError("AGENT_BUDGET_EXCEEDED", "The run step budget was reached.", 429, { reason: "budget_steps" });
      }
      if (budget.costUsd.gte(spec.limits.maxCostUsd)) {
        await finish("budget_cost");
        throw new StoatError("AGENT_BUDGET_EXCEEDED", "The run cost budget was reached.", 429, { reason: "budget_cost" });
      }
      const promptInputTokens = Math.ceil((opts.prompt.length + (opts.systemPrompt?.length ?? 0)) / 4);
      if (budget.inputTokens + promptInputTokens > spec.limits.maxTokens) {
        await finish("budget_tokens");
        throw new StoatError("AGENT_BUDGET_EXCEEDED", "The run token budget was reached.", 429, { reason: "budget_tokens" });
      }
      if (COUNTED_ROLES.has(spec.role)) {
        try {
          await assertTenantModelBudget(db, spec.tenantId);
        } catch (error) {
          if (error instanceof StoatError && error.code === "MODEL_BUDGET_EXCEEDED") {
            await finish("budget_cost");
          }
          throw error;
        }
      }
      const remainingMs = spec.limits.maxSeconds * 1000 - (Date.now() - startedAt);
      const timeoutMs = Math.max(1, Math.min(MODEL_TIMEOUT_MS, remainingMs));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new StoatError("MODEL_TIMEOUT", "The model call exceeded its time limit.", 504)),
          timeoutMs,
        );
      });
      budget.steps++;
      try {
        const response = await Promise.race([
          runtime.getLlmAdapter().execute({
            ...opts,
            tenantId: spec.tenantId,
            agentRunId: run.id,
            model: opts.model ?? run.model,
          }),
          timeout,
        ]);
        const checked = validate(response.data);
        const usage = response.usage ?? { inputTokens: promptInputTokens, outputTokens: 0, costUsd: 0 };
        budget.elapsedMs = Date.now() - startedAt;
        budget.inputTokens += usage.inputTokens;
        budget.outputTokens += usage.outputTokens;
        budget.costUsd = budget.costUsd.plus(usage.costUsd);
        await db.query(
          "UPDATE agent_runs SET steps_count = steps_count + 1, cost_usd = cost_usd + $2 WHERE id = $1",
          [run.id, usage.costUsd],
        );
        if (budget.inputTokens + budget.outputTokens > spec.limits.maxTokens) {
          await finish("budget_tokens");
          throw new StoatError("AGENT_BUDGET_EXCEEDED", "The run token budget was reached; model output was discarded.", 429, { reason: "budget_tokens" });
        }
        if (budget.costUsd.gt(spec.limits.maxCostUsd)) {
          await finish("budget_cost");
          throw new StoatError("AGENT_BUDGET_EXCEEDED", "The run cost budget was reached; model output was discarded.", 429, { reason: "budget_cost" });
        }
        if (!checked.ok) {
          await finish("invalid_output");
          throw new StoatError("AGENT_OUTPUT_INVALID", checked.error, 422);
        }
        return { value: checked.value, response };
      } catch (error) {
        budget.elapsedMs = Date.now() - startedAt;
        if (error instanceof StoatError && error.code === "MODEL_TIMEOUT") {
          await finish("timeout");
        } else if (!(error instanceof StoatError && error.code === "AGENT_BUDGET_EXCEEDED" && finished)) {
          await finish("failed_closed");
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async child(childSpec: Partial<RunSpec>): Promise<RunHandle> {
      const remainingSeconds = Math.max(0, spec.limits.maxSeconds - Math.ceil((Date.now() - startedAt) / 1000));
      const effective: RunSpec = {
        ...spec,
        ...childSpec,
        tenantId: spec.tenantId,
        scope: {
          missionId: spec.scope.missionId ?? childSpec.scope?.missionId,
          mandateId: spec.scope.mandateId ?? childSpec.scope?.mandateId,
          subject: spec.scope.subject ?? childSpec.scope?.subject,
        },
        toolSet: (childSpec.toolSet ?? spec.toolSet).filter((tool) => spec.toolSet.includes(tool)),
        parentRunId: run.id,
        limits: {
          maxSteps: Math.min(childSpec.limits?.maxSteps ?? spec.limits.maxSteps, Math.max(0, spec.limits.maxSteps - budget.steps)),
          maxSeconds: Math.min(childSpec.limits?.maxSeconds ?? remainingSeconds, remainingSeconds),
          maxTokens: Math.min(childSpec.limits?.maxTokens ?? spec.limits.maxTokens, Math.max(0, spec.limits.maxTokens - budget.inputTokens - budget.outputTokens)),
          maxCostUsd: Math.min(childSpec.limits?.maxCostUsd ?? spec.limits.maxCostUsd, Math.max(0, new Decimal(spec.limits.maxCostUsd).minus(budget.costUsd).toNumber())),
        },
      };
      return openRun(runtime, effective);
    },
    finish,
  };
  return handle;
}

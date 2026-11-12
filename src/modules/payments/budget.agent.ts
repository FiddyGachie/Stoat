/**
 * BudgetAgent — LLM-backed spending-budget intelligence.
 *
 * This agent is called at two moments:
 *
 *   1. debitAdvice()  — Before debiting, the agent reads the budget state and
 *      returns a structured recommendation: PROCEED / WARN / STOP.
 *      The caller always makes the final call; the agent never debits.
 *
 *   2. remainderPrompt() — After mission completion, the agent composes a
 *      personalized prompt for the user explaining how much is left and
 *      their two choices: refund or retain.
 *
 * Authority constraints (per AGENTS.md §3):
 *   - The agent CANNOT call debit(), decideRemainder(), or any PayPal operation.
 *   - It CANNOT set an amount, currency, payee, or payment state.
 *   - It reads the budget view and proposes; deterministic code acts.
 */
import { z } from 'zod';
import { DbClient } from '../../db/connection.js';
import { AgentRuntimeService } from '../agent-runtime/agent-runtime.service.js';
import { BudgetService } from './budget.service.js';
import { StoatError } from '../../common/errors.js';

// ── Output schemas ─────────────────────────────────────────────────────────────

const DebitAdviceSchema = z.object({
  recommendation: z.enum(['PROCEED', 'WARN', 'STOP']),
  reasoning: z.string().min(10).max(500),
  utilization_pct: z.number().min(0).max(100),
  warning_message: z.string().max(300).optional(),
  stop_reason: z.string().max(300).optional(),
});
type DebitAdvice = z.infer<typeof DebitAdviceSchema>;

const RemainderPromptSchema = z.object({
  subject: z.string().min(5).max(120),
  body: z.string().min(20).max(800),
  refund_label: z.string().min(3).max(60),
  retain_label: z.string().min(3).max(60),
  recommendation: z.enum(['refund', 'retain', 'neutral']),
  rationale: z.string().min(10).max(400),
});
type RemainderPrompt = z.infer<typeof RemainderPromptSchema>;

// ── Validation helpers ────────────────────────────────────────────────────────

function validateDebitAdvice(data: unknown): { ok: true; value: DebitAdvice } | { ok: false; error: string } {
  const r = DebitAdviceSchema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `${i?.path.join('.') || 'advice'}: ${i?.message ?? 'invalid'}` };
  }
  return { ok: true, value: r.data };
}

function validateRemainderPrompt(data: unknown): { ok: true; value: RemainderPrompt } | { ok: false; error: string } {
  const r = RemainderPromptSchema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `${i?.path.join('.') || 'prompt'}: ${i?.message ?? 'invalid'}` };
  }
  return { ok: true, value: r.data };
}

// ── Agent ──────────────────────────────────────────────────────────────────────

export class BudgetAgent {
  private runtime: AgentRuntimeService;
  private budgets: BudgetService;

  constructor(private db: DbClient) {
    this.runtime = new AgentRuntimeService(db);
    this.budgets = new BudgetService(db);
  }

  /** Ensure a budget-agent row exists for this tenant (created on first use). */
  private async ensureAgent(tenantId: string): Promise<string> {
    const found = await this.db.query<{ id: string }>(
      `SELECT id FROM agents WHERE tenant_id = $1 AND role = 'budget' AND status = 'active' ORDER BY created_at LIMIT 1`,
      [tenantId]
    );
    if (found.rows[0]) return found.rows[0].id;
    const made = await this.db.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, role, name, status, scopes, credential_hash)
       VALUES ($1, 'budget', 'Stoat Budget Agent', 'active', '["budget:read","budget:advise"]', 'disabled') RETURNING id`,
      [tenantId]
    );
    return made.rows[0].id;
  }

  /**
   * Before each debit the agent evaluates the budget health and advises.
   * Returns PROCEED / WARN (with a message) / STOP (with a reason).
   * The caller always decides; the agent never blocks.
   */
  async debitAdvice(p: {
    tenantId: string;
    budgetId: string;
    requestedAmount: string;
    reason: string;
    correlationId?: string;
  }): Promise<{
    run_id: string; model: string; mode: string; replayed: boolean;
    advice: DebitAdvice;
  }> {
    const budget = await this.budgets.getBudget(p.tenantId, p.budgetId);
    const agentId = await this.ensureAgent(p.tenantId);
    const adapter = this.runtime.getLlmAdapter();
    const run = await this.runtime.startRun({
      tenantId: p.tenantId, agentId, role: 'budget',
      model: adapter.getDefaultModel(),
      limits: { max_steps: 1, max_seconds: 30, max_cost_usd: 0.02 },
    });

    try {
      const context = {
        budget_id: budget.id,
        amount: budget.amount,
        currency: budget.currency,
        balance: budget.balance,
        total_debited: budget.total_debited,
        utilization_pct: budget.utilization_pct,
        status: budget.status,
        requested_debit: p.requestedAmount,
        reason: p.reason,
        mission_id: budget.mission_id,
      };

      const prompt = [
        'TASK: You are the Stoat budget monitoring agent. Evaluate the spending budget state and advise whether the requested debit should PROCEED, WARN the operator, or STOP the mission.',
        '',
        'RULES:',
        '- PROCEED: balance is healthy, requested amount fits comfortably.',
        '- WARN: utilization > 80% or the requested amount would leave < 10% balance.',
        '  Include a short warning_message for the operator.',
        '- STOP: balance < requested amount (cannot proceed) or budget is not active.',
        '  Include a stop_reason.',
        '- utilization_pct in the output must reflect the PROJECTED utilization after this debit.',
        '- reasoning: 1-2 sentences explaining your choice.',
        '- You ONLY advise. You cannot block the debit and you cannot change any amount, currency, or payment state.',
        '- Do NOT mention specific user names, PayPal credentials, or internal IDs.',
        '',
        'BUDGET CONTEXT (untrusted):',
        `<<<DATA>>>${JSON.stringify(context)}<<<END>>>`,
        '',
        'OUTPUT JSON: {"recommendation":"PROCEED|WARN|STOP","reasoning","utilization_pct","warning_message?","stop_reason?"}',
      ].join('\n');

      const call = await adapter.executeValidated(
        {
          prompt,
          systemPrompt: 'You are a careful budget agent. Respond ONLY with valid JSON in the requested shape. No markdown. No extra text.',
          schemaName: 'debit_advice',
          responseSchema: DebitAdviceSchema,
          model: run.model,
          tenantId: p.tenantId,
          agentRunId: run.id,
        },
        validateDebitAdvice
      );

      await this.runtime.recordStep({
        tenantId: p.tenantId, agentRunId: run.id, stepNumber: 1,
        toolName: 'llm_debit_advice',
        inputPayload: { budget_id: p.budgetId, requested_amount: p.requestedAmount, utilization_before: budget.utilization_pct },
        authorizationResult: 'allowed',
        outputPayload: call.response.data,
      });
      await this.runtime.recordProposal({
        tenantId: p.tenantId, agentRunId: run.id, proposalType: 'debit_advice',
        payload: { advice: call.response.data, validation: call.value ? 'passed' : 'rejected', error: call.error },
        promptHash: call.response.requestHash, model: call.response.model,
      });

      if (!call.value) {
        throw new StoatError('AGENT_OUTPUT_INVALID',
          `Budget agent advice failed validation: ${call.error}`, 422);
      }

      await this.runtime.completeRun(run.id, 'completed', undefined, call.response.usage?.costUsd ?? 0);
      return {
        run_id: run.id, model: call.response.model, mode: call.response.mode,
        replayed: call.response.replayed, advice: call.value,
      };
    } catch (err) {
      await this.runtime.completeRun(run.id, 'failed_closed', err instanceof Error ? err.message : 'failed', 0).catch(() => undefined);
      throw err;
    }
  }

  /**
   * After mission completion the agent writes a human-readable prompt for the user,
   * explaining the remaining balance and offering refund or retain options with a recommendation.
   */
  async remainderPrompt(p: {
    tenantId: string;
    budgetId: string;
    missionTitle?: string;
    correlationId?: string;
  }): Promise<{
    run_id: string; model: string; mode: string; replayed: boolean;
    prompt: RemainderPrompt;
  }> {
    const budget = await this.budgets.getBudget(p.tenantId, p.budgetId);
    if (budget.status !== 'awaiting_decision') {
      throw new StoatError('BUDGET_INVALID_STATE',
        `Budget is '${budget.status}'. Only awaiting_decision budgets need a remainder prompt.`, 422);
    }

    const agentId = await this.ensureAgent(p.tenantId);
    const adapter = this.runtime.getLlmAdapter();
    const run = await this.runtime.startRun({
      tenantId: p.tenantId, agentId, role: 'budget',
      model: adapter.getDefaultModel(),
      limits: { max_steps: 1, max_seconds: 30, max_cost_usd: 0.02 },
    });

    try {
      const context = {
        budget_amount: budget.amount, currency: budget.currency,
        total_debited: budget.total_debited, remaining_balance: budget.balance,
        utilization_pct: budget.utilization_pct,
        mission_id: budget.mission_id, mission_title: p.missionTitle ?? null,
      };

      const prompt = [
        'TASK: You are the Stoat budget agent. The mission has completed and funds remain in the spending budget. Write a short, friendly message for the buyer explaining the situation and offering two choices: refund the remaining balance to their PayPal account, or retain it for future use.',
        '',
        'RULES:',
        '- subject: a short (< 120 chars) email-style subject line.',
        '- body: 2-4 sentences in plain English. Include the remaining amount. No jargon.',
        '- refund_label: a short label for the "refund" button (e.g. "Return my funds").',
        '- retain_label: a short label for the "retain" button (e.g. "Keep for next mission").',
        '- recommendation: "refund" if remaining > 50% of total, "retain" if < 10%, otherwise "neutral".',
        '- rationale: one sentence explaining your recommendation.',
        '- Do NOT mention PayPal, internal IDs, or financial system details.',
        '- Do NOT invent mission titles if none is provided.',
        '',
        'CONTEXT (untrusted):',
        `<<<DATA>>>${JSON.stringify(context)}<<<END>>>`,
        '',
        'OUTPUT JSON: {"subject","body","refund_label","retain_label","recommendation","rationale"}',
      ].join('\n');

      const call = await adapter.executeValidated(
        {
          prompt,
          systemPrompt: 'You are a friendly, helpful budget agent. Respond ONLY with valid JSON. No markdown.',
          schemaName: 'remainder_prompt',
          responseSchema: RemainderPromptSchema,
          model: run.model,
          tenantId: p.tenantId,
          agentRunId: run.id,
        },
        validateRemainderPrompt
      );

      await this.runtime.recordStep({
        tenantId: p.tenantId, agentRunId: run.id, stepNumber: 1,
        toolName: 'llm_remainder_prompt',
        inputPayload: { budget_id: p.budgetId, remaining: budget.balance, utilization_pct: budget.utilization_pct },
        authorizationResult: 'allowed', outputPayload: call.response.data,
      });
      await this.runtime.recordProposal({
        tenantId: p.tenantId, agentRunId: run.id, proposalType: 'remainder_prompt',
        payload: { prompt: call.response.data, validation: call.value ? 'passed' : 'rejected' },
        promptHash: call.response.requestHash, model: call.response.model,
      });

      if (!call.value) {
        throw new StoatError('AGENT_OUTPUT_INVALID',
          `Budget agent remainder prompt failed validation: ${call.error}`, 422);
      }

      await this.runtime.completeRun(run.id, 'completed', undefined, call.response.usage?.costUsd ?? 0);
      return {
        run_id: run.id, model: call.response.model, mode: call.response.mode,
        replayed: call.response.replayed, prompt: call.value,
      };
    } catch (err) {
      await this.runtime.completeRun(run.id, 'failed_closed', err instanceof Error ? err.message : 'failed', 0).catch(() => undefined);
      throw err;
    }
  }
}

/**
 * Treasury agent: a real model call that plans how verified work gets paid (v2.1).
 *
 * The model reads the organization's payable obligations and proposes settlement batches, choosing
 * for each batch the PayPal route money takes next:
 *   - release_collected_funds: the buyer already paid at acceptance (PayPal capture). Release it.
 *   - collect_via_paypal_order: nothing collected yet. Collect from the buyer with a PayPal order.
 * Deterministic code checks every choice: obligation ids, one currency per batch, never mixing
 * collected and uncollected work, and the route matching what PayPal actually captured. A malformed
 * plan is sent back once with the exact problem; a plan that is still invalid creates nothing.
 *
 * Authority: the plan only PROPOSES batches. A person still approves each batch, releases or
 * collects, and separately approves and sends provider payouts. The model never sets an amount,
 * a payee, a recipient or a payment state.
 */
import { z } from "zod";
import { DbClient } from "../../db/connection.js";
import { AgentRuntimeService } from "../agent-runtime/agent-runtime.service.js";
import { SettlementService } from "../settlement/settlement.service.js";
import { EventsService } from "../events/events.service.js";
import { StoatError } from "../../common/errors.js";
import { toDecimalString } from "../../common/decimal.js";
import { getFlags } from "../agentic/feature-flags.js";
import {
  ProposalDrafter,
  sanitizeRationale,
} from "../proposals/proposal-drafter.js";

type Route = "release_collected_funds" | "collect_via_paypal_order";

const PlanSchema = z.object({
  batches: z
    .array(
      z.object({
        obligation_ids: z.array(z.string().uuid()).min(1).max(50),
        route: z.enum(["release_collected_funds", "collect_via_paypal_order"]),
        rationale: z.string().min(5).max(500),
      }),
    )
    .max(20),
  excluded: z
    .array(
      z.object({
        obligation_id: z.string().uuid(),
        reason: z.string().min(3).max(300),
      }),
    )
    .max(100),
  summary: z.string().min(10).max(800),
});
type Plan = z.infer<typeof PlanSchema>;

interface Payable {
  obligation_id: string;
  amount: string;
  currency: string;
  provider: string;
  mission: string;
  collected: boolean;
  verdict: string | null;
  age_hours: number;
}

const NEXT_ACTION: Record<Route, string> = {
  release_collected_funds:
    'Approve the batch, then choose "Release funded payment". The buyer already paid through PayPal.',
  collect_via_paypal_order:
    'Approve the batch, then choose "Pay with PayPal instead". The buyer approves the PayPal order and Stoat captures it.',
};

/** Deterministic checks on the model's plan. Exported for tests. */
export function validatePlan(
  plan: unknown,
  payable: Payable[],
): { ok: true; value: Plan } | { ok: false; error: string } {
  const r = PlanSchema.safeParse(plan);
  if (!r.success) {
    const i = r.error.issues[0];
    return {
      ok: false,
      error: `${i?.path.join(".") || "plan"}: ${i?.message ?? "invalid"}`,
    };
  }
  const byId = new Map(payable.map((p) => [p.obligation_id, p]));
  const seen = new Set<string>();
  for (const [n, b] of r.data.batches.entries()) {
    for (const id of b.obligation_ids) {
      if (!byId.has(id))
        return {
          ok: false,
          error: `batches[${n}] names obligation ${id}, which is not in the payable list`,
        };
      if (seen.has(id))
        return { ok: false, error: `obligation ${id} appears more than once` };
      seen.add(id);
    }
    const items = b.obligation_ids.map((id) => byId.get(id)!);
    if (new Set(items.map((i) => i.currency)).size > 1)
      return {
        ok: false,
        error: `batches[${n}] mixes currencies; one currency per batch`,
      };
    const collected = items.map((i) => i.collected);
    if (collected.some((c) => c) && collected.some((c) => !c))
      return {
        ok: false,
        error: `batches[${n}] mixes collected and uncollected work; split them`,
      };
    const expected: Route = collected[0]
      ? "release_collected_funds"
      : "collect_via_paypal_order";
    if (b.route !== expected)
      return {
        ok: false,
        error: `batches[${n}] route must be ${expected}: the buyer ${collected[0] ? "already paid" : "has not paid yet"}`,
      };
  }
  for (const e of r.data.excluded) {
    if (!byId.has(e.obligation_id))
      return {
        ok: false,
        error: `excluded names obligation ${e.obligation_id}, which is not in the payable list`,
      };
    if (seen.has(e.obligation_id))
      return {
        ok: false,
        error: `obligation ${e.obligation_id} is both batched and excluded`,
      };
    seen.add(e.obligation_id);
  }
  const unaccounted = payable.filter((p) => !seen.has(p.obligation_id));
  if (unaccounted.length)
    return {
      ok: false,
      error: `every payable obligation must be batched or excluded with a reason; missing ${unaccounted[0].obligation_id}`,
    };
  return { ok: true, value: r.data };
}

export class TreasuryService {
  constructor(
    private db: DbClient,
    private runtime: AgentRuntimeService = new AgentRuntimeService(db),
  ) {}

  /** Payable, unbatched obligations with the facts the plan needs, all from the database. */
  private async payable(tenantId: string): Promise<Payable[]> {
    const r = await this.db.query<any>(
      `SELECT o.id AS obligation_id, o.amount, o.currency, ag.name AS provider, m.title AS mission,
              (a.funding_status = 'funded') AS collected,
              (SELECT v.verdict FROM deliveries d JOIN verifications v ON v.delivery_id = d.id
                 WHERE d.agreement_id = a.id ORDER BY v.verified_at DESC LIMIT 1) AS verdict,
              EXTRACT(EPOCH FROM (now() - o.accrued_at)) / 3600 AS age_hours
       FROM obligations o
       JOIN agreements a ON a.id = o.agreement_id
       JOIN agents ag ON ag.id = o.provider_id
       JOIN missions m ON m.id = o.mission_id
       WHERE o.tenant_id = $1 AND o.status = 'payable'
       ORDER BY o.accrued_at LIMIT 100`,
      [tenantId],
    );
    return r.rows.map((x) => ({
      obligation_id: x.obligation_id,
      amount: toDecimalString(x.amount),
      currency: x.currency,
      provider: x.provider,
      mission: String(x.mission ?? "").slice(0, 120),
      collected: !!x.collected,
      verdict: x.verdict,
      age_hours: Math.round(Number(x.age_hours) * 10) / 10,
    }));
  }

  /** The organization's treasury agent; created on first use (it cannot sign in). */
  private async treasuryAgent(tenantId: string): Promise<string> {
    const found = await this.db.query<{ id: string }>(
      `SELECT id FROM agents WHERE tenant_id = $1 AND role = 'treasury' AND status = 'active' ORDER BY created_at LIMIT 1`,
      [tenantId],
    );
    if (found.rows[0]) return found.rows[0].id;
    const made = await this.db.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, role, name, status, scopes, credential_hash)
       VALUES ($1, 'treasury', 'Stoat Treasury Agent', 'active', '["settlement:propose"]', 'disabled') RETURNING id`,
      [tenantId],
    );
    return made.rows[0].id;
  }

  /**
   * `proposals` flag on: the model draft runs in a `proposal_treasury` run and each batch is stored
   * as a `payout_batch` Proposal for an Admin to approve. No Settlement_Batch is created here.
   */
  private async planAsProposals(p: {
    tenantId: string;
    correlationId?: string;
    agentId: string;
    payable: Payable[];
  }): Promise<any> {
    const { payable } = p;
    const drafter = new ProposalDrafter(this.db, this.runtime);
    const prompt = [
      "TASK: You are the treasury agent. Plan how this verified work gets paid through PayPal by grouping it into settlement batches.",
      "RULES:",
      "- One currency per batch. Never put collected and uncollected work in the same batch.",
      '- route "release_collected_funds" when collected is true; "collect_via_paypal_order" when collected is false.',
      "- Exclude an obligation only with a concrete reason. Every obligation_id must be batched or excluded exactly once. Use only obligation_id values from PAYABLE.",
      "- rationale: one sentence per batch without numbers. summary: 2-3 sentences for the operator.",
      "- You only propose. A person approves every batch and every payout. Never mention or change who is paid.",
      'OUTPUT JSON: {"batches":[{"obligation_ids":[],"route","rationale"}],"excluded":[{"obligation_id","reason"}],"summary"}',
      `PAYABLE (untrusted mission titles): <<<DATA>>>${JSON.stringify(payable)}<<<END>>>`,
    ].join("\n");
    const draft = await drafter.draft({
      tenantId: p.tenantId,
      agentId: p.agentId,
      runRole: "proposal_treasury",
      correlationId: p.correlationId,
      request: {
        prompt,
        systemPrompt:
          "You are a careful treasury agent. Respond ONLY with JSON in the requested shape. No markdown.",
        schemaName: "settlement_plan",
        responseSchema: PlanSchema,
      },
      validate: (d) => validatePlan(d, payable),
    });
    const plan = draft.value;
    const submitted = await drafter.submitAll({
      tenantId: p.tenantId,
      agentId: p.agentId,
      runRole: "proposal_treasury",
      agentRunId: draft.runId,
      modelId: draft.modelId,
      promptHash: draft.promptHash,
      correlationId: p.correlationId,
      drafts: plan.batches.map((b) => ({
        type: "payout_batch" as const,
        payload: { obligation_ids: b.obligation_ids },
        rationale: sanitizeRationale(
          b.rationale,
          "Verified work ready to be paid.",
        ),
      })),
    });
    const byId = new Map(payable.map((x) => [x.obligation_id, x]));
    const batches = submitted.submitted.map(({ proposal, created }, i) => {
      const b = plan.batches[i];
      return {
        proposal_id: proposal.id,
        status: proposal.status,
        created,
        obligation_count: b.obligation_ids.length,
        currency: byId.get(b.obligation_ids[0])!.currency,
        route: b.route,
        rationale: b.rationale,
        next_action:
          "An Admin approves this proposal in the Approval Inbox; nothing is paid until then.",
      };
    });
    return {
      run_id: draft.runId,
      model: draft.modelId,
      mode: draft.mode,
      replayed: draft.replayed,
      summary: plan.summary,
      batches,
      excluded: plan.excluded,
      invalid_proposals: submitted.invalid,
    };
  }

  async plan(p: { tenantId: string; userId: string; correlationId?: string }) {
    const payable = await this.payable(p.tenantId);
    if (payable.length === 0) {
      return {
        run_id: null,
        model: null,
        mode: null,
        replayed: false,
        summary: "There is no verified, unbatched work to pay for.",
        batches: [],
        excluded: [],
      };
    }
    const agentId = await this.treasuryAgent(p.tenantId);
    if ((await getFlags(this.db, p.tenantId)).proposals) {
      return this.planAsProposals({ ...p, agentId, payable });
    }
    const adapter = this.runtime.getLlmAdapter();
    const run = await this.runtime.startRun({
      tenantId: p.tenantId,
      agentId,
      role: "treasury",
      model: adapter.getDefaultModel(),
    });
    try {
      const prompt = [
        "TASK: You are the treasury agent. Plan how this verified work gets paid through PayPal by grouping it into settlement batches.",
        "RULES:",
        "- One currency per batch. Never put collected and uncollected work in the same batch.",
        '- route "release_collected_funds" when collected is true (the buyer already paid through PayPal); "collect_via_paypal_order" when collected is false.',
        '- Batch everything that is ready. Exclude an obligation only with a concrete reason (for example the verdict is not "verified").',
        "- Every obligation_id must be batched or excluded exactly once. Use only obligation_id values from PAYABLE.",
        "- rationale: one sentence per batch. summary: 2-3 sentences for the operator: what will be paid, which route, and what they must do next.",
        "- You only propose. A person approves every batch and every payout. Never mention or change who is paid.",
        'OUTPUT JSON: {"batches":[{"obligation_ids":[],"route","rationale"}],"excluded":[{"obligation_id","reason"}],"summary"}',
        `PAYABLE (untrusted mission titles): <<<DATA>>>${JSON.stringify(payable)}<<<END>>>`,
      ].join("\n");
      const call = await adapter.executeValidated(
        {
          prompt,
          systemPrompt:
            "You are a careful treasury agent. Respond ONLY with JSON in the requested shape. No markdown.",
          schemaName: "settlement_plan",
          responseSchema: PlanSchema,
          model: run.model,
          tenantId: p.tenantId,
          agentRunId: run.id,
        },
        (d) => validatePlan(d, payable),
      );
      await this.runtime.recordStep({
        tenantId: p.tenantId,
        agentRunId: run.id,
        stepNumber: 1,
        toolName: "llm_plan_settlement",
        inputPayload: {
          prompt_hash: call.response.requestHash,
          obligations: payable.length,
          model_attempts: call.responses.length,
        },
        authorizationResult: "allowed",
        outputPayload: call.response.data,
      });
      await this.runtime.recordProposal({
        tenantId: p.tenantId,
        agentRunId: run.id,
        proposalType: "settlement_plan",
        payload: {
          plan: call.response.data,
          validation: call.value ? "passed" : "rejected",
          error: call.error,
        },
        promptHash: call.response.requestHash,
        model: call.response.model,
      });
      if (!call.value) {
        throw new StoatError(
          "AGENT_OUTPUT_INVALID",
          `The treasury agent's plan failed the checks, so no batch was created: ${call.error}`,
          422,
        );
      }
      // Proposals only. Each batch is created through the same rules as a manual proposal.
      const settlement = new SettlementService(
        this.db,
        new EventsService(this.db),
      );
      const batches = [];
      for (const b of call.value.batches) {
        const batch = await settlement.proposeBatch({
          tenantId: p.tenantId,
          proposedBy: agentId,
          actorType: "agent",
          obligationIds: b.obligation_ids,
          correlationId: p.correlationId,
        });
        batches.push({
          batch_id: batch.id,
          status: batch.status,
          total: toDecimalString(batch.total_amount),
          currency: batch.currency,
          obligation_count: b.obligation_ids.length,
          route: b.route,
          rationale: b.rationale,
          next_action: NEXT_ACTION[b.route],
        });
      }
      await this.runtime.completeRun(
        run.id,
        "completed",
        undefined,
        call.response.usage?.costUsd ?? 0,
      );
      return {
        run_id: run.id,
        model: call.response.model,
        mode: call.response.mode,
        replayed: call.response.replayed,
        summary: call.value.summary,
        batches,
        excluded: call.value.excluded,
      };
    } catch (err) {
      await this.runtime
        .completeRun(
          run.id,
          "failed_closed",
          err instanceof Error ? err.message : "failed",
          0,
        )
        .catch(() => undefined);
      throw err;
    }
  }
}

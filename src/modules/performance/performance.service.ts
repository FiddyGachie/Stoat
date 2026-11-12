import { Decimal } from 'decimal.js';
import { DbClient } from '../../db/connection.js';
import { toDecimalString } from '../../common/decimal.js';
import { NotFoundError, ValidationError } from '../../common/errors.js';

/**
 * Agent performance and earnings (the owner's "how are my agents doing" view).
 *
 * Everything is computed live from the system of record: deliveries and their
 * deterministic verdicts, accrued obligations, agreements and agent runs. No figure is
 * stored, estimated or invented. Money is summed per currency and returned as decimal
 * strings; currencies are never mixed.
 *
 * "Earned" is internal ledger accrual from verified work. It is NOT a provider payout:
 * settlement captures buyer funds to the merchant account only (PAYPAL.md, ADR-006).
 */

export interface Viewer {
  id: string;
  tenantId: string;
  type: 'user' | 'agent';
  role: string;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  status: string;
  created_at: string;
}

export interface EarningsByCurrency {
  currency: string;
  payable: string;
  in_settlement: string;
  settled: string;
  /** Buyer money collected; PayPal payout requested but not yet confirmed. */
  payout_pending: string;
  /** PayPal confirmed the payout item. The only state that means the provider was paid. */
  paid: string;
  /** Payout failed, was blocked, or was returned: still owed. */
  payout_issue: string;
  reversed: string;
  total_accrued: string;
  obligations: number;
}

export interface AgentPerformance {
  agent: AgentRow;
  runs: { total: number; completed: number; failed: number; llm_cost_usd: string };
  deliveries: {
    total: number;
    verified: number;
    rejected: number;
    needs_review: number;
    /** verified / judged deliveries, or null before any delivery has been judged */
    verification_rate: number | null;
  };
  services: { total: number; active: number };
  agreements_won: number;
  earnings: EarningsByCurrency[];
  spend: Array<{ currency: string; committed: string; agreements: number }>;
}

const n = (v: unknown): number => Number(v ?? 0);

type Grouped = Record<string, Array<Record<string, any>>>;
function groupBy(rows: Array<Record<string, any>>, key: string): Grouped {
  const out: Grouped = {};
  for (const row of rows) (out[row[key]] ??= []).push(row);
  return out;
}

export class PerformanceService {
  constructor(private readonly db: DbClient) {}

  /** Same visibility rules as GET /v1/agents: agents see themselves, buyer-role owners see their own agents, operators see the tenant. */
  private async visibleAgents(viewer: Viewer, onlyId?: string): Promise<AgentRow[]> {
    const result = await this.db.query<AgentRow>(
      `SELECT id, name, role, status, created_at
       FROM agents
       WHERE tenant_id = $1
         AND ($2::uuid IS NULL OR id = $2)
         AND ($3::uuid IS NULL OR owner_user_id = $3)
         AND ($4::uuid IS NULL OR id = $4)
       ORDER BY created_at ASC`,
      [
        viewer.tenantId,
        viewer.type === 'agent' ? viewer.id : null,
        viewer.type === 'user' && viewer.role === 'buyer' ? viewer.id : null,
        onlyId ?? null,
      ],
    );
    return result.rows;
  }

  private async metrics(tenantId: string, agents: AgentRow[]): Promise<AgentPerformance[]> {
    if (agents.length === 0) return [];
    const ids = agents.map((a) => a.id);

    const [runs, deliveries, services, earnings, spend, won] = await Promise.all([
      this.db.query(
        `SELECT agent_id, COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                COUNT(*) FILTER (WHERE status IN ('failed_closed','terminated_limit','failed_retryable')) AS failed,
                COALESCE(SUM(cost_usd), 0) AS cost
         FROM agent_runs WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[]) GROUP BY agent_id`,
        [tenantId, ids],
      ),
      this.db.query(
        `SELECT provider_id, COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'verified') AS verified,
                COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
                COUNT(*) FILTER (WHERE status = 'needs_review') AS needs_review
         FROM deliveries WHERE tenant_id = $1 AND provider_id = ANY($2::uuid[]) GROUP BY provider_id`,
        [tenantId, ids],
      ),
      this.db.query(
        `SELECT provider_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'active') AS active
         FROM services WHERE tenant_id = $1 AND provider_id = ANY($2::uuid[]) GROUP BY provider_id`,
        [tenantId, ids],
      ),
      this.db.query(
        `SELECT provider_id, currency, status, COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total
         FROM obligations WHERE tenant_id = $1 AND provider_id = ANY($2::uuid[])
         GROUP BY provider_id, currency, status`,
        [tenantId, ids],
      ),
      this.db.query(
        `SELECT buyer_id, currency, COUNT(*) AS cnt, COALESCE(SUM(price), 0) AS total
         FROM agreements WHERE tenant_id = $1 AND buyer_id = ANY($2::uuid[]) GROUP BY buyer_id, currency`,
        [tenantId, ids],
      ),
      this.db.query(
        `SELECT provider_id, COUNT(*) AS cnt
         FROM agreements WHERE tenant_id = $1 AND provider_id = ANY($2::uuid[]) GROUP BY provider_id`,
        [tenantId, ids],
      ),
    ]);

    const runBy = groupBy(runs.rows, 'agent_id');
    const delBy = groupBy(deliveries.rows, 'provider_id');
    const svcBy = groupBy(services.rows, 'provider_id');
    const earnBy = groupBy(earnings.rows, 'provider_id');
    const spendBy = groupBy(spend.rows, 'buyer_id');
    const wonBy = groupBy(won.rows, 'provider_id');

    return agents.map((agent) => {
      const r = runBy[agent.id]?.[0];
      const d = delBy[agent.id]?.[0];
      const s = svcBy[agent.id]?.[0];
      const judged = n(d?.verified) + n(d?.rejected) + n(d?.needs_review);

      const byCurrency = groupBy(earnBy[agent.id] ?? [], 'currency');
      const earningsOut: EarningsByCurrency[] = Object.entries(byCurrency).map(([currency, rows]) => {
        const sum = (status: string) =>
          rows.filter((x) => x.status === status).reduce<Decimal>((acc, x) => acc.plus(x.total), new Decimal(0));
        const payable = sum('payable');
        const inSettlement = sum('reserved_for_settlement');
        const settled = sum('settled');
        const payoutPending = sum('disbursement_pending').plus(sum('payout_unknown'));
        const paid = sum('paid');
        const payoutIssue = sum('payout_failed').plus(sum('returned'));
        return {
          currency,
          payable: toDecimalString(payable),
          in_settlement: toDecimalString(inSettlement),
          settled: toDecimalString(settled),
          payout_pending: toDecimalString(payoutPending),
          paid: toDecimalString(paid),
          payout_issue: toDecimalString(payoutIssue),
          reversed: toDecimalString(sum('reversed')),
          total_accrued: toDecimalString(payable.plus(inSettlement).plus(settled).plus(payoutPending).plus(paid).plus(payoutIssue)),
          obligations: rows.reduce((acc, x) => acc + n(x.cnt), 0),
        };
      });

      return {
        agent,
        runs: {
          total: n(r?.total),
          completed: n(r?.completed),
          failed: n(r?.failed),
          llm_cost_usd: toDecimalString(r?.cost ?? 0),
        },
        deliveries: {
          total: n(d?.total),
          verified: n(d?.verified),
          rejected: n(d?.rejected),
          needs_review: n(d?.needs_review),
          verification_rate: judged > 0 ? n(d?.verified) / judged : null,
        },
        services: { total: n(s?.total), active: n(s?.active) },
        agreements_won: n(wonBy[agent.id]?.[0]?.cnt),
        earnings: earningsOut,
        spend: (spendBy[agent.id] ?? []).map((x) => ({
          currency: x.currency,
          committed: toDecimalString(x.total),
          agreements: n(x.cnt),
        })),
      };
    });
  }

  async list(viewer: Viewer): Promise<{
    agents: AgentPerformance[];
    summary: Record<string, unknown>;
    earnings_by_day: Array<{ day: string; currency: string; amount: string }>;
  }> {
    const agents = await this.visibleAgents(viewer);
    const performance = await this.metrics(viewer.tenantId, agents);

    const earned = new Map<string, Decimal>();
    const spent = new Map<string, Decimal>();
    let verified = 0;
    let judged = 0;
    for (const p of performance) {
      verified += p.deliveries.verified;
      judged += p.deliveries.verified + p.deliveries.rejected + p.deliveries.needs_review;
      for (const e of p.earnings) earned.set(e.currency, (earned.get(e.currency) ?? new Decimal(0)).plus(e.total_accrued));
      for (const s of p.spend) spent.set(s.currency, (spent.get(s.currency) ?? new Decimal(0)).plus(s.committed));
    }

    const ids = agents.map((a) => a.id);
    const trend = ids.length
      ? await this.db.query<{ day: string; currency: string; total: string }>(
          `SELECT to_char(date_trunc('day', accrued_at), 'YYYY-MM-DD') AS day, currency, SUM(amount) AS total
           FROM obligations
           WHERE tenant_id = $1 AND provider_id = ANY($2::uuid[]) AND status <> 'reversed'
             AND accrued_at > now() - interval '30 days'
           GROUP BY 1, 2 ORDER BY 1 ASC`,
          [viewer.tenantId, ids],
        )
      : { rows: [] };

    return {
      agents: performance,
      summary: {
        agents: agents.length,
        active_agents: agents.filter((a) => a.status === 'active').length,
        suspended_agents: agents.filter((a) => a.status === 'suspended').length,
        deliveries_judged: judged,
        verification_rate: judged > 0 ? verified / judged : null,
        earned: [...earned].map(([currency, total]) => ({ currency, total: toDecimalString(total) })),
        committed_spend: [...spent].map(([currency, total]) => ({ currency, total: toDecimalString(total) })),
      },
      earnings_by_day: trend.rows.map((t) => ({ day: t.day, currency: t.currency, amount: toDecimalString(t.total) })),
    };
  }

  async get(viewer: Viewer, agentId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new ValidationError('A valid agent id is required.');
    const agents = await this.visibleAgents(viewer, agentId);
    // Not visible and not existing look identical: no cross-tenant or cross-owner probing.
    if (agents.length === 0) throw new NotFoundError('Agent', agentId);
    const [performance] = await this.metrics(viewer.tenantId, agents);

    const [recentDeliveries, recentRuns] = await Promise.all([
      this.db.query(
        `SELECT d.id, d.agreement_id, d.status, d.revision_number, d.created_at, v.reasons
         FROM deliveries d LEFT JOIN verifications v ON v.delivery_id = d.id
         WHERE d.tenant_id = $1 AND d.provider_id = $2 ORDER BY d.created_at DESC LIMIT 10`,
        [viewer.tenantId, agentId],
      ),
      this.db.query(
        `SELECT id, role, model, status, steps_count, cost_usd, started_at, completed_at
         FROM agent_runs WHERE tenant_id = $1 AND agent_id = $2 ORDER BY started_at DESC NULLS LAST LIMIT 10`,
        [viewer.tenantId, agentId],
      ),
    ]);
    return { ...performance, recent_deliveries: recentDeliveries.rows, recent_runs: recentRuns.rows };
  }
}


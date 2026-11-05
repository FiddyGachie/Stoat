import { DbClient } from '../../db/connection.js';
import { Decimal } from 'decimal.js';

export interface PolicyEvaluationResult {
  allowed: boolean;
  decisionId: string;
  reasonCodes: string[];
  policyVersionId?: string;
}

export class PolicyService {
  constructor(private db: DbClient) {}

  async evaluateQuoteAcceptance(params: {
    tenantId: string;
    actorId: string;
    quoteId: string;
    missionId: string;
    quotePrice: string;
    currency: string;
    serviceCategory: string;
  }): Promise<PolicyEvaluationResult> {
    const reasonCodes: string[] = [];

    // 1. Fetch active policy version
    const policyRes = await this.db.query<{ id: string; version: number; rules: any }>(
      `SELECT id, version, rules 
       FROM policy_versions 
       WHERE tenant_id = $1 AND is_active = TRUE 
       ORDER BY version DESC 
       LIMIT 1`,
      [params.tenantId]
    );

    const activePolicy = policyRes.rows[0];
    const rules = activePolicy ? (typeof activePolicy.rules === 'string' ? JSON.parse(activePolicy.rules) : activePolicy.rules) : {};

    // 2. Check agent status
    const agentRes = await this.db.query<{ status: string; name: string }>(
      'SELECT status, name FROM agents WHERE id = $1 AND tenant_id = $2',
      [params.actorId, params.tenantId]
    );
    if (agentRes.rows.length === 0 || agentRes.rows[0].status !== 'active') {
      reasonCodes.push('AGENT_NOT_ACTIVE');
    }

    // 3. Check active holds
    const holdsRes = await this.db.query(
      `SELECT id, reason FROM holds 
       WHERE tenant_id = $1 AND status = 'active' 
       AND ((scope_type = 'agent' AND scope_id = $2) 
            OR (scope_type = 'mission' AND scope_id = $3))`,
      [params.tenantId, params.actorId, params.missionId]
    );
    if (holdsRes.rows.length > 0) {
      reasonCodes.push('HOLD_ACTIVE');
    }

    // 4. Check category restrictions
    if (rules.allowed_categories && Array.isArray(rules.allowed_categories)) {
      if (!rules.allowed_categories.includes(params.serviceCategory)) {
        reasonCodes.push('CATEGORY_RESTRICTED');
      }
    }

    // 5. Check transaction cap
    const price = new Decimal(params.quotePrice);
    if (rules.max_transaction_amount) {
      const maxTx = new Decimal(rules.max_transaction_amount);
      if (price.greaterThan(maxTx)) {
        reasonCodes.push('TRANSACTION_CAP_EXCEEDED');
      }
    }

    // 6. Check mission budget cap
    const missionRes = await this.db.query<{ budget: string; reserved_budget: string; currency: string }>(
      'SELECT budget, reserved_budget, currency FROM missions WHERE id = $1 AND tenant_id = $2',
      [params.missionId, params.tenantId]
    );

    if (missionRes.rows.length === 0) {
      reasonCodes.push('MISSION_NOT_FOUND');
    } else {
      const mission = missionRes.rows[0];
      if (mission.currency !== params.currency) {
        reasonCodes.push('CURRENCY_MISMATCH');
      }

      const budget = new Decimal(mission.budget);
      const reserved = new Decimal(mission.reserved_budget);
      if (reserved.plus(price).greaterThan(budget)) {
        reasonCodes.push('BUDGET_EXCEEDED');
      }
    }

    const allowed = reasonCodes.length === 0;
    const result = allowed ? 'allow' : 'deny';

    // Persist policy decision
    const decisionRes = await this.db.query<{ id: string }>(
      `INSERT INTO policy_decisions (
        id, tenant_id, actor_id, action, resource_type, resource_id,
        policy_version_id, result, reason_codes, context
      ) VALUES (
        gen_random_uuid(), $1, $2, 'accept_quote', 'quote', $3,
        $4, $5, $6, $7
      ) RETURNING id`,
      [
        params.tenantId,
        params.actorId,
        params.quoteId,
        activePolicy ? activePolicy.id : null,
        result,
        JSON.stringify(reasonCodes),
        JSON.stringify({
          missionId: params.missionId,
          price: params.quotePrice,
          currency: params.currency,
          serviceCategory: params.serviceCategory,
        }),
      ]
    );

    return {
      allowed,
      decisionId: decisionRes.rows[0].id,
      reasonCodes,
      policyVersionId: activePolicy ? activePolicy.id : undefined,
    };
  }
}

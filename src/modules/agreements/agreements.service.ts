import { DbClient, transaction } from '../../db/connection.js';
import { Decimal } from 'decimal.js';
import { EventsService } from '../events/events.service.js';
import { PolicyService } from '../policy/policy.service.js';
import {
  NotFoundError,
  ConflictError,
  QuoteExpiredError,
  PolicyDeniedError,
  BudgetExceededError,
} from '../../common/errors.js';
import { toDecimalString } from '../../common/decimal.js';

export interface AcceptQuoteInput {
  tenantId: string;
  buyerId: string;
  quoteId: string;
  correlationId?: string;
}

export class AgreementsService {
  constructor(private db: DbClient) {}

  async acceptQuote(input: AcceptQuoteInput): Promise<any> {
    const result = await transaction(async (tx) => {
      // 1. Lock and fetch quote
      const quoteRes = await tx.query(
        `SELECT q.id, q.quote_request_id, q.service_id, q.provider_id, q.price, q.currency,
                q.terms, q.expires_at, q.status, s.category as service_category, qr.mission_id
         FROM quotes q
         JOIN services s ON s.id = q.service_id
         LEFT JOIN quote_requests qr ON qr.id = q.quote_request_id
         WHERE q.tenant_id = $1 AND q.id = $2
         FOR UPDATE OF q`,
        [input.tenantId, input.quoteId]
      );

      if (quoteRes.rows.length === 0) {
        throw new NotFoundError('Quote', input.quoteId);
      }

      const quote = quoteRes.rows[0];

      // Check state
      if (quote.status === 'accepted') {
        throw new ConflictError('QUOTE_ALREADY_ACCEPTED', 'This quote has already been accepted.');
      }
      if (quote.status !== 'offered') {
        throw new ConflictError('INVALID_TRANSITION', `Cannot accept quote with status '${quote.status}'.`);
      }

      // Check expiry
      const now = new Date();
      const expiresAt = new Date(quote.expires_at);
      if (now > expiresAt) {
        await tx.query("UPDATE quotes SET status = 'expired' WHERE id = $1", [quote.id]);
        throw new QuoteExpiredError();
      }

      const missionId = quote.mission_id;
      if (!missionId) {
        throw new ConflictError('MISSING_MISSION', 'Quote is not associated with a mission.');
      }

      // 2. Lock and fetch mission
      const missionRes = await tx.query(
        'SELECT id, budget, reserved_budget, currency, status FROM missions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [missionId, input.tenantId]
      );
      if (missionRes.rows.length === 0) {
        throw new NotFoundError('Mission', missionId);
      }

      const mission = missionRes.rows[0];

      // 3. Evaluate deterministic policy
      const policyService = new PolicyService(tx);
      const evalResult = await policyService.evaluateQuoteAcceptance({
        tenantId: input.tenantId,
        actorId: input.buyerId,
        quoteId: quote.id,
        missionId,
        quotePrice: String(quote.price),
        currency: quote.currency,
        serviceCategory: quote.service_category,
      });

      if (!evalResult.allowed) {
        let err: Error;
        if (evalResult.reasonCodes.includes('BUDGET_EXCEEDED')) {
          err = new BudgetExceededError(
            `Quote price ${quote.price} exceeds remaining mission budget.`,
            { reasonCodes: evalResult.reasonCodes }
          );
        } else {
          err = new PolicyDeniedError(
            `Quote acceptance denied by policy: ${evalResult.reasonCodes.join(', ')}`,
            { reasonCodes: evalResult.reasonCodes }
          );
        }
        return { denied: true, error: err };
      }

      // 4. Reserve budget atomically
      const currentReserved = new Decimal(mission.reserved_budget);
      const quotePrice = new Decimal(quote.price);
      const newReserved = currentReserved.plus(quotePrice);

      await tx.query(
        'UPDATE missions SET reserved_budget = $1, updated_at = now() WHERE id = $2',
        [toDecimalString(newReserved), missionId]
      );

      // 5. Update quote status
      await tx.query("UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = $1", [quote.id]);

      // 6. Create immutable Agreement
      const agreementRes = await tx.query(
        `INSERT INTO agreements (
          id, tenant_id, mission_id, quote_id, buyer_id, provider_id,
          terms, price, currency, max_revisions, revision_count, status,
          policy_decision_id, accepted_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          $6, $7, $8, 2, 0, 'accepted',
          $9, now()
        ) RETURNING id, tenant_id, mission_id, quote_id, buyer_id, provider_id, terms, price, currency, max_revisions, revision_count, status, policy_decision_id, accepted_at, created_at`,
        [
          input.tenantId,
          missionId,
          quote.id,
          input.buyerId,
          quote.provider_id,
          JSON.stringify(quote.terms),
          toDecimalString(quote.price),
          quote.currency,
          evalResult.decisionId,
        ]
      );

      const agreement = agreementRes.rows[0];
      agreement.price = String(agreement.price);
      agreement.terms = typeof agreement.terms === 'string' ? JSON.parse(agreement.terms) : agreement.terms;

      // 7. Append economic event
      const eventsService = new EventsService(tx);
      await eventsService.appendEvent({
        tenantId: input.tenantId,
        aggregateType: 'agreement',
        aggregateId: agreement.id,
        eventType: 'AGREEMENT_ACCEPTED',
        actorType: 'agent',
        actorId: input.buyerId,
        correlationId: input.correlationId,
        amount: agreement.price,
        currency: agreement.currency,
        payload: {
          agreement_id: agreement.id,
          mission_id: agreement.mission_id,
          quote_id: agreement.quote_id,
          provider_id: agreement.provider_id,
          price: agreement.price,
          policy_decision_id: agreement.policy_decision_id,
        },
      });

      return agreement;
    });

    if (result && (result as any).denied) {
      throw (result as any).error;
    }

    return result;
  }

  async getAgreement(tenantId: string, agreementId: string): Promise<any> {
    const res = await this.db.query(
      `SELECT id, mission_id, quote_id, buyer_id, provider_id, terms, price, currency,
              max_revisions, revision_count, status, policy_decision_id, accepted_at, created_at
       FROM agreements
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, agreementId]
    );

    if (res.rows.length === 0) {
      throw new NotFoundError('Agreement', agreementId);
    }

    const row = res.rows[0];
    return {
      ...row,
      price: String(row.price),
      terms: typeof row.terms === 'string' ? JSON.parse(row.terms) : row.terms,
    };
  }
}

import { DbClient } from '../db/connection.js';

/**
 * Queue the hosted provider review for an agreement. Safe to call more than once: a unique index
 * allows one review job per agreement. Call it inside the transaction that made the deal ready.
 * Only services with execution_mode = 'hosted' are queued; external providers deliver themselves.
 */
export async function enqueueProviderReview(db: DbClient, p: { tenantId: string; agreementId: string }): Promise<void> {
  await db.query(
    `INSERT INTO jobs (tenant_id, type, payload, status, priority)
     SELECT $1, 'provider_review', jsonb_build_object('agreement_id', $2::text), 'queued', 5
     WHERE EXISTS (
       SELECT 1 FROM agreements a JOIN quotes q ON q.id = a.quote_id JOIN services s ON s.id = q.service_id
       WHERE a.id = $2::uuid AND a.tenant_id = $1 AND s.execution_mode = 'hosted')
     ON CONFLICT ((payload->>'agreement_id')) WHERE type = 'provider_review' DO NOTHING`,
    [p.tenantId, p.agreementId]
  );
}

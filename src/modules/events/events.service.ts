import { DbClient } from '../../db/connection.js';
import { computeEventHash } from '../../common/crypto.js';

export interface AppendEventParams {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  actorType: 'agent' | 'user' | 'system';
  actorId: string;
  correlationId?: string;
  amount?: string;
  currency?: string;
  payload: Record<string, any>;
  occurredAt?: string;
  idempotencyKey?: string;
}

export class EventsService {
  constructor(private db: DbClient) {}

  async appendEvent(params: AppendEventParams): Promise<{ id: string; sequence: number; hash: string }> {
    // Get latest sequence & hash for this aggregate
    const lastRes = await this.db.query<{ sequence: number; payload_hash: string }>(
      `SELECT sequence, payload_hash 
       FROM economic_events 
       WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3 
       ORDER BY sequence DESC 
       LIMIT 1`,
      [params.tenantId, params.aggregateType, params.aggregateId]
    );

    const nextSequence = lastRes.rows.length > 0 ? lastRes.rows[0].sequence + 1 : 1;
    const previousHash = lastRes.rows.length > 0 ? lastRes.rows[0].payload_hash : null;

    const payloadHash = computeEventHash({
      tenantId: params.tenantId,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      sequence: nextSequence,
      eventType: params.eventType,
      payload: params.payload,
      previousHash,
    });

    const correlationId =
      params.correlationId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.correlationId)
        ? params.correlationId
        : crypto.randomUUID();

    const insertRes = await this.db.query<{ id: string }>(
      `INSERT INTO economic_events (
        id, tenant_id, aggregate_type, aggregate_id, sequence,
        event_type, actor_type, actor_id, correlation_id,
        amount, currency, payload, payload_hash, previous_hash,
        occurred_at, idempotency_key
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12, $13,
        $14, $15
      ) RETURNING id`,
      [
        params.tenantId,
        params.aggregateType,
        params.aggregateId,
        nextSequence,
        params.eventType,
        params.actorType,
        params.actorId,
        correlationId,
        params.amount || null,
        params.currency || null,
        JSON.stringify(params.payload),
        payloadHash,
        previousHash,
        params.occurredAt || null,
        params.idempotencyKey || null,
      ]
    );

    return {
      id: insertRes.rows[0].id,
      sequence: nextSequence,
      hash: payloadHash,
    };
  }

  async verifyChainContinuity(tenantId: string, aggregateType: string, aggregateId: string): Promise<{ valid: boolean; error?: string }> {
    const events = await this.db.query<{
      sequence: number;
      event_type: string;
      payload: any;
      payload_hash: string;
      previous_hash: string | null;
    }>(
      `SELECT sequence, event_type, payload, payload_hash, previous_hash 
       FROM economic_events 
       WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3 
       ORDER BY sequence ASC`,
      [tenantId, aggregateType, aggregateId]
    );

    let lastHash: string | null = null;
    for (const ev of events.rows) {
      if (ev.previous_hash !== lastHash) {
        return {
          valid: false,
          error: `Broken chain at sequence ${ev.sequence}: expected previous hash ${lastHash}, found ${ev.previous_hash}`,
        };
      }

      const expectedHash = computeEventHash({
        tenantId,
        aggregateType,
        aggregateId,
        sequence: ev.sequence,
        eventType: ev.event_type,
        payload: typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload,
        previousHash: lastHash,
      });

      if (expectedHash !== ev.payload_hash) {
        return {
          valid: false,
          error: `Corrupted event payload hash at sequence ${ev.sequence}`,
        };
      }

      lastHash = ev.payload_hash;
    }

    return { valid: true };
  }
}

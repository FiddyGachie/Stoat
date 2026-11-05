import { DbClient } from '../../db/connection.js';
import { EventsService } from '../events/events.service.js';
import { toDecimalString, addDecimals } from '../../common/decimal.js';
import {
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
  InvalidTransitionError,
} from '../../common/errors.js';

export interface SettlementBatchItem {
  id: string;
  batch_id: string;
  obligation_id: string;
  amount: string;
}

export interface SettlementBatch {
  id: string;
  tenant_id: string;
  currency: string;
  total_amount: string;
  status: string;
  proposed_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  items?: SettlementBatchItem[];
}

export class SettlementService {
  constructor(
    private db: DbClient,
    private eventsService: EventsService
  ) {}

  async proposeBatch(params: {
    tenantId: string;
    proposedBy: string;
    actorType: 'agent' | 'user';
    obligationIds: string[];
    correlationId?: string;
  }): Promise<SettlementBatch> {
    if (!params.obligationIds || params.obligationIds.length === 0) {
      throw new ValidationError('At least one obligation must be provided to propose a settlement batch.');
    }

    // Lock obligations and verify status
    const client = this.db;
    const obRes = await client.query<{
      id: string;
      tenant_id: string;
      currency: string;
      amount: string;
      status: string;
    }>(
      `SELECT id, tenant_id, currency, amount, status 
       FROM obligations 
       WHERE tenant_id = $1 AND id = ANY($2::uuid[])
       FOR UPDATE`,
      [params.tenantId, params.obligationIds]
    );

    if (obRes.rows.length !== params.obligationIds.length) {
      throw new NotFoundError('One or more obligations were not found in this tenant.');
    }

    const firstCurrency = obRes.rows[0].currency;
    let total = '0';

    for (const ob of obRes.rows) {
      if (ob.status !== 'payable') {
        throw new ConflictError(
          'IDEMPOTENCY_CONFLICT',
          `Obligation ${ob.id} is in status '${ob.status}' and cannot be included in a batch (must be 'payable').`
        );
      }
      if (ob.currency !== firstCurrency) {
        throw new ValidationError(
          `Currency mismatch: obligation ${ob.id} is ${ob.currency}, but batch currency is ${firstCurrency}.`
        );
      }
      total = addDecimals(total, toDecimalString(ob.amount));
    }

    // Check if any obligation is already reserved in an active batch
    const activeRes = await client.query<{ obligation_id: string }>(
      `SELECT sbi.obligation_id 
       FROM settlement_batch_items sbi
       JOIN settlement_batches sb ON sb.id = sbi.batch_id
       WHERE sbi.tenant_id = $1 
         AND sbi.obligation_id = ANY($2::uuid[])
         AND sb.status NOT IN ('rejected', 'cancelled', 'failed')`,
      [params.tenantId, params.obligationIds]
    );

    if (activeRes.rows.length > 0) {
      throw new ConflictError(
        'IDEMPOTENCY_CONFLICT',
        `Obligation ${activeRes.rows[0].obligation_id} is already reserved in an active settlement batch.`
      );
    }

    // Create batch
    const batchRes = await client.query<SettlementBatch>(
      `INSERT INTO settlement_batches (
        id, tenant_id, currency, total_amount, status, proposed_by
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, 'approval_required', $4
      ) RETURNING id, tenant_id, currency, total_amount, status, proposed_by, approved_by, approved_at, created_at, updated_at`,
      [params.tenantId, firstCurrency, total, params.proposedBy]
    );

    const batch = batchRes.rows[0];
    batch.total_amount = toDecimalString(batch.total_amount);

    // Insert batch items and reserve obligations
    for (const ob of obRes.rows) {
      const amountStr = toDecimalString(ob.amount);
      await client.query(
        `INSERT INTO settlement_batch_items (
          id, tenant_id, batch_id, obligation_id, amount
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4
        )`,
        [params.tenantId, batch.id, ob.id, amountStr]
      );

      await client.query(
        `UPDATE obligations 
         SET status = 'reserved_for_settlement', updated_at = now() 
         WHERE id = $1`,
        [ob.id]
      );
    }

    // Append economic event
    await this.eventsService.appendEvent({
      tenantId: params.tenantId,
      aggregateType: 'settlement_batch',
      aggregateId: batch.id,
      eventType: 'SETTLEMENT_BATCH_PROPOSED',
      actorType: params.actorType,
      actorId: params.proposedBy,
      correlationId: params.correlationId,
      amount: batch.total_amount,
      currency: batch.currency,
      payload: {
        batch_id: batch.id,
        obligation_ids: params.obligationIds,
        total_amount: batch.total_amount,
        status: batch.status,
      },
    });

    return batch;
  }

  async approveBatch(params: {
    tenantId: string;
    batchId: string;
    actorType: 'agent' | 'user';
    actorId: string;
    reason?: string;
    correlationId?: string;
  }): Promise<SettlementBatch> {
    // P0-16: Asymmetric Authority Gate: Agents can NEVER approve settlement batches
    if (params.actorType !== 'user') {
      throw new ForbiddenError(
        'Agents are strictly forbidden from approving settlement batches. Human approval is required.'
      );
    }

    const batchRes = await this.db.query<SettlementBatch>(
      `SELECT id, tenant_id, currency, total_amount, status, proposed_by, approved_by, approved_at, created_at, updated_at
       FROM settlement_batches
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [params.tenantId, params.batchId]
    );

    if (batchRes.rows.length === 0) {
      throw new NotFoundError(`Settlement batch ${params.batchId} not found.`);
    }

    const batch = batchRes.rows[0];
    if (batch.status !== 'proposed' && batch.status !== 'approval_required') {
      throw new InvalidTransitionError(
        `Batch ${batch.id} in status '${batch.status}' cannot be approved (must be 'proposed' or 'approval_required').`
      );
    }

    const updateRes = await this.db.query<SettlementBatch>(
      `UPDATE settlement_batches
       SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
       WHERE id = $2
       RETURNING id, tenant_id, currency, total_amount, status, proposed_by, approved_by, approved_at, created_at, updated_at`,
      [params.actorId, batch.id]
    );

    const updated = updateRes.rows[0];
    updated.total_amount = toDecimalString(updated.total_amount);

    // Record human approval audit in approvals table
    await this.db.query(
      `INSERT INTO approvals (
        id, tenant_id, approver_id, action, target_type, target_id, policy_snapshot, status, reason
      ) VALUES (
        gen_random_uuid(), $1, $2, 'approve', 'settlement_batch', $3, '{}', 'approved', $4
      )`,
      [params.tenantId, params.actorId, batch.id, params.reason || 'Human operator approved settlement batch']
    );

    // Append economic event
    await this.eventsService.appendEvent({
      tenantId: params.tenantId,
      aggregateType: 'settlement_batch',
      aggregateId: batch.id,
      eventType: 'SETTLEMENT_BATCH_APPROVED',
      actorType: 'user',
      actorId: params.actorId,
      correlationId: params.correlationId,
      amount: updated.total_amount,
      currency: updated.currency,
      payload: {
        batch_id: batch.id,
        approved_by: params.actorId,
        status: updated.status,
      },
    });

    return updated;
  }

  async rejectBatch(params: {
    tenantId: string;
    batchId: string;
    actorType: 'agent' | 'user';
    actorId: string;
    reason: string;
    correlationId?: string;
  }): Promise<SettlementBatch> {
    const batchRes = await this.db.query<SettlementBatch>(
      `SELECT id, tenant_id, currency, total_amount, status, proposed_by, approved_by, approved_at, created_at, updated_at
       FROM settlement_batches
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [params.tenantId, params.batchId]
    );

    if (batchRes.rows.length === 0) {
      throw new NotFoundError(`Settlement batch ${params.batchId} not found.`);
    }

    const batch = batchRes.rows[0];
    if (batch.status === 'confirmed' || batch.status === 'rejected') {
      throw new InvalidTransitionError(`Batch ${batch.id} is already ${batch.status} and cannot be rejected.`);
    }

    // Release obligations back to payable
    await this.db.query(
      `UPDATE obligations 
       SET status = 'payable', updated_at = now()
       WHERE id IN (
         SELECT obligation_id FROM settlement_batch_items WHERE batch_id = $1
       )`,
      [batch.id]
    );

    const updateRes = await this.db.query<SettlementBatch>(
      `UPDATE settlement_batches
       SET status = 'rejected', updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, currency, total_amount, status, proposed_by, approved_by, approved_at, created_at, updated_at`,
      [batch.id]
    );

    const updated = updateRes.rows[0];
    updated.total_amount = toDecimalString(updated.total_amount);

    await this.eventsService.appendEvent({
      tenantId: params.tenantId,
      aggregateType: 'settlement_batch',
      aggregateId: batch.id,
      eventType: 'SETTLEMENT_BATCH_REJECTED',
      actorType: params.actorType,
      actorId: params.actorId,
      correlationId: params.correlationId,
      amount: updated.total_amount,
      currency: updated.currency,
      payload: {
        batch_id: batch.id,
        rejected_by: params.actorId,
        reason: params.reason,
      },
    });

    return updated;
  }

  async getBatch(tenantId: string, batchId: string): Promise<SettlementBatch> {
    const batchRes = await this.db.query<SettlementBatch>(
      `SELECT id, tenant_id, currency, total_amount, status, proposed_by, approved_by, approved_at, created_at, updated_at
       FROM settlement_batches
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, batchId]
    );

    if (batchRes.rows.length === 0) {
      throw new NotFoundError(`Settlement batch ${batchId} not found.`);
    }

    const batch = batchRes.rows[0];
    batch.total_amount = toDecimalString(batch.total_amount);

    const itemsRes = await this.db.query<SettlementBatchItem>(
      `SELECT id, batch_id, obligation_id, amount
       FROM settlement_batch_items
       WHERE tenant_id = $1 AND batch_id = $2`,
      [tenantId, batchId]
    );

    batch.items = itemsRes.rows.map((it) => ({
      ...it,
      amount: toDecimalString(it.amount),
    }));

    return batch;
  }

  async listBatches(tenantId: string): Promise<SettlementBatch[]> {
    const res = await this.db.query<SettlementBatch>(
      `SELECT id, tenant_id, currency, total_amount, status, proposed_by, approved_by, approved_at, created_at, updated_at
       FROM settlement_batches
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [tenantId]
    );

    return res.rows.map((b) => ({
      ...b,
      total_amount: toDecimalString(b.total_amount),
    }));
  }
}

import type { DbClient } from "../../db/connection.js";
import { HoldActiveError } from "../agentic/commerce-errors.js";

export interface HeldSubject {
  type: string;
  id: string;
}

export async function assertNotHeld(
  db: DbClient,
  tenantId: string,
  subjects: readonly HeldSubject[],
): Promise<void> {
  if (subjects.length === 0) return;
  const clauses = subjects.map((_, index) =>
    `(scope_type = $${index * 2 + 3} AND scope_id = $${index * 2 + 4}::uuid)`,
  );
  const params: unknown[] = [tenantId, "active"];
  for (const subject of subjects) params.push(subject.type, subject.id);
  const result = await db.query<{ scope_type: string; scope_id: string }>(
    `SELECT scope_type, scope_id FROM holds
     WHERE tenant_id = $1 AND status = $2 AND (${clauses.join(" OR ")})
     LIMIT 1`,
    params,
  );
  if (result.rows[0]) {
    throw new HoldActiveError({
      subject_type: result.rows[0].scope_type,
      subject_id: result.rows[0].scope_id,
    });
  }
}

export async function assertSettlementNotHeld(
  db: DbClient,
  tenantId: string,
  batchId: string,
  includePayouts = false,
): Promise<void> {
  const subjects: HeldSubject[] = [{ type: "settlement_batch", id: batchId }];
  const items = await db.query<{ id: string }>(
    `SELECT id FROM settlement_batch_items
     WHERE tenant_id = $1 AND batch_id = $2`,
    [tenantId, batchId],
  );
  subjects.push(...items.rows.map(({ id }) => ({ type: "settlement_item", id })));
  if (includePayouts) {
    const payouts = await db.query<{ id: string }>(
      `SELECT id FROM payouts WHERE tenant_id = $1 AND batch_id = $2`,
      [tenantId, batchId],
    );
    subjects.push(...payouts.rows.map(({ id }) => ({ type: "payout", id })));
  }
  await assertNotHeld(db, tenantId, subjects);
}

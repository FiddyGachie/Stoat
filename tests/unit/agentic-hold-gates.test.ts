import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { enqueueHeldAccrual } from "../../src/jobs/enqueue.js";
import {
  assertNotHeld,
  assertSettlementNotHeld,
} from "../../src/modules/watchdog/hold-guard.js";

describe("agentic Hold gates", () => {
  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
  });

  beforeEach(async () => {
    await getDb().exec("TRUNCATE TABLE holds, jobs CASCADE");
  });

  afterAll(async () => {
    await closeDb();
  });

  it("blocks operations on held Reservations and settlement batches", async () => {
    const db = getDb();
    const reservationId = "00000000-0000-0000-0000-000000000101";
    const batchId = "00000000-0000-0000-0000-000000000102";
    await db.query(
      `INSERT INTO holds (tenant_id, scope_type, scope_id, reason, reason_code, placed_by)
       VALUES ($1, 'reservation', $2, 'test', 'test', $3),
              ($1, 'settlement_batch', $4, 'test', 'test', $3)`,
      [SEED_IDS.tenantId, reservationId, SEED_IDS.userId, batchId],
    );

    await expect(
      assertNotHeld(db, SEED_IDS.tenantId, [
        { type: "reservation", id: reservationId },
      ]),
    ).rejects.toMatchObject({ code: "HOLD_ACTIVE" });
    await expect(
      assertSettlementNotHeld(db, SEED_IDS.tenantId, batchId),
    ).rejects.toMatchObject({ code: "HOLD_ACTIVE" });
    await expect(
      assertSettlementNotHeld(
        db,
        SEED_IDS.tenantId,
        "00000000-0000-0000-0000-000000000103",
      ),
    ).resolves.toBeUndefined();
  });

  it("queues held accrual with the verified agreement and delivery identifiers", async () => {
    const db = getDb();
    const agreementId = "00000000-0000-0000-0000-000000000104";
    const deliveryId = "00000000-0000-0000-0000-000000000105";
    await enqueueHeldAccrual(db, {
      tenantId: SEED_IDS.tenantId,
      agreementId,
      deliveryId,
    });

    const result = await db.query<{
      type: string;
      payload: { agreement_id: string; delivery_id: string };
      status: string;
    }>(
      `SELECT type, payload, status FROM jobs
       WHERE tenant_id = $1 AND type = 'held_accrual'`,
      [SEED_IDS.tenantId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      type: "held_accrual",
      status: "queued",
      payload: { agreement_id: agreementId, delivery_id: deliveryId },
    });
  });
});

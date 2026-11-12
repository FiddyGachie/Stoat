// Task 5.2: wallet event and audit helpers (R19.1-19.4, 19.10, 19.11).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb, transaction } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import {
  appendWalletEvent,
  recordRefusal,
  recordPayPalFailureEvent,
} from "../../src/modules/wallet/wallet-events.js";

const T = SEED_IDS.tenantId;
const db = () => getDb();

const events = (aggId: string) =>
  db().query<any>(
    `SELECT * FROM economic_events WHERE aggregate_id = $1 ORDER BY sequence`,
    [aggId],
  );

describe("wallet event and audit helpers", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
  });
  afterAll(async () => {
    await closeDb();
  });

  it("records actor, tenant, correlation, amount, currency and PayPal IDs", async () => {
    const dep = randomUUID();
    const corr = randomUUID();
    const actor = randomUUID();
    await transaction((tx) =>
      appendWalletEvent(tx, {
        tenantId: T,
        aggregateType: "wallet_deposit",
        aggregateId: dep,
        eventType: "DEPOSIT_CAPTURED",
        actorRole: "owner",
        actorId: actor,
        correlationId: corr,
        amount: "12.500000",
        currency: "USD",
        paypal: { orderId: "ORD1", captureId: "CAP1" },
      }),
    );
    const row = (await events(dep)).rows[0];
    expect(row.tenant_id).toBe(T);
    expect(row.actor_type).toBe("user");
    expect(row.actor_id).toBe(actor);
    expect(row.correlation_id).toBe(corr);
    expect(row.event_type).toBe("DEPOSIT_CAPTURED");
    expect(Number(row.amount)).toBe(12.5);
    expect(row.currency).toBe("USD");
    const p = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    expect(p).toMatchObject({
      actor_role: "owner",
      paypal_order_id: "ORD1",
      paypal_capture_id: "CAP1",
    });
  });

  it("chains events per aggregate and supports wallet and mission aggregates", async () => {
    const w = randomUUID();
    for (const t of ["A", "B"]) {
      await transaction((tx) =>
        appendWalletEvent(tx, {
          tenantId: T,
          aggregateType: "wallet",
          aggregateId: w,
          eventType: t,
          actorRole: "system",
          actorId: randomUUID(),
        }),
      );
    }
    expect((await events(w)).rows.map((r: any) => r.sequence)).toEqual([1, 2]);
    const m = randomUUID();
    await transaction((tx) =>
      appendWalletEvent(tx, {
        tenantId: T,
        aggregateType: "mission",
        aggregateId: m,
        eventType: "MISSION_FUNDING_ACTIVE",
        actorRole: "admin",
        actorId: randomUUID(),
      }),
    );
    expect((await events(m)).rows).toHaveLength(1);
  });

  it("rolls back the caller's state change when the event append fails", async () => {
    const agg = randomUUID();
    await expect(
      transaction(async (tx) => {
        await tx.query(
          `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, resource_type, resource_id, correlation_id, outcome)
           VALUES ($1,'system',$2,'state.change','wallet',$2,$2,'success')`,
          [T, agg],
        );
        // Invalid actor type for the table forces the append to fail.
        await appendWalletEvent(tx, {
          tenantId: T,
          aggregateType: "wallet",
          aggregateId: agg,
          eventType: "X",
          actorRole: "system",
          actorId: "not-a-uuid",
        });
      }),
    ).rejects.toThrow();
    const n = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1`,
      [agg],
    );
    expect(n.rows[0].n).toBe(0);
    expect((await events(agg)).rows).toHaveLength(0);
  });

  it("recordPayPalFailureEvent commits independently and records no amount as paid", async () => {
    const dep = randomUUID();
    await expect(
      transaction(async (tx) => {
        await tx.query("SELECT 1");
        throw new Error("caller failed");
      }),
    ).rejects.toThrow();
    await recordPayPalFailureEvent({
      tenantId: T,
      aggregateType: "wallet_deposit",
      aggregateId: dep,
      actorRole: "owner",
      actorId: randomUUID(),
      amount: "5.000000",
      currency: "USD",
      errorCode: "PAYPAL_UNREACHABLE",
      environment: "sandbox",
      paypal: { requestId: "REQ1" },
    });
    const row = (await events(dep)).rows[0];
    expect(row.event_type).toBe("PAYPAL_OPERATION_FAILED");
    expect(row.amount).toBeNull();
    const p = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    expect(p).toMatchObject({
      outcome: "failed",
      error_code: "PAYPAL_UNREACHABLE",
      paypal_request_id: "REQ1",
    });
  });

  it("recordRefusal writes exactly one audit row with all reasons", async () => {
    const wallet = randomUUID();
    const agent = randomUUID();
    const r = await recordRefusal(db(), {
      tenantId: T,
      principal: { type: "agent", id: agent },
      operation: "wallet.reserve",
      walletId: wallet,
      reasons: ["AGENT_PRINCIPAL", "NOT_WALLET_OWNER", "AGENT_PRINCIPAL"],
    });
    const rows = await db().query<any>(
      `SELECT * FROM audit_logs WHERE resource_id = $1`,
      [wallet],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).toBe(r.id);
    expect(rows.rows[0].outcome).toBe("refused");
    expect(rows.rows[0].actor_id).toBe(agent);
    const m =
      typeof rows.rows[0].metadata === "string"
        ? JSON.parse(rows.rows[0].metadata)
        : rows.rows[0].metadata;
    expect(m.reasons).toEqual(["AGENT_PRINCIPAL", "NOT_WALLET_OWNER"]);
    expect(m.operation).toBe("wallet.reserve");
    expect(m.target_wallet_id).toBe(wallet);
  });

  it("recordRefusal requires a reason and tolerates an unknown wallet", async () => {
    await expect(
      recordRefusal(db(), {
        tenantId: T,
        principal: { type: "user", id: randomUUID() },
        operation: "wallet.get",
        reasons: [],
      }),
    ).rejects.toThrow();
    const r = await recordRefusal(db(), {
      tenantId: T,
      principal: { type: "user", id: randomUUID() },
      operation: "wallet.get",
      walletId: "nope",
      reasons: ["WALLET_NOT_OWNED"],
    });
    expect(r.id).toBeTruthy();
  });
});

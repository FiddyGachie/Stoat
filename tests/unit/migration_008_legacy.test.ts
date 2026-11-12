// Task 1.4: legacy spending_budgets mapping in migration 008 (R17.5 - R17.8).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';

const sql008 = fs.readFileSync(
  path.join(process.cwd(), 'src/db/migrations/008_mission_budget_wallet.sql'), 'utf-8');

describe('migration 008 legacy budget mapping', () => {
  const ids = {
    active: '10000000-0000-0000-0000-000000000001',
    refunded: '10000000-0000-0000-0000-000000000002',
    retained: '10000000-0000-0000-0000-000000000003',
    pending: '10000000-0000-0000-0000-000000000004',
    noCapture: '10000000-0000-0000-0000-000000000005',
    noOwner: '10000000-0000-0000-0000-000000000006',
  };

  async function snapshot() {
    const db = getDb();
    const q = async (s: string) => (await db.query(s)).rows;
    return {
      wallets: await q(`SELECT id, balance_cache::text FROM wallets ORDER BY id`),
      deposits: await q(`SELECT id, captured_amount::text, credited_amount::text FROM wallet_deposits ORDER BY id`),
      funding: await q(`SELECT mission_id, state FROM mission_funding ORDER BY mission_id`),
      tx: await q(`SELECT id, reference FROM journal_transactions WHERE reference LIKE 'wallet:%' ORDER BY id`),
      lines: await q(`SELECT id FROM journal_lines WHERE wallet_id IS NOT NULL ORDER BY id`),
      refunds: await q(`SELECT id FROM wallet_refunds ORDER BY id`),
      items: await q(`SELECT id, status FROM wallet_refund_items ORDER BY id`),
      report: await q(`SELECT budget_id, outcome, reason FROM wallet_migration_report ORDER BY budget_id`),
    };
  }

  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    const agent = (await db.query(`SELECT id FROM agents WHERE tenant_id = $1 LIMIT 1`, [SEED_IDS.tenantId])).rows[0].id;
    const missionA = '20000000-0000-0000-0000-00000000000a';
    const missionB = '20000000-0000-0000-0000-00000000000b';
    for (const m of [missionA, missionB]) {
      await db.query(
        `INSERT INTO missions (id, tenant_id, buyer_id, title, brief, budget, deadline)
         VALUES ($1, $2, $3, 't', 'b', 100, now() + interval '1 day')`, [m, SEED_IDS.tenantId, agent]);
    }
    const ins = (id: string, owner: string, mission: string | null, status: string, amount: number,
                 balance: number, debited: number, capture: string | null) =>
      db.query(
        `INSERT INTO spending_budgets (id, tenant_id, owner_id, owner_type, mission_id, amount, currency,
           paypal_capture_id, paypal_environment, balance, total_debited, status)
         VALUES ($1, $2, $3, 'user', $4, $5, 'USD', $6, 'sandbox', $7, $8, $9)`,
        [id, SEED_IDS.tenantId, owner, mission, amount, capture, balance, debited, status]);
    await ins(ids.active, SEED_IDS.userId, missionA, 'active', 50, 30, 20, 'CAP-A');
    await ins(ids.refunded, SEED_IDS.userId, missionB, 'refunded', 40, 0, 10, 'CAP-R');
    await ins(ids.retained, SEED_IDS.userId, null, 'retained', 25, 5, 20, 'CAP-T');
    await ins(ids.pending, SEED_IDS.userId, null, 'pending_approval', 10, 0, 0, null);
    await ins(ids.noCapture, SEED_IDS.userId, null, 'active', 10, 10, 0, null);
    await ins(ids.noOwner, '99999999-0000-0000-0000-000000000009', null, 'active', 10, 10, 0, 'CAP-N');
    await db.query(
      `INSERT INTO budget_decisions (tenant_id, budget_id, decision, decided_by, paypal_refund_id, refund_status)
       VALUES ($1, $2, 'refund', $3, 'RF-1', 'COMPLETED')`, [SEED_IDS.tenantId, ids.refunded, SEED_IDS.userId]);
  });
  afterAll(async () => { await closeDb(); });

  it('maps rows, preserves capture sums, posts balanced opening entries, and is idempotent', async () => {
    const db = getDb();
    await db.exec(sql008);
    const first = await snapshot();

    expect(first.wallets).toHaveLength(1);
    expect(first.deposits).toHaveLength(3);
    const sum = (await db.query(`SELECT SUM(captured_amount)::text AS s FROM wallet_deposits`)).rows[0].s;
    expect(Number(sum)).toBe(115);
    const credited = Object.fromEntries(
      (await db.query(`SELECT migrated_from_budget_id AS b, credited_amount::text AS c FROM wallet_deposits`))
        .rows.map((r: any) => [r.b, Number(r.c)]));
    expect(credited[ids.active]).toBe(30);
    expect(credited[ids.refunded]).toBe(0);
    expect(credited[ids.retained]).toBe(5);

    expect(first.funding.map((f: any) => f.state).sort()).toEqual(['active', 'closed']);
    expect(first.tx).toHaveLength(2);
    expect(first.lines).toHaveLength(4);
    const bal = (await db.query(
      `SELECT SUM(l.credit - l.debit)::text AS s FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id WHERE a.account_code = '2103'`)).rows[0].s;
    expect(Number(bal)).toBe(35);
    expect(Number(first.wallets[0].balance_cache)).toBe(35);

    expect(first.refunds).toHaveLength(1);
    expect(first.items).toEqual([expect.objectContaining({ status: 'completed' })]);

    const skipped = first.report.filter((r: any) => r.outcome === 'skipped');
    expect(skipped.map((r: any) => r.budget_id).sort()).toEqual([ids.pending, ids.noCapture, ids.noOwner].sort());
    expect(first.report.filter((r: any) => r.outcome === 'migrated')).toHaveLength(3);

    await db.exec(sql008); // re-run
    expect(await snapshot()).toEqual(first);
  });
});

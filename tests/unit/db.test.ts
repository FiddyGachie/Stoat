import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, resetDb, closeDb, transaction } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';

describe('Slice 1: Database & Persistence', () => {
  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('runs initial migrations and creates all required tables', async () => {
    const db = getDb();

    // Check table existence
    const tablesRes = await db.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename;
    `);
    const tableNames = tablesRes.rows.map((r) => r.tablename);

    const requiredTables = [
      'tenants',
      'users',
      'agents',
      'agent_delegations',
      'services',
      'missions',
      'quote_requests',
      'quotes',
      'agreements',
      'economic_events',
      'artifacts',
      'deliveries',
      'verifications',
      'obligations',
      'accounts',
      'journal_transactions',
      'journal_lines',
      'settlement_batches',
      'settlement_batch_items',
      'payment_transactions',
      'webhook_events',
      'reconciliation_records',
      'approvals',
      'policy_versions',
      'policy_decisions',
      'holds',
      'idempotency_keys',
      'agent_runs',
      'agent_steps',
      'llm_proposals',
      'jobs',
      'audit_logs',
      'recorded_llm_responses',
    ];

    for (const table of requiredTables) {
      expect(tableNames, `Table ${table} should exist`).toContain(table);
    }
  });

  it('seeds standard tenant, users, agents, accounts, policies and services', async () => {
    const db = getDb();

    // Verify tenant
    const tenantRes = await db.query('SELECT * FROM tenants WHERE id = $1', [SEED_IDS.tenantId]);
    expect(tenantRes.rows.length).toBe(1);
    expect(tenantRes.rows[0].name).toBe('Acme Autonomous Org');

    // Verify accounts
    const accountsRes = await db.query('SELECT * FROM accounts WHERE tenant_id = $1', [SEED_IDS.tenantId]);
    expect(accountsRes.rows.length).toBe(3);
    const codes = accountsRes.rows.map((a: any) => a.account_code);
    expect(codes).toContain('5001');
    expect(codes).toContain('2001');
    expect(codes).toContain('2002');

    // Verify agents
    const agentsRes = await db.query('SELECT * FROM agents WHERE tenant_id = $1', [SEED_IDS.tenantId]);
    expect(agentsRes.rows.length).toBe(7);
    const roles = agentsRes.rows.map((a: any) => a.role);
    expect(roles).toContain('buyer');
    expect(roles).toContain('provider');
    expect(roles).toContain('treasury');
    expect(roles).toContain('watchdog');
    expect(roles).toContain('verifier_advisor');
    expect(roles).toContain('copilot');

    // Verify services
    const servicesRes = await db.query('SELECT * FROM services WHERE tenant_id = $1', [SEED_IDS.tenantId]);
    expect(servicesRes.rows.length).toBe(2);
    const prices = servicesRes.rows.map((s: any) => String(s.unit_price));
    expect(prices).toContain('0.120000');
    expect(prices).toContain('0.050000');
  });

  it('enforces exact numeric decimal precision and constraints', async () => {
    const db = getDb();

    // Test decimal precision insertion
    const testMissionId = '99999999-9999-9999-9999-999999999999';
    await db.query(`
      INSERT INTO missions (
        id, tenant_id, buyer_id, title, brief, budget, currency, deadline
      ) VALUES (
        $1, $2, $3, 'Precision Test Mission', 'Review code', 10.123456, 'USD', now() + interval '1 day'
      ) ON CONFLICT (id) DO NOTHING;
    `, [testMissionId, SEED_IDS.tenantId, SEED_IDS.buyerAgentId]);

    const missionRes = await db.query<{ budget: string }>(
      'SELECT budget FROM missions WHERE id = $1',
      [testMissionId]
    );
    expect(missionRes.rows.length).toBe(1);
    expect(missionRes.rows[0].budget).toBe('10.123456');

    // Check negative amount constraint on missions
    await expect(
      db.query(`
        INSERT INTO missions (
          id, tenant_id, buyer_id, title, brief, budget, currency, deadline
        ) VALUES (
          gen_random_uuid(), $1, $2, 'Negative Mission', 'Brief', -5.00, 'USD', now()
        );
      `, [SEED_IDS.tenantId, SEED_IDS.buyerAgentId])
    ).rejects.toThrow();
  });

  it('supports transactional atomicity with rollback', async () => {
    const db = getDb();

    try {
      await transaction(async (tx) => {
        await tx.query(`
          INSERT INTO tenants (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'Rollback Tenant');
        `);
        throw new Error('Simulated atomic failure');
      });
    } catch (e: any) {
      expect(e.message).toBe('Simulated atomic failure');
    }

    const checkRes = await db.query(
      'SELECT * FROM tenants WHERE id = $1',
      ['11111111-1111-1111-1111-111111111111']
    );
    expect(checkRes.rows.length).toBe(0);
  });
});

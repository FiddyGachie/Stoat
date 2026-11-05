import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { dispatch } from '../test-utils.js';

describe('Slice 2: Core Domain Services, API Middleware & Agreements (P0-02, P0-06, P0-07, P0-08, P0-09)', () => {
  let app: any;

  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.exec(`
      TRUNCATE TABLE agreements, quotes, quote_requests, missions, economic_events, idempotency_keys, policy_decisions CASCADE;
    `);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('P0-06: Buyer discovers active services from registry', async () => {
    const res = await dispatch(app, {
      method: 'GET',
      url: '/services',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.services).toBeDefined();
    expect(res.body.services.length).toBe(2);

    const aiService = res.body.services.find((s: any) => s.id === SEED_IDS.aiServiceId);
    expect(aiService).toBeDefined();
    expect(aiService.name).toBe('AI Deep Code Review');
    expect(aiService.unit_price).toBe('0.120000');
    expect(aiService.currency).toBe('USD');
  });

  it('P0-07: Buyer requests and receives structured quote with price, currency, scope and expiry', async () => {
    // 1. Create a mission
    const missionRes = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        title: 'Review PR #42',
        brief: 'Verify security and logic in payment gateway',
        budget: '1.00',
        currency: 'USD',
      },
    });
    expect(missionRes.status).toBe(201);
    const missionId = missionRes.body.id;

    // 2. Request quote
    const quoteRes = await dispatch(app, {
      method: 'POST',
      url: '/quotes',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        mission_id: missionId,
        service_id: SEED_IDS.aiServiceId,
        requested_scope: { repo: 'sample-app', files: ['auth.ts', 'server.ts'] },
        quantity: 1,
      },
    });

    expect(quoteRes.status).toBe(201);
    expect(quoteRes.body.id).toBeDefined();
    expect(quoteRes.body.price).toBe('0.120000');
    expect(quoteRes.body.currency).toBe('USD');
    expect(quoteRes.body.status).toBe('offered');
    expect(quoteRes.body.expires_at).toBeDefined();
    expect(new Date(quoteRes.body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('P0-08 & P0-09: Accepts quote within budget, creating immutable agreement and reserving budget', async () => {
    // Create mission with $0.20 budget
    const missionRes = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        title: 'Budget Bound Mission',
        brief: 'Testing budget policy',
        budget: '0.20',
      },
    });
    const missionId = missionRes.body.id;

    // Request quote ($0.12)
    const quoteRes = await dispatch(app, {
      method: 'POST',
      url: '/quotes',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        mission_id: missionId,
        service_id: SEED_IDS.aiServiceId,
        quantity: 1,
      },
    });
    const quoteId = quoteRes.body.id;

    // Accept quote
    const acceptRes = await dispatch(app, {
      method: 'POST',
      url: `/quotes/${quoteId}/accept`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.id).toBeDefined();
    expect(acceptRes.body.status).toBe('accepted');
    expect(acceptRes.body.price).toBe('0.120000');
    expect(acceptRes.body.policy_decision_id).toBeDefined();
    const agreementId = acceptRes.body.id;

    // Verify mission reserved budget updated
    const updatedMissionRes = await dispatch(app, {
      method: 'GET',
      url: `/missions/${missionId}`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });
    expect(updatedMissionRes.body.reserved_budget).toBe('0.120000');

    // Verify agreement can be retrieved
    const getAgreementRes = await dispatch(app, {
      method: 'GET',
      url: `/agreements/${agreementId}`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });
    expect(getAgreementRes.status).toBe(200);
    expect(getAgreementRes.body.id).toBe(agreementId);
    expect(getAgreementRes.body.price).toBe('0.120000');

    // Attempting to accept again results in 409 conflict
    const doubleAcceptRes = await dispatch(app, {
      method: 'POST',
      url: `/quotes/${quoteId}/accept`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });
    expect(doubleAcceptRes.status).toBe(409);
    expect(doubleAcceptRes.body.error.code).toBe('QUOTE_ALREADY_ACCEPTED');
  });

  it('P0-09: Rejects quote acceptance when spend exceeds mission budget', async () => {
    // Mission with budget $0.10 (less than service price $0.12)
    const missionRes = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        title: 'Underfunded Mission',
        brief: 'Cannot afford $0.12 review',
        budget: '0.10',
      },
    });
    const missionId = missionRes.body.id;

    const quoteRes = await dispatch(app, {
      method: 'POST',
      url: '/quotes',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        mission_id: missionId,
        service_id: SEED_IDS.aiServiceId,
        quantity: 1,
      },
    });
    const quoteId = quoteRes.body.id;

    // Attempt to accept
    const acceptRes = await dispatch(app, {
      method: 'POST',
      url: `/quotes/${quoteId}/accept`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });

    expect(acceptRes.status).toBe(422);
    expect(acceptRes.body.error.code).toBe('BUDGET_EXCEEDED');

    // Verify policy_decisions has a deny record
    const db = getDb();
    const decisions = await db.query(
      'SELECT result, reason_codes FROM policy_decisions WHERE resource_id = $1',
      [quoteId]
    );
    expect(decisions.rows.length).toBe(1);
    expect(decisions.rows[0].result).toBe('deny');
    expect(JSON.stringify(decisions.rows[0].reason_codes)).toContain('BUDGET_EXCEEDED');
  });

  it('P0-09: Rejects acceptance of expired quotes', async () => {
    const db = getDb();
    const missionRes = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        title: 'Expiry Test Mission',
        brief: 'Testing expired quote',
        budget: '5.00',
      },
    });
    const missionId = missionRes.body.id;

    const quoteRes = await dispatch(app, {
      method: 'POST',
      url: '/quotes',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        mission_id: missionId,
        service_id: SEED_IDS.aiServiceId,
        quantity: 1,
      },
    });
    const quoteId = quoteRes.body.id;

    // Manually backdate the quote expiration time to the past
    await db.query(
      "UPDATE quotes SET expires_at = now() - interval '1 hour' WHERE id = $1",
      [quoteId]
    );

    const acceptRes = await dispatch(app, {
      method: 'POST',
      url: `/quotes/${quoteId}/accept`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });

    expect(acceptRes.status).toBe(422);
    expect(acceptRes.body.error.code).toBe('QUOTE_EXPIRED');
  });

  it('P0-02: Enforces strict tenant isolation across queries and mutations', async () => {
    const db = getDb();

    // 1. Create a second tenant
    const tenant2Id = '00000000-0000-0000-0000-000000000999';
    await db.query(`
      INSERT INTO tenants (id, name, status) VALUES ($1, 'Tenant Two', 'active')
      ON CONFLICT (id) DO NOTHING;
    `, [tenant2Id]);

    // 2. Create an agent in tenant 2
    const agent2Id = '00000000-0000-0000-0000-000000000998';
    await db.query(`
      INSERT INTO agents (id, tenant_id, role, name, status, credential_hash)
      VALUES ($1, $2, 'buyer', 'Agent in Tenant 2', 'active', 'hash2')
      ON CONFLICT (id) DO NOTHING;
    `, [agent2Id, tenant2Id]);

    // 3. Create mission in Tenant 1
    const missionRes = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        title: 'Tenant 1 Mission',
        brief: 'Secret tenant 1 content',
        budget: '1.00',
      },
    });
    const mission1Id = missionRes.body.id;

    // 4. Agent in Tenant 2 attempts to read Tenant 1's mission -> returns 404 (not found in tenant 2)
    const readRes = await dispatch(app, {
      method: 'GET',
      url: `/missions/${mission1Id}`,
      headers: { Authorization: `Bearer agent:${agent2Id}` },
    });

    expect(readRes.status).toBe(404);
    expect(readRes.body.error.code).toBe('NOT_FOUND');

    // 5. Listing missions for Agent in Tenant 2 returns empty array, not Tenant 1 missions
    const listRes = await dispatch(app, {
      method: 'GET',
      url: '/missions',
      headers: { Authorization: `Bearer agent:${agent2Id}` },
    });

    expect(listRes.status).toBe(200);
    expect(listRes.body.missions.length).toBe(0);
  });

  it('Idempotency middleware returns cached response on identical request and 409 on altered payload', async () => {
    const idempotencyKey = 'idem_key_test_001';

    // 1. First creation
    const res1 = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: {
        Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: {
        title: 'Idempotent Mission',
        brief: 'Mission to be deduplicated',
        budget: '2.50',
      },
    });

    expect(res1.status).toBe(201);
    const missionId = res1.body.id;

    // Wait a brief tick for async insertion of idempotency key
    await new Promise((r) => setTimeout(r, 50));

    // 2. Exact same request with same key -> returns cached response with header
    const res2 = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: {
        Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: {
        title: 'Idempotent Mission',
        brief: 'Mission to be deduplicated',
        budget: '2.50',
      },
    });

    expect(res2.status).toBe(201);
    expect(res2.body.id).toBe(missionId);
    expect(res2.headers['x-idempotent-replay']).toBe('true');

    // 3. Same key with different payload -> 409 conflict
    const res3 = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: {
        Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: {
        title: 'Altered Mission Title',
        brief: 'Different content',
        budget: '5.00',
      },
    });

    expect(res3.status).toBe(409);
    expect(res3.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('Asymmetric role enforcement: non-buyer roles cannot request or accept quotes', async () => {
    // Treasury agent attempting to request quote -> 403 Forbidden
    const res = await dispatch(app, {
      method: 'POST',
      url: '/quotes',
      headers: { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` },
      body: {
        mission_id: '00000000-0000-0000-0000-000000000000',
        service_id: SEED_IDS.aiServiceId,
        quantity: 1,
      },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ACTION');
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { LedgerService } from '../../src/modules/ledger/ledger.service.js';
import { dispatch } from '../test-utils.js';

describe('Slice 4: Double-Entry Ledger, Obligations, Reversals & Live Integrity (P0-13, P0-14, P0-25)', () => {
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
      TRUNCATE TABLE journal_lines, journal_transactions, obligations, verifications,
                     deliveries, artifacts, agreements, quotes, quote_requests, missions,
                     economic_events, idempotency_keys, policy_decisions CASCADE;
    `);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function createAcceptedAgreement(): Promise<{ missionId: string; quoteId: string; agreementId: string }> {
    const missionRes = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: { title: 'Ledger Audit Mission', brief: 'Audit repo fixture', budget: '1.00' },
    });
    const missionId = missionRes.body.id;

    const quoteRes = await dispatch(app, {
      method: 'POST',
      url: '/quotes',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: { mission_id: missionId, service_id: SEED_IDS.aiServiceId, quantity: 1 },
    });
    const quoteId = quoteRes.body.id;

    const acceptRes = await dispatch(app, {
      method: 'POST',
      url: `/quotes/${quoteId}/accept`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });
    const agreementId = acceptRes.body.id;

    return { missionId, quoteId, agreementId };
  }

  it('P0-13: Accrues obligation only upon verified delivery and derives amount strictly from agreement', async () => {
    const { agreementId } = await createAcceptedAgreement();

    // 1. Submit ungrounded delivery -> rejected -> no obligation created
    const rejectedArtifact = await dispatch(app, {
      method: 'POST',
      url: '/artifacts',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        findings: [
          {
            file: 'src/does_not_exist.ts',
            line_start: 1,
            line_end: 2,
            snippet: 'foo',
            rule_id: 'SEC-002',
            severity: 'critical',
          },
        ],
      },
    });

    const rejectedDeliveryRes = await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: { agreement_id: agreementId, artifact_id: rejectedArtifact.body.id },
    });

    expect(rejectedDeliveryRes.body.delivery.status).toBe('rejected');
    expect(rejectedDeliveryRes.body.obligation).toBeNull();

    // Verify obligations list is empty
    const obListRes1 = await dispatch(app, {
      method: 'GET',
      url: '/obligations',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });
    expect(obListRes1.body.obligations.length).toBe(0);

    // 2. Request revision and submit clean grounded findings -> verified -> obligation accrued!
    await dispatch(app, {
      method: 'POST',
      url: `/deliveries/${rejectedDeliveryRes.body.delivery.id}/revision`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: { reasons: ['Fix file reference'] },
    });

    const verifiedArtifact = await dispatch(app, {
      method: 'POST',
      url: '/artifacts',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        findings: [
          {
            file: 'src/auth.ts',
            line_start: 4,
            line_end: 4,
            snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
            rule_id: 'SEC-002',
            severity: 'critical',
          },
        ],
      },
    });

    const verifiedDeliveryRes = await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: { agreement_id: agreementId, artifact_id: verifiedArtifact.body.id },
    });

    expect(verifiedDeliveryRes.body.delivery.status).toBe('verified');
    expect(verifiedDeliveryRes.body.obligation).toBeDefined();
    expect(verifiedDeliveryRes.body.obligation.amount).toBe('0.120000');
    expect(verifiedDeliveryRes.body.obligation.status).toBe('payable');

    // Verify exactly one obligation exists
    const obListRes2 = await dispatch(app, {
      method: 'GET',
      url: '/obligations',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
    });
    expect(obListRes2.body.obligations.length).toBe(1);
    expect(obListRes2.body.obligations[0].amount).toBe('0.120000');
  });

  it('P0-13: Invariant: Agreement cannot have more than one obligation', async () => {
    const { agreementId } = await createAcceptedAgreement();

    // Create a verified delivery
    const artifact = await dispatch(app, {
      method: 'POST',
      url: '/artifacts',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        findings: [
          {
            file: 'src/auth.ts',
            line_start: 4,
            line_end: 4,
            snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
            rule_id: 'SEC-002',
            severity: 'critical',
          },
        ],
      },
    });

    const deliveryRes = await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: { agreement_id: agreementId, artifact_id: artifact.body.id },
    });
    const deliveryId = deliveryRes.body.delivery.id;

    // Attempting to manually call accrueObligationForDelivery again on the same agreement throws ConflictError
    const ledger = new LedgerService(getDb());
    await expect(
      ledger.accrueObligationForDelivery({
        tenantId: SEED_IDS.tenantId,
        agreementId,
        deliveryId,
      })
    ).rejects.toThrow('An obligation already exists for agreement');
  });

  it('P0-14: Double-entry journal posts balanced entries and supports compensating reversals', async () => {
    const { agreementId } = await createAcceptedAgreement();

    const artifact = await dispatch(app, {
      method: 'POST',
      url: '/artifacts',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        findings: [
          {
            file: 'src/auth.ts',
            line_start: 4,
            line_end: 4,
            snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
            rule_id: 'SEC-002',
            severity: 'critical',
          },
        ],
      },
    });

    await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: { agreement_id: agreementId, artifact_id: artifact.body.id },
    });

    const db = getDb();

    // Check posted journal lines
    const linesRes = await db.query(
      `SELECT jl.debit, jl.credit, jl.currency, a.account_code, a.name 
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.tenant_id = $1
       ORDER BY jl.sequence ASC`,
      [SEED_IDS.tenantId]
    );

    expect(linesRes.rows.length).toBe(2);
    // Line 1: Debit Buyer Service Expense (5001)
    expect(linesRes.rows[0].account_code).toBe('5001');
    expect(String(linesRes.rows[0].debit)).toBe('0.120000');
    expect(String(linesRes.rows[0].credit)).toBe('0.000000');

    // Line 2: Credit Provider Payable (2001)
    expect(linesRes.rows[1].account_code).toBe('2001');
    expect(String(linesRes.rows[1].debit)).toBe('0.000000');
    expect(String(linesRes.rows[1].credit)).toBe('0.120000');

    // Test Reversal
    const txRes = await db.query(
      'SELECT id FROM journal_transactions WHERE tenant_id = $1 LIMIT 1',
      [SEED_IDS.tenantId]
    );
    const originalTxId = txRes.rows[0].id;

    const ledger = new LedgerService(db);
    const reversalResult = await ledger.reverseJournalTransaction({
      tenantId: SEED_IDS.tenantId,
      transactionId: originalTxId,
      reason: 'Quality audit adjustment',
      actorId: SEED_IDS.userId,
    });

    expect(reversalResult.reversalTransaction).toBeDefined();
    expect(reversalResult.lines.length).toBe(2);

    // Verify original transaction is marked 'reversed'
    const updatedOriginal = await db.query(
      'SELECT status FROM journal_transactions WHERE id = $1',
      [originalTxId]
    );
    expect(updatedOriginal.rows[0].status).toBe('reversed');

    // Verify net journal balance remains zero after reversal
    const totalsRes = await db.query(
      'SELECT SUM(debit) as total_debit, SUM(credit) as total_credit FROM journal_lines WHERE tenant_id = $1',
      [SEED_IDS.tenantId]
    );
    expect(String(totalsRes.rows[0].total_debit)).toBe(String(totalsRes.rows[0].total_credit));
  });

  it('P0-25: /integrity endpoint calculates all invariants and reports zero violations in clean state', async () => {
    // 1. In empty/initial state, integrity is healthy
    const initRes = await dispatch(app, {
      method: 'GET',
      url: '/integrity',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });

    expect(initRes.status).toBe(200);
    expect(initRes.body.integrity_status).toBe('healthy');
    expect(initRes.body.metrics.hash_chain_gaps).toBe(0);
    expect(initRes.body.metrics.duplicate_obligations).toBe(0);
    expect(initRes.body.metrics.orphan_reservations).toBe(0);
    expect(initRes.body.metrics.unauthorized_agreements).toBe(0);

    // 2. Perform complete end-to-end mission delivery
    const { agreementId } = await createAcceptedAgreement();
    const artifact = await dispatch(app, {
      method: 'POST',
      url: '/artifacts',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        findings: [
          {
            file: 'src/auth.ts',
            line_start: 4,
            line_end: 4,
            snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
            rule_id: 'SEC-002',
            severity: 'critical',
          },
        ],
      },
    });

    await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: { agreement_id: agreementId, artifact_id: artifact.body.id },
    });

    // 3. Query integrity again
    const postDeliveryRes = await dispatch(app, {
      method: 'GET',
      url: '/integrity',
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });

    expect(postDeliveryRes.status).toBe(200);
    expect(postDeliveryRes.body.integrity_status).toBe('healthy');
    expect(postDeliveryRes.body.metrics.debit_credit_balance.length).toBe(1);
    expect(postDeliveryRes.body.metrics.debit_credit_balance[0].balanced).toBe(true);
    expect(postDeliveryRes.body.metrics.debit_credit_balance[0].delta).toBe('0.000000');
    expect(postDeliveryRes.body.metrics.hash_chain_gaps).toBe(0);
    expect(postDeliveryRes.body.metrics.duplicate_obligations).toBe(0);
    expect(postDeliveryRes.body.metrics.unauthorized_agreements).toBe(0);
  });
});

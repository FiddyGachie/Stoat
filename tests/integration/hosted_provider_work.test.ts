import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { dispatch } from '../test-utils.js';
import { runOneJob } from '../../src/jobs/runner.js';
import { AgentRuntimeService } from '../../src/modules/agent-runtime/agent-runtime.service.js';
import { FundingService } from '../../src/modules/payments/funding.service.js';
import { reviewDouble } from '../llm-double.js';
import { acceptedAgreement, stubPayPal, PROVIDER, TRUNCATE_ALL, USER } from '../funding-helpers.js';

// After a deal is accepted (and paid, when funding is required), a hosted provider's review runs by
// itself. The model is a test double (tests/llm-double.ts); the queueing, the job and the verifier are real.
describe('Hosted provider work starts after acceptance', () => {
  let app: any;
  const T = SEED_IDS.tenantId;
  const runtime = () => new AgentRuntimeService(getDb(), 'live', undefined, { transport: reviewDouble() });
  const jobsFor = async (agreementId: string) =>
    (await getDb().query(`SELECT status, error FROM jobs WHERE type = 'provider_review' AND payload->>'agreement_id' = $1`, [agreementId])).rows;

  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    app = createApp();
  });
  beforeEach(async () => { await getDb().exec(`TRUNCATE TABLE jobs CASCADE; ${TRUNCATE_ALL}`); });
  afterEach(() => { delete process.env.REQUIRE_FUNDING; });
  afterAll(async () => { await closeDb(); });

  it('accepting a hosted service queues exactly one review, and the job delivers, verifies and accrues the obligation', async () => {
    const ag = await acceptedAgreement(app);
    expect(ag.status).toBe(200);
    expect(await jobsFor(ag.body.id)).toHaveLength(1);

    // the first answer is rejected by the verifier, the revision is verified: all inside one job
    expect(await runOneJob(getDb(), 'test', { runtime: runtime() })).toBe(true);
    const [job] = await jobsFor(ag.body.id);
    expect(job.status).toBe('succeeded');
    expect(job.error).toContain('verified after 2 attempt(s)');

    const a = await getDb().query('SELECT status, revision_count FROM agreements WHERE id = $1', [ag.body.id]);
    expect(a.rows[0]).toMatchObject({ status: 'verified', revision_count: 1 });
    const obs = await dispatch(app, { method: 'GET', url: '/v1/obligations', headers: USER });
    expect(obs.body.obligations.filter((o: any) => o.agreement_id === ag.body.id)).toHaveLength(1);

    // nothing left to do, and running again changes nothing
    expect(await runOneJob(getDb(), 'test', { runtime: runtime() })).toBe(false);
  });

  it('with REQUIRE_FUNDING the review waits for the PayPal capture, then is queued once', async () => {
    process.env.REQUIRE_FUNDING = 'true';
    const ag = await acceptedAgreement(app);
    expect(await jobsFor(ag.body.id)).toHaveLength(0);

    const gw = stubPayPal({ capturedAmount: '0.12' });
    const funding = new FundingService(getDb(), gw);
    const pay = await funding.requestFunding({ tenantId: T, agreementId: ag.body.id, actorId: SEED_IDS.userId });
    const order = (await getDb().query('SELECT provider_order_id AS o FROM agreement_payments WHERE id = $1', [pay!.payment_id])).rows[0].o;
    await funding.captureByOrder(order, 'return');
    await funding.captureByOrder(order, 'webhook');                 // a second trigger must not queue a second job
    expect(await jobsFor(ag.body.id)).toHaveLength(1);

    await runOneJob(getDb(), 'test', { runtime: runtime() });
    const a = await getDb().query('SELECT status FROM agreements WHERE id = $1', [ag.body.id]);
    expect(a.rows[0].status).toBe('verified');
  });

  it('external services are not run by Stoat: the provider agent delivers itself', async () => {
    const pub = await dispatch(app, { method: 'POST', url: '/v1/services', headers: PROVIDER, body: {
      name: 'External review', description: 'I deliver through the API.', category: 'code_review', unit_price: '0.10', currency: 'USD', unit: 'review',
    } });
    expect(pub.status).toBe(201);
    expect(pub.body.execution_mode).toBe('external');
    const ag = await acceptedAgreement(app, '50.000000', pub.body.id);
    expect(ag.status).toBe(200);
    expect(await jobsFor(ag.body.id)).toHaveLength(0);
    const bad = await dispatch(app, { method: 'POST', url: '/v1/services', headers: PROVIDER, body: {
      name: 'Bad', description: 'x', category: 'code_review', unit_price: '0.10', currency: 'USD', unit: 'review', execution_mode: 'magic',
    } });
    expect(bad.status).toBe(400);
  });

  it('a missing model key stops the job at once instead of retrying, and nothing is delivered', async () => {
    const saved = { f: process.env.FIREWORKS_API_KEY, l: process.env.LLM_API_KEY, m: process.env.LLM_MODE };
    delete process.env.FIREWORKS_API_KEY; delete process.env.LLM_API_KEY; process.env.LLM_MODE = 'live';
    try {
      const ag = await acceptedAgreement(app);
      await runOneJob(getDb(), 'test');                                // real adapter, no key
      const [job] = await jobsFor(ag.body.id);
      expect(job.status).toBe('dead');
      expect(job.error).toMatch(/model API key/i);
      const d = await getDb().query('SELECT COUNT(*)::int AS n FROM deliveries WHERE agreement_id = $1', [ag.body.id]);
      expect(d.rows[0].n).toBe(0);
    } finally {
      if (saved.f) process.env.FIREWORKS_API_KEY = saved.f;
      if (saved.l) process.env.LLM_API_KEY = saved.l;
      if (saved.m) process.env.LLM_MODE = saved.m; else delete process.env.LLM_MODE;
    }
  });
});

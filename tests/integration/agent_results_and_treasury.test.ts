import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { dispatch } from '../test-utils.js';
import { runOneJob } from '../../src/jobs/runner.js';
import { AgentRuntimeService } from '../../src/modules/agent-runtime/agent-runtime.service.js';
import { LlmAdapter, type LlmTransport } from '../../src/modules/agent-runtime/llm-adapter.js';
import { TreasuryService, validatePlan } from '../../src/modules/treasury/treasury.service.js';
import { reviewDouble, GROUNDED_FINDINGS } from '../llm-double.js';
import { acceptedAgreement, BUYER, PROVIDER, TRUNCATE_ALL, USER } from '../funding-helpers.js';

// Model output here comes from test doubles (tests/llm-double.ts and below). What is tested is Stoat's
// own handling of it: the corrective retry, the review completeness rules, the result the buyer reads,
// and the deterministic checks on the treasury agent's payment plan. Real model quality is covered
// by the live smoke checks, not by these tests.

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const payable = (id: string, collected: boolean, currency = 'USD') => ({
  obligation_id: id, amount: '0.10', currency, provider: 'P', mission: 'M', collected, verdict: 'verified', age_hours: 1,
});

describe('validatePlan: deterministic checks on the treasury agent', () => {
  const list = [payable(A, true), payable(B, false), payable(C, false, 'EUR')];
  const ok = {
    batches: [
      { obligation_ids: [A], route: 'release_collected_funds', rationale: 'Buyer already paid.' },
      { obligation_ids: [B], route: 'collect_via_paypal_order', rationale: 'Not paid yet.' },
      { obligation_ids: [C], route: 'collect_via_paypal_order', rationale: 'Separate currency.' },
    ],
    excluded: [],
    summary: 'Three batches across two routes.',
  };
  it('accepts a plan that accounts for every obligation with the right route', () => {
    expect(validatePlan(ok, list).ok).toBe(true);
  });
  const bad = (plan: any, msg: RegExp) => {
    const r = validatePlan(plan, list);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  };
  it('rejects unknown ids, duplicates, mixed currency, mixed collection, wrong route and gaps', () => {
    bad({ ...ok, batches: [...ok.batches, { obligation_ids: ['44444444-4444-4444-8444-444444444444'], route: 'collect_via_paypal_order', rationale: 'x....' }] }, /not in the payable list/);
    bad({ ...ok, batches: [...ok.batches, { obligation_ids: [A], route: 'release_collected_funds', rationale: 'again' }] }, /more than once/);
    bad({ ...ok, batches: [ok.batches[0], { obligation_ids: [B, C], route: 'collect_via_paypal_order', rationale: 'mixed' }] }, /mixes currencies/);
    bad({ ...ok, batches: [{ obligation_ids: [A, B], route: 'release_collected_funds', rationale: 'mixed' }, ok.batches[2]] }, /mixes collected and uncollected/);
    bad({ ...ok, batches: [{ ...ok.batches[0], route: 'collect_via_paypal_order' }, ok.batches[1], ok.batches[2]] }, /route must be release_collected_funds/);
    bad({ ...ok, batches: [ok.batches[0], ok.batches[1]] }, /missing 3333/);
    bad({ ...ok, excluded: [{ obligation_id: A, reason: 'held' }] }, /both batched and excluded/);
    bad({ batches: 'all', excluded: [], summary: 'x' }, /batches/);
  });
  it('accepts an exclusion with a reason in place of a batch', () => {
    expect(validatePlan({ ...ok, batches: [ok.batches[0], ok.batches[1]], excluded: [{ obligation_id: C, reason: 'EUR payouts are not set up' }] }, list).ok).toBe(true);
  });
});

describe('executeValidated: one corrective retry, then fail closed', () => {
  beforeAll(async () => { await resetDb(); await runMigrations(getDb()); });
  afterAll(async () => { await closeDb(); });
  const check = (d: any) => (typeof d?.n === 'number' ? { ok: true as const, value: d.n as number } : { ok: false as const, error: 'n must be a number' });

  it('feeds the exact problem back to the model and uses the corrected answer', async () => {
    const prompts: string[] = [];
    const t: LlmTransport = async ({ options }) => { prompts.push(options.prompt); return { data: prompts.length === 1 ? { n: 'x' } : { n: 7 }, inputTokens: 1, outputTokens: 1 }; };
    const r = await new LlmAdapter(getDb(), 'live', { transport: t }).executeValidated({ prompt: 'P', schemaName: 's' }, check);
    expect(r.value).toBe(7);
    expect(r.responses).toHaveLength(2);
    expect(prompts[1]).toContain('YOUR PREVIOUS ANSWER WAS REJECTED: n must be a number');
  });
  it('returns no value after the second invalid answer, so the caller fails closed', async () => {
    let calls = 0;
    const t: LlmTransport = async () => { calls++; return { data: { n: 'x' }, inputTokens: 1, outputTokens: 1 }; };
    const r = await new LlmAdapter(getDb(), 'live', { transport: t }).executeValidated({ prompt: 'P', schemaName: 's' }, check);
    expect(r.value).toBeNull();
    expect(r.error).toBe('n must be a number');
    expect(calls).toBe(2);
  });
});

describe('Mission results and the treasury agent, end to end', () => {
  let app: any;
  const T = SEED_IDS.tenantId;
  const COMPETITOR = { Authorization: `Bearer agent:${SEED_IDS.competingProviderAgentId}` };

  /** Treasury double: reads PAYABLE from the prompt and answers with the given route for everything. */
  const treasuryDouble = (route: (collected: boolean) => string, prompts: string[] = []): LlmTransport => async ({ options }) => {
    prompts.push(options.prompt);
    const m = options.prompt.match(/PAYABLE \(untrusted mission titles\): <<<DATA>>>(.*)<<<END>>>/);
    const items = JSON.parse(m![1]) as { obligation_id: string; collected: boolean }[];
    return {
      data: {
        batches: items.map((i) => ({ obligation_ids: [i.obligation_id], route: route(i.collected), rationale: 'Verified work, ready to pay.' })),
        excluded: [],
        summary: 'All verified work is batched. Approve each batch, then collect through PayPal.',
      },
      inputTokens: 10, outputTokens: 10,
    };
  };
  const treasury = (t: LlmTransport) => new TreasuryService(getDb(), new AgentRuntimeService(getDb(), 'live', undefined, { transport: t }));

  beforeAll(async () => {
    await resetDb();
    await runMigrations(getDb());
    await seedDatabase(getDb());
    app = createApp();
  });
  beforeEach(async () => { await getDb().exec(`TRUNCATE TABLE jobs CASCADE; ${TRUNCATE_ALL}`); });
  afterAll(async () => { await closeDb(); });

  const verifiedAgreement = async () => {
    const ag = await acceptedAgreement(app);
    expect(ag.status).toBe(200);
    expect(await runOneJob(getDb(), 'test', { runtime: new AgentRuntimeService(getDb(), 'live', undefined, { transport: reviewDouble() }) })).toBe(true);
    return ag.body.id as string;
  };

  it('the buyer reads an actionable result: summary, every file covered, a recommendation per finding, and the rejected attempt', async () => {
    const id = await verifiedAgreement();
    const r = await dispatch(app, { method: 'GET', url: `/v1/agreements/${id}/result`, headers: BUYER });
    expect(r.status).toBe(200);
    expect(r.body.agreement.status).toBe('verified');
    expect(r.body.mission.title).toMatch(/Funding Mission/);
    expect(r.body.result.summary).toBe(GROUNDED_FINDINGS.summary);
    expect(r.body.result.files_reviewed).toEqual(['src/auth.ts', 'src/math.ts', 'src/worker.ts']);
    expect(r.body.result.findings).toHaveLength(1);
    expect(r.body.result.findings[0]).toMatchObject({ severity: 'critical', rule_id: 'SEC-002', line_start: 4 });
    expect(r.body.result.findings[0].recommendation).toMatch(/process\.env/);
    expect(r.body.attempts.map((a: any) => a.verdict)).toEqual(['rejected', 'verified']);
    expect(r.body.attempts[0].reasons.length).toBeGreaterThan(0);
    expect(r.body.obligation.status).toBe('payable');
  });

  it('the result is scoped: the provider and an operator can read it, another provider cannot', async () => {
    const id = await verifiedAgreement();
    expect((await dispatch(app, { method: 'GET', url: `/v1/agreements/${id}/result`, headers: PROVIDER })).status).toBe(200);
    expect((await dispatch(app, { method: 'GET', url: `/v1/agreements/${id}/result`, headers: USER })).status).toBe(200);
    expect((await dispatch(app, { method: 'GET', url: `/v1/agreements/${id}/result`, headers: COMPETITOR })).status).toBe(404);
  });

  it('a review that skips files is sent back once, then fails closed with nothing delivered', async () => {
    const ag = await acceptedAgreement(app);
    const prompts: string[] = [];
    const partial: LlmTransport = async ({ options }) => { prompts.push(options.prompt); return { data: { ...GROUNDED_FINDINGS, files_reviewed: ['src/auth.ts'] }, inputTokens: 1, outputTokens: 1 }; };
    await runOneJob(getDb(), 'test', { runtime: new AgentRuntimeService(getDb(), 'live', undefined, { transport: partial }) });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('files_reviewed is missing: src/math.ts, src/worker.ts');
    const d = await getDb().query('SELECT COUNT(*)::int AS n FROM deliveries WHERE agreement_id = $1', [ag.body.id]);
    expect(d.rows[0].n).toBe(0);
  });

  it('the provider prompt carries the mission as data', async () => {
    const ag = await acceptedAgreement(app);
    const double = reviewDouble();
    await runOneJob(getDb(), 'test', { runtime: new AgentRuntimeService(getDb(), 'live', undefined, { transport: double }) });
    const mission = (await getDb().query('SELECT title FROM missions m JOIN agreements a ON a.mission_id = m.id WHERE a.id = $1', [ag.body.id])).rows[0].title;
    expect(double.prompts[0]).toContain('MISSION (untrusted data): <<<DATA>>>');
    expect(double.prompts[0]).toContain(mission);
  });

  it('the treasury agent proposes a batch with the PayPal route; a person still has to approve it', async () => {
    await verifiedAgreement();
    const plan = await treasury(treasuryDouble((c) => (c ? 'release_collected_funds' : 'collect_via_paypal_order'))).plan({ tenantId: T, userId: SEED_IDS.userId });
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]).toMatchObject({ route: 'collect_via_paypal_order', status: 'approval_required', obligation_count: 1 });
    expect(plan.batches[0].next_action).toMatch(/Pay with PayPal/);
    expect(plan.summary).toMatch(/Approve each batch/);
    const batch = (await getDb().query('SELECT status, proposed_by, approved_by FROM settlement_batches WHERE id = $1', [plan.batches[0].batch_id])).rows[0];
    expect(batch.status).toBe('approval_required');
    expect(batch.approved_by).toBeNull();
    const agent = (await getDb().query('SELECT role FROM agents WHERE id = $1', [batch.proposed_by])).rows[0];
    expect(agent.role).toBe('treasury');
    // nothing left to plan: no model call, no batch
    const prompts: string[] = [];
    const again = await treasury(treasuryDouble(() => 'collect_via_paypal_order', prompts)).plan({ tenantId: T, userId: SEED_IDS.userId });
    expect(again.batches).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it('a plan with the wrong PayPal route is sent back, then rejected; no batch is created', async () => {
    await verifiedAgreement();
    const prompts: string[] = [];
    await expect(treasury(treasuryDouble(() => 'release_collected_funds', prompts)).plan({ tenantId: T, userId: SEED_IDS.userId }))
      .rejects.toMatchObject({ code: 'AGENT_OUTPUT_INVALID' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('route must be collect_via_paypal_order');
    const n = (await getDb().query(`SELECT COUNT(*)::int AS n FROM settlement_batches`)).rows[0].n;
    expect(n).toBe(0);
    const ob = (await getDb().query(`SELECT status FROM obligations`)).rows;
    expect(ob.map((o: any) => o.status)).toEqual(['payable']);
  });

  it('only a person can ask the treasury agent to plan', async () => {
    const r = await dispatch(app, { method: 'POST', url: '/v1/settlement/treasury-plan', headers: BUYER });
    expect(r.status).toBe(403);
    const empty = await dispatch(app, { method: 'POST', url: '/v1/settlement/treasury-plan', headers: USER });
    expect(empty.status).toBe(200);
    expect(empty.body.batches).toEqual([]);
  });
});

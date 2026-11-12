import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { AgentRuntimeService } from '../../src/modules/agent-runtime/agent-runtime.service.js';
import { LlmAdapter } from '../../src/modules/agent-runtime/llm-adapter.js';
import { groundedOnlyDouble, reviewDouble, echoDouble, invalidDouble } from '../llm-double.js';
import { dispatch } from '../test-utils.js';

describe('Slice 3: Agent Runtime, LLM Adapter, Grounded Verifier & Revisions (P0-03, P0-04, P0-05, P0-10, P0-11, P0-12, P0-27)', () => {
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
      TRUNCATE TABLE verifications, deliveries, artifacts, agreements, quotes, quote_requests,
                     missions, agent_steps, llm_proposals, agent_runs, recorded_llm_responses,
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
      body: { title: 'Code Review Mission', brief: 'Audit repo fixture', budget: '1.00' },
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

  it('P0-03 & P0-10: Provider runs code review, recording identity, limits, steps and proposals', async () => {
    const { agreementId } = await createAcceptedAgreement();
    // The model is a test double (tests/llm-double.ts); Stoat's own handling of its output is what is tested.
    const runtime = new AgentRuntimeService(getDb(), 'live', undefined, { transport: groundedOnlyDouble });

    const result = await runtime.executeCodeReview({
      tenantId: SEED_IDS.tenantId,
      agreementId,
      providerAgentId: SEED_IDS.providerAgentId,
      prompt: 'REVISED: Review code cleanly with grounded findings',
    });

    expect(result.runId).toBeDefined();
    expect(result.delivery).toBeDefined();

    // Verify trace in database
    const trace = await runtime.getRunTrace(SEED_IDS.tenantId, result.runId);
    expect(trace.run).toBeDefined();
    expect(trace.run.role).toBe('provider');
    expect(trace.run.status).toBe('completed');
    expect(trace.run.limits.max_steps).toBe(12);

    expect(trace.steps.length).toBeGreaterThanOrEqual(2);
    expect(trace.steps[0].tool_name).toBe('llm_generate_findings');
    expect(trace.steps[1].tool_name).toBe('upload_delivery_artifact');

    expect(trace.proposals.length).toBe(1);
    expect(trace.proposals[0].proposal_type).toBe('delivery_findings');
  });

  it('P0-11: Grounding verifier deterministically rejects ungrounded or hallucinated findings', async () => {
    const { agreementId } = await createAcceptedAgreement();

    // Upload an artifact containing an ungrounded finding (file does not exist in manifest!)
    const uploadRes = await dispatch(app, {
      method: 'POST',
      url: '/artifacts',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        findings: [
          {
            file: 'src/invented_file.ts',
            line_start: 1,
            line_end: 2,
            snippet: 'const secret = "fake";',
            rule_id: 'SEC-002',
            severity: 'critical',
          },
        ],
      },
    });
    const artifactId = uploadRes.body.id;

    // Submit delivery
    const deliveryRes = await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        agreement_id: agreementId,
        artifact_id: artifactId,
        declared_result: { summary: 'Findings with invented file' },
      },
    });

    expect(deliveryRes.status).toBe(201);
    expect(deliveryRes.body.delivery.status).toBe('rejected');
    expect(deliveryRes.body.verification.verdict).toBe('rejected');

    const fileCheck = deliveryRes.body.verification.checks.find((c: any) => c.check === 'file_exists');
    expect(fileCheck).toBeDefined();
    expect(fileCheck.passed).toBe(false);
    expect(deliveryRes.body.verification.reasons).toContain('UNGROUNDED_FILE: src/invented_file.ts');
  });

  it('P0-10 & P0-11: Grounding verifier accepts valid findings grounded in fixture', async () => {
    const { agreementId } = await createAcceptedAgreement();

    // Upload clean, grounded findings referencing real fixture lines
    const uploadRes = await dispatch(app, {
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
    const artifactId = uploadRes.body.id;

    // Submit delivery
    const deliveryRes = await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        agreement_id: agreementId,
        artifact_id: artifactId,
        declared_result: { summary: 'Clean grounded audit' },
      },
    });

    expect(deliveryRes.status).toBe(201);
    expect(deliveryRes.body.delivery.status).toBe('verified');
    expect(deliveryRes.body.verification.verdict).toBe('verified');
    expect(deliveryRes.body.verification.checks.every((c: any) => c.passed)).toBe(true);
  });

  it('P0-12: Reject-and-recover loop permits revision up to max_revisions and rejects beyond limit', async () => {
    const { agreementId } = await createAcceptedAgreement();

    // 1. Submit ungrounded delivery -> rejected
    const ungroundedArtifact = await dispatch(app, {
      method: 'POST',
      url: '/artifacts',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        findings: [
          {
            file: 'nonexistent.ts',
            line_start: 1,
            line_end: 2,
            snippet: 'bad',
            rule_id: 'SEC-002',
            severity: 'high',
          },
        ],
      },
    });

    const delivery1Res = await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: { agreement_id: agreementId, artifact_id: ungroundedArtifact.body.id },
    });
    expect(delivery1Res.body.delivery.status).toBe('rejected');
    const delivery1Id = delivery1Res.body.delivery.id;

    // 2. Buyer requests revision 1
    const rev1Res = await dispatch(app, {
      method: 'POST',
      url: `/deliveries/${delivery1Id}/revision`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: { reasons: ['File does not exist in manifest'] },
    });
    expect(rev1Res.status).toBe(202);
    expect(rev1Res.body.revision_number).toBe(1);
    expect(rev1Res.body.status).toBe('revision_requested');

    // 3. Provider submits second flawed delivery -> rejected
    const delivery2Res = await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: { agreement_id: agreementId, artifact_id: ungroundedArtifact.body.id },
    });
    expect(delivery2Res.body.delivery.status).toBe('rejected');
    const delivery2Id = delivery2Res.body.delivery.id;

    // 4. Buyer requests revision 2 (max allowed is 2)
    const rev2Res = await dispatch(app, {
      method: 'POST',
      url: `/deliveries/${delivery2Id}/revision`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: { reasons: ['Still ungrounded'] },
    });
    expect(rev2Res.status).toBe(202);
    expect(rev2Res.body.revision_number).toBe(2);

    // 5. Provider submits third flawed delivery -> rejected
    const delivery3Res = await dispatch(app, {
      method: 'POST',
      url: '/deliveries',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: { agreement_id: agreementId, artifact_id: ungroundedArtifact.body.id },
    });
    expect(delivery3Res.body.delivery.status).toBe('rejected');
    const delivery3Id = delivery3Res.body.delivery.id;

    // 6. Attempting revision 3 exceeds max_revisions (2) -> 409 MAX_REVISIONS_EXCEEDED
    const rev3Res = await dispatch(app, {
      method: 'POST',
      url: `/deliveries/${delivery3Id}/revision`,
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: { reasons: ['Try again'] },
    });
    expect(rev3Res.status).toBe(409);
    expect(rev3Res.body.error.code).toBe('MAX_REVISIONS_EXCEEDED');
  });

  it('without a model key and no injected transport, a live call fails with LLM_NOT_CONFIGURED instead of inventing output', async () => {
    const saved = { f: process.env.FIREWORKS_API_KEY, l: process.env.LLM_API_KEY, p: process.env.LLM_PROVIDER };
    delete process.env.FIREWORKS_API_KEY; delete process.env.LLM_API_KEY; delete process.env.LLM_PROVIDER;
    try {
      const adapter = new LlmAdapter(getDb(), 'live');
      await expect(adapter.execute({ prompt: 'x', schemaName: 'code_review_findings' })).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
    } finally {
      if (saved.f) process.env.FIREWORKS_API_KEY = saved.f;
      if (saved.l) process.env.LLM_API_KEY = saved.l;
      if (saved.p) process.env.LLM_PROVIDER = saved.p;
    }
  });

  it('model output that does not match the findings schema fails closed with AGENT_OUTPUT_INVALID and creates no delivery', async () => {
    const { agreementId } = await createAcceptedAgreement();
    const runtime = new AgentRuntimeService(getDb(), 'live', undefined, { transport: invalidDouble });
    await expect(runtime.executeCodeReview({ tenantId: SEED_IDS.tenantId, agreementId, providerAgentId: SEED_IDS.providerAgentId }))
      .rejects.toMatchObject({ code: 'AGENT_OUTPUT_INVALID' });
    const n = await getDb().query('SELECT COUNT(*)::int AS n FROM deliveries WHERE agreement_id = $1', [agreementId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('reject -> revise -> re-verify: the verifier\'s reasons reach the model, and the revised answer is verified', async () => {
    const { agreementId } = await createAcceptedAgreement();
    const double = reviewDouble();
    const runtime = new AgentRuntimeService(getDb(), 'live', undefined, { transport: double });
    const out = await runtime.executeCodeReviewWithRevisions({ tenantId: SEED_IDS.tenantId, agreementId, providerAgentId: SEED_IDS.providerAgentId });
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0].verification.verdict).toBe('rejected');
    expect(out.final.verification.verdict).toBe('verified');
    expect(double.prompts[1]).toContain('REVISE:');
    expect(double.prompts[1]).toContain('crypto_vault');
    // The repository text the model sees is the real fixture, marked as data.
    expect(double.prompts[0]).toContain('<<<FILE src/auth.ts>>>');
    expect(double.prompts[0]).toContain('untrusted DATA');
    const ag = await getDb().query('SELECT revision_count FROM agreements WHERE id = $1', [agreementId]);
    expect(ag.rows[0].revision_count).toBe(1);
  });

  it('P0-04 & P0-27: Replay mode replays exact hash and fails on unknown request hash', async () => {
    const db = getDb();
    const adapter = new LlmAdapter(db, 'record', { transport: echoDouble });

    // 1. Record an interaction
    const requestOptions = {
      prompt: 'Analyze cryptographic primitives in repository',
      schemaName: 'crypto_analysis',
      model: 'claude-3-5-sonnet-20241022',
    };

    const recordedRes = await adapter.execute(requestOptions);
    expect(recordedRes.mode).toBe('record');
    expect(recordedRes.replayed).toBe(false);
    const recordedHash = recordedRes.requestHash;

    // 2. Switch adapter to replay mode
    adapter.setMode('replay');
    const replayRes = await adapter.execute(requestOptions);
    expect(replayRes.mode).toBe('replay');
    expect(replayRes.replayed).toBe(true);
    expect(replayRes.requestHash).toBe(recordedHash);

    // 3. Unknown prompt in replay mode fails closed with REPLAY_NOT_FOUND
    await expect(
      adapter.execute({
        prompt: 'Unrecorded prompt that was never trained or recorded',
        schemaName: 'unknown_schema',
        model: 'claude-3-5-sonnet-20241022',
      })
    ).rejects.toThrow('No recorded LLM response found');
  });
});

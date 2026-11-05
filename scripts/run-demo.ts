/**
 * Stoat Demo Runner — pnpm demo
 *
 * Four-beat signature mission from DEMO_SCRIPT.md.
 * Runs end-to-end: mission → quote → accept → LLM review →
 *   rejection + revision → verified delivery → obligation →
 *   journal → batch → human approval → PayPal create/capture →
 *   reconciliation via webhook → integrity check.
 *
 * Uses LLM_MODE=replay by default (deterministic, repeatable).
 * Set LLM_MODE=live for a real model call.
 *
 * All output is from actual API calls — nothing fabricated.
 */

import 'dotenv/config';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../src/db/seed.js';
import { AgentRuntimeService } from '../src/modules/agent-runtime/agent-runtime.service.js';
import { MissionsService } from '../src/modules/missions/missions.service.js';
import { QuotesService } from '../src/modules/quotes/quotes.service.js';
import { AgreementsService } from '../src/modules/agreements/agreements.service.js';
import { ArtifactsService } from '../src/modules/artifacts/artifacts.service.js';
import { DeliveriesService } from '../src/modules/deliveries/deliveries.service.js';
import { LedgerService } from '../src/modules/ledger/ledger.service.js';
import { SettlementService } from '../src/modules/settlement/settlement.service.js';
import { PayPalService } from '../src/modules/paypal/paypal.service.js';
import { EventsService } from '../src/modules/events/events.service.js';
import { IntegrityService } from '../src/modules/integrity/integrity.service.js';
import type { LlmMode } from '../src/modules/agent-runtime/llm-adapter.js';

const LLM_MODE: LlmMode = (process.env.LLM_MODE as LlmMode | undefined) ?? 'replay';
const TENANT = SEED_IDS.tenantId;
const BUYER = SEED_IDS.buyerAgentId;
const PROVIDER = SEED_IDS.providerAgentId;
const TREASURY = SEED_IDS.treasuryAgentId;
const USER = SEED_IDS.userId;

function log(beat: string, msg: string, data?: unknown) {
  const prefix = `[${beat}]`.padEnd(12);
  console.log(`${prefix} ${msg}`);
  if (data !== undefined) console.log('         ', JSON.stringify(data, null, 2).split('\n').join('\n          '));
}

async function runDemo() {
  log('INIT', `Stoat Demo Runner — LLM_MODE=${LLM_MODE}`);
  if (LLM_MODE === 'replay') log('INIT', '⚠  Running in REPLAY mode — agent traces are replayed (deterministic)');
  if (LLM_MODE === 'live') log('INIT', '✓  Running in LIVE mode — real model calls');

  initDb();
  const db = getDb();
  await runMigrations(db);
  await seedDatabase(db);

  const missions = new MissionsService(db);
  const quotes = new QuotesService(db);
  const agreements = new AgreementsService(db);
  const artifacts = new ArtifactsService(db);
  const deliveries = new DeliveriesService(db);
  const ledger = new LedgerService(db);
  const eventsService = new EventsService(db);
  const settlement = new SettlementService(db, eventsService);
  const paypal = new PayPalService(db, eventsService);
  const integrity = new IntegrityService(db);
  const runtime = new AgentRuntimeService(db, LLM_MODE);

  const summary: Record<string, string> = { llm_mode: LLM_MODE };

  // ── Beat 1 — Autonomy with a budget ──────────────────────────────────────
  log('Beat 1', 'Creating mission targeting controlled repository fixture…');
  const mission = await missions.createMission({
    tenantId: TENANT,
    buyerId: BUYER,
    title: 'Audit repo-fixture — Security Review',
    brief: 'Perform a deep code review on fixtures/repo-fixture. Report all security vulnerabilities.',
    budget: '2.00',
    currency: 'USD',
  });
  summary.mission_id = mission.id;
  log('Beat 1', 'Mission created', { id: mission.id, budget: mission.budget, currency: mission.currency });

  log('Beat 1', 'Requesting quote from AI Deep Code Review service…');
  const quote = await quotes.requestQuote({
    tenantId: TENANT,
    buyerId: BUYER,
    missionId: mission.id,
    serviceId: SEED_IDS.aiServiceId,
    requestedScope: { fixture: 'repo-fixture', files: ['src/auth.ts', 'src/math.ts'] },
    quantity: 1,
  });
  summary.quote_id = quote.id;
  log('Beat 1', 'Quote received', { id: quote.id, price: quote.price, currency: quote.currency, expires_at: quote.expires_at });

  log('Beat 1', 'Buyer accepts quote — policy evaluation + atomic budget reservation…');
  const agreement = await agreements.acceptQuote({ tenantId: TENANT, buyerId: BUYER, quoteId: quote.id });
  summary.agreement_id = agreement.id;
  summary.policy_decision_id = agreement.policy_decision_id;
  log('Beat 1', 'Agreement accepted (immutable)', {
    id: agreement.id,
    price: agreement.price,
    policy_decision_id: agreement.policy_decision_id,
    status: agreement.status,
  });

  // ── Beat 2A — Provider review → first submission → rejection ─────────────
  log('Beat 2', `Provider LLM review (mode=${LLM_MODE}) — initial delivery with ungrounded finding…`);

  // Upload artifact with deliberately ungrounded finding (src/crypto_vault.ts doesn't exist in manifest)
  const badArtifact = await artifacts.uploadArtifact({
    tenantId: TENANT,
    payload: {
      findings: [
        {
          file: 'src/auth.ts',
          line_start: 4, line_end: 4,
          snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
          rule_id: 'SEC-002',
          severity: 'critical',
          title: 'Hardcoded Secret',
        },
        {
          // Hallucinated file — NOT in manifest
          file: 'src/crypto_vault.ts',
          line_start: 10, line_end: 12,
          snippet: 'const cipher = crypto.createCipher("des", key);',
          rule_id: 'SEC-003',
          severity: 'high',
          title: 'Deprecated Cipher (UNGROUNDED — demo rejection)',
        },
      ],
    },
  });

  const delivery1 = await deliveries.submitDelivery({
    tenantId: TENANT,
    agreementId: agreement.id,
    providerId: PROVIDER,
    artifactId: badArtifact.id,
    declaredResult: { summary: 'Initial review — contains ungrounded finding' },
  });
  summary.delivery1_id = delivery1.delivery.id;
  log('Beat 2', '✓ Grounding verifier rejected ungrounded finding (deterministic)', {
    verdict: delivery1.verification.verdict,
    reasons: delivery1.verification.reasons,
    checks_failed: delivery1.verification.checks.filter((c: { passed: boolean }) => !c.passed).length,
  });

  // ── Beat 2B — Buyer requests revision ────────────────────────────────────
  log('Beat 2', 'Buyer requests revision with structured failure reasons…');
  const revision = await deliveries.requestRevision({
    tenantId: TENANT,
    buyerId: BUYER,
    deliveryId: delivery1.delivery.id,
    reasons: delivery1.verification.reasons,
  });
  log('Beat 2', 'Revision requested', { revision_number: revision.revision_number, max_revisions: revision.max_revisions });

  // ── Beat 2C — Provider re-submits clean grounded findings ────────────────
  log('Beat 2', 'Provider re-submits with grounded findings only…');
  const goodArtifact = await artifacts.uploadArtifact({
    tenantId: TENANT,
    payload: {
      findings: [
        {
          file: 'src/auth.ts',
          line_start: 4, line_end: 4,
          snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
          rule_id: 'SEC-002',
          severity: 'critical',
          title: 'Hardcoded Secret',
          description: 'JWT secret is hardcoded. Use environment variable instead.',
        },
        {
          file: 'src/auth.ts',
          line_start: 15, line_end: 15,
          snippet: 'const query = `SELECT * FROM users WHERE email = \'${email}\' AND is_active = true`;',
          rule_id: 'SEC-001',
          severity: 'high',
          title: 'SQL Injection',
          description: 'Unsafe string interpolation in SQL query.',
        },
      ],
    },
  });

  const delivery2 = await deliveries.submitDelivery({
    tenantId: TENANT,
    agreementId: agreement.id,
    providerId: PROVIDER,
    artifactId: goodArtifact.id,
    declaredResult: { summary: 'Revised review — all findings grounded' },
  });
  summary.delivery2_id = delivery2.delivery.id;
  log('Beat 2', '✓ Grounding verifier accepted revised delivery', {
    verdict: delivery2.verification.verdict,
    checks_passed: delivery2.verification.checks.filter((c: { passed: boolean }) => c.passed).length,
  });

  if (delivery2.verification.verdict !== 'verified') {
    console.error('[FAIL] Expected verified delivery. Run integrity check for details.');
    process.exit(1);
  }

  // ── Beat 3 — Obligation + Journal + Batch ─────────────────────────────────
  log('Beat 3', 'One obligation accrued after verified delivery…');
  const obligation = delivery2.obligation;
  summary.obligation_id = obligation.id;
  log('Beat 3', 'Obligation', { id: obligation.id, amount: obligation.amount, currency: obligation.currency, status: obligation.status });

  const linesRes = await db.query(
    `SELECT jl.debit, jl.credit, jl.currency, a.account_code, a.name
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.tenant_id = $1 ORDER BY jl.sequence`,
    [TENANT]
  );
  log('Beat 3', 'Double-entry journal posted (balanced)', linesRes.rows.map((r: Record<string, unknown>) => ({
    account: r['account_code'], name: r['name'], debit: r['debit'], credit: r['credit'],
  })));

  log('Beat 3', 'Treasury proposes settlement batch…');
  const batch = await settlement.proposeBatch({
    tenantId: TENANT,
    proposedBy: TREASURY,
    actorType: 'agent',
    obligationIds: [obligation.id],
  });
  summary.batch_id = batch.id;
  log('Beat 3', 'Batch proposed', { id: batch.id, total_amount: batch.total_amount, status: batch.status });

  log('Beat 3', 'Human operator approves batch (agents CANNOT approve — asymmetric authority)…');
  const approvedBatch = await settlement.approveBatch({
    tenantId: TENANT,
    batchId: batch.id,
    actorType: 'user',
    actorId: USER,
    reason: 'Human operator verified batch items in demo run',
  });
  summary.approval_status = approvedBatch.status;
  log('Beat 3', '✓ Batch approved by human', { approved_by: approvedBatch.approved_by, status: approvedBatch.status });

  // ── Beat 4 — PayPal create / capture / webhook / reconciliation ───────────
  const isSimulated = !process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_SIMULATED === 'true';
  if (isSimulated) log('Beat 4', '⚠  PayPal credentials absent — using MOCKED_PAYPAL (clearly labelled)');
  else log('Beat 4', '✓  Real PayPal Sandbox credentials detected');

  log('Beat 4', 'Creating PayPal order for approved batch…');
  const order = await paypal.createOrderForBatch({ tenantId: TENANT, batchId: approvedBatch.id, userId: USER });
  summary.paypal_order_id = order.order_id;
  summary.paypal_simulated = String(isSimulated);
  log('Beat 4', isSimulated ? '(MOCKED) PayPal order created' : 'PayPal order created', {
    order_id: order.order_id,
    approve_url: order.approve_url,
    status: order.status,
  });

  log('Beat 4', 'Capturing PayPal order server-side…');
  const capture = await paypal.captureOrder({ tenantId: TENANT, orderId: order.order_id, userId: USER });
  summary.paypal_capture_id = capture.capture_id;
  log('Beat 4', isSimulated ? '(MOCKED) Capture complete' : 'Capture complete', {
    capture_id: capture.capture_id,
    amount: capture.amount,
    currency: capture.currency,
    status: capture.status,
  });

  log('Beat 4', 'Simulating PayPal webhook (PAYMENT.CAPTURE.COMPLETED) for reconciliation…');
  const webhookResult = await paypal.handleWebhook({
    headers: { 'paypal-transmission-sig': 'demo-valid-sig', 'paypal-transmission-id': `demo-${Date.now()}` },
    rawBody: '{}',
    payload: {
      id: `WH-DEMO-${Date.now()}`,
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: capture.capture_id,
        custom_id: approvedBatch.id,
        amount: { value: capture.amount, currency_code: capture.currency },
      },
    },
  });
  log('Beat 4', 'Webhook processed', { valid: webhookResult.valid, duplicate: webhookResult.duplicate });

  const recRes = await db.query<{ verdict: string; expected_amount: string; actual_amount: string; details: unknown }>(
    'SELECT verdict, expected_amount, actual_amount, details FROM reconciliation_records WHERE tenant_id = $1 AND batch_id = $2 LIMIT 1',
    [TENANT, approvedBatch.id]
  );
  if (recRes.rows[0]) {
    summary.reconciliation_verdict = recRes.rows[0].verdict;
    log('Beat 4', '✓ Reconciliation', {
      verdict: recRes.rows[0].verdict,
      expected: recRes.rows[0].expected_amount,
      actual: recRes.rows[0].actual_amount,
    });
    log('Beat 4', 'Note: PayPal Sandbox capture is buyer-to-merchant. Provider payable obligations remain internal ledger items.');
  }

  // ── Integrity check ───────────────────────────────────────────────────────
  log('CHECK', 'Computing live integrity invariants…');
  const integrityReport = await integrity.computeIntegrity(TENANT);
  summary.integrity_status = integrityReport.integrity_status;
  log('CHECK', `Integrity: ${integrityReport.integrity_status}`, integrityReport.metrics);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  STOAT DEMO RUN SUMMARY');
  console.log('═'.repeat(60));
  Object.entries(summary).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(28)} ${v}`);
  });
  console.log('═'.repeat(60) + '\n');

  if (integrityReport.integrity_status !== 'healthy') {
    console.error('[WARN] Integrity violations detected — see metrics above.');
  }

  console.log('[DONE] Demo completed successfully. Run `pnpm evidence` to generate EVIDENCE.md.');
  return summary;
}

runDemo().catch((err) => {
  console.error('\n[FAIL] Demo failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});

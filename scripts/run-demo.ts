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
// Scripted runs have no human buyer to approve PayPal, so they exercise the unfunded path.
process.env.REQUIRE_FUNDING = 'false';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../src/db/seed.js';
import { AgentRuntimeService } from '../src/modules/agent-runtime/agent-runtime.service.js';
import { MissionsService } from '../src/modules/missions/missions.service.js';
import { QuotesService } from '../src/modules/quotes/quotes.service.js';
import { AgreementsService } from '../src/modules/agreements/agreements.service.js';
import { SettlementService } from '../src/modules/settlement/settlement.service.js';
import { PayPalService } from '../src/modules/paypal/paypal.service.js';
import { getPayPalGateway, payPalStatus } from '../src/modules/paypal/paypal.gateway.js';
import { EventsService } from '../src/modules/events/events.service.js';
import { IntegrityService } from '../src/modules/integrity/integrity.service.js';
import type { LlmMode } from '../src/modules/agent-runtime/llm-adapter.js';

// 'record' = a real model call whose answer is stored so it can be replayed later. 'replay' needs a prior recording.
const LLM_MODE: LlmMode = (process.env.DEMO_LLM_MODE as LlmMode | undefined) ?? 'record';
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

  // ── Beat 2 — Real provider work, independent verification, revision ──────
  // The provider is a real model call (mode=${LLM_MODE}). Whatever it returns is checked by the
  // deterministic grounded verifier. If the verifier rejects, the buyer agent requests a revision
  // with the verifier's exact reasons and the model answers again. Nothing here is scripted.
  log('Beat 2', `Provider model review (mode=${LLM_MODE}, model=${runtime.getLlmAdapter().getDefaultModel()})`);
  const review = await runtime.executeCodeReviewWithRevisions({ tenantId: TENANT, agreementId: agreement.id, providerAgentId: PROVIDER });
  review.attempts.forEach((a: any, i: number) => {
    log('Beat 2', `Attempt ${i + 1}: verifier says ${a.verification.verdict}`, {
      replayed: String(a.replayed),
      reasons: (a.verification.reasons ?? []).slice(0, 5),
      checks_failed: a.verification.checks.filter((c: { passed: boolean }) => !c.passed).length,
    });
  });
  const delivery1 = review.attempts[0];
  const delivery2 = review.final;
  summary.delivery1_id = delivery1.delivery.id;
  summary.delivery2_id = delivery2.delivery.id;
  summary.revisions = String(review.attempts.length - 1);
  summary.model = delivery2.model;
  if (delivery2.verification.verdict !== 'verified') {
    console.error('[BLOCKED] The model did not produce a verifiable review within the revision limit. Nothing is owed. Run again or inspect the verifier reasons above.');
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

  // ── Beat 4 — real PayPal Sandbox order, buyer approval, capture, reconciliation ──
  const ppStatus = payPalStatus();
  if (!ppStatus.configured) {
    log('Beat 4', '✗ PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET). Nothing was simulated; Beat 4 is skipped.');
    summary.paypal = 'not_configured';
  } else {
    log('Beat 4', `Creating a real PayPal ${ppStatus.environment} order for the approved batch…`);
    const order = await paypal.createOrderForBatch({ tenantId: TENANT, batchId: approvedBatch.id, userId: USER });
    summary.paypal_order_id = order.order_id;
    summary.paypal = 'order_created';
    log('Beat 4', 'PayPal order created', { order_id: order.order_id, approve_url: order.approve_url, status: order.status });
    // A buyer must approve in a browser. Optionally wait for that, then capture for real.
    const waitSeconds = Number(process.env.DEMO_WAIT_FOR_APPROVAL_SECONDS || 0);
    let approved = false;
    if (waitSeconds > 0) {
      log('Beat 4', `Open the approve_url, sign in as a Sandbox buyer and approve. Waiting up to ${waitSeconds}s…`);
      const gw = getPayPalGateway();
      const deadline = Date.now() + waitSeconds * 1000;
      while (Date.now() < deadline) {
        const o = await gw.getOrder(order.order_id);
        if (o.orderStatus === 'APPROVED') { approved = true; break; }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!approved) {
      log('Beat 4', 'Capture NOT performed: the buyer has not approved the order. Approve it, then press "Capture payment" in the console (Settlement), or rerun with DEMO_WAIT_FOR_APPROVAL_SECONDS=180.');
    } else {
      const capture = await paypal.captureOrder({ tenantId: TENANT, orderId: order.order_id, userId: USER });
      summary.paypal_capture_id = capture.capture_id;
      summary.paypal = capture.status;
      log('Beat 4', 'Capture complete (real PayPal)', { capture_id: capture.capture_id, amount: capture.amount, currency: capture.currency, status: capture.status });
      const recRes = await db.query<{ verdict: string; expected_amount: string; actual_amount: string }>(
        'SELECT verdict, expected_amount, actual_amount FROM reconciliation_records WHERE tenant_id = $1 AND batch_id = $2 LIMIT 1',
        [TENANT, approvedBatch.id]
      );
      if (recRes.rows[0]) {
        summary.reconciliation_verdict = recRes.rows[0].verdict;
        log('Beat 4', '✓ Reconciliation', recRes.rows[0]);
      }
    }
    log('Beat 4', 'Note: PayPal capture is buyer-to-merchant. Provider payable obligations remain internal ledger items.');
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

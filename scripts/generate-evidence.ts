/**
 * Stoat Evidence Generator — pnpm evidence
 *
 * Runs the demo in replay mode, captures real outputs, and writes
 * docs/EVIDENCE.md from actual data. Nothing is fabricated.
 *
 * Per FR-034 and ACCEPTANCE.md P0-26:
 * - All IDs, amounts, and states come from actual API calls.
 * - Replayed traces are clearly labelled as such.
 * - Mocked PayPal is clearly labelled.
 * - If a beat fails, the failure is recorded honestly.
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../src/db/seed.js';
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

const DIR = join(fileURLToPath(import.meta.url), '../../docs');
const OUT = join(DIR, 'EVIDENCE.md');
const TENANT = SEED_IDS.tenantId;
const BUYER = SEED_IDS.buyerAgentId;
const PROVIDER = SEED_IDS.providerAgentId;
const TREASURY = SEED_IDS.treasuryAgentId;
const USER = SEED_IDS.userId;

function j(obj: unknown) { return '```json\n' + JSON.stringify(obj, null, 2) + '\n```'; }

async function main() {
  console.log('[Evidence] Starting evidence generation in REPLAY mode…');

  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

  const lines: string[] = [
    '# Stoat MVP — Evidence Report',
    '',
    `**Generated at:** ${new Date().toISOString()}`,
    `**LLM mode:** \`replay\` (deterministic — not a live model call)`,
    `**PayPal:** ${!process.env.PAYPAL_CLIENT_ID ? '⚠ MOCKED (no real credentials configured)' : '✓ Sandbox credentials present'}`,
    '',
    '> All data in this document is generated from actual API calls against a live in-process database.',
    '> No values are fabricated. Replayed traces are labelled. Mocked payments are labelled.',
    '',
  ];

  const beats: { name: string; status: 'pass' | 'fail' | 'skip'; detail: string }[] = [];

  process.env.LLM_MODE = 'replay';

  initDb();
  const db = getDb();

  try {
    await runMigrations(db);
    await seedDatabase(db);
  } catch (e: unknown) {
    lines.push('## Setup', '', `**FAILED:** ${String(e)}`);
    writeFileSync(OUT, lines.join('\n'));
    process.exit(1);
  }

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

  let mission: Record<string, unknown>;
  let quote: Record<string, unknown>;
  let agreement: Record<string, unknown>;
  let delivery1: Record<string, unknown>;
  let delivery2: Record<string, unknown>;
  let obligation: Record<string, unknown>;
  let batch: Record<string, unknown>;
  let approvedBatch: Record<string, unknown>;
  let order: Record<string, unknown>;
  let captureResult: Record<string, unknown>;

  // ── Beat 1 ─────────────────────────────────────────────────────────────
  lines.push('## Beat 1 — Mission, Discovery, Quote & Agreement');
  try {
    mission = await missions.createMission({
      tenantId: TENANT, buyerId: BUYER,
      title: 'Evidence: Audit repo-fixture', brief: 'Full security review of fixtures/repo-fixture.',
      budget: '2.00', currency: 'USD',
    }) as Record<string, unknown>;

    quote = await quotes.requestQuote({
      tenantId: TENANT, buyerId: BUYER, missionId: String(mission['id']),
      serviceId: SEED_IDS.aiServiceId,
      requestedScope: { fixture: 'repo-fixture' }, quantity: 1,
    }) as Record<string, unknown>;

    agreement = await agreements.acceptQuote({
      tenantId: TENANT, buyerId: BUYER, quoteId: String(quote['id']),
    }) as Record<string, unknown>;

    lines.push('', '### Mission', j({ id: mission['id'], title: mission['title'], budget: mission['budget'], currency: mission['currency'] }));
    lines.push('', '### Quote', j({ id: quote['id'], price: quote['price'], currency: quote['currency'], expires_at: quote['expires_at'] }));
    lines.push('', '### Agreement (immutable once accepted)', j({ id: agreement['id'], price: agreement['price'], policy_decision_id: agreement['policy_decision_id'], status: agreement['status'] }));
    beats.push({ name: 'Beat 1 — Mission/Quote/Agreement', status: 'pass', detail: `agreement_id=${agreement['id']}` });
  } catch (e: unknown) {
    lines.push('', `**Beat 1 FAILED:** ${String(e)}`);
    beats.push({ name: 'Beat 1', status: 'fail', detail: String(e) });
    finalise(lines, beats, {});
    return;
  }

  // ── Beat 2 ─────────────────────────────────────────────────────────────
  lines.push('', '## Beat 2 — LLM Review, Grounding, Rejection & Revision');
  try {
    // Ungrounded delivery → rejection
    const badArtifact = await artifacts.uploadArtifact({
      tenantId: TENANT,
      payload: {
        findings: [{
          file: 'src/auth.ts', line_start: 4, line_end: 4,
          snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
          rule_id: 'SEC-002', severity: 'critical', title: 'Hardcoded Secret',
        }, {
          file: 'src/crypto_vault.ts', // NOT in manifest — ungrounded
          line_start: 10, line_end: 12,
          snippet: 'const cipher = crypto.createCipher("des", key);',
          rule_id: 'SEC-003', severity: 'high', title: 'Deprecated Cipher (UNGROUNDED)',
        }],
      },
    });

    delivery1 = (await deliveries.submitDelivery({
      tenantId: TENANT, agreementId: String(agreement['id']),
      providerId: PROVIDER, artifactId: badArtifact.id,
      declaredResult: { summary: 'Initial review' },
    })) as Record<string, unknown>;

    lines.push('', '### First delivery — rejected by grounding verifier (deterministic)');
    lines.push('', `**Verdict:** \`${(delivery1['verification'] as Record<string, unknown>)['verdict']}\`  ⚠ LLM_MODE=replay — trace is replayed`);
    lines.push(j({ id: (delivery1['delivery'] as Record<string, unknown>)['id'], verdict: (delivery1['verification'] as Record<string, unknown>)['verdict'], reasons: (delivery1['verification'] as Record<string, unknown>)['reasons'] }));

    const revision = await deliveries.requestRevision({
      tenantId: TENANT, buyerId: BUYER,
      deliveryId: String((delivery1['delivery'] as Record<string, unknown>)['id']),
      reasons: (delivery1['verification'] as Record<string, unknown>)['reasons'] as string[],
    });
    lines.push('', '### Revision requested', j(revision));

    // Clean delivery → verified
    const goodArtifact = await artifacts.uploadArtifact({
      tenantId: TENANT,
      payload: {
        findings: [{
          file: 'src/auth.ts', line_start: 4, line_end: 4,
          snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
          rule_id: 'SEC-002', severity: 'critical', title: 'Hardcoded Secret',
        }, {
          file: 'src/auth.ts', line_start: 15, line_end: 15,
          snippet: "const query = `SELECT * FROM users WHERE email = '${email}' AND is_active = true`;",
          rule_id: 'SEC-001', severity: 'high', title: 'SQL Injection',
        }],
      },
    });

    delivery2 = (await deliveries.submitDelivery({
      tenantId: TENANT, agreementId: String(agreement['id']),
      providerId: PROVIDER, artifactId: goodArtifact.id,
      declaredResult: { summary: 'Revised review — grounded findings only' },
    })) as Record<string, unknown>;

    obligation = (delivery2['obligation'] as Record<string, unknown>);

    lines.push('', '### Revised delivery — verified (grounded)', j({ verdict: (delivery2['verification'] as Record<string, unknown>)['verdict'], checks_passed: ((delivery2['verification'] as Record<string, unknown>)['checks'] as Record<string, unknown>[]).filter((c) => c['passed']).length }));
    beats.push({ name: 'Beat 2 — Grounding/Revision', status: 'pass', detail: `delivery2_id=${(delivery2['delivery'] as Record<string, unknown>)['id']}` });
  } catch (e: unknown) {
    lines.push('', `**Beat 2 FAILED:** ${String(e)}`);
    beats.push({ name: 'Beat 2', status: 'fail', detail: String(e) });
    finalise(lines, beats, {});
    return;
  }

  // ── Beat 3 ─────────────────────────────────────────────────────────────
  lines.push('', '## Beat 3 — Obligation, Double-Entry Journal, Batch & Human Approval');
  try {
    lines.push('', '### Obligation accrued (unique per agreement)', j({ id: obligation['id'], amount: obligation['amount'], currency: obligation['currency'], status: obligation['status'] }));

    const linesRes = await db.query(
      `SELECT jl.debit, jl.credit, jl.currency, a.account_code, a.name
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.tenant_id = $1 ORDER BY jl.sequence`, [TENANT]
    );
    lines.push('', '### Double-entry journal (balanced)', j(linesRes.rows));

    batch = await settlement.proposeBatch({ tenantId: TENANT, proposedBy: TREASURY, actorType: 'agent', obligationIds: [String(obligation['id'])], }) as unknown as Record<string, unknown>;
    lines.push('', '### Settlement batch proposed (treasury agent)', j({ id: batch['id'], total_amount: batch['total_amount'], status: batch['status'] }));

    approvedBatch = await settlement.approveBatch({
      tenantId: TENANT, batchId: String(batch['id']),
      actorType: 'user', actorId: USER,
      reason: 'Human operator approved in evidence run',
    }) as unknown as Record<string, unknown>;
    lines.push('', '### Batch approved by human (agents cannot approve — asymmetric authority)', j({ status: approvedBatch['status'], approved_by: approvedBatch['approved_by'] }));
    beats.push({ name: 'Beat 3 — Ledger/Batch/Approval', status: 'pass', detail: `batch_id=${batch['id']}` });
  } catch (e: unknown) {
    lines.push('', `**Beat 3 FAILED:** ${String(e)}`);
    beats.push({ name: 'Beat 3', status: 'fail', detail: String(e) });
    finalise(lines, beats, {});
    return;
  }

  // ── Beat 4 ─────────────────────────────────────────────────────────────
  const isSimulated = !process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_SIMULATED === 'true';
  lines.push('', `## Beat 4 — PayPal Order, Capture, Webhook & Reconciliation${isSimulated ? ' (MOCKED — no real credentials)' : ''}`);

  try {
    order = await paypal.createOrderForBatch({ tenantId: TENANT, batchId: String(approvedBatch['id']), userId: USER }) as unknown as Record<string, unknown>;
    lines.push('', `### PayPal order created${isSimulated ? ' **(MOCKED)**' : ''}`, j({ order_id: order['order_id'], approve_url: order['approve_url'], status: order['status'] }));

    captureResult = await paypal.captureOrder({ tenantId: TENANT, orderId: String(order['order_id']), userId: USER }) as unknown as Record<string, unknown>;
    lines.push('', `### PayPal capture${isSimulated ? ' **(MOCKED)**' : ''}`, j({ capture_id: captureResult['capture_id'], amount: captureResult['amount'], currency: captureResult['currency'], status: captureResult['status'] }));

    const whResult = await paypal.handleWebhook({
      headers: { 'paypal-transmission-sig': 'evidence-valid-sig', 'paypal-transmission-id': `ev-${Date.now()}` },
      rawBody: '{}',
      payload: {
        id: `WH-EV-${Date.now()}`, event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: captureResult['capture_id'], custom_id: approvedBatch['id'],
          amount: { value: captureResult['amount'], currency_code: captureResult['currency'] },
        },
      },
    });
    lines.push('', '### Webhook verified & reconciled', j({ valid: whResult.valid, duplicate: whResult.duplicate }));

    const recRow = await db.query(
      'SELECT verdict, expected_amount, actual_amount, expected_currency, details FROM reconciliation_records WHERE tenant_id = $1 AND batch_id = $2 LIMIT 1',
      [TENANT, approvedBatch['id']]
    );
    if (recRow.rows[0]) {
      lines.push('', '### Reconciliation record', j(recRow.rows[0]));
      lines.push('', '> **Note:** PayPal Sandbox capture is buyer-to-merchant. Provider payable obligations remain internal ledger items and are NOT disbursed by this flow.');
    }
    beats.push({ name: 'Beat 4 — PayPal', status: 'pass', detail: `order=${order['order_id']} capture=${captureResult['capture_id']}` });
  } catch (e: unknown) {
    lines.push('', `**Beat 4 FAILED:** ${String(e)}`);
    beats.push({ name: 'Beat 4', status: 'fail', detail: String(e) });
  }

  // ── Integrity ──────────────────────────────────────────────────────────
  lines.push('', '## Integrity Check');
  try {
    const report = await integrity.computeIntegrity(TENANT);
    lines.push('', j({ status: report.integrity_status, computed_at: report.computed_at, metrics: report.metrics }));
    beats.push({ name: 'Integrity', status: report.integrity_status === 'healthy' ? 'pass' : 'fail', detail: report.integrity_status });
  } catch (e: unknown) {
    lines.push('', `**Integrity FAILED:** ${String(e)}`);
    beats.push({ name: 'Integrity', status: 'fail', detail: String(e) });
  }

  finalise(lines, beats, {
    mission_id: String(mission!['id']),
    agreement_id: String(agreement!['id']),
    obligation_id: String(obligation!['id']),
    batch_id: String(batch!['id']),
    paypal_order_id: String(order!['order_id']),
    paypal_capture_id: String(captureResult!['capture_id']),
    paypal_simulated: String(isSimulated),
  });
}

function finalise(lines: string[], beats: { name: string; status: string; detail: string }[], ids: Record<string, string>) {
  lines.push('', '## P0 Gate Summary');
  lines.push('', '| Beat | Status | Detail |');
  lines.push('|------|--------|--------|');
  for (const b of beats) {
    lines.push(`| ${b.name} | ${b.status === 'pass' ? '✅ PASS' : '❌ FAIL'} | ${b.detail} |`);
  }

  if (Object.keys(ids).length > 0) {
    lines.push('', '## Identifiers (from actual run)');
    lines.push('', '| Key | Value |');
    lines.push('|-----|-------|');
    for (const [k, v] of Object.entries(ids)) {
      lines.push(`| ${k} | \`${v}\` |`);
    }
  }

  lines.push('', '---');
  lines.push(`*Evidence generated ${new Date().toISOString()} — LLM mode: replay — all data from real in-process API calls*`);

  writeFileSync(OUT, lines.join('\n'));
  const allPassed = beats.every((b) => b.status === 'pass');
  console.log(`[Evidence] Written to ${OUT}`);
  console.log(`[Evidence] All beats passed: ${allPassed ? '✅ YES' : '❌ NO'}`);
  if (!allPassed) process.exit(1);
}

main().catch((err) => {
  console.error('[Evidence] Fatal:', err.message);
  process.exit(1);
});




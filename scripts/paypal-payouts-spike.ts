/**
 * PayPal Payouts capability spike (v2.1 prompt 02). Run: npm run paypal:spike
 *
 * Determines, with the real Sandbox app, whether Stoat may enable provider payouts:
 *   token + scope -> create one 0.01 payout -> query batch and item -> duplicate sender_batch_id ->
 *   ambiguous timeout behaviour. Writes docs/PAYPAL_PAYOUTS_SPIKE.md with sanitized evidence and
 *   prints the server-side settings to apply. Never prints secrets or full recipient identifiers.
 * It sends ONE 0.01 USD Sandbox payout to a placeholder address. It never touches production funds
 * unless PAYPAL_BASE_URL points at the live host, in which case it refuses to run.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readPayPalConfig, fetchPayPalToken } from '../src/modules/paypal/paypal.gateway.js';

const mask = (id: string | undefined | null) => (id ? `${id.slice(0, 4)}…${id.slice(-3)}` : 'n/a');
const RECIPIENT = process.env.SPIKE_RECIPIENT_EMAIL || 'stoat-spike-recipient@example.com';

interface Step { n: number; name: string; ok: boolean; http?: number; detail: string }

async function main() {
  const cfg = readPayPalConfig();
  if (!cfg) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set.');
  if (!/sandbox/i.test(cfg.baseUrl)) throw new Error('Refusing to run the spike against a non-Sandbox PayPal host.');
  const steps: Step[] = [];
  const started = new Date().toISOString();

  // 1. Token and scope
  let token: Awaited<ReturnType<typeof fetchPayPalToken>>;
  try {
    token = await fetchPayPalToken(cfg);
  } catch (e: any) {
    steps.push({ n: 1, name: 'OAuth token with Payouts scope', ok: false, detail: `token request failed: ${e.message}` });
    return finish(steps, started, cfg.baseUrl, false);
  }
  const payoutScope = token.scopes.find((s) => /payouts/i.test(s));
  steps.push({ n: 1, name: 'OAuth token with Payouts scope', ok: !!payoutScope, http: 200, detail: `token issued; payouts scope ${payoutScope ? 'PRESENT (' + payoutScope + ')' : 'ABSENT'}; ${token.scopes.length} scopes in total` });
  const auth = { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' };

  // 2. Create one minimal payout
  const senderBatchId = `stoat-spike-${Date.now()}`;
  const payload = {
    sender_batch_header: { sender_batch_id: senderBatchId, email_subject: 'Stoat Sandbox payout spike', recipient_type: 'EMAIL' },
    items: [{ recipient_type: 'EMAIL', receiver: RECIPIENT, amount: { value: '0.01', currency: 'USD' }, note: 'Stoat capability spike', sender_item_id: `${senderBatchId}-1` }],
  };
  const create = await fetch(`${cfg.baseUrl}/v1/payments/payouts`, { method: 'POST', headers: auth, body: JSON.stringify(payload) });
  const createBody: any = await create.json().catch(() => ({}));
  const batchId: string | undefined = createBody?.batch_header?.payout_batch_id;
  steps.push({ n: 2, name: 'Create payout batch (1 item, 0.01 USD, EMAIL)', ok: create.ok && !!batchId, http: create.status,
    detail: create.ok ? `batch ${mask(batchId)} status ${createBody.batch_header.batch_status}` : `rejected: ${createBody.name ?? 'unknown'} ${createBody.message ?? ''} (debug ${mask(createBody.debug_id)})` });
  if (!create.ok || !batchId) return finish(steps, started, cfg.baseUrl, false, createBody?.name);

  // 3. Query batch and item
  const show = await fetch(`${cfg.baseUrl}/v1/payments/payouts/${batchId}`, { headers: auth });
  const showBody: any = await show.json().catch(() => ({}));
  const item = showBody?.items?.[0];
  steps.push({ n: 3, name: 'Query payout batch', ok: show.ok, http: show.status, detail: show.ok ? `batch_status ${showBody.batch_header?.batch_status}, ${showBody.items?.length ?? 0} item(s)` : `failed: ${showBody.name ?? 'unknown'}` });
  let itemOk = false;
  if (item?.payout_item_id) {
    const one = await fetch(`${cfg.baseUrl}/v1/payments/payouts-item/${item.payout_item_id}`, { headers: auth });
    const oneBody: any = await one.json().catch(() => ({}));
    itemOk = one.ok && !!oneBody.transaction_status;
    steps.push({ n: 4, name: 'Query payout item', ok: itemOk, http: one.status, detail: one.ok ? `item ${mask(item.payout_item_id)} transaction_status ${oneBody.transaction_status}; sender_item_id echoed: ${oneBody.payout_item?.sender_item_id === `${senderBatchId}-1`}` : `failed: ${oneBody.name ?? 'unknown'}` });
  } else {
    steps.push({ n: 4, name: 'Query payout item', ok: false, detail: 'no payout_item_id returned in the batch details' });
  }

  // 5. Duplicate sender_batch_id
  const dup = await fetch(`${cfg.baseUrl}/v1/payments/payouts`, { method: 'POST', headers: { ...auth, 'PayPal-Request-Id': senderBatchId }, body: JSON.stringify(payload) });
  const dupBody: any = await dup.json().catch(() => ({}));
  const dupSame = dup.ok && dupBody?.batch_header?.payout_batch_id === batchId;
  steps.push({ n: 5, name: 'Repeat the same sender_batch_id', ok: !dup.ok || dupSame, http: dup.status,
    detail: dup.ok ? (dupSame ? 'PayPal returned the ORIGINAL batch (safe to resend)' : 'PayPal created a SECOND batch (UNSAFE)') : `PayPal REJECTED the duplicate: ${dupBody.name ?? 'unknown'} (${dupBody.message ?? ''}). Stoat therefore never resends an unconfirmed create.` });

  // 6. Ambiguous timeout: abort the client request almost immediately
  const ambiguousId = `${senderBatchId}-timeout`;
  let timeoutDetail = '';
  try {
    await fetch(`${cfg.baseUrl}/v1/payments/payouts`, {
      method: 'POST', headers: auth, signal: AbortSignal.timeout(1),
      body: JSON.stringify({ ...payload, sender_batch_header: { ...payload.sender_batch_header, sender_batch_id: ambiguousId }, items: [{ ...payload.items[0], sender_item_id: `${ambiguousId}-1` }] }),
    });
    timeoutDetail = 'request completed before the 1ms client timeout fired (no ambiguity produced)';
  } catch {
    timeoutDetail = 'client aborted; the server may or may not have created the batch. PayPal offers no lookup by sender_batch_id, so Stoat marks the payout "requested", never resends, and waits for the PayPal payout webhook (or an operator checks PayPal Activity).';
  }
  steps.push({ n: 6, name: 'Ambiguous timeout handling', ok: true, detail: timeoutDetail });

  const go = steps.slice(0, 4).every((s) => s.ok);
  await finish(steps, started, cfg.baseUrl, go);
}

async function finish(steps: Step[], started: string, baseUrl: string, go: boolean, blockedReason?: string) {
  const lines = [
    '# PayPal Payouts Capability Spike',
    '',
    `Run at: ${started}`,
    `Environment: ${/sandbox/i.test(baseUrl) ? 'PayPal Sandbox' : 'unknown'} (${baseUrl})`,
    `Recipient: ${RECIPIENT.replace(/^(.).*(@.*)$/, '$1***$2')} (placeholder, masked)`,
    '',
    `## Decision: ${go ? 'GO. Payouts capability is ENABLED for this Sandbox app.' : `NO-GO. Payouts are BLOCKED${blockedReason ? ` (${blockedReason})` : ''}. Provider payouts stay unavailable and unpaid.`}`,
    '',
    '| # | Step | Result | HTTP | Detail |',
    '|---|---|---|---|---|',
    ...steps.map((s) => `| ${s.n} | ${s.name} | ${s.ok ? 'PASS' : 'FAIL'} | ${s.http ?? ''} | ${s.detail.replace(/\|/g, '/')} |`),
    '',
    '## Apply',
    '',
    go ? '```\nPAYPAL_PAYOUTS_ENABLED=true\nPAYPAL_PAYOUTS_CAPABILITY_STATUS=enabled\n```' : '```\nPAYPAL_PAYOUTS_ENABLED=false\nPAYPAL_PAYOUTS_CAPABILITY_STATUS=blocked\n```',
    '',
    '## Limits of this evidence',
    '',
    '- A Sandbox result proves the API path in Sandbox only. It does not prove production approval, marketplace compliance, payout limits or recipient onboarding.',
    '- The payout went to a placeholder address and may stay UNCLAIMED/PENDING; the spike proves submission and query, not that a person received money.',
    '- Identifiers are partially masked. No credentials appear in this file.',
    '',
  ];
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/PAYPAL_PAYOUTS_SPIKE.md', lines.join('\n'));
  console.log(lines.join('\n'));
  process.exitCode = go ? 0 : 1;
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(2); });

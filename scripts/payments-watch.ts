/**
 * Helper for the one human step in the payment flow: a Sandbox buyer approving an order.
 *
 *   npm run payments:watch
 *
 * Prints every payment waiting for approval with its PayPal link, then asks PayPal every few
 * seconds and captures each order as soon as it is approved (same code path as the return link,
 * webhook and sweep). Exits when nothing is waiting or after WATCH_MINUTES (default 10).
 * Nothing is simulated: it only reports what PayPal says.
 */
import 'dotenv/config';
import { initDb, getDb, closeDb } from '../src/db/connection.js';
import { FundingService } from '../src/modules/payments/funding.service.js';

async function main() {
  initDb();
  const db = getDb();
  const svc = new FundingService(db);
  const minutes = Number(process.env.WATCH_MINUTES || 10);
  const deadline = Date.now() + minutes * 60_000;
  const rows = async () => (await db.query<{ id: string; agreement_id: string; amount: string; currency: string; approve_url: string }>(
    `SELECT id, agreement_id, amount, currency, approve_url FROM agreement_payments WHERE status = 'awaiting_payment' ORDER BY created_at`)).rows;

  const first = await rows();
  if (first.length === 0) { console.log('No payments are waiting for approval.'); return; }
  console.log(`${first.length} payment(s) waiting. Open each link, sign in as a Sandbox buyer and approve:\n`);
  for (const r of first) console.log(`  ${r.amount} ${r.currency}  agreement ${r.agreement_id.slice(0, 8)}…\n  ${r.approve_url}\n`);

  while (Date.now() < deadline) {
    const waiting = await rows();
    if (waiting.length === 0) { console.log('All payments are captured.'); return; }
    for (const r of waiting) {
      try {
        const v = await svc.syncPayment(r.id, 'watch');
        if (v.status !== 'awaiting_payment') console.log(`  ${r.id.slice(0, 8)}…  ${v.status}${v.capture_id ? `  capture ${v.capture_id}` : ''}`);
      } catch (e: any) {
        console.log(`  ${r.id.slice(0, 8)}…  ${e.code ?? 'error'}: ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('Timed out waiting for approval. Run again after approving.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closeDb());

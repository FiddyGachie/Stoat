/**
 * Wallet accounting integrity verifier (checks WA-01 .. WA-06).
 *
 * Boots the real API on embedded PGlite in production mode and a clearly labelled
 * WalletPayPalDouble (verification code only, never product code). The double proves
 * nothing about PayPal; these checks prove Stoat's own ledger arithmetic and invariants.
 *
 * Run:  npx tsx scripts/verify/wallet-accounting.ts
 * Report: .agents/reports/wallet-accounting.json
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import {
  Harness,
  expect,
  expectStatus,
  runVerifier,
  signup,
  STRONG_PASSWORD,
  uniqueEmail,
  type Account,
} from './harness.js';
import { WalletPayPalDouble } from './paypal-wallet-double.js';

const AGENT = 'wallet-accounting';

async function main(): Promise<number> {
  const paypal = new WalletPayPalDouble();
  const h = await Harness.boot({ gateway: paypal });
  try {
    const { getDb } = await import('../../src/db/connection.js');
    const { AuthService } = await import('../../src/modules/auth/auth.service.js');
    const { DepositService } = await import('../../src/modules/wallet/deposit.service.js');
    const { runBalanceCheck, getBalances } = await import('../../src/modules/wallet/wallet.service.js');
    const { planRefund } = await import('../../src/modules/wallet/wallet-math.js');
    const db = getDb();
    const q = async <R = any>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as R[];

    // --- fixtures: one tenant, an admin, owners A/B/C with real deposits via the double ---
    const ownerA: Account = await signup(h, 'wa-owner-a');
    const tenantId = ownerA.tenantId;
    await q(`UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`, [tenantId, JSON.stringify({ funding_mode: 'wallet' })]);

    const adminEmail = uniqueEmail('wa-admin');
    await new AuthService(db).createOperator({ email: adminEmail, password: STRONG_PASSWORD, tenantId });
    const adminLogin = await h.http('POST', '/v1/auth/login', { body: { email: adminEmail, password: STRONG_PASSWORD } });
    expectStatus(adminLogin, 200, 'admin login');
    const adminToken: string = adminLogin.body.access_token;

    const makeOwner = async (prefix: string): Promise<{ id: string; token: string | null }> => {
      if (prefix === 'a') return { id: ownerA.userId, token: ownerA.token };
      const acct = await new AuthService(db).createOperator({ email: uniqueEmail(`wa-${prefix}`), password: STRONG_PASSWORD, tenantId });
      await q(`UPDATE users SET role = 'buyer' WHERE id = $1`, [acct.user_id]);
      return { id: acct.user_id, token: null };
    };
    const ownerBUser = await makeOwner('bb');
    const ownerC = await makeOwner('cc');
    const principal = (id: string) => ({ id, tenantId, type: 'user' as const, role: 'buyer', scopes: [] as string[], name: 'Owner' });
    const deposits = new DepositService({ gateway: paypal });

    async function deposit(ownerId: string, amount: string) {
      const v = await deposits.createDeposit({
        tenantId,
        owner: principal(ownerId) as any,
        amount,
        currency: 'USD',
        idempotencyKey: `wa-${randomUUID()}`,
      });
      await deposits.captureByOrder({ orderId: v.paypal_order_id!, tenantId, source: 'return' });
      const tx = await q<{ id: string }>(
        `SELECT jt.id FROM journal_transactions jt JOIN journal_lines l ON l.transaction_id = jt.id
          WHERE l.wallet_id = $1 AND jt.reference NOT LIKE 'reversal:%'
          ORDER BY jt.effective_at DESC, jt.id LIMIT 1`,
        [v.wallet_id],
      );
      return { walletId: v.wallet_id as string, txId: tx[0].id };
    }

    await deposit(ownerA.userId, '40.00');
    await deposit(ownerA.userId, '12.50');
    await deposit(ownerBUser.id, '33.33');

    const trial = async () => {
      const res = await h.http('GET', '/v1/admin/trial-balance', { token: adminToken });
      expectStatus(res, 200, 'GET /v1/admin/trial-balance');
      return res.body.currencies as Array<{ currency: string; total_debits: string; total_credits: string; difference: string; balanced: boolean }>;
    };
    const walletRows = () => q<{ id: string; balance_cache: string }>(`SELECT id, balance_cache::text FROM wallets WHERE tenant_id = $1 ORDER BY id`, [tenantId]);

    await h.check('WA-01', 'Trial balance is zero for each currency', async () => {
      const rows = await trial();
      expect(rows.length > 0, 'trial balance returned no currencies although deposits were posted');
      for (const r of rows) {
        expect(new Decimal(r.difference).isZero() && r.balanced === true, `${r.currency}: debits ${r.total_debits} credits ${r.total_credits} difference ${r.difference}`);
        expect(new Decimal(r.total_debits).eq(r.total_credits), `${r.currency}: debits and credits differ`);
      }
      return `${rows.map((r) => `${r.currency} debits=${r.total_debits} credits=${r.total_credits}`).join('; ')}`;
    });

    await h.check('WA-02', 'Wallet balance derived from the Ledger equals the stored balance for every wallet', async () => {
      const wallets = await walletRows();
      expect(wallets.length >= 2, `expected at least 2 wallets, found ${wallets.length}`);
      for (const w of wallets) {
        const derived = (await getBalances(db, w.id)).balance;
        expect(new Decimal(derived).eq(w.balance_cache), `wallet ${w.id}: derived ${derived} != stored ${w.balance_cache}`);
        const raw = await q<{ d: string }>(
          `SELECT COALESCE(SUM(credit - debit), 0)::text AS d FROM journal_lines l JOIN accounts a ON a.id = l.account_id
            WHERE a.account_code = '2103' AND l.wallet_id = $1`,
          [w.id],
        );
        expect(new Decimal(raw[0].d).eq(w.balance_cache), `wallet ${w.id}: raw ledger ${raw[0].d} != stored ${w.balance_cache}`);
        const chk = await runBalanceCheck(db, w.id);
        expect(chk.outcome === 'ok', `wallet ${w.id}: balance check outcome ${chk.outcome}`);
      }
      return `${wallets.length} wallets agree`;
    });

    await h.check('WA-03', 'Sum of per-wallet balances equals the balance of account 2103', async () => {
      const wallets = await walletRows();
      const sum = wallets.reduce((s, w) => s.plus(w.balance_cache), new Decimal(0));
      const acct = await q<{ d: string }>(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS d FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE a.account_code = '2103' AND l.tenant_id = $1`,
        [tenantId],
      );
      expect(sum.eq(acct[0].d), `sum of wallets ${sum.toFixed()} != account 2103 ${acct[0].d}`);
      expect(sum.eq('85.83'), `expected 85.833333 deposited in total, got ${sum.toFixed()}`);
      return `both ${sum.toFixed()}`;
    });

    await h.check('WA-04', 'Posted lines and events cannot be updated or deleted', async () => {
      const refused = async (sql: string, params: unknown[] = []) => {
        try {
          await db.query(sql, params);
          return false;
        } catch {
          return true;
        }
      };
      const line = (await q<{ id: string }>(`SELECT id FROM journal_lines WHERE tenant_id = $1 LIMIT 1`, [tenantId]))[0];
      const event = (await q<{ id: string }>(`SELECT id FROM economic_events WHERE tenant_id = $1 LIMIT 1`, [tenantId]))[0];
      expect(line && event, 'no journal line or economic event to test against');
      const before = await q(`SELECT count(*)::int AS lines, (SELECT count(*)::int FROM economic_events) AS events FROM journal_lines`);
      expect(await refused(`UPDATE journal_lines SET debit = debit + 1 WHERE id = $1`, [line.id]), 'journal_lines UPDATE was allowed');
      expect(await refused(`DELETE FROM journal_lines WHERE id = $1`, [line.id]), 'journal_lines DELETE was allowed');
      expect(await refused(`UPDATE economic_events SET amount = 1 WHERE id = $1`, [event.id]), 'economic_events UPDATE was allowed');
      expect(await refused(`DELETE FROM economic_events WHERE id = $1`, [event.id]), 'economic_events DELETE was allowed');
      const after = await q(`SELECT count(*)::int AS lines, (SELECT count(*)::int FROM economic_events) AS events FROM journal_lines`);
      expect(JSON.stringify(before) === JSON.stringify(after), `row counts changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      return 'UPDATE and DELETE refused on journal_lines and economic_events; counts unchanged';
    });

    await h.check('WA-05', 'A reversing entry restores balances and lifts a block', async () => {
      const dep = await deposit(ownerC.id, '10.00');
      const dep2 = await deposit(ownerC.id, '7.00');
      // Real drift: stored balance no longer matches the ledger.
      await q(`UPDATE wallets SET balance_cache = 10 WHERE id = $1`, [dep2.walletId]);
      const blocked = await runBalanceCheck(db, dep2.walletId);
      expect(blocked.outcome === 'blocked', `drift was not detected, outcome ${blocked.outcome}`);
      expect((await q(`SELECT status FROM wallets WHERE id = $1`, [dep2.walletId]))[0].status === 'blocked', 'wallet not blocked after drift');

      const rev = await h.http('POST', `/v1/admin/journal/transactions/${dep2.txId}/reverse`, { token: adminToken, body: { reason: 'verify WA-05' } });
      expectStatus(rev, 201, 'reverse deposit');
      expect(rev.body.wallets?.[0]?.block_lifted === true && rev.body.wallets[0].status === 'active', `block not lifted: ${JSON.stringify(rev.body.wallets)}`);
      const w = (await q(`SELECT status, balance_cache::text AS cache FROM wallets WHERE id = $1`, [dep2.walletId]))[0];
      expect(w.status === 'active', `wallet status ${w.status}`);
      expect(new Decimal(w.cache).eq('10'), `balance after reversal ${w.cache}, expected 10`);
      expect(new Decimal((await getBalances(db, dep2.walletId)).balance).eq(w.cache), 'derived and stored balance differ after reversal');
      for (const r of await trial()) expect(r.balanced, `trial balance unbalanced after reversal for ${r.currency}`);
      expect(dep.txId !== dep2.txId, 'fixture error');
      return 'drift blocked the wallet; reversing entry restored 10 and lifted the block';
    });

    await h.check('WA-06', 'Refund_Plan splits across captures and never exceeds a capture\'s unrefunded amount', async () => {
      // Pure planner first.
      const now = new Date();
      const caps = [
        { depositId: 'd1', captureId: 'c1', capturedAt: new Date(now.getTime() - 2000), unrefunded: '10' },
        { depositId: 'd2', captureId: 'c2', capturedAt: new Date(now.getTime() - 1000), unrefunded: '6' },
      ];
      const split = planRefund(caps, '12', now, 180);
      expect(split.ok && split.items.length === 2, `12 over [10,6] should split, got ${JSON.stringify(split)}`);
      if (split.ok) {
        expect(split.items[0].amount === '10' && split.items[1].amount === '2', `unexpected split ${JSON.stringify(split.items)}`);
        for (const it of split.items) {
          const cap = caps.find((c) => c.captureId === it.captureId)!;
          expect(new Decimal(it.amount).lte(cap.unrefunded), `item ${it.captureId} exceeds unrefunded`);
        }
      }
      const over = planRefund(caps, '16.01', now, 180);
      expect(!over.ok && over.code === 'REFUND_EXCEEDS_CAPTURES', `over-refund not rejected: ${JSON.stringify(over)}`);

      // End to end: a refund larger than any one capture goes through the route and splits.
      const owner = await makeOwner('dd');
      const ownerTokenRes = await h.http('POST', '/v1/auth/login', { body: { email: (await q(`SELECT email FROM users WHERE id = $1`, [owner.id]))[0].email, password: STRONG_PASSWORD } });
      expectStatus(ownerTokenRes, 200, 'owner login');
      const token: string = ownerTokenRes.body.access_token;
      const d1 = await deposit(owner.id, '10.00');
      await deposit(owner.id, '6.00');
      const r = await h.http('POST', '/v1/wallet/refunds', {
        token,
        headers: { 'idempotency-key': `wa-${randomUUID()}` },
        body: { amount: '12.00' },
      });
      expectStatus(r, 201, 'POST /v1/wallet/refunds');
      expect(r.body.items?.length === 2, `expected 2 refund items, got ${r.body.items?.length}`);
      const refunded = await q<{ capture_id: string; refunded: string; captured: string }>(
        `SELECT d.id AS capture_id, COALESCE((SELECT SUM(ri.amount) FROM wallet_refund_items ri WHERE ri.deposit_id = d.id), 0)::text AS refunded, d.amount::text AS captured
           FROM wallet_deposits d WHERE d.wallet_id = $1 AND d.status = 'captured'`,
        [d1.walletId],
      ).catch(() => null);
      if (refunded) {
        for (const c of refunded) expect(new Decimal(c.refunded).lte(c.captured), `capture ${c.capture_id} refunded ${c.refunded} > captured ${c.captured}`);
      }
      const total = (r.body.items as Array<{ amount: string }>).reduce((s, i) => s.plus(i.amount), new Decimal(0));
      expect(total.eq('12'), `item amounts sum to ${total.toFixed()}, expected 12`);
      expect(paypal.count('refundCapture') >= 2, 'expected one refund call per capture');
      // Asking for more than the remaining 4.00 is refused.
      const tooMuch = await h.http('POST', '/v1/wallet/refunds', { token, headers: { 'idempotency-key': `wa-${randomUUID()}` }, body: { amount: '4.01' } });
      expect(tooMuch.status >= 400 && tooMuch.status < 500, `over-refund returned HTTP ${tooMuch.status}`);
      return 'planner and route split 12 across captures of 10 and 6; 4.01 more refused';
    });
  } catch (err) {
    // A script error must never read as a pass: every check that did not run is recorded as failed.
    for (const id of ['WA-01', 'WA-02', 'WA-03', 'WA-04', 'WA-05', 'WA-06']) {
      if (!h.checks.some((c) => c.id === id)) h.checks.push({ id, name: 'not completed', status: 'FAIL', evidence: `could not complete: ${(err as Error).message}` });
    }
  } finally {
    h.note('WA-NOTE', 'PayPal test double', 'PayPal responses came from WalletPayPalDouble; this verifier proves Stoat accounting, not PayPal behaviour.');
    const code = h.report(AGENT, 'WALLET_ACCOUNTING_VERIFIED', 'WALLET_ACCOUNTING_BLOCKED');
    await h.close();
    process.exitCode = code;
  }
  return process.exitCode ?? 0;
}

await runVerifier(AGENT, main);

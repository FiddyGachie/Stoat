/**
 * Wallet read models (task 16.1; R9.13, R9.14, R10.1 to R10.11).
 *
 * Statement, user account, wallet list, business account and trial balance. All figures are
 * derived from the ledger (journal lines) at read time. Nothing here changes a balance, posts a
 * journal line or accepts an amount, currency or payee. The only write is the one Admin
 * notification per distinct mismatch (R9.14, R10.8), deduplicated by event ID.
 */
import { Decimal } from "decimal.js";
import { DbClient, getDb, transaction } from "../../db/connection.js";
import { NotFoundError } from "../../common/errors.js";
import { formatMoney } from "./wallet-math.js";
import { notifyInTx } from "./notification.service.js";
import { getBalances } from "./wallet.service.js";

const PAGE = 200;

/** Statement kind from the journal reference (set by the deterministic posting code). */
function classify(reference: string): {
  kind: string;
  description: string;
  entityType: string | null;
  entityId: string | null;
} {
  const rest = (p: string) => reference.slice(p.length);
  if (reference.startsWith("wallet:deposit:"))
    return {
      kind: "deposit",
      description: "Deposit captured",
      entityType: "wallet_deposit",
      entityId: rest("wallet:deposit:"),
    };
  if (reference.startsWith("wallet:charge:"))
    return {
      kind: "charge",
      description: "Charge for a verified obligation",
      entityType: "obligation",
      entityId: rest("wallet:charge:"),
    };
  if (reference.startsWith("wallet:refund:"))
    return {
      kind: "refund",
      description: "Refund completed",
      entityType: "wallet_refund_item",
      entityId: rest("wallet:refund:"),
    };
  if (reference.startsWith("reversal:"))
    return {
      kind: "reversal",
      description: "Reversing entry",
      entityType: "journal_transaction",
      entityId: rest("reversal:"),
    };
  return {
    kind: "adjustment",
    description: "Ledger movement",
    entityType: null,
    entityId: null,
  };
}

export interface StatementResult {
  wallet_id: string;
  currency: string;
  paypal_environment: string;
  balance: string;
  lines: Array<Record<string, unknown>>;
  next_cursor: string | null;
}

export function decodeOffset(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(cursor))
    return null;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}
export const encodeOffset = (n: number): string =>
  Buffer.from(String(n)).toString("base64url");

/**
 * Every ledger movement on the wallet's 2103 lines, ascending by posting time, ties broken by
 * ledger sequence (R10.10). Running balance is the exact cumulative sum, so the last row equals
 * the derived Wallet_Balance. A wallet with no movements gives an empty list and a zero balance.
 */
export async function walletStatement(
  db: DbClient,
  p: { tenantId: string; walletId: string; offset?: number },
): Promise<StatementResult> {
  const w = await db.query<{ id: string; currency: string; env: string }>(
    `SELECT id, currency, paypal_environment AS env FROM wallets WHERE id = $1 AND tenant_id = $2`,
    [p.walletId, p.tenantId],
  );
  if (!w.rows[0]) throw new NotFoundError("Wallet");
  const r = await db.query(
    `SELECT jl.id, jl.debit::text AS debit, jl.credit::text AS credit, jt.reference, jt.effective_at
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       JOIN journal_transactions jt ON jt.id = jl.transaction_id
      WHERE jl.wallet_id = $1 AND jl.tenant_id = $2 AND a.account_code = '2103'
      ORDER BY jt.effective_at ASC, jt.posting_seq ASC, jl.sequence ASC, jl.id ASC`,
    [p.walletId, p.tenantId],
  );
  let running = new Decimal(0);
  const all = r.rows.map((row: any) => {
    const amount = new Decimal(row.credit).minus(row.debit);
    running = running.plus(amount);
    const c = classify(String(row.reference));
    return {
      id: row.id,
      wallet_id: p.walletId,
      kind: c.kind,
      description: c.description,
      amount: amount.toFixed(),
      currency: w.rows[0].currency,
      balance_after: running.toFixed(),
      entity_type: c.entityType,
      entity_id: c.entityId,
      paypal_environment: w.rows[0].env,
      occurred_at: row.effective_at,
    };
  });
  const offset = p.offset ?? 0;
  const lines = all.slice(offset, offset + PAGE);
  return {
    wallet_id: p.walletId,
    currency: w.rows[0].currency,
    paypal_environment: w.rows[0].env,
    balance: running.toFixed(),
    lines,
    next_cursor:
      offset + PAGE < all.length ? encodeOffset(offset + PAGE) : null,
  };
}

/** Account view of one Owner: deposits, reservations, charges, refunds and balance per wallet. */
export async function userAccount(
  db: DbClient,
  p: { tenantId: string; ownerUserId: string; environment?: string | null },
) {
  const ws = await db.query(
    `SELECT * FROM wallets
      WHERE tenant_id = $1 AND owner_user_id = $2 AND ($3::text IS NULL OR paypal_environment = $3)
      ORDER BY created_at, id`,
    [p.tenantId, p.ownerUserId, p.environment ?? null],
  );
  const wallets = [];
  for (const w of ws.rows) {
    const [balances, deposits, reservations, charges, refunds] =
      await Promise.all([
        getBalances(db, w.id),
        db.query(
          `SELECT id, mission_id, status, amount, credited_amount, currency, paypal_order_id,
                  paypal_capture_id, created_at
             FROM wallet_deposits WHERE wallet_id = $1 ORDER BY created_at DESC, id LIMIT 500`,
          [w.id],
        ),
        db.query(
          `SELECT id, mission_id, agreement_id, status, amount, currency, created_at
             FROM wallet_reservations WHERE wallet_id = $1 ORDER BY created_at DESC, id LIMIT 500`,
          [w.id],
        ),
        db.query(
          `SELECT id, mission_id, obligation_id, amount, currency, created_at
             FROM wallet_charges WHERE wallet_id = $1 ORDER BY created_at DESC, id LIMIT 500`,
          [w.id],
        ),
        db.query(
          `SELECT r.id, r.kind, r.status, r.amount, r.currency, r.created_at,
                  COALESCE((SELECT array_agg(i.paypal_refund_id ORDER BY i.created_at, i.id)
                              FROM wallet_refund_items i
                             WHERE i.refund_id = r.id AND i.paypal_refund_id IS NOT NULL), '{}') AS paypal_refund_ids
             FROM wallet_refunds r WHERE r.wallet_id = $1 ORDER BY r.created_at DESC, r.id LIMIT 500`,
          [w.id],
        ),
      ]);
    wallets.push({
      wallet: w,
      balances,
      deposits: deposits.rows,
      reservations: reservations.rows,
      charges: charges.rows,
      refunds: refunds.rows,
    });
  }
  return { ownerUserId: p.ownerUserId, wallets };
}

/** Tenant-scoped wallet page for Admins: 50 by default, at most 200 (R10.5). */
export async function adminWallets(
  db: DbClient,
  p: { tenantId: string; limit: number; offset: number },
) {
  const r = await db.query(
    `SELECT * FROM wallets WHERE tenant_id = $1 ORDER BY created_at, id LIMIT $2 OFFSET $3`,
    [p.tenantId, p.limit + 1, p.offset],
  );
  const page = r.rows.slice(0, p.limit);
  const out = [];
  for (const w of page)
    out.push({ wallet: w, balances: await getBalances(db, w.id) });
  return {
    wallets: out,
    next_cursor:
      r.rows.length > p.limit ? encodeOffset(p.offset + p.limit) : null,
  };
}

export interface BusinessAccountFigures {
  currency: string;
  paypal_funds_received: string;
  wallet_balance_held: string;
  funds_allocated_to_providers: string;
  provider_payouts_completed: string;
  refunds_completed: string;
  platform_revenue: string;
  wallet_balance_sum: string;
  difference: string;
}

/**
 * Business account per currency, derived from journal lines at read time (R10.1, R10.6).
 * When the ledger's Customer-funds-held balance differs from the sum of Wallet balances, one
 * wallet_balance_mismatch Admin notification is raised per distinct difference and nothing is
 * altered (R10.8).
 */
export async function businessAccount(
  tenantId: string,
): Promise<BusinessAccountFigures[]> {
  const db = getDb();
  const bal = await db.query<{
    currency: string;
    code: string;
    d: string;
    c: string;
  }>(
    `SELECT a.currency, a.account_code AS code, COALESCE(SUM(jl.debit),0)::text AS d,
            COALESCE(SUM(jl.credit),0)::text AS c
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       JOIN journal_transactions jt ON jt.id = jl.transaction_id
      WHERE jl.tenant_id = $1 AND jt.status = 'posted'
      GROUP BY a.currency, a.account_code`,
    [tenantId],
  );
  const special = await db.query<{
    currency: string;
    payouts: string;
    refunds: string;
  }>(
    `SELECT a.currency,
            COALESCE(SUM(CASE WHEN a.account_code = '1101' AND jt.reference LIKE 'payout:%' THEN jl.credit
                              WHEN a.account_code = '1101' AND jt.reference LIKE 'payout-return:%' THEN -jl.debit
                              ELSE 0 END), 0)::text AS payouts,
            COALESCE(SUM(CASE WHEN a.account_code = '2103' AND jt.reference LIKE 'wallet:refund:%' THEN jl.debit
                              ELSE 0 END), 0)::text AS refunds
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       JOIN journal_transactions jt ON jt.id = jl.transaction_id
      WHERE jl.tenant_id = $1 AND jt.status = 'posted'
      GROUP BY a.currency`,
    [tenantId],
  );
  const sums = await db.query<{ currency: string; s: string }>(
    `SELECT currency, COALESCE(SUM(balance_cache),0)::text AS s FROM wallets WHERE tenant_id = $1 GROUP BY currency`,
    [tenantId],
  );

  const currencies = new Set<string>([
    ...bal.rows.map((r) => r.currency),
    ...sums.rows.map((r) => r.currency),
  ]);
  const net = (cur: string, code: string, normal: "debit" | "credit") => {
    const r = bal.rows.find((x) => x.currency === cur && x.code === code);
    if (!r) return new Decimal(0);
    return normal === "debit"
      ? new Decimal(r.d).minus(r.c)
      : new Decimal(r.c).minus(r.d);
  };
  const out: BusinessAccountFigures[] = [];
  const mismatches: Array<{ currency: string; diff: Decimal }> = [];
  for (const cur of [...currencies].sort()) {
    const held = net(cur, "2103", "credit");
    const walletSum = new Decimal(
      sums.rows.find((x) => x.currency === cur)?.s ?? "0",
    );
    const diff = held.minus(walletSum);
    const sp = special.rows.find((x) => x.currency === cur);
    out.push({
      currency: cur,
      paypal_funds_received: net(cur, "1101", "debit").toFixed(),
      wallet_balance_held: held.toFixed(),
      funds_allocated_to_providers: net(cur, "2102", "credit").toFixed(),
      provider_payouts_completed: new Decimal(sp?.payouts ?? "0").toFixed(),
      refunds_completed: new Decimal(sp?.refunds ?? "0").toFixed(),
      platform_revenue: net(cur, "4101", "credit").toFixed(),
      wallet_balance_sum: walletSum.toFixed(),
      difference: diff.toFixed(),
    });
    if (!diff.isZero()) mismatches.push({ currency: cur, diff });
  }
  if (mismatches.length > 0) {
    await transaction(async (tx) => {
      for (const m of mismatches) {
        await notifyInTx(tx, {
          tenantId,
          kind: "wallet_balance_mismatch",
          recipient: { admins: true },
          title: "Business account mismatch",
          body: `Customer funds held differs from the sum of Wallet balances in ${m.currency} by ${formatMoney(m.diff)}.`,
          eventId: `wallet_balance_mismatch:business:${m.currency}:${m.diff.toFixed()}`,
        });
      }
    });
  }
  return out;
}

export interface TrialBalanceRow {
  currency: string;
  total_debits: string;
  total_credits: string;
  difference: string;
  balanced: boolean;
}

/** Trial balance per currency over all posted lines of the tenant (R9.13). */
export async function trialBalance(
  db: DbClient,
  tenantId: string,
  opts: { notify?: boolean } = {},
): Promise<TrialBalanceRow[]> {
  const r = await db.query<{ currency: string; d: string; c: string }>(
    `SELECT jl.currency, COALESCE(SUM(jl.debit),0)::text AS d, COALESCE(SUM(jl.credit),0)::text AS c
       FROM journal_lines jl JOIN journal_transactions jt ON jt.id = jl.transaction_id
      WHERE jl.tenant_id = $1 AND jt.status = 'posted'
      GROUP BY jl.currency ORDER BY jl.currency`,
    [tenantId],
  );
  const rows = r.rows.map((x) => {
    const diff = new Decimal(x.d).minus(x.c);
    return {
      currency: x.currency,
      total_debits: new Decimal(x.d).toFixed(),
      total_credits: new Decimal(x.c).toFixed(),
      difference: diff.toFixed(),
      balanced: diff.isZero(),
    };
  });
  const bad = rows.filter((x) => !x.balanced);
  if (bad.length > 0 && opts.notify !== false) {
    await transaction(async (tx) => {
      for (const m of bad) {
        await notifyInTx(tx, {
          tenantId,
          kind: "trial_balance_mismatch",
          recipient: { admins: true },
          title: "Trial balance mismatch",
          body: `Debits and credits differ in ${m.currency} by ${formatMoney(m.difference)}.`,
          eventId: `trial_balance_mismatch:${m.currency}:${m.difference}`,
        });
      }
    });
  }
  return rows;
}

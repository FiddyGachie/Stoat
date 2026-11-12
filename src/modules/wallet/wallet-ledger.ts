/**
 * WalletLedger: N-line, balanced, optionally wallet-tagged journal posting.
 *
 * `postTwoLineJournal` (src/modules/ledger/postings.ts) delegates to `postJournal`.
 * Deterministic code only: no agent supplies an amount, account, wallet or currency here
 * (AGENTS.md section 8, Money_Boundary).
 */
import { Decimal } from "decimal.js";
import { DbClient } from "../../db/connection.js";
import { ValidationError } from "../../common/errors.js";
import { MAX_AMOUNT, parseMoney } from "./wallet-math.js";
import { runBalanceCheckHook } from "./wallet-hooks.js";
// Side effect: registers the real balance check with the hook registry.
import "./wallet.service.js";

/** Accounts created per tenant and currency on first use. */
export const LEDGER_ACCOUNTS: Record<
  string,
  [name: string, normalBalance: "debit" | "credit"]
> = {
  "1101": ["PayPal funds received (clearing)", "debit"],
  "2101": ["Customer funds held for agreements", "credit"],
  "2102": ["Funds allocated to providers (payout pending)", "credit"],
  "2103": ["Customer wallet funds held", "credit"],
  "5101": ["PayPal processing fees", "debit"],
  "4101": ["Platform revenue", "credit"],
};

export type JournalRule =
  | "MIN_TWO_LINES"
  | "UNBALANCED"
  | "MIXED_CURRENCY"
  | "NON_POSITIVE_AMOUNT"
  | "TOO_MANY_DECIMALS"
  | "INVALID_AMOUNT"
  | "INVALID_SIDE"
  | "UNKNOWN_ACCOUNT"
  | "WALLET_EVENT_REQUIRED"
  | "WALLET_REFERENCE_REQUIRED"
  | "WALLET_TAG_REQUIRED";

export interface JournalLineInput {
  accountCode: string;
  side: "debit" | "credit";
  amount: string;
  walletId?: string | null;
}

export interface PostJournalInput {
  tenantId: string;
  eventId: string;
  reference: string;
  currency: string;
  lines: readonly JournalLineInput[];
}

export interface PostJournalResult {
  transactionId: string;
  /** True when the reference was already posted and the original was returned. */
  replayed: boolean;
}

function reject(
  rule: JournalRule,
  message: string,
  extra?: Record<string, unknown>,
): never {
  throw new ValidationError(`Journal rejected (${rule}): ${message}`, {
    rule,
    ...extra,
  });
}

/** Pure validation; throws a ValidationError naming the violated rule. Writes nothing. */
export function validateJournal(p: PostJournalInput): void {
  if (!Array.isArray(p.lines) || p.lines.length < 2) {
    reject("MIN_TWO_LINES", "a journal transaction needs at least two lines.");
  }
  if (typeof p.currency !== "string" || p.currency.length === 0) {
    reject("MIXED_CURRENCY", "a single currency is required.");
  }
  const lineCurrency = (l: JournalLineInput): string =>
    (l as { currency?: string }).currency ?? p.currency;
  if (p.lines.some((l) => lineCurrency(l) !== p.currency)) {
    reject("MIXED_CURRENCY", "all lines must use the transaction currency.");
  }

  let debits = new Decimal(0);
  let credits = new Decimal(0);
  let touchesWallet = false;
  p.lines.forEach((l, i) => {
    if (l.side !== "debit" && l.side !== "credit")
      reject("INVALID_SIDE", `line ${i + 1} side must be debit or credit.`);
    if (typeof l.accountCode !== "string" || l.accountCode.length === 0)
      reject("UNKNOWN_ACCOUNT", `line ${i + 1} needs an account code.`);
    const m = parseMoney(l.amount);
    if (!m.ok) {
      if (m.reason === "TOO_MANY_FRACTION_DIGITS")
        reject(
          "TOO_MANY_DECIMALS",
          `line ${i + 1} has more than six decimals.`,
        );
      if (typeof l.amount === "string" && /^\s*-/.test(l.amount))
        reject("NON_POSITIVE_AMOUNT", `line ${i + 1} amount must be positive.`);
      reject(
        "INVALID_AMOUNT",
        `line ${i + 1} amount is not a valid decimal (max ${MAX_AMOUNT}).`,
      );
    }
    if (!m.decimal.gt(0))
      reject("NON_POSITIVE_AMOUNT", `line ${i + 1} amount must be positive.`);
    if (l.side === "debit") debits = debits.plus(m.decimal);
    else credits = credits.plus(m.decimal);
    if (l.accountCode === "2103" && !l.walletId)
      reject(
        "WALLET_TAG_REQUIRED",
        `line ${i + 1} on account 2103 must carry a wallet.`,
      );
    if (l.walletId) touchesWallet = true;
  });
  if (!debits.eq(credits)) {
    reject(
      "UNBALANCED",
      `debits ${debits.toFixed()} do not equal credits ${credits.toFixed()}.`,
    );
  }
  if (touchesWallet) {
    if (!p.eventId)
      reject(
        "WALLET_EVENT_REQUIRED",
        "a wallet transaction needs one linked economic event.",
      );
    if (!p.reference.startsWith("wallet:"))
      reject(
        "WALLET_REFERENCE_REQUIRED",
        "a wallet transaction reference must start with 'wallet:'.",
      );
  }
}

async function ensureAccount(
  tx: DbClient,
  tenantId: string,
  currency: string,
  code: string,
): Promise<string> {
  const meta = LEDGER_ACCOUNTS[code];
  if (meta) {
    await tx.query(
      `INSERT INTO accounts (id, tenant_id, account_code, name, normal_balance, currency, is_active)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, TRUE) ON CONFLICT (tenant_id, currency, account_code) DO NOTHING`,
      [tenantId, code, meta[0], meta[1], currency],
    );
  }
  const a = await tx.query<{ id: string }>(
    `SELECT id FROM accounts WHERE tenant_id = $1 AND currency = $2 AND account_code = $3`,
    [tenantId, currency, code],
  );
  if (!a.rows[0])
    throw new Error(
      `Ledger account ${code} (${currency}) does not exist for this tenant.`,
    );
  return a.rows[0].id;
}

/**
 * Post one balanced journal transaction with N lines inside the caller's transaction.
 * Idempotent by `reference` for wallet references: the original transaction is returned.
 */
export async function postJournal(
  tx: DbClient,
  p: PostJournalInput,
): Promise<PostJournalResult> {
  validateJournal(p);
  const isWalletRef = p.reference.startsWith("wallet:");

  if (isWalletRef) {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM journal_transactions WHERE tenant_id = $1 AND reference = $2`,
      [p.tenantId, p.reference],
    );
    if (existing.rows[0])
      return { transactionId: existing.rows[0].id, replayed: true };
  }

  const ids = new Map<string, string>();
  for (const code of new Set(p.lines.map((l) => l.accountCode))) {
    ids.set(code, await ensureAccount(tx, p.tenantId, p.currency, code));
  }

  const jt = isWalletRef
    ? await tx.query<{ id: string }>(
        `INSERT INTO journal_transactions (id, tenant_id, source_event_id, reference, status, effective_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'posted', now())
         ON CONFLICT (tenant_id, reference) WHERE reference LIKE 'wallet:%' DO NOTHING RETURNING id`,
        [p.tenantId, p.eventId, p.reference],
      )
    : await tx.query<{ id: string }>(
        `INSERT INTO journal_transactions (id, tenant_id, source_event_id, reference, status, effective_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'posted', now()) RETURNING id`,
        [p.tenantId, p.eventId, p.reference],
      );

  if (!jt.rows[0]) {
    // Lost a race with a concurrent identical posting: return the original.
    const again = await tx.query<{ id: string }>(
      `SELECT id FROM journal_transactions WHERE tenant_id = $1 AND reference = $2`,
      [p.tenantId, p.reference],
    );
    return { transactionId: again.rows[0].id, replayed: true };
  }

  const transactionId = jt.rows[0].id;
  // One statement for all lines, so the balance trigger also holds outside an explicit transaction.
  const params: unknown[] = [p.tenantId, transactionId, p.currency];
  const tuples = p.lines.map((l, i) => {
    const o = params.length;
    params.push(
      ids.get(l.accountCode),
      l.side === "debit" ? l.amount : "0",
      l.side === "credit" ? l.amount : "0",
      i + 1,
      l.walletId ?? null,
    );
    return `(gen_random_uuid(), $1, $2, $${o + 1}, $${o + 2}, $${o + 3}, $3, $${o + 4}, $${o + 5})`;
  });
  await tx.query(
    `INSERT INTO journal_lines (id, tenant_id, transaction_id, account_id, debit, credit, currency, sequence, wallet_id)
     VALUES ${tuples.join(", ")}`,
    params,
  );
  // Keep the drift detector in step with this posting (same transaction), then check it.
  // Drift injected anywhere else leaves cache and derived apart, which the check then catches.
  const deltas = new Map<string, Decimal>();
  for (const l of p.lines) {
    if (l.accountCode !== "2103" || !l.walletId) continue;
    const signed = new Decimal(l.amount).times(l.side === "credit" ? 1 : -1);
    deltas.set(
      l.walletId,
      (deltas.get(l.walletId) ?? new Decimal(0)).plus(signed),
    );
  }
  for (const [walletId, delta] of deltas) {
    await tx.query(
      `UPDATE wallets
          SET balance_cache = GREATEST(0, balance_cache + $2::numeric),
              last_activity_at = now(), updated_at = now()
        WHERE id = $1`,
      [walletId, delta.toFixed()],
    );
  }
  await runBalanceCheckHook(
    tx,
    p.tenantId,
    p.lines.map((l) => l.walletId),
  );
  return { transactionId, replayed: false };
}

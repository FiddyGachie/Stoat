/**
 * WalletService core: wallet lookup, derived balances and the balance check.
 *
 * Deterministic code only. No agent supplies an amount, currency, payee or wallet state here
 * (AGENTS.md section 8, Money_Boundary). The balance is derived from journal lines on account
 * 2103; `wallets.balance_cache` exists only to detect drift.
 *
 * Reservation, charge, deposit and refund logic live in later tasks and call
 * `assertWalletUsable` (new Reservations and Charges) before they act.
 */
import { Decimal } from "decimal.js";
import { DbClient } from "../../db/connection.js";
import { ConflictError, NotFoundError } from "../../common/errors.js";
import { EventsService } from "../events/events.service.js";
import { payPalStatus } from "../paypal/paypal.gateway.js";
import { computeAvailable, formatMoney, sumMoney } from "./wallet-math.js";
import { setBalanceCheckHook } from "./wallet-hooks.js";
import { notifyInTx } from "./notification.service.js";

export type PayPalEnvironment = "sandbox" | "live";

export interface WalletRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  currency: string;
  paypal_environment: PayPalEnvironment;
  status: "active" | "blocked";
  blocked_reason: string | null;
  balance_cache: string;
  last_activity_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface WalletBalances {
  walletId: string;
  currency: string;
  balance: string;
  reserved: string;
  pendingRefund: string;
  available: string;
  deposited: string;
  charged: string;
  refunded: string;
}

export type BalanceCheckOutcome =
  | "ok"
  | "blocked"
  | "still_blocked"
  | "lifted"
  | "not_found";

export interface BalanceCheckResult {
  walletId: string;
  outcome: BalanceCheckOutcome;
  /** derived - cache, as a decimal string (before any correction). */
  difference: string;
  derived: string;
  cached: string;
  notified: boolean;
}

/** Nil UUID: system actor on events written by the balance check (actor_id is a UUID column). */
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

/** PayPal environment the deployment is configured for (sandbox when unconfigured). */
export function configuredEnvironment(): PayPalEnvironment {
  return payPalStatus().environment ?? "sandbox";
}

// ---------------------------------------------------------------------------
// Notification seam (backed by NotificationService; tests may override)
// ---------------------------------------------------------------------------

export interface WalletMismatchNotice {
  tenantId: string;
  walletId: string;
  /** derived - cache */
  difference: string;
  /** Economic_Event that recorded the block; makes the notice idempotent per block. */
  eventId: string;
}

export type WalletMismatchNotifier = (
  tx: DbClient,
  notice: WalletMismatchNotice,
) => Promise<void>;

/**
 * Default: one `wallet_balance_mismatch` row per Admin (operator or supervisor) of the tenant,
 * never the Owner, created through NotificationService in the caller's transaction.
 */
const defaultNotifier: WalletMismatchNotifier = async (tx, n) => {
  await notifyInTx(tx, {
    tenantId: n.tenantId,
    kind: "wallet_balance_mismatch",
    recipient: { admins: true },
    title: "Wallet balance mismatch",
    body: `Wallet ${n.walletId} is blocked: stored and derived balance differ by ${n.difference}.`,
    entityType: "wallet",
    entityId: n.walletId,
    eventId: `wallet_balance_mismatch:${n.walletId}:${n.eventId}`,
  });
};

let notifier: WalletMismatchNotifier = defaultNotifier;

export function setWalletMismatchNotifier(
  fn: WalletMismatchNotifier | null,
): void {
  notifier = fn ?? defaultNotifier;
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

const normalizeWallet = (r: any): WalletRow => ({
  ...r,
  balance_cache: formatMoney(String(r.balance_cache)),
});

/**
 * One wallet per (tenant, owner, currency, environment). Race-safe:
 * INSERT ... ON CONFLICT DO NOTHING, then select.
 */
export async function getOrCreateWallet(
  db: DbClient,
  p: {
    tenantId: string;
    ownerUserId: string;
    currency: string;
    environment?: PayPalEnvironment;
  },
): Promise<WalletRow> {
  const environment = p.environment ?? configuredEnvironment();
  await db.query(
    `INSERT INTO wallets (id, tenant_id, owner_user_id, currency, paypal_environment)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id, owner_user_id, currency, paypal_environment) DO NOTHING`,
    [p.tenantId, p.ownerUserId, p.currency, environment],
  );
  const r = await db.query(
    `SELECT * FROM wallets
      WHERE tenant_id = $1 AND owner_user_id = $2 AND currency = $3 AND paypal_environment = $4`,
    [p.tenantId, p.ownerUserId, p.currency, environment],
  );
  return normalizeWallet(r.rows[0]);
}

/**
 * Owner view: wallets whose environment differs from the configured one are hidden (R1.14, R1.15).
 * Returns null when the wallet does not exist, is not the owner's, or is hidden.
 */
export async function getWalletForOwner(
  db: DbClient,
  p: {
    tenantId: string;
    ownerUserId: string;
    walletId: string;
    environment?: PayPalEnvironment;
  },
): Promise<WalletRow | null> {
  const environment = p.environment ?? configuredEnvironment();
  const r = await db.query(
    `SELECT * FROM wallets
      WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND paypal_environment = $4`,
    [p.walletId, p.tenantId, p.ownerUserId, environment],
  );
  return r.rows[0] ? normalizeWallet(r.rows[0]) : null;
}

/** Owner view: only wallets in the configured environment. */
export async function listWalletsForOwner(
  db: DbClient,
  p: { tenantId: string; ownerUserId: string; environment?: PayPalEnvironment },
): Promise<WalletRow[]> {
  const environment = p.environment ?? configuredEnvironment();
  const r = await db.query(
    `SELECT * FROM wallets
      WHERE tenant_id = $1 AND owner_user_id = $2 AND paypal_environment = $3
      ORDER BY created_at, id`,
    [p.tenantId, p.ownerUserId, environment],
  );
  return r.rows.map(normalizeWallet);
}

/** Admin view: wallets in another environment, flagged so funds are never spent across environments. */
export async function listEnvironmentMismatchedWallets(
  db: DbClient,
  p: { tenantId: string; environment?: PayPalEnvironment },
): Promise<Array<WalletRow & { environment_mismatch: true }>> {
  const environment = p.environment ?? configuredEnvironment();
  const r = await db.query(
    `SELECT * FROM wallets
      WHERE tenant_id = $1 AND paypal_environment <> $2
      ORDER BY created_at, id`,
    [p.tenantId, environment],
  );
  return r.rows.map((w) => ({
    ...normalizeWallet(w),
    environment_mismatch: true as const,
  }));
}

/**
 * Guard for new Reservations and Charges: a blocked wallet or one outside the configured
 * environment refuses (R9.15, R1.15). Releases do not call this.
 */
export async function assertWalletUsable(
  db: DbClient,
  walletId: string,
  environment: PayPalEnvironment = configuredEnvironment(),
): Promise<WalletRow> {
  const r = await db.query(`SELECT * FROM wallets WHERE id = $1`, [walletId]);
  if (!r.rows[0]) throw new NotFoundError("Wallet", walletId);
  const w = normalizeWallet(r.rows[0]);
  if (w.status === "blocked") {
    throw new ConflictError(
      "WALLET_BLOCKED",
      "This wallet is blocked pending an Admin review and cannot take new reservations or charges.",
      { wallet_id: walletId },
    );
  }
  if (w.paypal_environment !== environment) {
    throw new ConflictError(
      "WALLET_ENVIRONMENT_MISMATCH",
      "This wallet belongs to a different PayPal environment than the one configured.",
      { wallet_id: walletId },
    );
  }
  return w;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

async function derivedBalance(db: DbClient, walletId: string): Promise<string> {
  const r = await db.query<{ bal: string | null }>(
    `SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS bal
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.wallet_id = $1 AND a.account_code = '2103'`,
    [walletId],
  );
  return new Decimal(r.rows[0]?.bal ?? "0").toFixed();
}

/**
 * Wallet_Balance = SUM(credit - debit) on 2103 lines for the wallet.
 * available = balance - active reservations - pending refunds.
 */
export async function getBalances(
  db: DbClient,
  walletId: string,
): Promise<WalletBalances> {
  const [w, balance, reserved, pending, deposited, charged, refunded] =
    await Promise.all([
      db.query<{ currency: string }>(`SELECT currency FROM wallets WHERE id = $1`, [walletId]),
      derivedBalance(db, walletId),
      db.query<{ s: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS s FROM wallet_reservations
        WHERE wallet_id = $1 AND status = 'active'`,
        [walletId],
      ),
      db.query<{ s: string }>(
        `SELECT COALESCE(SUM(i.amount), 0)::text AS s
         FROM wallet_refund_items i JOIN wallet_refunds r ON r.id = i.refund_id
        WHERE r.wallet_id = $1 AND i.status IN ('submitted', 'pending')`,
        [walletId],
      ),
      db.query<{ s: string }>(
        `SELECT COALESCE(SUM(credited_amount), 0)::text AS s FROM wallet_deposits
        WHERE wallet_id = $1 AND status = 'captured'`,
        [walletId],
      ),
      db.query<{ s: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS s FROM wallet_charges WHERE wallet_id = $1`,
        [walletId],
      ),
      db.query<{ s: string }>(
        `SELECT COALESCE(SUM(i.amount), 0)::text AS s
         FROM wallet_refund_items i JOIN wallet_refunds r ON r.id = i.refund_id
        WHERE r.wallet_id = $1 AND i.status = 'completed'`,
        [walletId],
      ),
    ]);
  if (!w.rows[0]) throw new NotFoundError("Wallet", walletId);

  const reservedS = sumMoney([reserved.rows[0].s]);
  const pendingS = sumMoney([pending.rows[0].s]);
  return {
    walletId,
    currency: w.rows[0].currency,
    balance: formatMoney(balance),
    reserved: formatMoney(reservedS),
    pendingRefund: formatMoney(pendingS),
    available: formatMoney(computeAvailable(balance, [reservedS], [pendingS])),
    deposited: formatMoney(deposited.rows[0].s),
    charged: formatMoney(charged.rows[0].s),
    refunded: formatMoney(refunded.rows[0].s),
  };
}

// ---------------------------------------------------------------------------
// Balance check (R9.15, R9.16, R9.19, R1.4)
// ---------------------------------------------------------------------------

/**
 * Compare `balance_cache` with the derived balance for one wallet, inside the caller's transaction.
 *
 * - match, active: nothing to do.
 * - mismatch, active: block, raise ONE wallet_balance_mismatch Admin notice, append an event.
 * - mismatch, blocked: keep the block, raise nothing, leave the cache untouched.
 * - match, blocked: lift the block and append an event recording the lift.
 * The derived value is always authoritative; the cache is corrected only when the check passes.
 */
export async function runBalanceCheck(
  db: DbClient,
  walletId: string,
): Promise<BalanceCheckResult> {
  const locked = await db.query(
    `SELECT * FROM wallets WHERE id = $1 FOR UPDATE`,
    [walletId],
  );
  if (!locked.rows[0]) {
    return {
      walletId,
      outcome: "not_found",
      difference: "0",
      derived: "0",
      cached: "0",
      notified: false,
    };
  }
  const w = normalizeWallet(locked.rows[0]);
  const derived = await derivedBalance(db, walletId);
  const cached = new Decimal(w.balance_cache);
  const diff = new Decimal(derived).minus(cached);
  const base = {
    walletId,
    difference: diff.toFixed(),
    derived,
    cached: cached.toFixed(),
  };
  const events = new EventsService(db);

  if (diff.isZero()) {
    if (w.status !== "blocked")
      return { ...base, outcome: "ok", notified: false };
    await db.query(
      `UPDATE wallets SET status = 'active', blocked_reason = NULL, updated_at = now() WHERE id = $1`,
      [walletId],
    );
    await events.appendEvent({
      tenantId: w.tenant_id,
      aggregateType: "wallet",
      aggregateId: walletId,
      eventType: "WALLET_BLOCK_LIFTED",
      actorType: "system",
      actorId: SYSTEM_ACTOR,
      amount: formatMoney(derived),
      currency: w.currency,
      payload: {
        wallet_id: walletId,
        reason: "balance_restored",
        balance: formatMoney(derived),
      },
    });
    return { ...base, outcome: "lifted", notified: false };
  }

  if (w.status === "blocked") {
    // Still mismatched: keep the block, no new Notification (R9.19).
    return { ...base, outcome: "still_blocked", notified: false };
  }

  const upd = await db.query(
    `UPDATE wallets
        SET status = 'blocked', blocked_reason = 'balance_mismatch', updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING id`,
    [walletId],
  );
  if (!upd.rows[0])
    return { ...base, outcome: "still_blocked", notified: false };

  const ev = await events.appendEvent({
    tenantId: w.tenant_id,
    aggregateType: "wallet",
    aggregateId: walletId,
    eventType: "WALLET_BLOCKED",
    actorType: "system",
    actorId: SYSTEM_ACTOR,
    currency: w.currency,
    payload: {
      wallet_id: walletId,
      reason: "balance_mismatch",
      derived: formatMoney(derived),
      cached: formatMoney(cached),
      difference: diff.toFixed(),
    },
  });
  await notifier(db, {
    tenantId: w.tenant_id,
    walletId,
    difference: diff.toFixed(),
    eventId: ev.id,
  });
  return { ...base, outcome: "blocked", notified: true };
}

/** Run the check for every wallet of a tenant (reconciliation run, sweep). */
export async function runBalanceChecksForTenant(
  db: DbClient,
  tenantId: string,
): Promise<BalanceCheckResult[]> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM wallets WHERE tenant_id = $1 ORDER BY id`,
    [tenantId],
  );
  const out: BalanceCheckResult[] = [];
  for (const w of r.rows) out.push(await runBalanceCheck(db, w.id));
  return out;
}

/** Register the check with the ledger hook (task 4.2). Safe to call more than once. */
export function registerWalletBalanceCheck(): void {
  setBalanceCheckHook(async (tx, tenantId, walletIds) => {
    for (const id of walletIds) {
      const owned = await tx.query(
        `SELECT 1 FROM wallets WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      if (owned.rows[0]) await runBalanceCheck(tx, id);
    }
  });
}

registerWalletBalanceCheck();

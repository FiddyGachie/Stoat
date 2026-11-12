/**
 * Wallet response serializers (task 8.11; R4.6, R4.13, R4.14, R12.11).
 *
 * Every wallet, deposit, refund, notification, statement, analytics and admin wallet route builds
 * its response through one of these explicit allowlist serializers. Each copies named fields only,
 * so a column added to a table later is never exposed by accident. No key named recipient, payee,
 * payout_recipient, payment_source or credential-like appears at any depth, for any principal.
 * `assertNoSensitiveKeys` is the deep backstop: it throws instead of returning a leaking shape.
 *
 * Payout recipients are registered and viewed only through the Payout_Account_Endpoints, which
 * this module neither reads nor writes.
 */
import { formatMoney } from "./wallet-math.js";

/** Key names that must never appear in a wallet response, at any depth. */
export const SENSITIVE_KEY_RE =
  /recipient|payee|receiver|payment[_-]?source|payout[_-]?(account|email)|secret|password|passwd|token|credential|api[_-]?key|authorization|private[_-]?key|client[_-]?id/i;

// serializeNotification omits `recipient_user_id`: it matches a forbidden key name and the
// caller already knows who they are.

export class SensitiveKeyError extends Error {
  constructor(public readonly path: string) {
    super(`Sensitive key in wallet response at ${path}`);
    this.name = "SensitiveKeyError";
  }
}

/** Throw if any object key at any depth looks like a recipient, payee, payment source or credential. */
export function assertNoSensitiveKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSensitiveKeys(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) throw new SensitiveKeyError(`${path}.${k}`);
      assertNoSensitiveKeys(v, `${path}.${k}`);
    }
  }
}

/** Run the deep check, then return the value unchanged. Used as the last step of every view. */
export function safe<T>(value: T): T {
  assertNoSensitiveKeys(value);
  return value;
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v);
const isoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v);
const money = (v: unknown): string => formatMoney(String(v ?? "0"));

export interface WalletBalancesInput {
  balance: unknown;
  reserved: unknown;
  pendingRefund: unknown;
  available: unknown;
  deposited: unknown;
  charged: unknown;
  refunded: unknown;
}

export interface WalletView {
  id: string;
  currency: string;
  status: string;
  paypal_environment: string;
  balance: string;
  reserved: string;
  pending_refund: string;
  available: string;
  deposited: string;
  charged: string;
  refunded: string;
  funding_mode: string;
}

export function serializeWallet(
  w: any,
  b: WalletBalancesInput,
  fundingMode: string,
): WalletView {
  return safe({
    id: w.id,
    currency: w.currency,
    status: w.status,
    paypal_environment: w.paypal_environment,
    balance: money(b.balance),
    reserved: money(b.reserved),
    pending_refund: money(b.pendingRefund),
    available: money(b.available),
    deposited: money(b.deposited),
    charged: money(b.charged),
    refunded: money(b.refunded),
    funding_mode: fundingMode,
  });
}

export interface DepositView {
  id: string;
  wallet_id: string;
  mission_id: string | null;
  is_top_up: boolean;
  status: string;
  amount: string;
  currency: string;
  credited_amount: string;
  paypal_environment: "sandbox" | "live";
  paypal_order_id: string | null;
  approve_url: string | null;
  failure_reason: string | null;
  created_at: string;
}

export function serializeDeposit(r: any): DepositView {
  return safe({
    id: r.id,
    wallet_id: r.wallet_id,
    mission_id: r.mission_id ?? null,
    is_top_up: !!r.is_top_up,
    status: r.status,
    amount: money(r.amount),
    currency: r.currency,
    credited_amount: money(r.credited_amount),
    paypal_environment: r.paypal_environment,
    paypal_order_id: r.paypal_order_id ?? null,
    approve_url:
      r.status === "awaiting_approval" ? (r.approve_url ?? null) : null,
    failure_reason: r.failure_reason ?? null,
    created_at: iso(r.created_at),
  });
}

export function serializeRefundItem(i: any) {
  return safe({
    id: i.id,
    deposit_id: i.deposit_id,
    paypal_capture_id: i.paypal_capture_id,
    amount: money(i.amount),
    status: i.status,
    paypal_refund_id: i.paypal_refund_id ?? null,
    paypal_status: i.paypal_status ?? null,
    failure_reason: i.failure_reason ?? null,
    attempts: Number(i.attempts ?? 0),
  });
}

export function serializeRefund(r: any) {
  return safe({
    id: r.id,
    wallet_id: r.wallet_id,
    kind: r.kind,
    mission_id: r.mission_id ?? null,
    decision_id: r.decision_id ?? null,
    amount: money(r.amount),
    currency: r.currency,
    status: r.status,
    actor_user_id: r.actor_user_id ?? null,
    actor_role: r.actor_role ?? null,
    reason: r.reason ?? null,
    paypal_environment: r.paypal_environment,
    created_at: iso(r.created_at),
    updated_at: r.updated_at ? iso(r.updated_at) : iso(r.created_at),
    ...(Array.isArray(r.items)
      ? { items: r.items.map(serializeRefundItem) }
      : {}),
  });
}

/** Remainder decision with the refund it started (if any). */
export function serializeDecision(d: any, refund: unknown | null = null) {
  return safe({
    id: d.id,
    mission_id: d.mission_id,
    wallet_id: d.wallet_id,
    decision: d.decision,
    remainder_amount: money(d.remainder_amount),
    refund_amount: money(d.refund_amount),
    decided_by: d.decided_by,
    decided_at: iso(d.decided_at),
    refund,
  });
}

export function serializeNotification(n: any) {
  return safe({
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    entity_type: n.entity_type ?? null,
    entity_id: n.entity_id ?? null,
    mission_id: n.mission_id ?? null,
    // Navigation only (R13.12); built by NotificationService, never a state-changing URL.
    link: n.link ?? null,
    created_at: iso(n.created_at),
    read_at: isoOrNull(n.read_at),
    updated_at: isoOrNull(n.updated_at),
    resolved_at: isoOrNull(n.resolved_at),
  });
}

/**
 * Economic_Event history entry (R19.2, R19.5). Named fields only: the stored payload is never
 * echoed, only the PayPal IDs and actor role taken out of it.
 */
export function serializeEconomicEvent(e: any) {
  const p = (
    e.payload && typeof e.payload === "object" ? e.payload : {}
  ) as Record<string, unknown>;
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return safe({
    id: e.id,
    aggregate_type: e.aggregate_type,
    aggregate_id: e.aggregate_id,
    sequence: Number(e.sequence),
    event_type: e.event_type,
    actor_type: e.actor_type,
    actor_role: s(p.actor_role),
    actor_id: e.actor_id,
    tenant_id: e.tenant_id,
    correlation_id: e.correlation_id,
    amount:
      e.amount === null || e.amount === undefined ? null : money(e.amount),
    currency: e.currency ?? null,
    recorded_at: iso(e.recorded_at),
    paypal_order_id: s(p.paypal_order_id),
    paypal_capture_id: s(p.paypal_capture_id),
    paypal_refund_id: s(p.paypal_refund_id),
    paypal_payout_batch_id: s(p.paypal_payout_batch_id),
    paypal_request_id: s(p.paypal_request_id),
  });
}

export function serializeStatementLine(l: any) {
  return safe({
    id: l.id ?? null,
    wallet_id: l.wallet_id,
    kind: l.kind,
    description: l.description ?? null,
    amount: money(l.amount),
    currency: l.currency,
    balance_after:
      l.balance_after === undefined || l.balance_after === null
        ? null
        : money(l.balance_after),
    entity_type: l.entity_type ?? null,
    entity_id: l.entity_id ?? null,
    paypal_environment: l.paypal_environment ?? null,
    occurred_at: iso(l.occurred_at ?? l.created_at),
  });
}

/** Admin wallet summary: tenant-scoped totals and owner identity by ID only. */
export function serializeAdminWallet(w: any, b: WalletBalancesInput) {
  return safe({
    id: w.id,
    owner_user_id: w.owner_user_id,
    currency: w.currency,
    status: w.status,
    paypal_environment: w.paypal_environment,
    balance: money(b.balance),
    reserved: money(b.reserved),
    pending_refund: money(b.pendingRefund),
    available: money(b.available),
    deposited: money(b.deposited),
    charged: money(b.charged),
    refunded: money(b.refunded),
    last_activity_at: isoOrNull(w.last_activity_at),
  });
}

/**
 * Analytics rows: named scalar columns only. Money-like columns become Decimal strings; any
 * column outside `allowed` is dropped.
 */
export function serializeAnalyticsRow(
  row: Record<string, unknown>,
  allowed: readonly string[],
  moneyColumns: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (!(k in row)) continue;
    const v = row[k];
    if (v === null || v === undefined) out[k] = null;
    else if (moneyColumns.includes(k)) out[k] = money(v);
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return safe(out);
}

/** Mission wallet view: named fields only; the Owner is not echoed back. */
export function serializeMissionWallet(v: any) {
  return safe({
    mission_id: v.mission_id,
    title: v.title,
    mission_status: v.mission_status,
    currency: v.currency,
    budget: money(v.budget),
    available: money(v.available),
    shortfall: money(v.shortfall),
    reserved: money(v.reserved),
    charged: money(v.charged),
    unreserved_funding: money(v.unreserved_funding),
    state: v.state,
  });
}

/** Statement page: named fields only; each line goes through `serializeStatementLine`. */
export function serializeStatement(s: any) {
  return safe({
    wallet_id: s.wallet_id,
    currency: s.currency,
    paypal_environment: s.paypal_environment,
    balance: money(s.balance),
    lines: (s.lines as any[]).map(serializeStatementLine),
    next_cursor: s.next_cursor ?? null,
  });
}

/** User account view (R10.2): one entry per wallet, PayPal IDs where they exist. */
export function serializeUserAccount(a: any, fundingMode: string) {
  return safe({
    user_id: a.ownerUserId,
    wallets: (a.wallets as any[]).map((e) => ({
      wallet: serializeWallet(e.wallet, e.balances, fundingMode),
      deposits: e.deposits.map((d: any) => ({
        id: d.id,
        mission_id: d.mission_id ?? null,
        status: d.status,
        amount: money(d.amount),
        credited_amount: money(d.credited_amount),
        currency: d.currency,
        paypal_order_id: d.paypal_order_id ?? null,
        paypal_capture_id: d.paypal_capture_id ?? null,
        created_at: iso(d.created_at),
      })),
      reservations: e.reservations.map((x: any) => ({
        id: x.id,
        mission_id: x.mission_id,
        agreement_id: x.agreement_id,
        status: x.status,
        amount: money(x.amount),
        currency: x.currency,
        created_at: iso(x.created_at),
      })),
      charges: e.charges.map((x: any) => ({
        id: x.id,
        mission_id: x.mission_id,
        obligation_id: x.obligation_id,
        amount: money(x.amount),
        currency: x.currency,
        created_at: iso(x.created_at),
      })),
      refunds: e.refunds.map((x: any) => ({
        id: x.id,
        kind: x.kind,
        status: x.status,
        amount: money(x.amount),
        currency: x.currency,
        paypal_refund_ids: Array.isArray(x.paypal_refund_ids)
          ? x.paypal_refund_ids.map(String)
          : [],
        created_at: iso(x.created_at),
      })),
    })),
  });
}

export function serializeBusinessAccount(rows: any[]) {
  return safe(
    rows.map((r) => ({
      currency: r.currency,
      paypal_funds_received: money(r.paypal_funds_received),
      wallet_balance_held: money(r.wallet_balance_held),
      funds_allocated_to_providers: money(r.funds_allocated_to_providers),
      provider_payouts_completed: money(r.provider_payouts_completed),
      refunds_completed: money(r.refunds_completed),
      platform_revenue: money(r.platform_revenue),
      wallet_balance_sum: money(r.wallet_balance_sum),
      difference: money(r.difference),
    })),
  );
}

export function serializeTrialBalance(rows: any[]) {
  return safe(
    rows.map((r) => ({
      currency: r.currency,
      total_debits: money(r.total_debits),
      total_credits: money(r.total_credits),
      difference: money(r.difference),
      balanced: !!r.balanced,
    })),
  );
}

/** Reconciliation run (task 17.2; R11.15). Named fields only; trial balance rows are re-shaped. */
export function serializeReconciliationRun(r: any, exceptions?: any[]) {
  const c = r.counts ?? {};
  const out: Record<string, unknown> = {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    paypal_environment: r.paypal_environment,
    started_at: iso(r.started_at),
    finished_at: isoOrNull(r.finished_at),
    counts: {
      orders: Number(c.orders ?? 0),
      captures: Number(c.captures ?? 0),
      refunds: Number(c.refunds ?? 0),
      payouts: Number(c.payouts ?? 0),
      new_exceptions: Number(c.new_exceptions ?? 0),
      open_exceptions: Number(c.open_exceptions ?? 0),
      resolved_exceptions: Number(c.resolved_exceptions ?? 0),
      unverifiable: Number(c.unverifiable ?? 0),
    },
    totals: Object.fromEntries(
      Object.entries((c.totals ?? {}) as Record<string, any>).map(
        ([cur, t]) => [
          cur,
          Object.fromEntries(
            (["captures", "refunds", "payouts"] as const).map((g) => [
              g,
              {
                stoat: money(t?.[g]?.stoat),
                paypal: money(t?.[g]?.paypal),
              },
            ]),
          ),
        ],
      ),
    ),
    trial_balance: ((r.trial_balance ?? []) as any[]).map((t) => ({
      currency: t.currency,
      total_debits: money(t.debit),
      total_credits: money(t.credit),
      difference: money(t.difference),
      balanced: Number(t.difference) === 0,
    })),
  };
  if (exceptions)
    out.exceptions = exceptions.map(serializeReconciliationException);
  return safe(out);
}

/** Reconciliation exception. `detail` keeps scalar values under non-sensitive keys only. */
export function serializeReconciliationException(e: any) {
  const detail: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(
    (e.detail ?? {}) as Record<string, unknown>,
  )) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    if (v === null || ["string", "number", "boolean"].includes(typeof v))
      detail[k] = v as string | number | boolean | null;
  }
  return safe({
    id: e.id,
    item_type: e.item_type,
    paypal_id: e.paypal_id,
    kind: e.kind,
    currency: e.currency ?? null,
    stoat_amount: e.stoat_amount == null ? null : money(e.stoat_amount),
    paypal_amount: e.paypal_amount == null ? null : money(e.paypal_amount),
    difference: e.difference == null ? null : money(e.difference),
    status: e.status,
    first_run_id: e.first_run_id,
    last_run_id: e.last_run_id,
    resolved_at: isoOrNull(e.resolved_at),
    resolved_run_id: e.resolved_run_id ?? null,
    created_at: iso(e.created_at),
    detail,
  });
}

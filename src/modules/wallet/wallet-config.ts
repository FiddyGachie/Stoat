/** Wallet deployment settings read from the environment (task 10.1 documents the full set). */

/** Supported wallet currencies; default USD. */
export function walletCurrencies(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.WALLET_CURRENCIES?.trim();
  const list = (raw ? raw.split(",") : ["USD"])
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  return list.length ? list : ["USD"];
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Low-balance threshold as a percentage of the Mission_Budget (1 to 100); default 20. */
export function walletLowBalancePct(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const n = Number(env.WALLET_LOW_BALANCE_PCT?.trim());
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 20;
}

/** Captures older than this are excluded from Refund_Plans; default 180 days. */
export function paypalRefundWindowDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveInt(env.PAYPAL_REFUND_WINDOW_DAYS, 180);
}

/** Deposit approval window in ms; default 3 hours. */
export function walletDepositTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveInt(env.WALLET_DEPOSIT_TTL_MS, 10_800_000);
}

/** Pending refund re-check interval in ms; at most 15 minutes. */
export function walletSweepRefundMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Math.min(positiveInt(env.WALLET_SWEEP_REFUND_MS, 900_000), 900_000);
}

/** Scheduled reconciliation interval in ms; default 24 hours. */
export function walletReconcileIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveInt(env.WALLET_RECONCILE_INTERVAL_MS, 86_400_000);
}

/** Maximum amount of one Deposit, as a decimal string; default 10000.00. */
export function walletMaxDeposit(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.WALLET_MAX_DEPOSIT?.trim();
  return raw && /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(raw) && Number(raw) > 0
    ? raw
    : "10000.00";
}

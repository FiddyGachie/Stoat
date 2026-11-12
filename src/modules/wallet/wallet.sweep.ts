import type { DbClient } from "../../db/connection.js";
import { DepositService } from "./deposit.service.js";
import { RefundService } from "./refund.service.js";
import { runBalanceCheck } from "./wallet.service.js";
import { enqueueMissionCompletionJobs } from "./mission-completion.service.js";
import { enqueueReconciliationJobs } from "./reconciliation.service.js";
import { walletReconcileIntervalMs } from "./wallet-config.js";

/** A reconciliation run still `running` after this long was abandoned by a crashed process. */
export const RECONCILIATION_STALE_MS = 30 * 60 * 1000;

export interface WalletSweepResult {
  deposits: { synced: number; recovered: number };
  refunds: { checked: number; completed: number; failed: number };
  balanceChecks: { checked: number; blocked: number; errors: number };
  staleReconciliations: number;
  /** `wallet_reconciliation` jobs queued by this tick (one per due tenant). */
  reconciliationQueued?: number;
}

/**
 * Close reconciliation runs left `running` by a dead process so the one-running-per-tenant
 * index cannot lock reconciliation out forever. The reconciliation service itself arrives with
 * task 17; this only touches the table it will own and never moves money.
 */
export async function cleanupStaleReconciliations(
  db: DbClient,
  staleMs = RECONCILIATION_STALE_MS,
): Promise<number> {
  const r = await db.query(
    `UPDATE reconciliation_runs
        SET status = 'failed', finished_at = now()
      WHERE status = 'running'
        AND started_at < now() - ($1::bigint * interval '1 millisecond')
      RETURNING id`,
    [staleMs],
  );
  return r.rows.length;
}

/** Balance check for every wallet; one failing wallet never stops the rest. */
export async function checkAllWalletBalances(
  db: DbClient,
): Promise<WalletSweepResult["balanceChecks"]> {
  const out = { checked: 0, blocked: 0, errors: 0 };
  const wallets = await db.query<{ id: string }>(
    `SELECT id FROM wallets ORDER BY id`,
  );
  for (const w of wallets.rows) {
    try {
      const res = await runBalanceCheck(db, w.id);
      out.checked++;
      if (res.outcome === "blocked") out.blocked++;
    } catch (err) {
      out.errors++;
      console.error(
        "[WalletSweep] balance check failed:",
        w.id,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

/** One tick of the wallet sweeps. Each step is isolated and idempotent. */
export async function runWalletSweep(db: DbClient): Promise<WalletSweepResult> {
  const result: WalletSweepResult = {
    deposits: { synced: 0, recovered: 0 },
    refunds: { checked: 0, completed: 0, failed: 0 },
    balanceChecks: { checked: 0, blocked: 0, errors: 0 },
    staleReconciliations: 0,
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(
        `[WalletSweep] ${name} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  };
  await step("deposits", async () => {
    result.deposits = await new DepositService({ db }).sweep();
  });
  await step("refunds", async () => {
    result.refunds = await new RefundService({ db }).sweep();
  });
  await step("balance", async () => {
    result.balanceChecks = await checkAllWalletBalances(db);
  });
  await step("mission-completion", async () => {
    await enqueueMissionCompletionJobs(db);
  });
  await step("reconciliation", async () => {
    result.staleReconciliations = await cleanupStaleReconciliations(db);
  });
  await step("reconciliation-schedule", async () => {
    result.reconciliationQueued = await enqueueReconciliationJobs(
      db,
      walletReconcileIntervalMs(),
    );
  });
  return result;
}

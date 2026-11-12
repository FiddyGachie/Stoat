import { DbClient } from "../../db/connection.js";
import { FundingService } from "./funding.service.js";
import { PayoutService } from "./payout.service.js";
import { BudgetService } from "./budget.service.js";
import { runWalletSweep } from "../wallet/wallet.sweep.js";
import { runAgenticSweep } from "../agentic/agentic.sweep.js";

/**
 * Safety net for money movement. Every 30 seconds it finishes whatever the return redirect or a
 * webhook did not: capture approved payments, expire lapsed ones, follow payouts to their final
 * state. Used by the API process (so a single-process deploy still completes) and by the worker.
 * Overlap between instances is harmless because every step is idempotent.
 */
export function startPaymentSweeps(
  db: DbClient,
  intervalMs = 30_000,
): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const f = await new FundingService(db).sweep();
      const p = await new PayoutService(db).sweep();
      const b = await new BudgetService(db).sweep();
      if (b.activated || b.errors) console.log("[BudgetSweep]", b);
      const w = await runWalletSweep(db);
      const a = await runAgenticSweep(db);
      if (
        w.deposits.synced ||
        w.deposits.recovered ||
        w.balanceChecks.blocked ||
        w.balanceChecks.errors ||
        w.staleReconciliations
      )
        console.log("[WalletSweep]", w);
      if (a.errors) console.log("[AgenticSweep]", a);
      if (f.captured || f.expired || f.errors || p.paid || p.errors)
        console.log("[PaymentSweep]", { funding: f, payouts: p });
    } catch (err) {
      console.error(
        "[PaymentSweep] failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

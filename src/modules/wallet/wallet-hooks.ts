/**
 * Registry for the wallet balance check hook.
 *
 * The ledger (postJournal, reverseJournalTransaction) calls `runBalanceCheckHook` inside its
 * database transaction after posting any line tagged with a wallet. WalletService registers the
 * real check with `setBalanceCheckHook`; until then the hook is a no-op. This keeps the ledger
 * free of a dependency on WalletService.
 */
import type { DbClient } from "../../db/connection.js";

export type BalanceCheckHook = (
  tx: DbClient,
  tenantId: string,
  walletIds: readonly string[],
) => Promise<void>;

let hook: BalanceCheckHook | null = null;

/** Register (or clear with null) the balance check. Called by WalletService at load. */
export function setBalanceCheckHook(fn: BalanceCheckHook | null): void {
  hook = fn;
}

/** Run the registered check for the distinct, non-empty wallet IDs. No-op when none is registered. */
export async function runBalanceCheckHook(
  tx: DbClient,
  tenantId: string,
  walletIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  if (!hook) return;
  const ids = [...new Set(walletIds.filter((w): w is string => !!w))];
  if (ids.length === 0) return;
  await hook(tx, tenantId, ids);
}

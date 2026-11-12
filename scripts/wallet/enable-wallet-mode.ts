/**
 * Switch a tenant to wallet funding mode so agent missions are funded from approved budgets.
 *
 *   npx tsx scripts/wallet/enable-wallet-mode.ts            # dry run: report only, changes nothing
 *   npx tsx scripts/wallet/enable-wallet-mode.ts --apply    # switch and move approved budgets
 *
 * Options: --tenant <id> (default: the only tenant), --actor <userId> (recorded in the audit log;
 * default: the tenant's first operator/supervisor, else its first user).
 *
 * Uses the same guarded path as PUT /v1/admin/funding-mode: refused while any agreement is
 * accepted, awaiting revision or awaiting review. No PayPal call is made. Captured spending
 * budgets move into the Owner's wallet with a balanced Dr 2101 / Cr 2103 entry.
 * Run it on the machine that owns DATABASE_URL; it is an operator action, not an API route.
 */
import "dotenv/config";
import { getDb, closeDb } from "../../src/db/connection.js";
import { setFundingMode, getFundingMode, FUNDING_MODE_BUSY_STATUSES } from "../../src/modules/wallet/funding-mode.js";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const apply = args.includes("--apply");

async function main() {
  const db = getDb();
  const tenants = await db.query<{ id: string; name: string | null }>(`SELECT id, name FROM tenants ORDER BY created_at`);
  const tenantId = opt("--tenant") ?? (tenants.rows.length === 1 ? tenants.rows[0].id : undefined);
  if (!tenantId) throw new Error(`Several tenants exist; pass --tenant <id>. Tenants: ${tenants.rows.map((t) => t.id).join(", ")}`);

  const actor = opt("--actor") ?? (await db.query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 ORDER BY (role IN ('operator','supervisor')) DESC, created_at LIMIT 1`, [tenantId])).rows[0]?.id;
  if (!actor) throw new Error("No user found to record as the actor; pass --actor <userId>.");

  const mode = await getFundingMode(db, tenantId);
  const busy = await db.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM agreements WHERE tenant_id = $1 AND status = ANY($2::text[]) GROUP BY 1`,
    [tenantId, [...FUNDING_MODE_BUSY_STATUSES]]);
  const budgets = await db.query<{ id: string; status: string; balance: string; currency: string; mission_id: string | null }>(
    `SELECT id, status, balance::text, currency, mission_id FROM spending_budgets
      WHERE tenant_id = $1 AND wallet_deposit_id IS NULL AND status IN ('active','depleted','awaiting_decision')
        AND paypal_capture_id IS NOT NULL ORDER BY created_at`, [tenantId]);

  console.log(`Tenant ${tenantId}: funding mode is '${mode}'.`);
  console.log(busy.rows.length
    ? `Blocking agreements: ${busy.rows.map((r) => `${r.n} ${r.status}`).join(", ")} (finish or cancel them first).`
    : "No agreements are in flight; the switch is allowed.");
  console.log(budgets.rows.length
    ? `Approved budgets that will move into the wallet:\n${budgets.rows.map((b) => `  ${b.id}  ${b.status}  ${b.balance} ${b.currency}${b.mission_id ? `  mission ${b.mission_id}` : ""}`).join("\n")}`
    : "No approved budgets to move.");

  if (!apply) { console.log("\nDry run only. Re-run with --apply to switch."); return; }
  if (mode === "wallet") { console.log("Already in wallet mode; nothing to do."); return; }
  const res = await setFundingMode({ tenantId, mode: "wallet", actorId: actor });
  console.log(`\nSwitched: ${res.previous} -> ${res.funding_mode}.`);
  for (const b of res.budgets_moved ?? []) {
    console.log(b.bridged ? `  moved budget ${b.budgetId}: ${b.credited} credited to wallet ${b.walletId}` : `  skipped budget ${b.budgetId}: ${b.reason}`);
  }
}

main().then(() => closeDb()).catch(async (err) => {
  console.error(`Failed: ${err?.code ? err.code + ": " : ""}${err?.message ?? err}`);
  await closeDb();
  process.exitCode = 1;
});

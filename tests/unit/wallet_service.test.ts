// Task 5.1: WalletService core (R1.1-1.4, 1.8-1.11, 1.14, 1.15, 9.15, 9.16, 9.19).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { postJournal } from "../../src/modules/wallet/wallet-ledger.js";
import { LedgerService } from "../../src/modules/ledger/ledger.service.js";
import {
  getOrCreateWallet,
  getBalances,
  runBalanceCheck,
  assertWalletUsable,
  getWalletForOwner,
  listWalletsForOwner,
  listEnvironmentMismatchedWallets,
} from "../../src/modules/wallet/wallet.service.js";

const T = SEED_IDS.tenantId;
const O = SEED_IDS.userId;
const db = () => getDb();

async function event(): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO economic_events (id, tenant_id, aggregate_type, aggregate_id, sequence, event_type, actor_type, actor_id, correlation_id, payload_hash)
     VALUES ($1, $2, 'wallet', $3, 1, 'test', 'system', $4, $5, 'h')`,
    [id, T, randomUUID(), randomUUID(), randomUUID()],
  );
  return id;
}

async function credit(walletId: string, amount: string, currency = "USD"): Promise<string> {
  const eventId = await event();
  const r = await postJournal(db(), {
    tenantId: T,
    eventId,
    reference: `wallet:test:${eventId}`,
    currency,
    lines: [
      { accountCode: "1101", side: "debit", amount },
      { accountCode: "2103", side: "credit", amount, walletId },
    ],
  });
  return r.transactionId;
}

const mismatchCount = async (walletId: string) =>
  (
    await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE kind = 'wallet_balance_mismatch' AND entity_id = $1`,
      [walletId],
    )
  ).rows[0].n;

describe("WalletService core", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
  });
  afterAll(async () => {
    await closeDb();
  });

  it("getOrCreateWallet is one row per tenant, owner, currency and environment, even concurrently", async () => {
    const p = {
      tenantId: T,
      ownerUserId: O,
      currency: "USD",
      environment: "sandbox" as const,
    };
    const rows = await Promise.all(
      [1, 2, 3].map(() => getOrCreateWallet(db(), p)),
    );
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    const other = await getOrCreateWallet(db(), { ...p, environment: "live" });
    expect(other.id).not.toBe(rows[0].id);
    const n = (
      await db().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM wallets WHERE owner_user_id = $1`,
        [O],
      )
    ).rows[0].n;
    expect(n).toBe(2);
  });

  it("hides wallets of another environment from the Owner and flags them for Admins", async () => {
    const live = await getOrCreateWallet(db(), {
      tenantId: T,
      ownerUserId: O,
      currency: "USD",
      environment: "live",
    });
    const sandbox = await getOrCreateWallet(db(), {
      tenantId: T,
      ownerUserId: O,
      currency: "USD",
      environment: "sandbox",
    });
    const visible = await listWalletsForOwner(db(), {
      tenantId: T,
      ownerUserId: O,
      environment: "sandbox",
    });
    expect(visible.map((w) => w.id)).toEqual([sandbox.id]);
    expect(
      await getWalletForOwner(db(), {
        tenantId: T,
        ownerUserId: O,
        walletId: live.id,
        environment: "sandbox",
      }),
    ).toBeNull();
    const flagged = await listEnvironmentMismatchedWallets(db(), {
      tenantId: T,
      environment: "sandbox",
    });
    expect(flagged.map((w) => w.id)).toEqual([live.id]);
    await expect(
      assertWalletUsable(db(), live.id, "sandbox"),
    ).rejects.toMatchObject({
      code: "WALLET_ENVIRONMENT_MISMATCH",
    });
  });

  it("derives balances from 2103 lines", async () => {
    const w = await getOrCreateWallet(db(), {
      tenantId: T,
      ownerUserId: O,
      currency: "USD",
      environment: "sandbox",
    });
    expect((await getBalances(db(), w.id)).balance).toBe("0");
    await credit(w.id, "12.5");
    const b = await getBalances(db(), w.id);
    expect(b).toMatchObject({
      balance: "12.5",
      reserved: "0",
      pendingRefund: "0",
      available: "12.5",
      charged: "0",
      refunded: "0",
    });
    expect((await runBalanceCheck(db(), w.id)).outcome).toBe("ok");
  });

  it("blocks once on drift, stays quiet while still mismatched, refuses new use, and lifts after a reversal", async () => {
    const w = await getOrCreateWallet(db(), {
      tenantId: T,
      ownerUserId: O,
      currency: "EUR",
      environment: "sandbox",
    });
    await credit(w.id, "10", "EUR"); // cache 10, derived 10
    const second = await credit(w.id, "5", "EUR"); // cache 15, derived 15
    expect((await getBalances(db(), w.id)).balance).toBe("15");

    // Drift: stored balance disagrees with the ledger.
    await db().query(`UPDATE wallets SET balance_cache = 10 WHERE id = $1`, [
      w.id,
    ]);
    const first = await runBalanceCheck(db(), w.id);
    expect(first.outcome).toBe("blocked");
    expect(first.difference).toBe("5");
    expect(await mismatchCount(w.id)).toBeGreaterThan(0);
    const after1 = await mismatchCount(w.id);

    // Repeated mismatch: block kept, no new Notification, cache untouched.
    const again = await runBalanceCheck(db(), w.id);
    expect(again.outcome).toBe("still_blocked");
    expect(again.notified).toBe(false);
    expect(await mismatchCount(w.id)).toBe(after1);

    // Derived is authoritative.
    expect((await getBalances(db(), w.id)).balance).toBe("15");

    // Blocked wallets refuse new reservations and charges.
    await expect(
      assertWalletUsable(db(), w.id, "sandbox"),
    ).rejects.toMatchObject({ code: "WALLET_BLOCKED" });

    // A posting while blocked and mismatched keeps the block and raises nothing new.
    await credit(w.id, "1", "EUR");
    expect(await mismatchCount(w.id)).toBe(after1);
    expect((await runBalanceCheck(db(), w.id)).outcome).toBe("still_blocked");

    // Now derived 16, cache 11. Reversing the +5 gives derived 11 = cache 11: the block lifts.
    const ledger = new LedgerService(db());
    await ledger.reverseJournalTransaction({
      tenantId: T,
      transactionId: second,
      reason: "fix drift",
      actorId: O,
    });
    const row = (
      await db().query<{ status: string }>(
        `SELECT status FROM wallets WHERE id = $1`,
        [w.id],
      )
    ).rows[0];
    expect(row.status).toBe("active");
    const lifted = (
      await db().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM economic_events WHERE aggregate_id = $1 AND event_type = 'WALLET_BLOCK_LIFTED'`,
        [w.id],
      )
    ).rows[0].n;
    expect(lifted).toBe(1);
    await expect(
      assertWalletUsable(db(), w.id, "sandbox"),
    ).resolves.toMatchObject({ id: w.id });
    expect(await mismatchCount(w.id)).toBe(after1);
  });
});

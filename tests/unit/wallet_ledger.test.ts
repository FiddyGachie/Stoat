// Task 4.1: WalletLedger.postJournal (R9.1 - R9.3, R9.5 - R9.9, R9.12, R9.17, R9.20).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import {
  postJournal,
  validateJournal,
} from "../../src/modules/wallet/wallet-ledger.js";
import { postTwoLineJournal } from "../../src/modules/ledger/postings.js";

const T = SEED_IDS.tenantId;
const base = { tenantId: T, eventId: "e", reference: "x", currency: "USD" };
const dr = (accountCode: string, amount: string, walletId?: string) => ({
  accountCode,
  side: "debit" as const,
  amount,
  walletId,
});
const cr = (accountCode: string, amount: string, walletId?: string) => ({
  accountCode,
  side: "credit" as const,
  amount,
  walletId,
});

function rule(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e: any) {
    return e.details?.rule;
  }
  return undefined;
}

describe("validateJournal", () => {
  it("names the violated rule", () => {
    expect(
      rule(() => validateJournal({ ...base, lines: [dr("1101", "1")] })),
    ).toBe("MIN_TWO_LINES");
    expect(
      rule(() =>
        validateJournal({ ...base, lines: [dr("1101", "2"), cr("2101", "1")] }),
      ),
    ).toBe("UNBALANCED");
    expect(
      rule(() =>
        validateJournal({ ...base, lines: [dr("1101", "0"), cr("2101", "0")] }),
      ),
    ).toBe("NON_POSITIVE_AMOUNT");
    expect(
      rule(() =>
        validateJournal({
          ...base,
          lines: [dr("1101", "-1"), cr("2101", "-1")],
        }),
      ),
    ).toBe("NON_POSITIVE_AMOUNT");
    expect(
      rule(() =>
        validateJournal({
          ...base,
          lines: [dr("1101", "1.0000001"), cr("2101", "1.0000001")],
        }),
      ),
    ).toBe("TOO_MANY_DECIMALS");
    const mixed = [{ ...dr("1101", "1"), currency: "EUR" }, cr("2101", "1")];
    expect(rule(() => validateJournal({ ...base, lines: mixed as any }))).toBe(
      "MIXED_CURRENCY",
    );
    expect(
      rule(() =>
        validateJournal({ ...base, lines: [dr("1101", "1"), cr("2103", "1")] }),
      ),
    ).toBe("WALLET_TAG_REQUIRED");
    expect(
      rule(() =>
        validateJournal({
          ...base,
          eventId: "",
          reference: "wallet:a",
          lines: [dr("1101", "1", "w"), cr("2103", "1", "w")],
        }),
      ),
    ).toBe("WALLET_EVENT_REQUIRED");
  });
  it("accepts a balanced three-line entry", () => {
    expect(() =>
      validateJournal({
        ...base,
        reference: "wallet:ok",
        lines: [dr("1101", "10"), cr("2103", "9.5", "w"), cr("4101", "0.5")],
      }),
    ).not.toThrow();
  });
});

describe("postJournal", () => {
  let walletId: string;
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

  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
    walletId = (
      await db().query<{ id: string }>(
        `INSERT INTO wallets (tenant_id, owner_user_id, currency, paypal_environment) VALUES ($1, $2, 'USD', 'sandbox') RETURNING id`,
        [T, SEED_IDS.userId],
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    await closeDb();
  });

  it("posts wallet entries with auto-created accounts, is idempotent by reference, and rejects nothing-written on failure", async () => {
    const eventId = await event();
    const input = {
      tenantId: T,
      eventId,
      reference: `wallet:test:${eventId}`,
      currency: "USD",
      lines: [dr("1101", "10"), cr("2103", "9.5", walletId), cr("4101", "0.5")],
    };
    const first = await postJournal(db(), input);
    const again = await postJournal(db(), input);
    expect(first.replayed).toBe(false);
    expect(again).toEqual({
      transactionId: first.transactionId,
      replayed: true,
    });

    const codes = (
      await db().query<{ account_code: string }>(
        `SELECT account_code FROM accounts WHERE tenant_id = $1 AND currency = 'USD' AND account_code IN ('2103','4101','5101')`,
        [T],
      )
    ).rows.map((r) => r.account_code);
    expect(codes).toContain("2103");
    expect(codes).toContain("4101");
    const n = (
      await db().query(
        `SELECT count(*)::int AS n FROM journal_lines WHERE transaction_id = $1`,
        [first.transactionId],
      )
    ).rows[0] as any;
    expect(n.n).toBe(3);
    const tagged = (
      await db().query(
        `SELECT count(*)::int AS n FROM journal_lines WHERE transaction_id = $1 AND wallet_id = $2`,
        [first.transactionId, walletId],
      )
    ).rows[0] as any;
    expect(tagged.n).toBe(1);

    await expect(
      postJournal(db(), {
        ...input,
        reference: "wallet:bad",
        lines: [dr("1101", "1"), cr("2103", "2", walletId)],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const bad = (
      await db().query(
        `SELECT count(*)::int AS n FROM journal_transactions WHERE reference = 'wallet:bad'`,
      )
    ).rows[0] as any;
    expect(bad.n).toBe(0);
  });

  it("postTwoLineJournal still posts a debit/credit pair", async () => {
    const eventId = await event();
    await postTwoLineJournal(db(), {
      tenantId: T,
      eventId,
      reference: `legacy:${eventId}`,
      currency: "USD",
      amount: "12.5",
      debitCode: "1101",
      creditCode: "2101",
    });
    const rows = (
      await db().query<{ debit: string; credit: string; account_code: string }>(
        `SELECT l.debit::text, l.credit::text, a.account_code FROM journal_lines l
         JOIN journal_transactions t ON t.id = l.transaction_id JOIN accounts a ON a.id = l.account_id
        WHERE t.reference = $1 ORDER BY l.sequence`,
        [`legacy:${eventId}`],
      )
    ).rows;
    expect(
      rows.map((r) => [r.account_code, Number(r.debit), Number(r.credit)]),
    ).toEqual([
      ["1101", 12.5, 0],
      ["2101", 0, 12.5],
    ]);
  });
});

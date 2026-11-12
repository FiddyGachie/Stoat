// Task 6.1: NotificationService (R7.15-7.21, R13.1-13.6, R13.10-13.13).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import {
  notifyInTx,
  list,
  unreadCount,
  markRead,
  resolveLowBalance,
  updateDepletionShortfall,
  sanitizeNotificationText,
  setEmailSender,
  type EmailMessage,
} from "../../src/modules/wallet/notification.service.js";
import { runOneJob } from "../../src/jobs/runner.js";

const T = SEED_IDS.tenantId;
const ADMIN = SEED_IDS.userId; // seeded as operator
const OWNER = randomUUID();
const SUPERVISOR = randomUUID();
const db = () => getDb();

const rows = async (sql: string, p: any[] = []) =>
  (await db().query(sql, p)).rows;

describe("NotificationService", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
    for (const [id, role] of [
      [OWNER, "buyer"],
      [SUPERVISOR, "supervisor"],
    ]) {
      await db().query(
        `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, $4)`,
        [id, T, `${role}-${id}@example.test`, role],
      );
    }
  });
  afterEach(() => setEmailSender(null));
  afterAll(async () => {
    await closeDb();
  });

  const base = { tenantId: T, title: "Title", body: "Body 10.00 USD" };

  it("sends Admin-only kinds to every Admin and never the Owner, deduped by event ID", async () => {
    const eventId = `e-${randomUUID()}`;
    const made = await notifyInTx(db(), {
      ...base,
      kind: "deposit_stuck",
      recipient: { admins: true },
      eventId,
    });
    expect(made.map((m) => m.recipientUserId).sort()).toEqual(
      [ADMIN, SUPERVISOR].sort(),
    );
    const again = await notifyInTx(db(), {
      ...base,
      kind: "deposit_stuck",
      recipient: { admins: true },
      eventId,
    });
    expect(again).toEqual([]);
    expect(
      await rows(`SELECT 1 FROM notifications WHERE event_id = $1`, [eventId]),
    ).toHaveLength(2);
    await expect(
      notifyInTx(db(), {
        ...base,
        kind: "wallet_balance_mismatch",
        recipient: { userId: OWNER },
        eventId: "x",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("sends topup_incomplete to the Owner only", async () => {
    const made = await notifyInTx(db(), {
      ...base,
      kind: "topup_incomplete",
      recipient: { userId: OWNER },
      eventId: `e-${randomUUID()}`,
    });
    expect(made.map((m) => m.recipientUserId)).toEqual([OWNER]);
    await expect(
      notifyInTx(db(), {
        ...base,
        kind: "topup_incomplete",
        recipient: { admins: true },
        eventId: "y",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("lists newest first in pages of 50, counts unread, and marks read once for the recipient only", async () => {
    const user = randomUUID();
    await db().query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'buyer')`,
      [user, T, `u-${user}@example.test`],
    );
    for (let i = 0; i < 55; i++) {
      await notifyInTx(db(), {
        ...base,
        kind: "deposit_captured",
        recipient: { userId: user },
        eventId: `page-${i}`,
      });
    }
    const p1 = await list(db(), user);
    expect(p1.items).toHaveLength(50);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await list(db(), user, { cursor: p1.next_cursor });
    expect(p2.items).toHaveLength(5);
    expect(p2.next_cursor).toBeNull();
    const ids = [...p1.items, ...p2.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(55);
    expect(await unreadCount(db(), user)).toBe(55);

    const first = await markRead(db(), user, ids[0]);
    expect(first.read_at).not.toBeNull();
    expect((await markRead(db(), user, ids[0])).read_at).toBe(first.read_at);
    expect(await unreadCount(db(), user)).toBe(54);
    await expect(markRead(db(), OWNER, ids[1])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await list(db(), OWNER)).items.map((i) => i.id)).not.toContain(
      ids[1],
    );
  });

  it("resolves low balance once", async () => {
    const mission = randomUUID();
    await db()
      .query(
        `INSERT INTO missions (id, tenant_id, buyer_id, objective, budget_ceiling, currency, status)
       VALUES ($1, $2, $3, 'o', 10, 'USD', 'open')`,
        [mission, T, SEED_IDS.buyerAgentId],
      )
      .catch(() => undefined); // mission row is not required by notifications (no FK)
    await notifyInTx(db(), {
      ...base,
      kind: "low_balance",
      recipient: { userId: OWNER },
      eventId: `lb-${randomUUID()}`,
      missionId: mission,
    });
    expect(await resolveLowBalance(db(), mission)).toBe(1);
    expect(await resolveLowBalance(db(), mission)).toBe(0);
  });

  it("updates the depletion notification in place, resets it to unread, and asks for a new email", async () => {
    const sent: EmailMessage[] = [];
    setEmailSender({ send: async (m) => void sent.push(m) });
    const mission = randomUUID();
    const [n] = await notifyInTx(db(), {
      ...base,
      kind: "depleted",
      recipient: { userId: OWNER },
      eventId: `dep-${randomUUID()}`,
      missionId: mission,
    });
    await markRead(db(), OWNER, n.id);
    expect(await updateDepletionShortfall(db(), n.id, "4.5", "USD")).toBe(true);
    const all = await rows(
      `SELECT * FROM notifications WHERE mission_id = $1 AND kind = 'depleted'`,
      [mission],
    );
    expect(all).toHaveLength(1);
    expect(all[0].read_at).toBeNull();
    expect(all[0].updated_at).not.toBeNull();
    expect(all[0].body).toContain("4.5 USD");
    // creation email + shortfall email
    const jobs = await rows(
      `SELECT max_attempts FROM jobs WHERE type = 'wallet_email' AND payload->>'notification_id' = $1`,
      [n.id],
    );
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.max_attempts === 3)).toBe(true);
    // same shortfall again: no change, no extra job
    expect(await updateDepletionShortfall(db(), n.id, "4.5", "USD")).toBe(
      false,
    );
    expect(
      await rows(
        `SELECT 1 FROM jobs WHERE type = 'wallet_email' AND payload->>'notification_id' = $1`,
        [n.id],
      ),
    ).toHaveLength(2);
    // any other content edit is rejected by the database guard
    await expect(
      db().query(`UPDATE notifications SET kind = 'topped_up' WHERE id = $1`, [
        n.id,
      ]),
    ).rejects.toThrow();
  });

  it("creates no email job without a provider, and keeps the row when email fails", async () => {
    const none = await notifyInTx(db(), {
      ...base,
      kind: "low_balance",
      recipient: { userId: OWNER },
      eventId: `ne-${randomUUID()}`,
      missionId: randomUUID(),
    });
    expect(
      await rows(`SELECT 1 FROM jobs WHERE payload->>'notification_id' = $1`, [
        none[0].id,
      ]),
    ).toHaveLength(0);

    setEmailSender({
      send: async () => {
        throw new Error("provider down");
      },
    });
    const [n] = await notifyInTx(db(), {
      ...base,
      kind: "low_balance",
      recipient: { userId: OWNER },
      eventId: `fe-${randomUUID()}`,
      missionId: randomUUID(),
    });
    await db().query(
      `UPDATE jobs SET run_after = now() WHERE type = 'wallet_email'`,
    );
    await db().query(
      `DELETE FROM jobs WHERE type = 'wallet_email' AND payload->>'notification_id' <> $1`,
      [n.id],
    );
    for (let i = 0; i < 4; i++) {
      await db().query(
        `UPDATE jobs SET run_after = now() WHERE type = 'wallet_email' AND status = 'queued'`,
      );
      await runOneJob(db(), "test-worker");
    }
    const job = (
      await rows(
        `SELECT status, attempts FROM jobs WHERE payload->>'notification_id' = $1`,
        [n.id],
      )
    )[0];
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(3);
    expect(
      await rows(`SELECT 1 FROM notifications WHERE id = $1`, [n.id]),
    ).toHaveLength(1);
  });

  it("sends the email to the recipient address without storing it on the notification", async () => {
    const sent: EmailMessage[] = [];
    setEmailSender({ send: async (m) => void sent.push(m) });
    const [n] = await notifyInTx(db(), {
      ...base,
      kind: "low_balance",
      recipient: { userId: OWNER },
      eventId: `ok-${randomUUID()}`,
      missionId: randomUUID(),
    });
    await db().query(
      `UPDATE jobs SET run_after = now() WHERE type = 'wallet_email' AND status = 'queued'`,
    );
    while (await runOneJob(db(), "test-worker")) {
      /* drain */
    }
    expect(sent.some((m) => m.to.startsWith("buyer-"))).toBe(true);
    const row = (
      await rows(`SELECT title, body FROM notifications WHERE id = $1`, [n.id])
    )[0];
    expect(JSON.stringify(row)).not.toContain("@");
  });

  it("rejects secrets, token-like strings, emails and bad lengths, but allows IDs and amounts", () => {
    const ok = (body: string) => sanitizeNotificationText({ title: "t", body });
    expect(
      ok(
        `Deposit ${randomUUID()} of 10.50 USD captured (PayPal order 5O190127TN364715T).`,
      ).title,
    ).toBe("t");
    for (const bad of [
      "contact me at someone@example.com",
      "access_token: abc",
      "Bearer abcdefghijklmnop",
      "A".repeat(40),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      "password=hunter2",
    ]) {
      expect(() => ok(bad), bad).toThrow();
    }
    expect(() => sanitizeNotificationText({ title: "", body: "x" })).toThrow();
    expect(() =>
      sanitizeNotificationText({ title: "x".repeat(121), body: "x" }),
    ).toThrow();
    expect(() =>
      sanitizeNotificationText({ title: "x", body: "x".repeat(1001) }),
    ).toThrow();
    expect(() =>
      sanitizeNotificationText({ title: "x", body: "word ".repeat(199) }),
    ).not.toThrow();
  });

  it("rejects unsafe content on create and persists nothing", async () => {
    const eventId = `bad-${randomUUID()}`;
    await expect(
      notifyInTx(db(), {
        ...base,
        body: "token: abc",
        kind: "deposit_captured",
        recipient: { userId: OWNER },
        eventId,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      await rows(`SELECT 1 FROM notifications WHERE event_id = $1`, [eventId]),
    ).toHaveLength(0);
  });
});

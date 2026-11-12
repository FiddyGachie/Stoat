// Task 8.3: walletGuard and the first wallet routes (R1.10, R1.12, R1.13, R2.14, R4.1-4.5, R4.10, R4.11, R12.1, R12.2, R19.4, R19.11).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import { notifyInTx } from "../../src/modules/wallet/notification.service.js";
import { appendWalletEvent } from "../../src/modules/wallet/wallet-events.js";

const T = SEED_IDS.tenantId;
const OWNER = randomUUID(); // buyer user
const OTHER = randomUUID(); // second buyer user, same tenant
const ADMIN = SEED_IDS.userId; // seeded operator
const T2 = randomUUID();
const FOREIGN = randomUUID(); // user in another tenant
const db = () => getDb();
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const user = (id: string) => as(`user:${id}`);
const agent = as(`agent:${SEED_IDS.buyerAgentId}`);
const count = async (table: string, where = "true") =>
  (
    await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    )
  ).rows[0].n;
const refusals = () => count("audit_logs", "outcome = 'refused'");

describe("walletGuard and wallet routes", () => {
  let app: any;
  let paypal: WalletPayPalDouble;
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
    paypal = new WalletPayPalDouble();
    app = createApp({ gateway: paypal });
  });
  afterAll(async () => {
    await closeDb();
  });
  beforeEach(async () => {
    await db().query(TRUNCATE_ALL);
    await db().query(
      `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`,
      [T, JSON.stringify({ funding_mode: "wallet" })],
    );
    await db()
      .query(`DELETE FROM users WHERE id = ANY($1)`, [[OWNER, OTHER, FOREIGN]])
      .catch(() => undefined);
    await db().query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Other') ON CONFLICT DO NOTHING`,
      [T2],
    );
    for (const [id, tenant, email] of [
      [OWNER, T, "owner@x.test"],
      [OTHER, T, "other@x.test"],
      [FOREIGN, T2, "foreign@x.test"],
    ]) {
      await db().query(
        `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'buyer') ON CONFLICT (id) DO NOTHING`,
        [id, tenant, email],
      );
    }
  });

  const createDeposit = (
    who: Record<string, string>,
    over: Record<string, unknown> = {},
    key = `k-${randomUUID()}`,
  ) =>
    dispatch(app, {
      method: "POST",
      url: "/v1/wallet/deposits",
      headers: { ...who, "idempotency-key": key },
      body: { amount: "25.00", currency: "USD", ...over },
    });

  // Task 15.1: notification routes (R7.17, R7.18, R13.7, R13.10).
  describe("notification routes", () => {
    const note = (userId: string, n: number) =>
      notifyInTx(db(), {
        tenantId: T,
        kind: "deposit_captured",
        recipient: { userId },
        title: `Deposit ${n}`,
        body: `Deposit ${n} was captured.`,
        eventId: `evt-${userId}-${n}`,
      });
    const get = (who: Record<string, string>, url: string) =>
      dispatch(app, { method: "GET", url, headers: who });

    it("pages newest first by cursor, 50 per page, only the recipient's own", async () => {
      for (let i = 0; i < 52; i++) await note(OWNER, i);
      await note(OTHER, 99);
      const p1 = await get(user(OWNER), "/v1/notifications");
      expect(p1.status).toBe(200);
      expect(p1.body.notifications).toHaveLength(50);
      expect(p1.body.next_cursor).toBeTruthy();
      const p2 = await get(
        user(OWNER),
        `/v1/notifications?cursor=${encodeURIComponent(p1.body.next_cursor)}`,
      );
      expect(p2.body.notifications).toHaveLength(2);
      expect(p2.body.next_cursor).toBeNull();
      const ids = [...p1.body.notifications, ...p2.body.notifications].map(
        (n: any) => n.id,
      );
      expect(new Set(ids).size).toBe(52);
      expect(p1.body.notifications[0].title).toBe("Deposit 51");
      expect(JSON.stringify(p1.body)).not.toMatch(/Deposit 99/);
      const bad = await get(user(OWNER), "/v1/notifications?cursor=%%%");
      expect(bad.status).toBe(400);
    });

    it("counts unread and marks read once; others see 404 with no content", async () => {
      await note(OWNER, 1);
      await note(OWNER, 2);
      const list = await get(user(OWNER), "/v1/notifications");
      const id = list.body.notifications[0].id;
      expect(
        (await get(user(OWNER), "/v1/notifications/unread-count")).body,
      ).toEqual({ unread_count: 2 });
      const read = await dispatch(app, {
        method: "POST",
        url: `/v1/notifications/${id}/read`,
        headers: user(OWNER),
      });
      expect(read.status).toBe(200);
      expect(read.body.notification.read_at).toBeTruthy();
      expect(read.body.unread_count).toBe(1);
      const again = await dispatch(app, {
        method: "POST",
        url: `/v1/notifications/${id}/read`,
        headers: user(OWNER),
      });
      expect(again.body.notification.read_at).toBe(
        read.body.notification.read_at,
      );
      for (const who of [OTHER, FOREIGN]) {
        const r = await dispatch(app, {
          method: "POST",
          url: `/v1/notifications/${id}/read`,
          headers: user(who),
        });
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toMatch(/Deposit/);
      }
      expect(
        (await get(user(OTHER), "/v1/notifications/unread-count")).body,
      ).toEqual({ unread_count: 0 });
      const unknown = await dispatch(app, {
        method: "POST",
        url: `/v1/notifications/${randomUUID()}/read`,
        headers: user(OWNER),
      });
      expect(unknown.status).toBe(404);
    });

    it("refuses agents with 403 and one audit row per request", async () => {
      await note(OWNER, 1);
      for (const [method, url] of [
        ["GET", "/v1/notifications"],
        ["GET", "/v1/notifications/unread-count"],
        ["POST", `/v1/notifications/${randomUUID()}/read`],
      ] as const) {
        const before = await refusals();
        const r = await dispatch(app, { method, url, headers: agent });
        expect(r.status).toBe(403);
        expect(JSON.stringify(r.body)).not.toMatch(/Deposit/);
        expect(await refusals()).toBe(before + 1);
      }
    });
  });

  // Task 15.2: Economic_Event history route (R19.5, R19.6, R19.7).
  describe("event history route", () => {
    const get = (who: Record<string, string>, url: string) =>
      dispatch(app, { method: "GET", url, headers: who });
    const seed = async () => {
      const c = await createDeposit(user(OWNER));
      const w = await get(user(OWNER), "/v1/wallet");
      const walletId = w.body.wallets[0].id as string;
      for (let i = 0; i < 102; i++) {
        await appendWalletEvent(db(), {
          tenantId: T,
          aggregateType: "wallet",
          aggregateId: walletId,
          eventType: "TEST_EVENT",
          actorRole: "system",
          actorId: OWNER,
          amount: "1.00",
          currency: "USD",
          paypal: { captureId: `CAP-${i}` },
        });
      }
      return { depositId: c.body.id as string, walletId };
    };

    it("pages the owner's history ascending, 100 per page, allowlisted fields only", async () => {
      const { walletId } = await seed();
      const url = `/v1/wallet/events?entity_type=wallet&entity_id=${walletId}`;
      const p1 = await get(user(OWNER), url);
      expect(p1.status).toBe(200);
      expect(p1.body.events).toHaveLength(100);
      expect(p1.body.next_cursor).toBeTruthy();
      const seqs = p1.body.events.map((e: any) => e.sequence);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      const p2 = await get(
        user(OWNER),
        `${url}&cursor=${encodeURIComponent(p1.body.next_cursor)}`,
      );
      expect(p2.body.events.length).toBeGreaterThanOrEqual(2);
      expect(p2.body.next_cursor).toBeNull();
      expect(p2.body.events[0].sequence).toBe(seqs[99] + 1);
      const e = p1.body.events[0];
      expect(Object.keys(e).sort()).toEqual(
        [
          "id",
          "aggregate_type",
          "aggregate_id",
          "sequence",
          "event_type",
          "actor_type",
          "actor_role",
          "actor_id",
          "tenant_id",
          "correlation_id",
          "amount",
          "currency",
          "recorded_at",
          "paypal_order_id",
          "paypal_capture_id",
          "paypal_refund_id",
          "paypal_payout_batch_id",
          "paypal_request_id",
        ].sort(),
      );
      expect(e.amount).toBe("1");
      expect(e.paypal_capture_id).toBe("CAP-0");
      expect((await get(user(OWNER), `${url}&cursor=%%%`)).status).toBe(400);
    });

    it("serves a deposit history to its owner and a same-tenant admin", async () => {
      const { depositId } = await seed();
      const url = `/v1/wallet/events?entity_type=wallet_deposit&entity_id=${depositId}`;
      const o = await get(user(OWNER), url);
      expect(o.status).toBe(200);
      expect(o.body.events.length).toBeGreaterThan(0);
      const a = await get(user(ADMIN), url);
      expect(a.status).toBe(200);
      expect(a.body.events.map((e: any) => e.id)).toEqual(
        o.body.events.map((e: any) => e.id),
      );
    });

    it("refuses others identically with one audit row each; no existence disclosure", async () => {
      const { walletId } = await seed();
      const real = `/v1/wallet/events?entity_type=wallet&entity_id=${walletId}`;
      const missing = `/v1/wallet/events?entity_type=wallet&entity_id=${randomUUID()}`;
      const bodies: string[] = [];
      for (const [who, url] of [
        [user(OTHER), real],
        [user(FOREIGN), real],
        [user(OTHER), missing],
        [agent, real],
      ] as const) {
        const before = await refusals();
        const r = await get(who, url);
        expect(r.status).toBe(403);
        expect(await refusals()).toBe(before + 1);
        if (who !== agent) {
          bodies.push(JSON.stringify({ ...r.body, correlation_id: undefined }));
        }
      }
      expect(
        new Set(
          bodies.map((b) =>
            b.replace(/"(request_id|correlation_id)":"[^"]*"/g, ""),
          ),
        ).size,
      ).toBe(1);
      const bad = await get(
        user(OWNER),
        "/v1/wallet/events?entity_type=x&entity_id=y",
      );
      expect(bad.status).toBe(400);
    });
  });

  it("requires authentication", async () => {
    const r = await dispatch(app, { method: "GET", url: "/v1/wallet" });
    expect(r.status).toBe(401);
  });

  it("owner creates a deposit and reads it back; amounts are strings with the environment", async () => {
    const c = await createDeposit(user(OWNER));
    expect(c.status).toBe(201);
    expect(c.body.status).toBe("awaiting_approval");
    expect(c.body.amount).toBe("25");
    expect(c.body.paypal_environment).toBe("sandbox");
    const g = await dispatch(app, {
      method: "GET",
      url: `/v1/wallet/deposits/${c.body.id}`,
      headers: user(OWNER),
    });
    expect(g.status).toBe(200);
    expect(g.body.id).toBe(c.body.id);
    const l = await dispatch(app, {
      method: "GET",
      url: "/v1/wallet/deposits",
      headers: user(OWNER),
    });
    expect(l.body.deposits).toHaveLength(1);
    expect(l.body.paypal_environment).toBe("sandbox");
    const w = await dispatch(app, {
      method: "GET",
      url: "/v1/wallet",
      headers: user(OWNER),
    });
    expect(w.status).toBe(200);
    expect(w.body.wallets).toHaveLength(1);
    expect(w.body.wallets[0].available).toBe("0");
    expect(typeof w.body.wallets[0].balance).toBe("string");
    expect(w.body.paypal_environment).toBe("sandbox");
    expect(JSON.stringify(w.body)).not.toMatch(
      /recipient|payee|payment_source/i,
    );
  });

  it("requires an Idempotency-Key", async () => {
    const r = await dispatch(app, {
      method: "POST",
      url: "/v1/wallet/deposits",
      headers: user(OWNER),
      body: { amount: "5.00", currency: "USD" },
    });
    expect(r.status).toBe(400);
    expect(await count("wallet_deposits")).toBe(0);
  });

  it("ignores body identity: the deposit goes to the principal's wallet", async () => {
    const other = await dispatch(app, {
      method: "GET",
      url: "/v1/wallet",
      headers: user(OTHER),
    });
    const c = await createDeposit(user(OWNER), {
      owner_user_id: OTHER,
      wallet_id: other.body.wallets?.[0]?.id ?? randomUUID(),
      user_id: OTHER,
    });
    expect(c.status).toBe(201);
    const row = (
      await db().query(
        `SELECT owner_user_id FROM wallet_deposits WHERE id = $1`,
        [c.body.id],
      )
    ).rows[0] as any;
    expect(row.owner_user_id).toBe(OWNER);
  });

  it("rejects a payee or recipient field", async () => {
    const r = await createDeposit(user(OWNER), {
      payout_recipient: "x@y.test",
    });
    expect(r.status).toBe(400);
    expect(await count("wallet_deposits")).toBe(0);
  });

  it("refuses an agent on every wallet route with 403 and exactly one audit row each", async () => {
    const before0 = paypal.count("createOrder");
    const calls: Array<[string, string, any?]> = [
      ["GET", "/v1/wallet"],
      ["POST", "/v1/wallet/deposits", { amount: "1.00", currency: "USD" }],
      ["GET", "/v1/wallet/deposits"],
      ["GET", `/v1/wallet/deposits/${randomUUID()}`],
      ["POST", `/v1/wallet/deposits/${randomUUID()}/refresh`],
    ];
    for (const [method, url, body] of calls) {
      const before = await refusals();
      const r = await dispatch(app, {
        method: method as "GET" | "POST",
        url,
        headers: { ...agent, "idempotency-key": "same-key" },
        body,
      });
      expect(r.status, url).toBe(403);
      expect(r.body.error.code).toBe("FORBIDDEN_ACTION");
      expect(await refusals(), url).toBe(before + 1);
    }
    expect(await count("wallet_deposits")).toBe(0);
    expect(paypal.count("createOrder")).toBe(before0);
  });

  it("agent refusal lists all reasons when the target wallet is someone else's", async () => {
    const c = await createDeposit(user(OWNER));
    const before = await refusals();
    const r = await dispatch(app, {
      method: "GET",
      url: `/v1/wallet/deposits/${c.body.id}`,
      headers: agent,
    });
    expect(r.status).toBe(403);
    expect(await refusals()).toBe(before + 1);
    const row = (
      await db().query(
        `SELECT reason, metadata FROM audit_logs WHERE outcome = 'refused' ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0] as any;
    const meta =
      typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata;
    expect(meta.reasons).toEqual(["agent_principal", "wallet_not_owned"]);
    expect(meta.target_wallet_id).toBeTruthy();
  });

  it("same-tenant non-owner gets 403 WALLET_NOT_OWNED with one audit row; admin may read", async () => {
    const c = await createDeposit(user(OWNER));
    const before = await refusals();
    const r = await dispatch(app, {
      method: "GET",
      url: `/v1/wallet/deposits/${c.body.id}`,
      headers: user(OTHER),
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("WALLET_NOT_OWNED");
    expect(await refusals()).toBe(before + 1);
    const rr = await dispatch(app, {
      method: "POST",
      url: `/v1/wallet/deposits/${c.body.id}/refresh`,
      headers: user(OTHER),
    });
    expect(rr.body.error.code).toBe("WALLET_NOT_OWNED");
    expect(await refusals()).toBe(before + 2);

    const a = await dispatch(app, {
      method: "GET",
      url: `/v1/wallet/deposits/${c.body.id}`,
      headers: user(ADMIN),
    });
    expect(a.status).toBe(200);
    const list = await dispatch(app, {
      method: "GET",
      url: "/v1/wallet/deposits",
      headers: user(OTHER),
    });
    expect(list.body.deposits).toHaveLength(0);
    const alist = await dispatch(app, {
      method: "GET",
      url: "/v1/wallet/deposits",
      headers: user(ADMIN),
    });
    expect(alist.body.deposits).toHaveLength(1);
  });

  it("answers a cross-tenant deposit exactly like a missing one", async () => {
    const c = await createDeposit(user(OWNER));
    const cross = await dispatch(app, {
      method: "GET",
      url: `/v1/wallet/deposits/${c.body.id}`,
      headers: user(FOREIGN),
    });
    const missing = await dispatch(app, {
      method: "GET",
      url: `/v1/wallet/deposits/${randomUUID()}`,
      headers: user(FOREIGN),
    });
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe(missing.body.error.code);
    expect(cross.body.error.message.replace(/'[^']*'/g, "")).toBe(
      missing.body.error.message.replace(/'[^']*'/g, ""),
    );
  });

  it("refresh by the owner asks PayPal and returns the deposit", async () => {
    const c = await createDeposit(user(OWNER));
    const r = await dispatch(app, {
      method: "POST",
      url: `/v1/wallet/deposits/${c.body.id}/refresh`,
      headers: user(OWNER),
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(c.body.id);
  });

  it("has no wallet route for an Admin to reserve, charge or refund for an Owner", async () => {
    const paths: string[] = [];
    const walk = (stack: any[]) => {
      for (const l of stack) {
        if (l.route)
          paths.push(
            `${Object.keys(l.route.methods).join(",")} ${l.route.path}`,
          );
        else if (l.handle?.stack) walk(l.handle.stack);
      }
    };
    walk(app._router.stack);
    const wallet = paths.filter((p) => p.includes("/v1/wallet"));
    expect(wallet.length).toBeGreaterThan(0);
    // Task 14.3 adds Owner-scoped refund routes (the wallet is always the principal's own).
    // Nothing reserves or charges, and no refund route takes a wallet ID from the URL or body.
    expect(wallet.filter((p) => /reserv|charge/i.test(p))).toEqual([]);
    expect(wallet.filter((p) => /refund/i.test(p)).sort()).toEqual(
      [
        "get /v1/wallet/refunds",
        "get /v1/wallet/refunds/:id",
        "post /v1/wallet/refunds",
        "post /v1/wallet/refunds/:id/retry",
      ].sort(),
    );
  });
});

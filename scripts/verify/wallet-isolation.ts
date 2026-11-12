/**
 * Fund isolation verifier (WI-01..WI-05).
 *
 * Boots the real app on embedded PGlite in production mode and drives the wallet routes over
 * real HTTP. The PayPal gateway is the scripted WalletPayPalDouble: it only lets deposit
 * orders be created, so these checks show Stoat's own isolation logic, not PayPal behaviour.
 *
 *   WI-01 another Owner in the same tenant is refused and writes exactly one audit row
 *   WI-02 a cross-tenant request is indistinguishable from "not found"
 *   WI-03 an agent calling each money route gets 403 and exactly one audit row
 *   WI-04 identity supplied in a request body is ignored
 *   WI-05 the database rejects a reservation whose wallet owner differs from the mission owner
 *
 * Writes .agents/reports/wallet-isolation.json. Exit code 0 only if every check passes.
 */
import { randomUUID } from "node:crypto";
import {
  Harness,
  NIL_UUID,
  expect,
  expectCode,
  expectStatus,
  provisionAgent,
  runVerifier,
  signup,
  type Account,
} from "./harness.js";
import { WalletPayPalDouble } from "./paypal-wallet-double.js";

const AGENT = "wallet-isolation";

async function main(): Promise<number> {
  const gateway = new WalletPayPalDouble();
  const h = await Harness.boot({ gateway });
  const { getDb } = await import("../../src/db/connection.js");
  const { issueAccessToken } = await import("../../src/common/auth-crypto.js");
  const db = getDb();

  const refusals = async (tenantId: string): Promise<number> =>
    Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND outcome = 'refused'`,
          [tenantId],
        )
      ).rows[0].n,
    );
  const setWalletMode = (tenantId: string) =>
    db.query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','wallet') WHERE id = $1`,
      [tenantId],
    );
  const deposit = (
    who: Account,
    body: Record<string, unknown> = { amount: "10.00", currency: "USD" },
  ) =>
    h.http("POST", "/v1/wallet/deposits", {
      token: who.token,
      body,
      headers: { "idempotency-key": `k-${randomUUID()}` },
    });

  try {
    // Two Owners in tenant A, one Owner in tenant B.
    const a = await signup(h, "wi-a", "Org WI A");
    const c = await signup(h, "wi-c", "Org WI C");
    await setWalletMode(a.tenantId);
    await setWalletMode(c.tenantId);
    const bId = randomUUID();
    const bEmail = `wi-b.${Date.now().toString(36)}@verify.stoat.test`;
    await db.query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'buyer')`,
      [bId, a.tenantId, bEmail],
    );
    const b: Account = {
      email: bEmail,
      token: issueAccessToken(bId, "user"),
      userId: bId,
      tenantId: a.tenantId,
    };

    const dA = await deposit(a);
    expectStatus(dA, 201, "Owner A creates a deposit");
    const depositA = dA.body.id as string;
    const walletA = dA.body.wallet_id as string;

    await h.check(
      "WI-01",
      "Another Owner in the same tenant is refused with one audit row each",
      async () => {
        const targets: Array<[string, string]> = [
          ["GET", `/v1/wallet/deposits/${depositA}`],
          ["POST", `/v1/wallet/deposits/${depositA}/refresh`],
        ];
        for (const [method, url] of targets) {
          const before = await refusals(a.tenantId);
          const res = await h.http(method, url, { token: b.token });
          expectCode(
            res,
            403,
            "WALLET_NOT_OWNED",
            `${method} ${url} as Owner B`,
          );
          const after = await refusals(a.tenantId);
          expect(
            after === before + 1,
            `${method} ${url}: expected exactly 1 audit row, got ${after - before}`,
          );
        }
        const list = await h.http("GET", "/v1/wallet/deposits", {
          token: b.token,
        });
        expectStatus(list, 200, "Owner B lists deposits");
        expect(
          !JSON.stringify(list.body).includes(depositA),
          "Owner B's list contains Owner A's deposit",
        );
        const own = await h.http("GET", `/v1/wallet/deposits/${depositA}`, {
          token: a.token,
        });
        expectStatus(own, 200, "Owner A still reads own deposit");
        return "GET and refresh by Owner B -> 403 WALLET_NOT_OWNED, 1 audit row each; B list excludes A deposit; A can read own";
      },
    );

    await h.check(
      "WI-02",
      "Cross-tenant looks the same as not found",
      async () => {
        const before = await refusals(c.tenantId);
        for (const [method, path] of [
          ["GET", `/v1/wallet/deposits/${depositA}`],
          ["POST", `/v1/wallet/deposits/${depositA}/refresh`],
        ] as const) {
          const cross = await h.http(method, path, { token: c.token });
          const missing = await h.http(
            method,
            path.replace(depositA, NIL_UUID),
            { token: c.token },
          );
          expect(
            cross.status === 404,
            `${method} cross-tenant: expected 404, got ${cross.status}`,
          );
          expect(
            missing.status === 404,
            `${method} missing: expected 404, got ${missing.status}`,
          );
          expect(
            JSON.stringify(cross.body?.error?.code) ===
              JSON.stringify(missing.body?.error?.code),
            `${method}: cross-tenant error code differs from not-found`,
          );
          // The correlation ID is generated per request; every other field must match.
          const shape = (body: any, id: string) =>
            JSON.stringify(body, (k, v) =>
              k === "correlation_id" ? undefined : v,
            ).replaceAll(id, "X");
          expect(
            shape(cross.body, depositA) === shape(missing.body, NIL_UUID),
            `${method}: cross-tenant body differs from not-found body`,
          );
        }
        const list = await h.http("GET", "/v1/wallet/deposits", {
          token: c.token,
        });
        expect(
          !JSON.stringify(list.body).includes(depositA),
          "tenant C list leaks tenant A's deposit",
        );
        expect(
          (await refusals(c.tenantId)) === before,
          "cross-tenant probe must not reveal itself through an audit row in the attacker tenant",
        );
        return "cross-tenant GET/refresh -> 404 with the same code and body shape as a missing ID";
      },
    );

    await h.check(
      "WI-03",
      "An agent on any money route gets 403 and exactly one audit row",
      async () => {
        const agent = await provisionAgent(h, a, "buyer", "wi-buyer");
        const id = randomUUID();
        const routes: Array<[string, string, unknown?]> = [
          ["GET", "/v1/wallet"],
          ["POST", "/v1/wallet/deposits", { amount: "5.00", currency: "USD" }],
          ["GET", "/v1/wallet/deposits"],
          ["GET", `/v1/wallet/deposits/${depositA}`],
          ["POST", `/v1/wallet/deposits/${depositA}/refresh`],
          ["POST", "/v1/wallet/refunds", { amount: "1.00" }],
          ["POST", `/v1/wallet/refunds/${id}/retry`],
          ["POST", `/v1/wallet/missions/${id}/complete`],
          ["POST", `/v1/wallet/missions/${id}/top-up`, { amount: "1.00" }],
          [
            "POST",
            `/v1/wallet/missions/${id}/remainder-decision`,
            { decision: "refund" },
          ],
          [
            "POST",
            `/v1/admin/wallets/${walletA}/refunds`,
            { amount: "1.00", reason: "x" },
          ],
          [
            "POST",
            `/v1/admin/journal/transactions/${id}/reverse`,
            { reason: "x" },
          ],
        ];
        const depositsBefore = Number(
          (
            await db.query(
              `SELECT count(*)::int AS n FROM wallet_deposits WHERE tenant_id = $1`,
              [a.tenantId],
            )
          ).rows[0].n,
        );
        const orders = gateway.count("createOrder");
        const bad: string[] = [];
        for (const [method, url, body] of routes) {
          const before = await refusals(a.tenantId);
          const res = await h.http(method, url, {
            token: agent.token,
            body,
            headers: { "idempotency-key": `k-${randomUUID()}` },
          });
          const rows = (await refusals(a.tenantId)) - before;
          if (res.status !== 403 || rows !== 1)
            bad.push(
              `${method} ${url} -> HTTP ${res.status}, ${rows} audit row(s)`,
            );
        }
        expect(
          bad.length === 0,
          `agent not refused cleanly: ${bad.join("; ")}`,
        );
        const depositsAfter = Number(
          (
            await db.query(
              `SELECT count(*)::int AS n FROM wallet_deposits WHERE tenant_id = $1`,
              [a.tenantId],
            )
          ).rows[0].n,
        );
        expect(
          depositsAfter === depositsBefore &&
            gateway.count("createOrder") === orders,
          "an agent request created a deposit or a PayPal order",
        );
        return `${routes.length} money routes refused with 403 and one audit row each; no deposit or PayPal order created`;
      },
    );

    await h.check(
      "WI-04",
      "Identity supplied in a request body is ignored",
      async () => {
        const bWalletsBefore = await h.http("GET", "/v1/wallet", {
          token: b.token,
        });
        expectStatus(bWalletsBefore, 200, "Owner B reads own wallets");
        const res = await deposit(b, {
          amount: "7.00",
          currency: "USD",
          wallet_id: walletA,
          owner_user_id: a.userId,
          user_id: a.userId,
          tenant_id: c.tenantId,
        });
        expectStatus(res, 201, "Owner B deposit with forged identity fields");
        expect(
          res.body.wallet_id !== walletA,
          "deposit landed in Owner A's wallet",
        );
        const row = (
          await db.query(
            `SELECT d.tenant_id, w.owner_user_id FROM wallet_deposits d JOIN wallets w ON w.id = d.wallet_id WHERE d.id = $1`,
            [res.body.id],
          )
        ).rows[0];
        expect(
          row.owner_user_id === b.userId && row.tenant_id === b.tenantId,
          `deposit owner/tenant came from the body (owner ${row.owner_user_id}, tenant ${row.tenant_id})`,
        );
        const aCount = Number(
          (
            await db.query(
              `SELECT count(*)::int AS n FROM wallet_deposits WHERE wallet_id = $1`,
              [walletA],
            )
          ).rows[0].n,
        );
        expect(aCount === 1, `Owner A's wallet gained deposits (${aCount})`);
        const payee = await deposit(b, {
          amount: "7.00",
          currency: "USD",
          payee: "attacker@evil.test",
          recipient: "attacker@evil.test",
        });
        expect(
          payee.status >= 400 && payee.status < 500,
          `payee-like keys must be rejected with 4xx, got ${payee.status}`,
        );
        return (
          "forged wallet_id/owner_user_id/user_id/tenant_id ignored; payee keys rejected with " +
          payee.status
        );
      },
    );

    await h.check(
      "WI-05",
      "DB trigger rejects a reservation for a wallet the mission owner does not own",
      async () => {
        const agentA = await provisionAgent(h, a, "buyer", "wi-mission-buyer");
        const m = await h.http("POST", "/missions", {
          token: agentA.token,
          body: {
            title: "Isolation probe",
            brief: "Review the fixture",
            budget: "50",
            currency: "USD",
          },
        });
        expectStatus(m, 201, "Owner A buyer agent creates a mission");
        const missionId = m.body.id as string;
        const walletB = (
          await db.query(
            `SELECT id FROM wallets WHERE tenant_id = $1 AND owner_user_id = $2`,
            [a.tenantId, b.userId],
          )
        ).rows[0]?.id;
        expect(walletB, "Owner B wallet missing");
        const reservationsBefore = Number(
          (await db.query(`SELECT count(*)::int AS n FROM wallet_reservations`))
            .rows[0].n,
        );
        let message = "";
        try {
          await db.query(
            `INSERT INTO wallet_reservations (tenant_id, wallet_id, mission_id, agreement_id, amount, currency, status)
           VALUES ($1, $2, $3, $4, 1, 'USD', 'active')`,
            [a.tenantId, walletB, missionId, randomUUID()],
          );
        } catch (err) {
          message = (err as Error).message;
        }
        expect(
          /wallet owner must equal the mission owner/i.test(message),
          `expected the owner trigger to reject the insert, got: ${message || "no error"}`,
        );
        const reservationsAfter = Number(
          (await db.query(`SELECT count(*)::int AS n FROM wallet_reservations`))
            .rows[0].n,
        );
        expect(
          reservationsAfter === reservationsBefore,
          "a reservation row was written",
        );
        return `direct insert rejected: ${message}`;
      },
    );
  } finally {
    await h.close();
  }
  return h.report(AGENT, "ISOLATION_VERIFIED", "ISOLATION_BLOCKED");
}

void runVerifier(AGENT, main);

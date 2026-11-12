/**
 * Agentic boundary verifier (Requirement 17.6).
 *
 * Boots the real app on embedded PGlite in production mode and, as an agent principal of every
 * role, attempts each operation Requirements 1, 3, 6, 9 and 14 forbid, on REST, MCP and the
 * portal (the AgentToolGateway entry the console uses, via = "portal").
 *
 *   AB-01 Mandate operations (R1): create, list, get, revoke, lift suspension
 *   AB-02 Quote selection (R3): autonomous selection by a non-Buyer agent
 *   AB-03 Watchdog and holds (R6): release, explain, thresholds, feature flags
 *   AB-04 Proposal decisions (R9): approve, reject, list, get
 *   AB-05 Money and recipient routes (R14.1/14.2): approve, capture, refund, payout, recipient
 *   AB-06 Forbidden tool names and out-of-role tools on REST, MCP and portal (R14)
 *   AB-07 Payee, recipient, amount and currency keys in tool arguments are rejected (R14)
 *   AB-08 No stored money or authority record changed during the whole run
 *
 * Writes .agents/reports/agentic-boundary.json. Exit code 0 only if every check passes.
 */
import { randomUUID } from "node:crypto";
import {
  Harness,
  expect,
  provisionAgent,
  runVerifier,
  signup,
  type Account,
} from "./harness.js";

const AGENT = "agentic-boundary";

// Tables whose rows carry money, authority or decisions. Audit, run and rate-limit tables are
// excluded because refusals are expected to write to them.
const GUARDED_TABLES = [
  "mandates",
  "mandate_acceptances",
  "proposals",
  "proposal_decisions",
  "holds",
  "wallets",
  "wallet_reservations",
  "wallet_deposits",
  "wallet_charges",
  "wallet_refunds",
  "wallet_refund_items",
  "journal_transactions",
  "journal_lines",
  "economic_events",
  "accounts",
  "agreements",
  "agreement_payments",
  "obligations",
  "settlement_batches",
  "settlement_batch_items",
  "payouts",
  "provider_payout_accounts",
  "provider_paypal_profiles",
  "payment_transactions",
  "approvals",
  "budget_debits",
  "mission_funding",
  "remainder_decisions",
  "spending_budgets",
  "policy_versions",
  "missions",
  "quotes",
  "watchdog_alerts",
  "watchdog_thresholds",
];

const ROLES = [
  "buyer",
  "provider",
  "treasury",
  "watchdog",
  "budget",
  "copilot",
] as const;
type Role = (typeof ROLES)[number];

// Mirrors tool-definitions.ts; used only to pick tools OUTSIDE each role's set.
const TOOL_ROLES: Record<string, readonly string[]> = {
  payment_status: [
    "buyer",
    "provider",
    "treasury",
    "budget",
    "watchdog",
    "copilot",
  ],
  mandate_remaining: ["buyer", "budget"],
  wallet_summary: ["buyer", "budget"],
  propose_topup: ["budget"],
  propose_remainder_refund: ["budget"],
  propose_payout_batch: ["treasury"],
  propose_mandate_change: ["budget", "treasury"],
  propose_hold_release: ["watchdog"],
};

async function main(): Promise<number> {
  const h = await Harness.boot();
  const { getDb } = await import("../../src/db/connection.js");
  const { issueAccessToken } = await import("../../src/common/auth-crypto.js");
  const { FORBIDDEN_MCP_TOOLS } = await import("../../src/mcp/server.js");
  const { AgentToolGateway } =
    await import("../../src/modules/agent-tools/tool-gateway.js");
  const db = getDb();

  const tableExists = async (t: string): Promise<boolean> =>
    (
      await db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
        [t],
      )
    ).rows.length > 0;

  const snapshot = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const t of GUARDED_TABLES) {
      if (!(await tableExists(t))) continue;
      const r = await db.query(
        `SELECT count(*)::int AS n, COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x`,
      );
      out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
  };
  const diff = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).filter((k) => a[k] !== b[k]);

  const refusals = async (tenantId: string): Promise<number> =>
    Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1`,
          [tenantId],
        )
      ).rows[0].n,
    );

  try {
    const owner: Account = await signup(h, "ab-owner", "Org AB");
    const tenantId = owner.tenantId;

    // Agents of every role. buyer/provider through the API, the rest inserted directly.
    const tokens = {} as Record<Role, string>;
    const principals = {} as Record<Role, any>;
    const buyer = await provisionAgent(h, owner, "buyer", "ab-buyer");
    const provider = await provisionAgent(h, owner, "provider", "ab-provider");
    tokens.buyer = buyer.token;
    tokens.provider = provider.token;
    principals.buyer = { id: buyer.id };
    principals.provider = { id: provider.id };
    for (const role of ["treasury", "watchdog", "budget", "copilot"] as const) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO agents (id, tenant_id, role, name, status, credential_hash, owner_user_id)
         VALUES ($1, $2, $3, $4, 'active', 'unused', $5)`,
        [id, tenantId, role, `ab-${role}`, owner.userId],
      );
      tokens[role] = issueAccessToken(id, "agent");
      principals[role] = { id };
    }
    for (const role of ROLES) {
      const me = await h.http("GET", "/v1/auth/me", { token: tokens[role] });
      expect(me.status === 200, `${role} agent token rejected: ${me.status}`);
    }

    const id = randomUUID();
    const id2 = randomUUID();

    const before = await snapshot();

    /** One attempted forbidden REST call. Fails unless refused with 403 and (optionally) audited. */
    const rest = async (
      role: Role,
      method: string,
      url: string,
      body: unknown,
      audited: boolean,
      bad: string[],
    ) => {
      const a = await refusals(tenantId);
      const res = await h.http(method, url, {
        token: tokens[role],
        body,
        headers: { "idempotency-key": `k-${randomUUID()}` },
      });
      const rows = (await refusals(tenantId)) - a;
      if (res.status !== 403)
        bad.push(`${role} ${method} ${url} -> HTTP ${res.status}`);
      else if (audited && rows < 1)
        bad.push(`${role} ${method} ${url} -> 403 but no audit row`);
    };

    const sweep = async (
      routes: Array<[string, string, unknown?]>,
      audited: boolean,
      roles: readonly Role[] = ROLES,
    ) => {
      const bad: string[] = [];
      for (const role of roles)
        for (const [m, u, b] of routes) await rest(role, m, u, b, audited, bad);
      expect(bad.length === 0, `not refused: ${bad.join("; ")}`);
      return roles.length * routes.length;
    };

    await h.check(
      "AB-01",
      "Mandate operations are refused for every agent role (R1)",
      async () => {
        const n = await sweep(
          [
            [
              "POST",
              "/v1/mandates",
              { currency: "USD", per_transaction_cap: "10", total_cap: "50" },
            ],
            ["GET", "/v1/mandates"],
            ["GET", `/v1/mandates/${id}`],
            ["DELETE", `/v1/mandates/${id}`],
            ["POST", `/v1/mandates/${id}/lift-suspension`, { reason: "x" }],
          ],
          true,
        );
        return `${n} attempts -> 403 with an audit row each`;
      },
    );

    await h.check(
      "AB-02",
      "Autonomous quote selection is refused for non-Buyer agents (R3)",
      async () => {
        const n = await sweep(
          [
            [
              "POST",
              `/v1/missions/${id}/mandate-selection`,
              { mandate_id: id2 },
            ],
          ],
          true,
          ROLES.filter((r) => r !== "buyer"),
        );
        return `${n} attempts -> 403 with an audit row each`;
      },
    );

    await h.check(
      "AB-03",
      "Hold release, explanations, thresholds and flags are refused (R6)",
      async () => {
        const n = await sweep(
          [
            ["POST", `/v1/watchdog/holds/${id}/release`, { reason: "x" }],
            ["GET", "/v1/watchdog/holds"],
            ["GET", `/v1/watchdog/holds/${id}`],
            ["GET", "/v1/watchdog/alerts"],
            ["GET", `/v1/watchdog/alerts/${id}`],
            ["POST", `/v1/watchdog/alerts/${id}/explain`],
            ["GET", "/v1/admin/watchdog/thresholds"],
            ["PUT", "/v1/admin/watchdog/thresholds/velocity", { value: 1 }],
            ["PUT", "/v1/agentic/flags/mandates", { enabled: true }],
            ["POST", "/v1/admin/agentic/integrity-check"],
          ],
          false,
        );
        return `${n} attempts -> 403`;
      },
    );

    await h.check(
      "AB-04",
      "Proposal approve, reject and reads are refused (R9)",
      async () => {
        const n = await sweep(
          [
            ["POST", `/v1/proposals/${id}/approve`, { comment: "x" }],
            ["POST", `/v1/proposals/${id}/reject`, { reason: "x" }],
            ["GET", "/v1/proposals"],
            ["GET", `/v1/proposals/${id}`],
            ["GET", "/v1/proposals/pending-count"],
          ],
          true,
        );
        return `${n} attempts -> 403 with an audit row each`;
      },
    );

    await h.check(
      "AB-05",
      "Money, payout and recipient routes are refused (R14)",
      async () => {
        const n = await sweep(
          [
            ["POST", `/v1/settlement/batches/${id}/approve`],
            ["POST", `/v1/settlement/batches/${id}/paypal/create-order`],
            ["POST", `/v1/settlement/batches/${id}/paypal/capture`],
            [
              "PUT",
              `/v1/agents/${id}/payout-account`,
              { paypal_email: "attacker@evil.test" },
            ],
            ["POST", `/v1/agents/${id}/payout-account/verify`],
            [
              "POST",
              "/v1/wallet/deposits",
              { amount: "5.00", currency: "USD" },
            ],
            ["POST", "/v1/wallet/refunds", { amount: "1.00" }],
            ["POST", `/v1/wallet/missions/${id}/top-up`, { amount: "1.00" }],
          ],
          false,
        );
        return `${n} attempts -> 403`;
      },
    );

    // Tool names: money-moving names plus every real tool outside the role's set.
    const extraForbidden = [
      "deposit",
      "reserve_funds",
      "charge_wallet",
      "refund_wallet",
      "approve_proposal",
      "reject_proposal",
      "release_hold",
      "create_mandate",
      "revoke_mandate",
      "get_payout_recipient",
    ];

    await h.check(
      "AB-06",
      "Forbidden and out-of-role tools are refused on REST, MCP and portal (R14)",
      async () => {
        const gateway = new AgentToolGateway(db);
        const bad: string[] = [];
        let attempts = 0;
        for (const role of ROLES) {
          const names = [
            ...FORBIDDEN_MCP_TOOLS,
            ...extraForbidden,
            ...Object.keys(TOOL_ROLES).filter(
              (t) => !TOOL_ROLES[t].includes(role),
            ),
          ];
          for (const tool of names) {
            const args = {
              wallet_id: id,
              mandate_id: id,
              hold_id: id,
              batch_id: id,
            };
            // REST
            const a = await refusals(tenantId);
            const r = await h.http("POST", `/v1/agent-tools/${tool}`, {
              token: tokens[role],
              body: args,
            });
            attempts++;
            if (r.status !== 403)
              bad.push(`REST ${role} ${tool} -> ${r.status}`);
            // Known tools leave an audit row; unknown names are refused by the router.
            if (tool in TOOL_ROLES && (await refusals(tenantId)) - a < 1)
              bad.push(`REST ${role} ${tool} -> no audit row`);
            // MCP
            const m = await h.http("POST", "/mcp", {
              token: tokens[role],
              body: {
                jsonrpc: "2.0",
                id: attempts,
                method: "tools/call",
                params: { name: tool, arguments: args },
              },
            });
            attempts++;
            if (!m.body?.error || m.body?.result)
              bad.push(
                `MCP ${role} ${tool} -> ${JSON.stringify(m.body).slice(0, 120)}`,
              );
            else if (
              tool in TOOL_ROLES &&
              m.body.error.data?.code !== "FORBIDDEN_ACTION"
            )
              bad.push(
                `MCP ${role} ${tool} -> code ${m.body.error.data?.code}`,
              );
            // Portal
            try {
              await gateway.call({
                principal: {
                  type: "agent",
                  id: principals[role].id,
                  tenantId,
                  role,
                } as any,
                tool,
                args,
                via: "portal",
              });
              bad.push(`portal ${role} ${tool} -> succeeded`);
            } catch (e) {
              if ((e as any).code !== "FORBIDDEN_ACTION")
                bad.push(`portal ${role} ${tool} -> ${(e as any).code}`);
            }
            attempts++;
          }
        }
        // Humans may not use the tool gateway either.
        const human = await h.http("POST", "/v1/agent-tools/payment_status", {
          token: owner.token,
          body: {},
        });
        attempts++;
        if (human.status !== 403)
          bad.push(`human tool call -> ${human.status}`);
        // MCP tools/list must not expose a forbidden name.
        for (const role of ROLES) {
          const list = await h.http("POST", "/mcp", {
            token: tokens[role],
            body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          });
          const listed: string[] = (list.body?.result?.tools ?? []).map(
            (t: any) => t.name,
          );
          for (const f of [...FORBIDDEN_MCP_TOOLS, ...extraForbidden])
            if (listed.includes(f))
              bad.push(`MCP tools/list exposes ${f} to ${role}`);
        }
        expect(
          bad.length === 0,
          `not refused: ${bad.slice(0, 12).join("; ")} (${bad.length} total)`,
        );
        return `${attempts} attempts refused with FORBIDDEN_ACTION / 403`;
      },
    );

    await h.check(
      "AB-07",
      "Payee, recipient, amount and currency keys in tool arguments are rejected (R14)",
      async () => {
        const bad: string[] = [];
        const cases: Array<[Role, string, Record<string, unknown>]> = [
          [
            "budget",
            "propose_topup",
            { wallet_id: id, rationale: "low", recipient: "a@evil.test" },
          ],
          [
            "budget",
            "propose_topup",
            { wallet_id: id, rationale: "low", amount: "100" },
          ],
          [
            "budget",
            "propose_topup",
            { wallet_id: id, rationale: "low", currency: "EUR" },
          ],
          [
            "treasury",
            "propose_payout_batch",
            { obligation_ids: [id], rationale: "ok", payee: "a@evil.test" },
          ],
          [
            "treasury",
            "propose_payout_batch",
            { obligation_ids: [id], rationale: "ok", payout_recipient: "x" },
          ],
          ["buyer", "wallet_summary", { wallet_id: id, payee: "x" }],
          ["buyer", "mandate_remaining", { mandate_id: id, amount: "1" }],
        ];
        const gateway = new AgentToolGateway(db);
        for (const [role, tool, args] of cases) {
          const r = await h.http("POST", `/v1/agent-tools/${tool}`, {
            token: tokens[role],
            body: args,
          });
          if (r.status < 400 || r.status >= 500)
            bad.push(`REST ${role} ${tool} -> ${r.status}`);
          const m = await h.http("POST", "/mcp", {
            token: tokens[role],
            body: {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: tool, arguments: args },
            },
          });
          if (!m.body?.error || m.body?.result)
            bad.push(`MCP ${role} ${tool} accepted`);
          try {
            await gateway.call({
              principal: {
                type: "agent",
                id: principals[role].id,
                tenantId,
                role,
              } as any,
              tool,
              args,
              via: "portal",
            });
            bad.push(`portal ${role} ${tool} accepted`);
          } catch {
            /* expected */
          }
        }
        expect(bad.length === 0, `accepted: ${bad.join("; ")}`);
        return `${cases.length * 3} attempts rejected`;
      },
    );

    await h.check("AB-08", "No money or authority record changed", async () => {
      const after = await snapshot();
      const changed = diff(before, after);
      expect(changed.length === 0, `tables changed: ${changed.join(", ")}`);
      return `${Object.keys(after).length} guarded tables identical before and after`;
    });
  } finally {
    await h.close();
  }
  return h.report(
    AGENT,
    "AGENTIC_BOUNDARY_VERIFIED",
    "AGENTIC_BOUNDARY_BREACHED",
  );
}

void runVerifier(AGENT, main);

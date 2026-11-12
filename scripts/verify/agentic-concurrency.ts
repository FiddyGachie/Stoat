/**
 * Agentic concurrency verifier (agentic-commerce task 17.2; Requirements 17.7, 9.12).
 *   npx tsx scripts/verify/agentic-concurrency.ts
 *
 * Needs LIVE PostgreSQL. PGlite serializes transactions, so it cannot prove row-lock behaviour.
 * Without DATABASE_URL this prints a clear message and exits 0 (skipped, not passed).
 *
 * It creates its own fresh tenant (unique e-mail, no existing rows are touched) and checks:
 *   AC-01  20+ parallel autonomous acceptances against a Mandate with less than one price of
 *          remaining cap: accepted prices never exceed Total_Cap or Daily_Cap, the Mandate usage
 *          derived from the database matches, and every loser is refused.
 *   AC-02  Parallel approvals of one Proposal: exactly one wins, the others see the recorded
 *          state, and one approval row, one event and one execution job exist.
 *   AC-03  Parallel executor runs on the approved Proposal: the executor runs exactly once.
 *
 * PayPal is answered by WalletPayPalDouble. THE DOUBLE PROVES NOTHING ABOUT PAYPAL.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Decimal } from "decimal.js";

const AGENT = "agentic-concurrency";
const CONSOLE_ORIGIN = "https://console.verify.stoat.test";
const PARALLEL_ACCEPTANCES = 24;
const PARALLEL_APPROVALS = 12;
const PARALLEL_EXECUTIONS = 8;
const PRICE = "0.12";
const TOTAL_CAP = "0.20"; // 0.12 fits once; the remaining 0.08 is less than one price
const DAILY_CAP = "0.20";

interface Check {
  id: string;
  name: string;
  status: "PASS" | "FAIL";
  evidence: string;
}
const checks: Check[] = [];
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function check(id: string, name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    checks.push({ id, name, status: "PASS", evidence: (await fn()) ?? "ok" });
  } catch (err) {
    checks.push({ id, name, status: "FAIL", evidence: (err as Error).message });
  }
}

function report(): number {
  const failed = checks.filter((c) => c.status === "FAIL");
  for (const c of checks) {
    console.log(`${c.status}  ${c.id.padEnd(6)} ${c.name}${c.status === "PASS" ? `\n          ${c.evidence}` : `\n          -> ${c.evidence}`}`);
  }
  const signal = failed.length === 0 ? "AGENTIC_CONCURRENCY_VERIFIED" : "AGENTIC_CONCURRENCY_DEFECTS_FOUND";
  console.log(`\n${AGENT}: ${checks.length - failed.length} passed, ${failed.length} failed -> ${signal}`);
  const dir = join(process.cwd(), ".agents", "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${AGENT}.json`),
    JSON.stringify({ agent: AGENT, signal, generated_at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks }, null, 2),
  );
  return failed.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log(
      `${AGENT}: SKIPPED. DATABASE_URL is not set. This verifier proves row-lock behaviour and needs live PostgreSQL; ` +
        "PGlite serializes transactions and cannot show it. Set DATABASE_URL to a disposable database to run it.",
    );
    return 0;
  }

  process.env.JWT_SECRET ||= "verify-agentic-concurrency-jwt-secret-0123456789abcdef";
  process.env.LLM_MODE = "replay";
  process.env.REQUIRE_FUNDING = "false";
  process.env.CONSOLE_URL = CONSOLE_ORIGIN;
  delete process.env.RENDER;

  const { initDb, getDb, closeDb } = await import("../../src/db/connection.js");
  const { runMigrations } = await import("../../src/db/migrate.js");
  const { createApp } = await import("../../src/api/app.js");
  const { ProposalService } = await import("../../src/modules/proposals/proposal.service.js");
  const { executeProposal } = await import("../../src/modules/proposals/proposal.executor.js");
  const { WalletPayPalDouble } = await import("./paypal-wallet-double.js");

  initDb({ databaseUrl });
  const db = getDb();
  await runMigrations(db);
  const q = async <R = any>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as R[];

  const app = createApp({ gateway: new WalletPayPalDouble() });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const http = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, body };
  };
  const must = (res: { status: number; body: any }, status: number, ctx: string) =>
    expect(res.status === status, `${ctx}: expected HTTP ${status}, got ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);

  try {
    // ── fixtures: fresh tenant, wallet mode, funded wallet, provider service, Mandate ─────────
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const signup = await http("POST", "/v1/auth/signup", {
      body: { email: `agentic.concurrency.${stamp}@verify.stoat.test`, password: "correct-horse-battery-staple", organization_name: `Agentic Concurrency ${stamp}` },
    });
    must(signup, 201, "signup");
    const token: string = signup.body.access_token;
    const userId: string = signup.body.user.id;
    const tenantId: string = signup.body.user.tenant_id;

    await q(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb)
         || jsonb_build_object('funding_mode','wallet','feature_flags', jsonb_build_object('mandates', true, 'proposals', true))
       WHERE id = $1`,
      [tenantId],
    );

    const created = await http("POST", "/v1/agents", { token, body: { name: "Concurrency Reviewer", role: "provider" } });
    must(created, 201, "provision provider");
    const providerAgentId: string = created.body.agent.id;
    const login = await http("POST", "/v1/auth/agent/login", { body: { agent_id: providerAgentId, secret: created.body.secret } });
    must(login, 200, "provider login");
    const providerToken: string = login.body.access_token;

    const service = await http("POST", "/v1/services", {
      token: providerToken,
      body: { name: "Concurrency review", description: "Grounded code review.", category: "code_review", unit_price: PRICE, currency: "USD", unit: "review" },
    });
    must(service, 201, "publish service");

    const deposit = await http("POST", "/v1/wallet/deposits", {
      token,
      headers: { "idempotency-key": `dep-${stamp}`, origin: CONSOLE_ORIGIN },
      body: { amount: "20.00", currency: "USD" },
    });
    must(deposit, 201, "create deposit");
    const ret = await fetch(`${base}/v1/paypal/return?token=${encodeURIComponent(deposit.body.paypal_order_id)}`, { redirect: "manual" });
    expect(ret.status === 302, `deposit return redirect: HTTP ${ret.status}`);

    const mandate = await http("POST", "/v1/mandates", {
      token,
      headers: { "idempotency-key": `mandate-${stamp}` },
      body: {
        per_agreement_max: PRICE,
        daily_cap: DAILY_CAP,
        total_cap: TOTAL_CAP,
        allowed_categories: ["code_review"],
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    });
    must(mandate, 201, "create mandate");
    const mandateId: string = mandate.body.id;

    // One mission and one quote per attempt, so only the Mandate cap can refuse an acceptance.
    const quoteIds = await Promise.all(
      Array.from({ length: PARALLEL_ACCEPTANCES }, async (_, i) => {
        const m = await http("POST", "/v1/missions", {
          token,
          body: { title: `AC ${i}`, brief: "Review the auth code.", budget: "1.00", currency: "USD" },
        });
        must(m, 201, `create mission ${i}`);
        const quote = await http("POST", "/v1/quotes", { token, body: { mission_id: m.body.id, service_id: service.body.id, quantity: 1 } });
        must(quote, 201, `request quote ${i}`);
        return quote.body.id as string;
      }),
    );

    // ── AC-01 ────────────────────────────────────────────────────────────────────────────────
    await check("AC-01", `${PARALLEL_ACCEPTANCES} parallel autonomous acceptances never exceed Total_Cap or Daily_Cap`, async () => {
      const results = await Promise.all(
        quoteIds.map((quoteId, i) =>
          http("POST", `/v1/quotes/${quoteId}/accept`, {
            token,
            headers: { "idempotency-key": `ac01-${stamp}-${i}` },
            body: { mandate_id: mandateId },
          }),
        ),
      );
      const accepted = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => r.status !== 200);
      const unexpected = refused.filter((r) => r.status >= 500);
      expect(unexpected.length === 0, `${unexpected.length} acceptances failed with a server error: ${JSON.stringify(unexpected[0]?.body).slice(0, 200)}`);

      const acceptedPrice = accepted.reduce((sum, r) => sum.plus(String(r.body.price)), new Decimal(0));
      expect(acceptedPrice.lte(TOTAL_CAP), `accepted prices ${acceptedPrice} exceed Total_Cap ${TOTAL_CAP}`);
      expect(acceptedPrice.lte(DAILY_CAP), `accepted prices ${acceptedPrice} exceed Daily_Cap ${DAILY_CAP}`);

      const usage = await q<{ usage: string; n: number; acceptances: number }>(
        `SELECT COALESCE(SUM(r.amount),0)::text AS usage, count(*)::int AS n,
                (SELECT count(*)::int FROM mandate_acceptances WHERE mandate_id = $1) AS acceptances
           FROM wallet_reservations r WHERE r.mandate_id = $1 AND r.status IN ('active','charged')`,
        [mandateId],
      );
      expect(new Decimal(usage[0].usage).lte(TOTAL_CAP), `database Mandate usage ${usage[0].usage} exceeds Total_Cap ${TOTAL_CAP}`);
      expect(new Decimal(usage[0].usage).lte(DAILY_CAP), `database Mandate usage ${usage[0].usage} exceeds Daily_Cap ${DAILY_CAP}`);
      expect(usage[0].n === accepted.length && usage[0].acceptances === accepted.length, `${accepted.length} HTTP acceptances but ${usage[0].n} reservations and ${usage[0].acceptances} acceptance rows`);
      expect(accepted.length === 1, `expected exactly 1 acceptance (one price of cap), got ${accepted.length}`);
      const codes = [...new Set(refused.map((r) => `${r.status}:${r.body?.error?.code ?? r.body?.code ?? "?"}`))];
      return `${accepted.length} accepted, ${refused.length} refused (${codes.join(", ")}); usage ${usage[0].usage} of cap ${TOTAL_CAP}`;
    });

    // ── proposal fixture: a pending topup_suggestion (the executor takes no money action) ─────
    const wallet = (await q<{ id: string }>("SELECT id FROM wallets WHERE tenant_id = $1 AND owner_user_id = $2", [tenantId, userId]))[0];
    expect(wallet, "owner wallet not found");
    const run = (
      await q<{ id: string }>(
        `INSERT INTO agent_runs (tenant_id, agent_id, role, model, cost_usd, status)
         VALUES ($1, $2, 'budget', 'verify-model', 0, 'completed') RETURNING id`,
        [tenantId, providerAgentId],
      )
    )[0];
    const proposal = (
      await q<{ id: string }>(
        `INSERT INTO proposals
           (tenant_id, proposal_type, schema_version, subject_key, payload, rationale, source,
            proposer_agent_id, agent_run_id, validation_decision, decider_scope, owner_user_id, expires_at)
         VALUES ($1,'topup_suggestion','topup_suggestion_v1',$2,$3,'Concurrency check.','tool',$4,$5,
                 '{"valid":true,"reason_codes":[]}','owner',$6, now() + interval '1 hour')
         RETURNING id`,
        [tenantId, `verify:${stamp}`, JSON.stringify({ wallet_id: wallet.id }), providerAgentId, run.id, userId],
      )
    )[0];
    const decider = { id: userId, tenantId, type: "user" as const, role: "buyer", scopes: [] as string[], name: "Owner" };

    // ── AC-02 ────────────────────────────────────────────────────────────────────────────────
    await check("AC-02", `${PARALLEL_APPROVALS} parallel approvals of one Proposal: exactly one wins`, async () => {
      const service = new ProposalService(db);
      const outcomes = await Promise.allSettled(
        Array.from({ length: PARALLEL_APPROVALS }, () =>
          service.decide({ tenantId, proposalId: proposal.id, decider: decider as any, decision: "approve" }),
        ),
      );
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(rejected.length === 0, `${rejected.length} approvals threw: ${String((rejected[0] as PromiseRejectedResult)?.reason?.message)}`);
      const results = outcomes.map((o) => (o as PromiseFulfilledResult<any>).value);
      const winners = results.filter((r) => r.already_decided === false);
      expect(winners.length === 1, `${winners.length} approvals reported winning, expected 1`);
      expect(results.every((r) => r.status === "approved"), "a losing approval did not see the recorded approved state");
      const [row] = await q(
        `SELECT
           (SELECT count(*)::int FROM proposal_decisions WHERE proposal_id = $1 AND decision = 'approved') AS approvals,
           (SELECT count(*)::int FROM economic_events WHERE tenant_id = $2 AND aggregate_id = $1 AND event_type = 'PROPOSAL_APPROVED') AS events,
           (SELECT count(*)::int FROM jobs WHERE tenant_id = $2 AND type = 'proposal_execute' AND payload->>'proposal_id' = $1::text) AS jobs`,
        [proposal.id, tenantId],
      );
      expect(row.approvals === 1, `${row.approvals} approval rows, expected 1`);
      expect(row.events === 1, `${row.events} PROPOSAL_APPROVED events, expected 1`);
      expect(row.jobs === 1, `${row.jobs} proposal_execute jobs queued, expected 1`);
      return `1 winner of ${PARALLEL_APPROVALS}; 1 approval row, 1 event, 1 job`;
    });

    // ── AC-03 ────────────────────────────────────────────────────────────────────────────────
    await check("AC-03", `${PARALLEL_EXECUTIONS} parallel executor runs on one approved Proposal: executor runs once`, async () => {
      const outcomes = await Promise.all(
        Array.from({ length: PARALLEL_EXECUTIONS }, () => executeProposal(db, { tenantId, proposalId: proposal.id })),
      );
      const executed = outcomes.filter((o) => o.status === "executed");
      expect(executed.length === 1, `${executed.length} executor runs reported execution, expected 1 (${outcomes.map((o) => o.status).join(",")})`);
      const [row] = await q(
        `SELECT p.status, p.execution_attempts,
           (SELECT count(*)::int FROM proposal_decisions WHERE proposal_id = p.id AND decision = 'executed') AS executed_rows,
           (SELECT count(*)::int FROM economic_events WHERE tenant_id = p.tenant_id AND aggregate_id = p.id AND event_type = 'PROPOSAL_EXECUTED') AS events
         FROM proposals p WHERE p.id = $1`,
        [proposal.id],
      );
      expect(row.status === "executed", `Proposal ended ${row.status}`);
      expect(row.execution_attempts === 1, `execution_attempts is ${row.execution_attempts}, expected 1`);
      expect(row.executed_rows === 1 && row.events === 1, `${row.executed_rows} executed rows and ${row.events} PROPOSAL_EXECUTED events, expected 1 each`);
      return `executor ran once across ${PARALLEL_EXECUTIONS} concurrent calls`;
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb();
  }
  return report();
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`${AGENT}: could not complete: ${(err as Error).message}`);
    process.exit(1);
  },
);

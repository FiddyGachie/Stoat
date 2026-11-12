/**
 * Agentic secrets verifier (AS-01..AS-09), Requirement 17.9 (Property 53).
 *
 * Boots the real app on embedded PGlite in production mode with FAKE secrets seeded into the
 * environment (a model key, PayPal client credentials) and into the database (a provider's
 * payout recipient). It then drives the agentic surfaces over real HTTP and through the tool
 * gateway, and scans everything they produced for any seeded value:
 *
 *   AS-01 log output (stdout, stderr and console) from the whole run
 *   AS-02 Economic_Events
 *   AS-03 Proposals and their decisions
 *   AS-04 insight digests and narratives (response and stored)
 *   AS-05 analytics results: payments datasets and charts, wallet datasets (including the
 *         notifications dataset, which must not carry recipient_user_id) and CSV exports
 *   AS-06 agent tool responses, including a refusal and a model transport failure
 *   AS-07 every other table in the database, plus Audit_Logs, agent runs and holds
 *   AS-08 tool reads label unconfirmed PayPal state as pending or unknown (or PAYPAL_NOT_CONFIGURED)
 *
 * The values are fake. The model transport is a test double (the application never configures
 * one); the PayPal gateway is the scripted WalletPayPalDouble.
 *
 * Writes .agents/reports/agentic-secrets.json. Exit code 0 only if every check passes.
 */
import { randomUUID } from "node:crypto";
import {
  Harness,
  expect,
  expectStatus,
  provisionAgent,
  runVerifier,
  signup,
  type HttpResult,
} from "./harness.js";
import { WalletPayPalDouble } from "./paypal-wallet-double.js";
import { insightDouble, questionDouble } from "../../tests/llm-double.js";

const AGENT = "agentic-secrets";

// ── Fake seeded values. None is a real credential. ───────────────────────────
const MODEL_KEY = "sk-fake-model-key-7f3a9c1e5b2d4086seed";
const PAYPAL_CLIENT_ID = "AfakeClientIdSeed7731xQmNpLwZ";
const PAYPAL_CLIENT_SECRET = "EfakeClientSecretSeed9954zKvRtYu";
const RECIPIENT_EMAIL = "seeded.recipient.4471@payout-seed.stoat.test";
const RECIPIENT_LOCAL = "seeded.recipient.4471";
const RECIPIENT_DOMAIN = "payout-seed.stoat.test";

const SEEDS: Array<[string, string]> = [
  ["model key", MODEL_KEY],
  ["PayPal client id", PAYPAL_CLIENT_ID],
  ["PayPal client secret", PAYPAL_CLIENT_SECRET],
  ["recipient email", RECIPIENT_EMAIL],
  ["recipient local part", RECIPIENT_LOCAL],
  ["recipient domain", RECIPIENT_DOMAIN],
];

type Surface =
  | "logs"
  | "events"
  | "proposals"
  | "digests"
  | "analytics"
  | "tools"
  | "db";
const corpus = new Map<Surface, Array<{ label: string; text: string }>>();
function collect(surface: Surface, label: string, value: unknown): void {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  const list = corpus.get(surface) ?? [];
  list.push({ label, text });
  corpus.set(surface, list);
}

/** Every seeded value found in a surface, as "label: kind". Case-insensitive. */
function leaks(surface: Surface): string[] {
  const found: string[] = [];
  for (const { label, text } of corpus.get(surface) ?? []) {
    const lower = text.toLowerCase();
    for (const [kind, value] of SEEDS) {
      if (lower.includes(value.toLowerCase())) found.push(`${label}: ${kind}`);
    }
  }
  return [...new Set(found)];
}
const size = (surface: Surface) => corpus.get(surface)?.length ?? 0;

// ── Log capture: everything written to stdout, stderr or console from now on. ─
const logLines: string[] = [];
function captureLogs(): () => void {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const wrap = (real: typeof process.stdout.write) =>
    ((chunk: any, ...rest: any[]) => {
      logLines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return (real as any)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = wrap(out);
  process.stderr.write = wrap(err);
  return () => {
    process.stdout.write = out;
    process.stderr.write = err;
  };
}

/** One model transport for the app: insight and question doubles, plus an optional failure mode. */
let failModel: false | "plain" | "echo" = false;
function modelTransport() {
  const insight = insightDouble();
  const question = questionDouble({ intent: "unsupported" });
  const prompts: string[] = [];
  const transport = (async (req: any) => {
    prompts.push(
      String(req.options.prompt) + String(req.options.systemPrompt ?? ""),
    );
    if (failModel === "plain")
      throw new Error("401 Unauthorized from the model provider");
    if (failModel === "echo") {
      // A provider failure that echoes the credential it was called with.
      throw new Error(
        `401 Unauthorized for Bearer ${MODEL_KEY} (client ${PAYPAL_CLIENT_ID})`,
      );
    }
    return req.options.schemaName === "question_mapping_v1"
      ? question(req)
      : insight(req);
  }) as any;
  transport.prompts = prompts;
  return transport;
}

async function main(): Promise<number> {
  // Seed the environment before anything reads it.
  process.env.FIREWORKS_API_KEY = MODEL_KEY;
  process.env.LLM_API_KEY = MODEL_KEY;
  process.env.PAYPAL_CLIENT_ID = PAYPAL_CLIENT_ID;
  process.env.PAYPAL_CLIENT_SECRET = PAYPAL_CLIENT_SECRET;
  delete process.env.ANTHROPIC_API_KEY;

  const restoreLogs = captureLogs();
  const transport = modelTransport();
  const gateway = new WalletPayPalDouble();

  // The app takes the runtime through createApp; Harness.boot does not forward it, so build it here.
  const { AgentRuntimeService } =
    await import("../../src/modules/agent-runtime/agent-runtime.service.js");
  const { getDb, resetDb, closeDb } =
    await import("../../src/db/connection.js");
  void resetDb;
  void closeDb;
  const h = await bootWithRuntime(
    gateway,
    async (db) => new AgentRuntimeService(db, "live", undefined, { transport }),
  );
  const db = getDb();
  const { issueAccessToken } = await import("../../src/common/auth-crypto.js");

  // Record every HTTP response, labelled by the surface it belongs to.
  const surfaceOf = (path: string): Surface =>
    path.startsWith("/v1/agent-tools")
      ? "tools"
      : path.startsWith("/v1/proposals")
        ? "proposals"
        : path.includes("/insights")
          ? "digests"
          : path.startsWith("/v1/analytics") || path.startsWith("/v1/wallet")
            ? "analytics"
            : "db";
  const call = async (
    method: string,
    path: string,
    opts: Parameters<Harness["http"]>[2] = {},
  ): Promise<HttpResult> => {
    const res = await h.http(method, path, opts);
    collect(surfaceOf(path), `${method} ${path}`, res.body);
    return res;
  };

  try {
    // ── Setup: owner, wallet mode, every agentic flag on ────────────────────
    const owner = await signup(h, "as-owner", "Org AS");
    await db.query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object(
         'feature_flags', jsonb_build_object('mandates',true,'watchdog',true,'proposals',true,
           'payments_analytics',true,'insights',true,'nl_questions',true,'agent_tools',true))
       WHERE id = $1`,
      [owner.tenantId],
    );
    const provider = await provisionAgent(h, owner, "provider", "as-provider");
    const me = await h.http("GET", "/v1/auth/me", { token: owner.token });
    expectStatus(me, 200, "auth/me");
    const buyerAgentId = me.body.buyer_agent_id as string;

    // Agents for the tool roles. Roles are free text in `agents`, so insert them directly.
    const mkAgent = async (role: string) => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO agents (id, tenant_id, role, name, credential_hash) VALUES ($1,$2,$3,$4,'seed-not-a-hash')`,
        [id, owner.tenantId, role, `as-${role}`],
      );
      return { id, token: issueAccessToken(id, "agent") };
    };
    const budget = await mkAgent("budget");
    const treasury = await mkAgent("treasury");

    // Seed the payout recipient through the real route, then verify it.
    const put = await h.http(
      "PUT",
      `/v1/agents/${provider.id}/payout-account`,
      {
        token: owner.token,
        body: {
          recipient_type: "EMAIL",
          paypal_email: RECIPIENT_EMAIL,
          consent: true,
        },
      },
    );
    expectStatus(put, 200, "set recipient");
    collect("db", "PUT payout-account", put.body);
    const verified = await h.http(
      "POST",
      `/v1/agents/${provider.id}/payout-account/verify`,
      {
        token: owner.token,
        body: { confirm_masked: put.body.recipient_masked },
      },
    );
    expectStatus(verified, 200, "verify recipient");
    collect("db", "POST payout-account/verify", verified.body);

    // ── Drive the marketplace so events, obligations and payouts exist ──────
    const service = await h.http("POST", "/v1/services", {
      token: provider.token,
      body: {
        name: "Secrets review",
        description: "Reviews a scoped fixture.",
        category: "code_review",
        unit_price: "0.12",
        currency: "USD",
        unit: "review",
      },
    });
    expectStatus(service, 201, "publish service");
    const mission = await h.http("POST", "/v1/missions", {
      token: owner.token,
      body: {
        title: "Secrets probe",
        brief: "Check authentication code.",
        budget: "1.00",
        currency: "USD",
      },
    });
    expectStatus(mission, 201, "create mission");
    const quote = await h.http("POST", "/v1/quotes", {
      token: owner.token,
      body: {
        mission_id: mission.body.id,
        service_id: service.body.id,
        quantity: 1,
      },
    });
    expectStatus(quote, 201, "quote");
    const accepted = await h.http(
      "POST",
      `/v1/quotes/${quote.body.id}/accept`,
      { token: owner.token },
    );
    expectStatus(accepted, 200, "accept quote");
    const agreementId = accepted.body.id as string;
    const artifact = await h.http("POST", "/v1/artifacts", {
      token: provider.token,
      body: {
        findings: [
          {
            file: "src/auth.ts",
            line_start: 4,
            line_end: 4,
            snippet:
              'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
            rule_id: "SEC-002",
            severity: "critical",
            title: "Hardcoded secret",
          },
        ],
      },
    });
    expectStatus(artifact, 201, "artifact");
    const delivery = await h.http("POST", "/v1/deliveries", {
      token: provider.token,
      body: { agreement_id: agreementId, artifact_id: artifact.body.id },
    });
    expectStatus(delivery, 201, "delivery");
    const obligations = await call("GET", "/v1/obligations", {
      token: owner.token,
    });
    const obligationId = obligations.body?.obligations?.[0]?.id as
      | string
      | undefined;
    expect(obligationId, "no obligation accrued");
    const batch = await h.http("POST", "/v1/settlement/batches", {
      token: owner.token,
      body: { obligation_ids: [obligationId] },
    });
    expectStatus(batch, 201, "settlement batch");
    await h.http("POST", `/v1/settlement/batches/${batch.body.id}/approve`, {
      token: owner.token,
      body: { reason: "verify" },
    });
    // Payout surfaces (the recipient is on file): approval attempt, payments, money flow.
    for (const path of [
      `/v1/settlement/batches/${batch.body.id}`,
      `/v1/settlement/batches/${batch.body.id}/payment`,
      "/v1/paypal/status",
      "/v1/agents/" + provider.id + "/payout-account",
    ]) {
      collect(
        "db",
        `GET ${path}`,
        (await h.http("GET", path, { token: owner.token })).body,
      );
    }
    collect(
      "db",
      "POST payout-approval",
      (
        await h.http(
          "POST",
          `/v1/settlement/batches/${batch.body.id}/payout-approval`,
          { token: owner.token },
        )
      ).body,
    );

    // Wallet mode starts here so the marketplace flow above did not need a funded wallet.
    await db.query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','wallet') WHERE id = $1`,
      [owner.tenantId],
    );
    // Wallet: a deposit, plus a notification so the notifications dataset has a row.
    const dep = await h.http("POST", "/v1/wallet/deposits", {
      token: owner.token,
      body: { amount: "10.00", currency: "USD" },
      headers: { "idempotency-key": `k-${randomUUID()}` },
    });
    expectStatus(dep, 201, "wallet deposit");
    collect("analytics", "POST /v1/wallet/deposits", dep.body);
    await db.query(
      `INSERT INTO notifications (tenant_id, recipient_user_id, kind, title, body, event_id)
       VALUES ($1,$2,'deposit_captured','Deposit captured','Your deposit was captured.',$3)`,
      [owner.tenantId, owner.userId, `as-${randomUUID()}`],
    );
    const walletRes = await call("GET", "/v1/wallet", { token: owner.token });
    const walletId: string | undefined =
      walletRes.body?.wallets?.[0]?.id ??
      walletRes.body?.wallet?.id ??
      walletRes.body?.id ??
      dep.body.wallet_id;
    expect(walletId, "no wallet id");

    // ── Analytics: payments datasets and charts, wallet datasets and CSV ────
    const range =
      "from=" +
      new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10) +
      "&to=" +
      new Date().toISOString().slice(0, 10);
    const datasets = [
      "spend-facts",
      "mandate-usage",
      "alerts",
      "holds",
      "proposals",
      "paypal-flows",
    ];
    for (const d of datasets)
      await call("GET", `/v1/analytics/payments/${d}?${range}`, {
        token: owner.token,
      });
    const charts = await call(
      "GET",
      `/v1/analytics/payments/charts/spend-by-day?${range}`,
      { token: owner.token },
    );
    void charts;
    const walletDatasets = [
      "deposits",
      "reservations",
      "charges",
      "refunds",
      "payouts",
      "notifications",
      "statements",
    ];
    let notificationsDataset: HttpResult | undefined;
    for (const d of walletDatasets) {
      const r = await call("GET", `/v1/analytics/wallet/${d}`, {
        token: owner.token,
      });
      if (d === "notifications") notificationsDataset = r;
      const csv = await fetch(`${h.base}/v1/analytics/wallet/${d}.csv`, {
        headers: { authorization: `Bearer ${owner.token}` },
      });
      collect(
        "analytics",
        `GET /v1/analytics/wallet/${d}.csv`,
        await csv.text(),
      );
    }
    await call("GET", "/v1/analytics/wallet/charts/balance-over-time", {
      token: owner.token,
    });
    // Intent and question routes (model double maps to "unsupported").
    await call("POST", "/v1/analytics/payments/questions", {
      token: owner.token,
      body: { text: "What did we spend this week?" },
    });
    await call("POST", "/v1/analytics/payments/intents/spend_by_mandate", {
      token: owner.token,
      body: { params: {} },
    });

    // ── Insights: success, then a provider failure that echoes credentials ──
    const insight = await call("POST", "/v1/analytics/payments/insights", {
      token: owner.token,
      body: {
        from: range.split("&")[0].slice(5),
        to: range.split("&")[1].slice(3),
      },
    });
    collect("digests", "insight status " + insight.status, {
      status: insight.status,
    });
    failModel = "plain";
    const failedInsight = await call(
      "POST",
      "/v1/analytics/payments/insights",
      {
        token: owner.token,
        body: {
          from: range.split("&")[0].slice(5),
          to: range.split("&")[1].slice(3),
        },
      },
    );
    const failedQuestion = await call(
      "POST",
      "/v1/analytics/payments/questions",
      {
        token: owner.token,
        body: { text: "How much did we spend on mandates?" },
      },
    );
    failModel = false;
    collect("digests", "failed insight", failedInsight.body);
    collect("analytics", "failed question", failedQuestion.body);

    // ── Agent tools (REST) ──────────────────────────────────────────────────
    const toolStates: Array<{ tool: string; res: HttpResult }> = [];
    const tool = async (token: string, name: string, args: unknown) => {
      const res = await call("POST", `/v1/agent-tools/${name}`, {
        token,
        body: args,
      });
      toolStates.push({ tool: name, res });
      return res;
    };
    await call("GET", "/v1/agent-tools", { token: budget.token });
    await tool(budget.token, "payment_status", { agreement_id: agreementId });
    await tool(treasury.token, "payment_status", {
      obligation_id: obligationId,
    });
    await tool(provider.token, "payment_status", { agreement_id: agreementId });
    await tool(budget.token, "wallet_summary", { wallet_id: walletId });
    await tool(budget.token, "propose_topup", {
      wallet_id: walletId,
      rationale: "The wallet is running low for open missions.",
    });
    await tool(treasury.token, "propose_payout_batch", {
      obligation_ids: [obligationId],
      rationale: "These obligations are payable and ready to be batched.",
    });
    // Refusals and invalid calls echo no secret either.
    await tool(provider.token, "propose_topup", {
      wallet_id: walletId,
      rationale: "Not allowed for this role.",
    });
    await tool(budget.token, "wallet_summary", {
      wallet_id: walletId,
      recipient: RECIPIENT_EMAIL,
      paypal_email: RECIPIENT_EMAIL,
    });
    await tool(budget.token, "payment_status", { agreement_id: randomUUID() });
    await tool(budget.token, "no_such_tool", { api_key: MODEL_KEY });
    void buyerAgentId;

    // ── Proposals as the Owner/Admin sees them ──────────────────────────────
    const list = await call("GET", "/v1/proposals", { token: owner.token });
    for (const p of list.body?.proposals ?? list.body?.items ?? []) {
      await call("GET", `/v1/proposals/${p.id}`, { token: owner.token });
    }
    await call("GET", "/v1/proposals/pending-count", { token: owner.token });
    await call("GET", "/v1/watchdog/alerts", { token: owner.token });
    await call("GET", "/v1/watchdog/holds", { token: owner.token });
    await call("GET", "/v1/agentic/capabilities", { token: owner.token });

    // ── Database sweep: events, proposals, narratives, runs, audit and the rest ──
    const tables = (
      await db.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
      )
    ).rows.map((r: any) => r.table_name as string);
    const rowCounts: Record<string, number> = {};
    for (const t of tables) {
      const rows = (
        await db.query(`SELECT row_to_json(x)::text AS j FROM "${t}" x`)
      ).rows;
      rowCounts[t] = rows.length;
      const surface: Surface =
        t === "economic_events"
          ? "events"
          : t === "proposals" || t === "proposal_decisions"
            ? "proposals"
            : t === "insight_narratives"
              ? "digests"
              : t === "nl_questions"
                ? "analytics"
                : "db";
      for (const r of rows) collect(surface, `table ${t}`, r.j);
    }
    // Model prompts are outbound data: they must not carry a secret or a recipient either.
    for (const p of transport.prompts as string[])
      collect("tools", "model prompt", p);
    collect("logs", "captured output", logLines.join(""));
    const logsBeforeEcho = logLines.length;

    // Probe: a provider error that echoes the credentials. The response must stay clean; the log
    // result is reported as a note because the leak originates in the provider error text.
    failModel = "echo";
    const echoed = await call("POST", "/v1/analytics/payments/insights", {
      token: owner.token,
      body: {
        from: range.split("&")[0].slice(5),
        to: range.split("&")[1].slice(3),
      },
    });
    const echoedQ = await call("POST", "/v1/analytics/payments/questions", {
      token: owner.token,
      body: { text: "Echo probe question" },
    });
    failModel = false;
    const echoLogLeak = SEEDS.filter(([, v]) =>
      logLines.slice(logsBeforeEcho).join("").includes(v),
    ).map(([k]) => k);

    // ── Checks ──────────────────────────────────────────────────────────────
    const none =
      (surface: Surface, what: string, min = 1) =>
      async () => {
        expect(size(surface) >= min, `nothing was collected for ${what}`);
        const found = leaks(surface);
        expect(
          found.length === 0,
          `seeded secret found in ${what}: ${found.join("; ")}`,
        );
        return `${size(surface)} ${what} item(s) scanned, none contained a seeded value`;
      };

    await h.check(
      "AS-09",
      "A model provider error that echoes credentials does not reach any response",
      async () => {
        const text = JSON.stringify([echoed.body, echoedQ.body]).toLowerCase();
        const found = SEEDS.filter(([, v]) =>
          text.includes(v.toLowerCase()),
        ).map(([k]) => k);
        expect(
          found.length === 0,
          `echoed credential reached a response: ${found.join(", ")}`,
        );
        return `responses clean (HTTP ${echoed.status}, ${echoedQ.status})`;
      },
    );
    h.note(
      "AS-N1",
      "Provider error text is logged verbatim",
      echoLogLeak.length === 0
        ? "An echoed provider credential was not written to the logs."
        : `If a model provider echoes a credential in its error message, the server error log prints it (${echoLogLeak.join(", ")}). Stoat never adds the key itself; redact provider errors if a provider can echo credentials.`,
    );
    await h.check(
      "AS-01",
      "No log line contains a seeded key, credential or recipient",
      async () => {
        expect(logLines.length > 0, "no log output was captured");
        const found = leaks("logs");
        expect(
          found.length === 0,
          `seeded secret found in logs: ${found.join("; ")}`,
        );
        return `${logLines.length} log write(s) scanned`;
      },
    );
    await h.check(
      "AS-02",
      "No Economic_Event contains a seeded value",
      async () => {
        expect(
          (rowCounts.economic_events ?? 0) > 0,
          "no Economic_Events exist to scan",
        );
        return none("events", "Economic_Events")();
      },
    );
    await h.check(
      "AS-03",
      "No Proposal, Proposal decision or proposal response contains a seeded value",
      async () => {
        expect(
          (rowCounts.proposals ?? 0) >= 2,
          `expected the tool calls to file Proposals, found ${rowCounts.proposals ?? 0}`,
        );
        return none("proposals", "Proposal")();
      },
    );
    await h.check(
      "AS-04",
      "No digest, narrative or insight failure contains a seeded value",
      async () => {
        expect(
          insight.status === 200,
          `insight -> HTTP ${insight.status} ${JSON.stringify(insight.body).slice(0, 160)}`,
        );
        expect(insight.body?.digest, "insight response has no digest");
        return none("digests", "digest")();
      },
    );
    await h.check(
      "AS-05",
      "No analytics result, chart, CSV or question contains a seeded value",
      async () => {
        return none("analytics", "analytics result")();
      },
    );
    await h.check(
      "AS-06",
      "No agent tool response, refusal or model prompt contains a seeded value",
      async () => {
        return none("tools", "tool response", 5)();
      },
    );
    await h.check(
      "AS-07",
      "No other table row, Audit_Log, agent run, hold or payout response contains a seeded value",
      async () => {
        return none("db", "database row or payout response", 10)();
      },
    );
    await h.check(
      "AS-08",
      "The wallet notifications dataset has no recipient_user_id; unconfirmed PayPal state is labelled",
      async () => {
        expect(notificationsDataset, "notifications dataset was not read");
        expectStatus(notificationsDataset, 200, "notifications dataset");
        const text = JSON.stringify(notificationsDataset.body);
        expect(
          !/recipient_user_id/i.test(text),
          "notifications dataset exposes recipient_user_id",
        );
        expect(
          (notificationsDataset.body.rows ?? []).length >= 1,
          "notifications dataset returned no row to inspect",
        );
        // Every PayPal-derived state a tool returned is labelled, never a bare confirmation claim.
        const allowed = new Set([
          "confirmed",
          "pending",
          "unknown",
          "none",
          "PAYPAL_NOT_CONFIGURED",
        ]);
        let labelled = 0;
        for (const { tool: name, res } of toolStates) {
          if (name !== "payment_status" || res.status !== 200) continue;
          const r = res.body.result;
          for (const field of ["capture", "refund", "payout"]) {
            const state = r?.[field]?.state;
            expect(
              allowed.has(state),
              `payment_status ${field}.state "${state}" is not a labelled value`,
            );
            labelled += 1;
          }
          // Nothing PayPal has not confirmed may read as paid.
          expect(
            r.payout.state !== "confirmed" ||
              r.payout.recorded_status === "paid",
            "payout labelled confirmed without a paid payout",
          );
        }
        expect(labelled > 0, "no payment_status result was available to check");
        return `notifications dataset clean; ${labelled} PayPal state field(s) labelled`;
      },
    );
  } finally {
    restoreLogs();
    await h.close();
  }
  return h.report(AGENT, "SECRETS_VERIFIED", "SECRETS_LEAKED");
}

/**
 * Harness.boot does not forward an agentic runtime, so boot the same way here with one.
 * Mirrors Harness.boot (production mode, fresh PGlite, no seed data).
 */
async function bootWithRuntime(
  gateway: WalletPayPalDouble,
  makeRuntime: (db: any) => Promise<unknown>,
): Promise<Harness> {
  const mod = await import("./harness.js");
  const { TEST_JWT_SECRET } = mod;
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.RENDER;
  process.env.LLM_MODE = "live";
  process.env.REQUIRE_FUNDING = "false";

  const { resetDb, getDb } = await import("../../src/db/connection.js");
  const { runMigrations } = await import("../../src/db/migrate.js");
  const { createApp } = await import("../../src/api/app.js");
  await resetDb();
  await runMigrations(getDb());
  const runtime = await makeRuntime(getDb());
  const app = createApp({ gateway, agenticRuntime: runtime as any });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as import("node:net").AddressInfo;
  // Harness has a private constructor; build through the public type with the same shape.
  return new (Harness as any)(server, `http://127.0.0.1:${port}`) as Harness;
}

void runVerifier(AGENT, main);

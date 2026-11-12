/**
 * Agentic-commerce ledger and wallet invariants verifier (spec agentic-commerce, task 17.5, R17.11).
 *
 * Runs seeded random sequences of Mandate, Hold, Proposal, acceptance, release, charge and deposit
 * operations against the real services on embedded PGlite. After EVERY step it checks that
 *   1. the Ledger is balanced per currency (total debits = total credits), and
 *   2. every Wallet's Available_Balance is at least 0.
 * Operations that the platform refuses (guards, holds, insufficient funds) are expected and fine;
 * only an invariant violation or an unexpected script error fails the run.
 *
 * Run:  npx tsx scripts/verify/agentic-invariants.ts
 * Optional: INVARIANT_SEED=123 INVARIANT_STEPS=150 INVARIANT_RUNS=2
 * Report: .agents/reports/agentic-invariants.json
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Decimal } from "decimal.js";

const AGENT = "agentic-invariants";
const STEPS = Number(process.env.INVARIANT_STEPS ?? 120);
const RUNS = Number(process.env.INVARIANT_RUNS ?? 2);
const BASE_SEED = Number(process.env.INVARIANT_SEED ?? 20260601);

/** Small deterministic PRNG so a failing sequence can be replayed from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Violation {
  seed: number;
  step: number;
  op: string;
  detail: string;
}

async function main(): Promise<number> {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??=
    "verify-agentic-invariants-secret-0123456789abcdef";
  delete process.env.DATABASE_URL;
  delete process.env.RENDER;

  const { closeDb, getDb, resetDb, transaction } =
    await import("../../src/db/connection.js");
  const { runMigrations } = await import("../../src/db/migrate.js");
  const { seedDatabase, SEED_IDS } = await import("../../src/db/seed.js");
  const { createApp } = await import("../../src/api/app.js");
  const { MandateService } =
    await import("../../src/modules/mandates/mandate.service.js");
  const { AgreementsService } =
    await import("../../src/modules/agreements/agreements.service.js");
  const { HoldService } =
    await import("../../src/modules/watchdog/hold.service.js");
  const { ProposalService } =
    await import("../../src/modules/proposals/proposal.service.js");
  const { executeProposal } =
    await import("../../src/modules/proposals/proposal.executor.js");
  const { releaseReservation } =
    await import("../../src/modules/wallet/reservation.service.js");
  const { chargeInTx } =
    await import("../../src/modules/wallet/charge.service.js");
  const { getBalances } =
    await import("../../src/modules/wallet/wallet.service.js");
  const { trialBalance } =
    await import("../../src/modules/wallet/wallet-reads.service.js");
  const { dispatch } = await import("../../tests/test-utils.js");
  const H = await import("../../tests/agentic-helpers.js");

  const violations: Violation[] = [];
  const opCounts: Record<string, { tried: number; ok: number }> = {};
  let totalSteps = 0;

  await resetDb();
  const db = getDb();
  await runMigrations(db);
  await seedDatabase(db);
  const T = SEED_IDS.tenantId;
  const app = createApp();

  try {
    for (let run = 0; run < RUNS; run++) {
      const seed = BASE_SEED + run;
      const rand = mulberry32(seed);
      const pick = <X>(xs: readonly X[]): X =>
        xs[Math.floor(rand() * xs.length)];

      // --- fixtures: two owners with wallets, buyer agents, a watchdog and a budget agent ---
      await db.exec(H.TRUNCATE_ALL);
      await db.exec("TRUNCATE TABLE holds, jobs, agent_runs CASCADE");
      await H.setFundingMode(db, T, "wallet");
      await H.setFlags(db, T, {
        mandates: true,
        watchdog: true,
        proposals: true,
        insights: true,
      });

      const operator = await H.createOwner(db, T, "operator");
      const operatorP = {
        id: operator.id,
        tenantId: T,
        type: "user" as const,
        role: "operator",
        scopes: [],
        name: "Op",
      };

      const owners = [] as Array<{
        id: string;
        wallet: { id: string };
        buyer: { id: string; headers: Record<string, string> };
        principal: any;
        mandates: string[];
      }>;
      for (let i = 0; i < 2; i++) {
        const o = await H.createOwner(db, T, "buyer");
        const wallet = await H.createWallet(db, {
          ownerUserId: o.id,
          funded: pick(["0.50", "1.00", "3.00"]),
        });
        const buyer = await H.createAgentPrincipal(db, {
          ownerUserId: o.id,
          role: "buyer",
        });
        owners.push({
          id: o.id,
          wallet,
          buyer,
          principal: {
            id: o.id,
            tenantId: T,
            type: "user",
            role: "buyer",
            scopes: [],
            name: "Owner",
          },
          mandates: [],
        });
      }
      const budgetAgent = await H.createAgentPrincipal(db, {
        ownerUserId: owners[0].id,
        role: "budget",
      });
      const watchdog = await H.createAgentPrincipal(db, {
        ownerUserId: operator.id,
        role: "watchdog",
      });
      const mkRun = async (agentId: string, role: string) =>
        (
          await db.query<{ id: string }>(
            `INSERT INTO agent_runs (tenant_id, agent_id, role, model, status)
             VALUES ($1, $2, $3, 'test-model', 'completed') RETURNING id`,
            [T, agentId, role],
          )
        ).rows[0].id;
      const budgetRun = await mkRun(budgetAgent.id, "budget");
      const watchdogRun = await mkRun(watchdog.id, "watchdog");

      const agreements: Array<{
        id: string;
        ownerIdx: number;
        reservationId?: string;
      }> = [];
      const holds: string[] = [];
      const proposals: string[] = [];

      const mandates = new MandateService(db);
      const holdSvc = new HoldService(db);
      const proposalSvc = new ProposalService(db);
      const agreementsSvc = new AgreementsService(db);

      const budgetPrincipal = {
        id: budgetAgent.id,
        tenantId: T,
        type: "agent" as const,
        role: "budget",
        scopes: [],
        name: "Budget",
      };

      // --- operations: each returns true when it changed something, throws on refusal ---
      const ops: Record<string, () => Promise<boolean>> = {
        deposit: async () => {
          const o = pick(owners);
          const amount = pick(["0.10", "0.25", "1.00", "2.50"]);
          const { postJournal } =
            await import("../../src/modules/wallet/wallet-ledger.js");
          const eventId = randomUUID();
          await db.query(
            `INSERT INTO economic_events (id, tenant_id, aggregate_type, aggregate_id, sequence, event_type, actor_type, actor_id, correlation_id, payload_hash)
             VALUES ($1,$2,'wallet',$3,1,'test','system',$4,$5,'h')`,
            [eventId, T, randomUUID(), randomUUID(), randomUUID()],
          );
          await transaction((tx) =>
            postJournal(tx, {
              tenantId: T,
              eventId,
              reference: `wallet:inv:${eventId}`,
              currency: "USD",
              lines: [
                { accountCode: "1101", side: "debit", amount },
                {
                  accountCode: "2103",
                  side: "credit",
                  amount,
                  walletId: o.wallet.id,
                },
              ],
            }),
          );
          return true;
        },

        mandateCreate: async () => {
          const o = pick(owners);
          const m = await H.createMandate(db, {
            ownerUserId: o.id,
            walletId: o.wallet.id,
            allowed_categories: ["code_review"],
            per_agreement_max: pick(["0.12", "0.15", "1.00"]),
            daily_cap: "1.00",
            total_cap: pick(["1.00", "2.00", "5.00"]),
          });
          o.mandates.push(m.id);
          return true;
        },

        mandateRevoke: async () => {
          const o = pick(owners);
          if (!o.mandates.length) return false;
          await mandates.revoke({
            tenantId: T,
            actor: o.principal,
            mandateId: pick(o.mandates),
          });
          return true;
        },

        mandateSuspendLift: async () => {
          const o = pick(owners);
          if (!o.mandates.length) return false;
          const id = pick(o.mandates);
          await mandates.suspendForWatchdog({
            tenantId: T,
            mandateId: id,
          } as any);
          return true;
        },

        acceptHuman: async () => {
          const idx = Math.floor(rand() * owners.length);
          const o = owners[idx];
          const mission = await H.createMission(app, {
            budget: "5.000000",
            headers: o.buyer.headers,
          });
          const quote = await H.createQuote(app, mission, {
            serviceId: pick([SEED_IDS.aiServiceId, SEED_IDS.staticServiceId]),
            headers: o.buyer.headers,
          });
          const res = await dispatch(app, {
            method: "POST",
            url: `/quotes/${quote}/accept`,
            headers: o.buyer.headers,
          });
          if (res.status >= 300 || !res.body?.id) return false;
          agreements.push({ id: res.body.id, ownerIdx: idx });
          return true;
        },

        acceptMandate: async () => {
          const idx = Math.floor(rand() * owners.length);
          const o = owners[idx];
          if (!o.mandates.length) return false;
          const mission = await H.createMission(app, {
            budget: "5.000000",
            headers: o.buyer.headers,
          });
          const quote = await H.createQuote(app, mission, {
            serviceId: pick([SEED_IDS.aiServiceId, SEED_IDS.staticServiceId]),
            headers: o.buyer.headers,
          });
          const agreement = await agreementsSvc.acceptQuote({
            tenantId: T,
            buyerId: o.buyer.id,
            quoteId: quote,
            mandateId: pick(o.mandates),
            idempotencyKey: randomUUID(),
            actorType: "agent",
          });
          if (agreement?.id)
            agreements.push({ id: agreement.id, ownerIdx: idx });
          return true;
        },

        release: async () => {
          if (!agreements.length) return false;
          await releaseReservation({
            tenantId: T,
            agreementId: pick(agreements).id,
            reason: "invariant_check",
          });
          return true;
        },

        charge: async () => {
          if (!agreements.length) return false;
          const a = pick(agreements);
          const ag = (
            await db.query<any>("SELECT * FROM agreements WHERE id = $1", [
              a.id,
            ])
          ).rows[0];
          if (!ag) return false;
          const obligation = await db.query<{ id: string }>(
            `INSERT INTO obligations (tenant_id, agreement_id, mission_id, buyer_id, provider_id, amount, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (tenant_id, agreement_id) DO UPDATE SET updated_at = now() RETURNING id`,
            [
              T,
              ag.id,
              ag.mission_id,
              ag.buyer_id,
              ag.provider_id,
              ag.price,
              ag.currency,
            ],
          );
          await transaction((tx) =>
            chargeInTx(tx, {
              tenantId: T,
              obligationId: obligation.rows[0].id,
            }),
          );
          return true;
        },

        holdPlace: async () => {
          const res = await db.query<{ id: string }>(
            "SELECT id FROM wallet_reservations WHERE tenant_id = $1 AND status = 'active'",
            [T],
          );
          if (!res.rows.length) return false;
          const hold = await holdSvc.placeHold({
            tenantId: T,
            subjectType: "reservation",
            subjectId: pick(res.rows).id,
            reasonCode: "invariant_check",
            placer:
              rand() < 0.5
                ? { type: "system" }
                : { type: "agent", agentId: watchdog.id, runId: watchdogRun },
          });
          holds.push(hold.id);
          return true;
        },

        holdRelease: async () => {
          if (!holds.length) return false;
          await holdSvc.releaseHold({
            tenantId: T,
            holdId: pick(holds),
            releaser: operatorP as any,
            reason: "invariant_check",
          });
          return true;
        },

        holdReleaseProposal: async () => {
          if (!holds.length) return false;
          const r = await holdSvc.requestRelease({
            tenantId: T,
            holdId: pick(holds),
            agentId: watchdog.id,
            runId: watchdogRun,
            rationale: "The anomaly was reviewed and looks resolved",
          });
          proposals.push(r.proposalId);
          return true;
        },

        proposalSubmit: async () => {
          const o = owners[0];
          const kind = pick(["topup", "mandate_change"] as const);
          const submitted =
            kind === "topup" || !o.mandates.length
              ? await proposalSvc.submit({
                  tenantId: T,
                  submitter: budgetPrincipal as any,
                  type: "topup_suggestion",
                  payload: { wallet_id: o.wallet.id },
                  rationale: "The balance is low for upcoming work",
                  agentRunId: budgetRun,
                  provenance: { source: "tool" },
                })
              : await proposalSvc.submit({
                  tenantId: T,
                  submitter: budgetPrincipal as any,
                  type: "mandate_change",
                  payload: {
                    mandate_id: pick(o.mandates),
                    action: pick(["revoke", "suspend"] as const),
                  },
                  rationale: "The spending pace looks unusual",
                  agentRunId: budgetRun,
                  provenance: { source: "tool" },
                });
          proposals.push(submitted.proposal.id);
          return true;
        },

        proposalDecide: async () => {
          if (!proposals.length) return false;
          const id = pick(proposals);
          const row = (
            await db.query<any>(
              "SELECT decider_scope FROM proposals WHERE id = $1",
              [id],
            )
          ).rows[0];
          const decider =
            row?.decider_scope === "admin" ? operatorP : owners[0].principal;
          const decision = rand() < 0.7 ? "approve" : "reject";
          await proposalSvc.decide({
            tenantId: T,
            proposalId: id,
            decider: decider as any,
            decision,
            comment: decision === "reject" ? "Not needed" : undefined,
          });
          return true;
        },

        proposalExecute: async () => {
          const approved = await db.query<{ id: string }>(
            "SELECT id FROM proposals WHERE tenant_id = $1 AND status = 'approved'",
            [T],
          );
          if (!approved.rows.length) return false;
          await executeProposal(db, {
            tenantId: T,
            proposalId: pick(approved.rows).id,
          });
          return true;
        },
      };
      const names = Object.keys(ops);

      const check = async (step: number, op: string): Promise<void> => {
        const tb = await trialBalance(db, T);
        for (const row of tb) {
          if (
            !new Decimal(row.total_debits).eq(row.total_credits) ||
            !new Decimal(row.difference).isZero()
          ) {
            violations.push({
              seed,
              step,
              op,
              detail: `ledger unbalanced in ${row.currency}: debits ${row.total_debits} credits ${row.total_credits}`,
            });
          }
        }
        const wallets = await db.query<{ id: string }>(
          "SELECT id FROM wallets WHERE tenant_id = $1",
          [T],
        );
        for (const w of wallets.rows) {
          const b = await getBalances(db, w.id);
          if (new Decimal(b.available).lt(0)) {
            violations.push({
              seed,
              step,
              op,
              detail: `wallet ${w.id} available ${b.available} < 0`,
            });
          }
        }
      };

      await check(0, "initial");
      for (let step = 1; step <= STEPS; step++) {
        const op = pick(names);
        const stat = (opCounts[op] ??= { tried: 0, ok: 0 });
        stat.tried += 1;
        try {
          if (await ops[op]()) stat.ok += 1;
        } catch (err) {
          /* a refused operation is expected; the invariants below must still hold */
          if (process.env.INVARIANT_DEBUG && !(stat as any).err) {
            (stat as any).err = (err as Error).message;
            console.log(`[debug] ${op}: ${(err as Error).message}`);
          }
        }
        totalSteps += 1;
        await check(step, op);
        if (violations.length) break;
      }
      if (violations.length) break;
    }
  } finally {
    await closeDb();
  }

  const failed = violations.length > 0;
  const exercised = Object.entries(opCounts)
    .map(([k, v]) => `${k}=${v.ok}/${v.tried}`)
    .join(" ");
  const evidence = failed
    ? violations
        .slice(0, 5)
        .map((v) => `seed ${v.seed} step ${v.step} after ${v.op}: ${v.detail}`)
        .join("; ")
    : `${totalSteps} steps over ${RUNS} sequences (seed ${BASE_SEED}); ledger balanced per currency and every Available_Balance >= 0 after each step. Operations (succeeded/tried): ${exercised}`;
  const checks = [
    {
      id: "AI-01",
      name: "Ledger balanced and Available_Balance >= 0 after every step",
      status: failed ? "FAIL" : "PASS",
      evidence,
    },
  ];
  console.log(
    `${checks[0].status}  AI-01  ${checks[0].name}\n          -> ${evidence}`,
  );
  const signal = failed
    ? "AGENTIC_INVARIANTS_BLOCKED"
    : "AGENTIC_INVARIANTS_VERIFIED";
  console.log(
    `\n${AGENT}: ${failed ? 0 : 1} passed, ${failed ? 1 : 0} failed -> ${signal}`,
  );
  const dir = join(process.cwd(), ".agents", "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${AGENT}.json`),
    JSON.stringify(
      {
        agent: AGENT,
        signal,
        generated_at: new Date().toISOString(),
        passed: failed ? 0 : 1,
        failed: failed ? 1 : 0,
        manual: 0,
        checks,
      },
      null,
      2,
    ),
  );
  return failed ? 1 : 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(
    `${AGENT}: could not complete: ${(err as Error).stack ?? (err as Error).message}`,
  );
  process.exit(1);
}

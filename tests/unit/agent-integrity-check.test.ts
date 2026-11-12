import { describe, expect, it } from "vitest";
import {
  handleIntegrityCheckJob,
  queueIntegrityChecks,
  runIntegrityCheck,
} from "../../src/modules/agent-tools/integrity-check.js";
import { AGENTIC_ROUTE_PATHS } from "../../src/modules/agentic/agentic.routes.js";

const T = "22222222-2222-4222-8222-222222222222";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Minimal SQL-dispatching fake: returns seeded rows per query, records notifications. */
function fakeDb(seed: {
  events?: unknown[];
  audits?: unknown[];
  deposits?: unknown[];
  runs?: unknown[];
}) {
  const sent: unknown[][] = [];
  const queries: string[] = [];
  const db: any = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes("FROM economic_events")) return { rows: seed.events ?? [] };
      if (sql.includes("FROM audit_logs")) return { rows: seed.audits ?? [] };
      if (sql.includes("FROM wallet_deposits")) return { rows: seed.deposits ?? [] };
      if (sql.includes("FROM wallet_refunds") || sql.includes("FROM payouts"))
        return { rows: [] };
      if (sql.includes("FROM agent_runs")) return { rows: seed.runs ?? [] };
      if (sql.includes("INSERT INTO notifications")) {
        sent.push(params);
        return { rows: [{ id: ID(900), recipient_user_id: ID(901) }] };
      }
      return { rows: [] };
    },
  };
  return { db, sent, queries };
}

describe("agent integrity check", () => {
  it("is clean with nothing seeded and creates no notification", async () => {
    const { db, sent } = fakeDb({});
    const r = await runIntegrityCheck(db, T);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("reports each violation kind and notifies Admins naming the record", async () => {
    const { db, sent } = fakeDb({
      events: [{ id: ID(1), event_type: "PAYOUT_SENT" }],
      audits: [{ id: ID(2), action: "payout.send" }],
      deposits: [{ id: ID(3) }],
      runs: [{ id: ID(4), tool_set: ["wire_money"] }],
    });
    const r = await runIntegrityCheck(db, T);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind).sort()).toEqual([
      "agent_in_human_column",
      "agent_money_audit",
      "agent_money_event",
      "tool_run_out_of_set",
    ]);
    expect(sent).toHaveLength(4);
    for (const [i, v] of r.violations.entries()) {
      // params: tenant, kind, title, body, ..., eventId at index 6
      expect(sent[i][1]).toBe("agent_integrity_violation");
      expect(String(sent[i][3])).toContain(v.record_id);
    }
    expect(r.notifications_created).toBe(4);
  });

  it("job handler requires a tenant and summarizes the result", async () => {
    const { db } = fakeDb({});
    await expect(handleIntegrityCheckJob(db, {})).rejects.toThrow();
    expect(await handleIntegrityCheckJob(db, { tenant_id: T })).toMatch(/clean/);
  });

  it("sweep step only queues tenants with no check in the last 24 hours", async () => {
    const { db, queries } = fakeDb({});
    await queueIntegrityChecks(db);
    expect(queries[0]).toContain("agent_integrity_check");
    expect(queries[0]).toContain("24 hours");
  });

  it("registers the on-demand route path", () => {
    expect(AGENTIC_ROUTE_PATHS).toContain("/v1/admin/agentic/integrity-check");
  });
});

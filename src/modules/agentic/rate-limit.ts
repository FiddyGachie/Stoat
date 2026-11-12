import { RateLimitedError } from "./commerce-errors.js";
import type { DbClient } from "../../db/connection.js";

export interface SlidingWindowLimiter {
  allow(attemptAt?: number): boolean;
  remaining(attemptAt?: number): number;
}

export function createLimiter(input: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): SlidingWindowLimiter {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.windowMs <= 0) {
    throw new RangeError("A rate limiter requires a positive integer limit and window.");
  }
  const now = input.now ?? Date.now;
  const attempts: number[] = [];
  const trim = (at: number) => {
    while (attempts.length && attempts[0] <= at - input.windowMs) attempts.shift();
  };
  return {
    allow(attemptAt) {
      const at = attemptAt ?? now();
      trim(at);
      if (attempts.length >= input.limit) return false;
      attempts.push(at);
      return true;
    },
    remaining(attemptAt) {
      trim(attemptAt ?? now());
      return Math.max(0, input.limit - attempts.length);
    },
  };
}

export async function assertDatabaseRateLimit(input: {
  db: DbClient;
  tenantId: string;
  actorId: string;
  scope: "hold" | "proposal" | "nl_question" | "agent_tool";
  limit: number;
  windowMs: number;
}): Promise<void> {
  const sqlByScope = {
    hold: `SELECT count(*)::int AS n FROM holds WHERE tenant_id = $1 AND placed_by = $2
           AND placed_at >= now() - ($3::bigint * interval '1 millisecond')`,
    proposal: `SELECT count(*)::int AS n FROM proposals WHERE tenant_id = $1 AND proposer_agent_id = $2
               AND created_at >= now() - ($3::bigint * interval '1 millisecond')`,
    nl_question: `SELECT count(*)::int AS n FROM nl_questions WHERE tenant_id = $1 AND user_id = $2
                  AND created_at >= now() - ($3::bigint * interval '1 millisecond')`,
    agent_tool: `SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND actor_id = $2
                 AND action LIKE 'agent_tool.%'
                 AND created_at >= now() - ($3::bigint * interval '1 millisecond')`,
  } as const;
  const result = await input.db.query<{ n: number }>(sqlByScope[input.scope], [
    input.tenantId,
    input.actorId,
    input.windowMs,
  ]);
  if ((result.rows[0]?.n ?? 0) >= input.limit) throw new RateLimitedError(input.scope);
}

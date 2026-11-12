function positiveNumber(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}.`);
  }
  return value;
}

export const mandateMaxLifetimeDays = () => positiveNumber("MANDATE_MAX_LIFETIME_DAYS", 30);
export const watchdogIntervalMs = () => positiveNumber("WATCHDOG_INTERVAL_MS", 300_000);
export const holdRateLimit = () => positiveNumber("HOLD_RATE_LIMIT", 20);
export const proposalTtlHours = () => positiveNumber("PROPOSAL_TTL_HOURS", 24);
export const proposalRateLimit = () => positiveNumber("PROPOSAL_RATE_LIMIT", 30);
export const proposalMaxBytes = () => positiveNumber("PROPOSAL_MAX_BYTES", 65_536);
export const analyticsTimeoutMs = () => positiveNumber("ANALYTICS_TIMEOUT_MS", 10_000);
export const intentRowLimit = () => positiveNumber("INTENT_ROW_LIMIT", 1_000);
export const nlQuestionRateLimit = () => positiveNumber("NL_QUESTION_RATE_LIMIT", 20);
export const agentToolRateLimit = () => positiveNumber("AGENT_TOOL_RATE_LIMIT", 120);
export const agenticDailyModelBudgetUsd = () =>
  positiveNumber("AGENTIC_DAILY_MODEL_BUDGET_USD", 2);
export const heldAccrualMaxDays = () => positiveNumber("HELD_ACCRUAL_MAX_DAYS", 14);

import { createHash } from "node:crypto";
import { z } from "zod";

export const PROPOSAL_TYPES = [
  "topup_suggestion",
  "remainder_refund",
  "payout_batch",
  "mandate_change",
  "hold_release",
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export const PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
  "execution_failed",
  "invalid",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSER_ROLES: Record<ProposalType, readonly string[]> = {
  topup_suggestion: ["budget"],
  remainder_refund: ["budget"],
  payout_batch: ["treasury"],
  hold_release: ["watchdog"],
  mandate_change: ["budget", "treasury"],
};

export const DECIDER: Record<ProposalType, "owner" | "admin"> = {
  topup_suggestion: "owner",
  remainder_refund: "owner",
  mandate_change: "owner",
  payout_batch: "admin",
  hold_release: "admin",
};

export const MAX_PAYOUT_BATCH_OBLIGATIONS = 100;
export const DISPLAY_HINT_MIN = "0.01";
export const DISPLAY_HINT_MAX = "999999999.99";

const uuid = z.string().uuid();

/** Decimal string in [0.01, 999999999.99] with at most 6 fractional digits. */
export const displayAmountHint = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/)
  .refine((v) => {
    const [whole = "0", frac = ""] = v.split(".");
    const n = Number(whole);
    if (n > 999_999_999) return false;
    if (n === 999_999_999 && /[1-9]/.test(frac.slice(2))) return false;
    if (n === 0 && !/[1-9]/.test(frac.slice(0, 2))) return false;
    return true;
  }, "out_of_range");

export const rationaleSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !/[0-9$€£¥]/.test(v), "rationale_contains_amount");

const hint = displayAmountHint.optional();

export const PAYLOAD_SCHEMAS = {
  topup_suggestion: z
    .object({ wallet_id: uuid, mission_id: uuid.optional(), display_amount_hint: hint })
    .strict(),
  remainder_refund: z
    .object({ mission_id: uuid, wallet_id: uuid, display_amount_hint: hint })
    .strict(),
  payout_batch: z
    .object({
      obligation_ids: z.array(uuid).min(1).max(MAX_PAYOUT_BATCH_OBLIGATIONS),
      display_amount_hint: hint,
    })
    .strict(),
  mandate_change: z
    .object({
      mandate_id: uuid,
      action: z.enum(["revoke", "suspend", "review_terms"]),
      display_amount_hint: hint,
    })
    .strict(),
  hold_release: z.object({ hold_id: uuid }).strict(),
} as const satisfies Record<ProposalType, z.ZodTypeAny>;

export const SCHEMA_VERSIONS: Record<ProposalType, string> = {
  topup_suggestion: "topup_suggestion_v1",
  remainder_refund: "remainder_refund_v1",
  payout_batch: "payout_batch_v1",
  mandate_change: "mandate_change_v1",
  hold_release: "hold_release_v1",
};

export function isProposalType(value: unknown): value is ProposalType {
  return typeof value === "string" && (PROPOSAL_TYPES as readonly string[]).includes(value);
}

/** Registered schema version for a type, or null when the type is unknown (R8.1). */
export function schemaVersionFor(type: string): string | null {
  return isProposalType(type) ? SCHEMA_VERSIONS[type] : null;
}

/** Referenced record IDs in a valid payload, sorted, for dedupe. */
export function referencedIds(type: ProposalType, payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") ids.push(v.toLowerCase());
  };
  switch (type) {
    case "topup_suggestion":
      push(payload.wallet_id);
      push(payload.mission_id);
      break;
    case "remainder_refund":
      push(payload.mission_id);
      push(payload.wallet_id);
      break;
    case "payout_batch":
      if (Array.isArray(payload.obligation_ids)) payload.obligation_ids.forEach(push);
      break;
    case "mandate_change":
      push(payload.mandate_id);
      break;
    case "hold_release":
      push(payload.hold_id);
      break;
  }
  return [...new Set(ids)].sort();
}

export function computeSubjectKey(type: ProposalType, payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${type}:${referencedIds(type, payload).join(",")}`)
    .digest("hex");
}

/**
 * Strict argument schemas for the eight Agent_Tools (agentic-commerce task 14.1, R14.1, R14.2, R14.9).
 *
 * No schema accepts an amount, currency, payee, recipient or payment-state argument. Every schema is
 * `.strict()`, so such a key (or any unknown key) is a validation failure that names the key. Read
 * tools take one record ID. `propose_*` tools take the Proposal payload (record IDs and, for a
 * mandate change, the action) plus a rationale; they omit `display_amount_hint` on purpose, because
 * an agent tool carries no amount of any kind.
 */
import { z } from "zod";
import { PAYLOAD_SCHEMAS, rationaleSchema } from "../proposals/proposal.schemas.js";

export const TOOL_NAMES = [
  "payment_status",
  "mandate_remaining",
  "wallet_summary",
  "propose_topup",
  "propose_remainder_refund",
  "propose_payout_batch",
  "propose_mandate_change",
  "propose_hold_release",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

/** Maximum size of the serialized arguments of one call (R14.9). */
export const TOOL_MAX_ARGUMENT_BYTES = 16 * 1024;

const uuid = z.string().uuid();

export const TOOL_ARGUMENT_SCHEMAS = {
  payment_status: z
    .object({ agreement_id: uuid.optional(), obligation_id: uuid.optional() })
    .strict()
    .superRefine((value, ctx) => {
      const given = [value.agreement_id, value.obligation_id].filter((v) => v !== undefined);
      if (given.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [value.agreement_id === undefined ? "agreement_id" : "obligation_id"],
          message: "Exactly one of agreement_id or obligation_id is required.",
        });
      }
    }),
  mandate_remaining: z.object({ mandate_id: uuid }).strict(),
  wallet_summary: z.object({ wallet_id: uuid }).strict(),
  propose_topup: PAYLOAD_SCHEMAS.topup_suggestion
    .omit({ display_amount_hint: true })
    .extend({ rationale: rationaleSchema })
    .strict(),
  propose_remainder_refund: PAYLOAD_SCHEMAS.remainder_refund
    .omit({ display_amount_hint: true })
    .extend({ rationale: rationaleSchema })
    .strict(),
  propose_payout_batch: PAYLOAD_SCHEMAS.payout_batch
    .omit({ display_amount_hint: true })
    .extend({ rationale: rationaleSchema })
    .strict(),
  propose_mandate_change: PAYLOAD_SCHEMAS.mandate_change
    .omit({ display_amount_hint: true })
    .extend({ rationale: rationaleSchema })
    .strict(),
  propose_hold_release: PAYLOAD_SCHEMAS.hold_release.extend({ rationale: rationaleSchema }).strict(),
} as const satisfies Record<ToolName, z.ZodTypeAny>;

export type ToolArguments = Record<string, unknown>;

export type ToolArgumentsResult =
  | { ok: true; args: ToolArguments }
  | { ok: false; fields: string[]; message: string };

/** Serialized size in bytes; an unserializable value counts as over the limit. */
export function argumentBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? {}) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Validate the arguments of one call. Failures name the offending argument(s) and never echo a
 * value, so a rejected call cannot reflect a secret back to its caller or into the audit trail.
 */
export function parseToolArguments(tool: ToolName, raw: unknown): ToolArgumentsResult {
  const args = raw === undefined || raw === null ? {} : raw;
  if (argumentBytes(args) > TOOL_MAX_ARGUMENT_BYTES) {
    return {
      ok: false,
      fields: ["arguments"],
      message: `The arguments exceed ${TOOL_MAX_ARGUMENT_BYTES} bytes.`,
    };
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, fields: ["arguments"], message: "The arguments must be a JSON object." };
  }
  const parsed = TOOL_ARGUMENT_SCHEMAS[tool].safeParse(args);
  if (parsed.success) return { ok: true, args: parsed.data as ToolArguments };

  const fields = new Set<string>();
  for (const issue of parsed.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) fields.add(key);
    } else {
      fields.add(issue.path.length > 0 ? issue.path.join(".") : "arguments");
    }
  }
  const named = [...fields].sort();
  return {
    ok: false,
    fields: named,
    message: `Invalid argument${named.length === 1 ? "" : "s"}: ${named.join(", ")}.`,
  };
}

import { Decimal } from "decimal.js";
import { hasForbiddenKey } from "../agentic/redact.js";
import {
  PAYLOAD_SCHEMAS,
  computeSubjectKey,
  isProposalType,
  rationaleSchema,
  schemaVersionFor,
  type ProposalType,
} from "./proposal.schemas.js";

export const DEFAULT_PROPOSAL_MAX_BYTES = 65_536;

export interface RedactedPayload {
  redacted: true;
  keys: string[];
  bytes: number;
}

export interface ValidProposalDraft {
  ok: true;
  type: ProposalType;
  schemaVersion: string;
  payload: Record<string, unknown>;
  rationale: string;
  subjectKey: string;
  displayAmountHint: string | null;
}

export interface InvalidProposalDraft {
  ok: false;
  /** `PROPOSAL_TOO_LARGE` means refuse and store nothing (R8.18); others are stored as invalid. */
  tooLarge: boolean;
  schema: string | null;
  reasonCodes: string[];
  redactedPayload: RedactedPayload;
}

export type ProposalDraftResult = ValidProposalDraft | InvalidProposalDraft;

const FORBIDDEN_NAMES =
  /^(payee|recipient|payout[_-]?recipient|currency|payment[_-]?state)$/i;

/** Any depth; also catches the shared agentic forbidden list. */
function hasForbiddenField(value: unknown, depth = 0): boolean {
  if (hasForbiddenKey(value)) return true;
  if (depth > 20 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasForbiddenField(v, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([k, v]) => FORBIDDEN_NAMES.test(k) || hasForbiddenField(v, depth + 1),
  );
}

export function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Key names only; no values. Top-level keys, as the design stores them. */
export function redactPayload(payload: unknown): RedactedPayload {
  const keys =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload as Record<string, unknown>).sort()
      : [];
  return { redacted: true, keys, bytes: byteSize(payload) };
}

export function validateProposalDraft(input: {
  type: unknown;
  payload: unknown;
  rationale: unknown;
  maxBytes?: number;
}): ProposalDraftResult {
  const maxBytes = input.maxBytes ?? DEFAULT_PROPOSAL_MAX_BYTES;
  const redactedPayload = redactPayload(input.payload);
  const type = input.type;
  const fail = (reasonCodes: string[], tooLarge = false): InvalidProposalDraft => ({
    ok: false,
    tooLarge,
    schema: typeof type === "string" ? schemaVersionFor(type) : null,
    reasonCodes,
    redactedPayload,
  });

  if (redactedPayload.bytes > maxBytes) return fail(["PROPOSAL_TOO_LARGE"], true);
  if (!isProposalType(type)) return fail(["unknown_type"]);

  const reasons: string[] = [];
  if (
    input.payload === null ||
    typeof input.payload !== "object" ||
    Array.isArray(input.payload)
  ) {
    return fail(["payload_not_object"]);
  }
  if (hasForbiddenField(input.payload)) reasons.push("forbidden_field");

  const rationale = rationaleSchema.safeParse(input.rationale);
  if (!rationale.success) {
    reasons.push(...rationale.error.issues.map((i) => `rationale:${i.message === "Required" ? "required" : i.message}`));
  }

  const parsed = PAYLOAD_SCHEMAS[type].safeParse(input.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".");
      reasons.push(path ? `${path}:${issue.code}` : issue.code);
    }
  }
  if (reasons.length > 0 || !parsed.success || !rationale.success) {
    return fail([...new Set(reasons)].sort());
  }

  const payload = parsed.data as Record<string, unknown>;
  const hint = payload.display_amount_hint;
  return {
    ok: true,
    type,
    schemaVersion: schemaVersionFor(type) as string,
    payload,
    rationale: rationale.data,
    subjectKey: computeSubjectKey(type, payload),
    displayAmountHint: typeof hint === "string" ? new Decimal(hint).toFixed() : null,
  };
}

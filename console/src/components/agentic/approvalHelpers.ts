/**
 * Pure helpers for the Approval Inbox. Money_Boundary: amounts here are display hints only;
 * nothing in this file sets an amount, currency, payee or payment state.
 */

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** A `hold_release` approval needs a comment (R9.15). Reject always needs a reason. */
export function commentRequired(proposalType: string): boolean {
  return proposalType === "hold_release";
}

/** Whether a decision can be sent: approve needs a comment only for hold_release; reject needs a reason. */
export function canSubmitDecision(kind: "approve" | "reject", proposalType: string, text: string): boolean {
  const trimmed = text.trim();
  if (kind === "reject") return trimmed.length > 0;
  return !commentRequired(proposalType) || trimmed.length > 0;
}

const DECIMAL_HINT = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;

/** The Wallet link after a topup_suggestion is approved. The hint is only a prefill the person can edit. */
export function topupHref(missionId: unknown, hint: unknown): string {
  const mission = str(missionId);
  if (!mission) return "#/wallet";
  const h = str(hint);
  const params = new URLSearchParams({ topup: mission });
  if (DECIMAL_HINT.test(h)) params.set("hint", h);
  return `#/wallet?${params.toString()}`;
}

/** What the grid shows as the subject: the record the Proposal is about, never a person or payee. */
export function proposalSubject(p: Row): string {
  const payload = (p.payload && typeof p.payload === "object" ? p.payload : {}) as Row;
  switch (str(p.proposal_type)) {
    case "topup_suggestion":
      return payload.mission_id ? `Mission ${str(payload.mission_id).slice(0, 8)}` : `Wallet ${str(payload.wallet_id).slice(0, 8)}`;
    case "remainder_refund":
      return `Mission ${str(payload.mission_id).slice(0, 8)}`;
    case "payout_batch": {
      const n = Array.isArray(payload.obligation_ids) ? payload.obligation_ids.length : 0;
      return `${n} obligation${n === 1 ? "" : "s"}`;
    }
    case "mandate_change":
      return `Mandate ${str(payload.mandate_id).slice(0, 8)} (${str(payload.action)})`;
    case "hold_release":
      return `Hold ${str(payload.hold_id).slice(0, 8)}`;
    default:
      return "";
  }
}

/** A validation decision as short text. */
export function validationText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Row;
    const verdict = str(o.decision ?? o.result ?? o.status);
    const codes = Array.isArray(o.reason_codes) ? o.reason_codes.join(", ") : "";
    if (verdict || codes) return [verdict, codes].filter(Boolean).join(": ");
    return JSON.stringify(v);
  }
  return str(v);
}

/** Flat grid rows. Field names avoid anything that could show a payee or recipient. */
export function toGridRow(p: Row): Row {
  return {
    id: str(p.id),
    type: str(p.proposal_type),
    subject: proposalSubject(p),
    agent: str(p.proposer_agent_id).slice(0, 8),
    rationale: str(p.rationale),
    validation: validationText(p.validation_decision),
    created_at: p.created_at,
    expires_at: p.expires_at,
  };
}

/** Error text for a failed decision: the code first, then the message. */
export function decisionErrorText(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code;
  const message = e?.message || "The decision could not be recorded.";
  return `${code ? `${code}: ` : ""}${message}`;
}

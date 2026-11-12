/**
 * Pure helpers for the Mandates workspace. No React, so tests can import them directly.
 * Money_Boundary: a Mandate body carries caps, categories, scope and expiry only. There is no
 * payee, recipient or payment state, and no wallet or owner (the server derives those).
 */

export interface MandateForm {
  currency: string;
  perAgreementMax: string;
  dailyCap: string;
  totalCap: string;
  /** Comma or whitespace separated. */
  categories: string;
  /** Optional, comma or whitespace separated mission IDs. */
  missionScope: string;
  /** `datetime-local` value or ISO string. */
  expiresAt: string;
}

export const EMPTY_MANDATE_FORM: MandateForm = {
  currency: "USD",
  perAgreementMax: "",
  dailyCap: "",
  totalCap: "",
  categories: "",
  missionScope: "",
  expiresAt: "",
};

/** Split a free-text list on commas and whitespace, dropping blanks and repeats. */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** The request body for POST /v1/mandates. Amounts stay as the strings the person typed. */
export function buildMandateBody(form: MandateForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    currency: form.currency.trim().toUpperCase(),
    per_agreement_max: form.perAgreementMax.trim(),
    daily_cap: form.dailyCap.trim(),
    total_cap: form.totalCap.trim(),
    allowed_categories: splitList(form.categories),
    expires_at: toIso(form.expiresAt),
  };
  const scope = splitList(form.missionScope);
  if (scope.length > 0) body.mission_scope = scope;
  return body;
}

function toIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/** A Mandate in one of these states can still be revoked by its Owner. */
const REVOCABLE = new Set(["active", "suspended", "exhausted"]);

export function canRevoke(status: unknown, role: string | undefined): boolean {
  return role === "buyer" && typeof status === "string" && REVOCABLE.has(status);
}

export type MandateView = "loading" | "full" | "wind-down" | "disabled";

/**
 * Which view to show. With the flag on: the full workspace. With the flag off and at least one
 * Mandate: the read-only wind-down view (Revoke only). With the flag off and none: disabled.
 */
export function mandateView(flagOn: boolean | undefined, mandateCount: number | undefined): MandateView {
  if (flagOn === undefined) return "loading";
  if (flagOn) return "full";
  return mandateCount !== undefined && mandateCount > 0 ? "wind-down" : "disabled";
}

/** Apply a server response over a row so a revoke shows `revoked` at once. */
export function mergeRow<T extends { id?: unknown }>(rows: readonly T[], updated: T): T[] {
  return rows.map((r) => (r.id !== undefined && r.id === updated.id ? { ...r, ...updated } : r));
}

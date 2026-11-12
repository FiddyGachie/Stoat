/**
 * Insight narrative validation (agentic-commerce design section 5, R12.2 to R12.4).
 *
 * Pure functions: schema, cited keys, numeric tokens against cited figures at the token's own
 * displayed precision, and follow-up intents against the Intent_Catalog. Any failure is a
 * `Validation` error; the service turns it into `AGENT_OUTPUT_INVALID` and stores nothing.
 */
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { Validation } from "../agentic/run-kit.js";
import { hasForbiddenKey } from "../agentic/redact.js";

export const INSIGHT_SCHEMA_VERSION = "payments_insight_v1";
export const MAX_DIGEST_FIGURES = 50;
export const MAX_HEADLINE = 120;
export const MAX_FINDINGS = 5;
export const MAX_FINDING_TEXT = 300;
export const MAX_FOLLOW_UPS = 3;

export type FigureKind = "amount" | "count" | "percent" | "days";

export interface DigestFigure {
  key: string;
  /** Decimal string, no exponent. */
  value: string;
  currency?: string;
  kind: FigureKind;
}

export interface InsightDigest {
  figures: DigestFigure[];
}

export const InsightNarrativeSchema = z
  .object({
    headline: z.string().min(1).max(MAX_HEADLINE),
    findings: z
      .array(
        z
          .object({
            text: z.string().min(1).max(MAX_FINDING_TEXT),
            cites: z
              .array(z.string().min(1).max(120))
              .min(1)
              .max(MAX_DIGEST_FIGURES),
          })
          .strict(),
      )
      .max(MAX_FINDINGS),
    follow_ups: z
      .array(
        z
          .object({
            intent: z.string().min(1).max(100),
            params: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(MAX_FOLLOW_UPS),
  })
  .strict();

export type InsightNarrative = z.infer<typeof InsightNarrativeSchema>;

/** A numeric token: optional thousands separators, optional decimals, optional percent sign. */
const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;
const CURRENCY_SYMBOLS = /[$€£¥]/;
/** Params may name a currency filter, but never a payee, recipient, email or payment state. */
const PARAM_DENIED_KEY =
  /^(amount|payee|recipient|payment[_-]?state|payout[_-]?recipient|receiver|payer|email|paypal[_-]?email|sql)$/i;

function paramsAreSafe(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value))
    return value.every((item) => paramsAreSafe(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).every(
    ([key, item]) =>
      !PARAM_DENIED_KEY.test(key) && paramsAreSafe(item, depth + 1),
  );
}

/** Number of decimal places the token displays. */
function placesOf(token: string): number {
  const dot = token.indexOf(".");
  return dot < 0 ? 0 : token.length - dot - 1;
}

/**
 * True when `token` equals some cited figure's value rounded half-up to the token's own
 * decimal places. A token whose precision exceeds the figure's still matches by equality.
 */
export function tokenMatchesCited(
  token: string,
  cited: DigestFigure[],
): boolean {
  const clean = token.replace(/,/g, "");
  const places = placesOf(clean);
  const tokenValue = new Decimal(clean);
  return cited.some((figure) =>
    new Decimal(figure.value)
      .toDecimalPlaces(places, Decimal.ROUND_HALF_UP)
      .equals(tokenValue),
  );
}

export function validateInsight(
  output: unknown,
  digest: InsightDigest,
  isCatalogIntent: (name: string) => boolean,
  paramsValid: (
    name: string,
    params: Record<string, unknown>,
  ) => boolean = () => true,
): Validation<InsightNarrative> {
  const parsed = InsightNarrativeSchema.safeParse(output);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(".") || "output"}: ${issue?.message ?? "invalid"}`,
    };
  }
  const narrative = parsed.data;
  // Params may legitimately carry a currency filter, so the key check skips follow-up params.
  if (
    hasForbiddenKey({
      headline: narrative.headline,
      findings: narrative.findings,
      follow_ups: narrative.follow_ups.map((f) => ({ intent: f.intent })),
    })
  ) {
    return { ok: false, error: "forbidden field." };
  }

  const byKey = new Map(digest.figures.map((figure) => [figure.key, figure]));

  if (CURRENCY_SYMBOLS.test(narrative.headline)) {
    return { ok: false, error: "headline must not contain currency symbols." };
  }
  if ((narrative.headline.match(NUMBER_TOKEN) ?? []).length > 0) {
    return { ok: false, error: "headline must not state figures." };
  }

  for (const [index, finding] of narrative.findings.entries()) {
    const cited: DigestFigure[] = [];
    for (const key of finding.cites) {
      const figure = byKey.get(key);
      if (!figure)
        return {
          ok: false,
          error: `findings.${index}.cites: unknown digest key.`,
        };
      cited.push(figure);
    }
    if (CURRENCY_SYMBOLS.test(finding.text)) {
      return {
        ok: false,
        error: `findings.${index}.text: currency symbols are not allowed.`,
      };
    }
    for (const token of finding.text.match(NUMBER_TOKEN) ?? []) {
      if (!tokenMatchesCited(token, cited)) {
        return {
          ok: false,
          error: `findings.${index}.text: a number does not match a cited figure.`,
        };
      }
    }
  }

  for (const [index, followUp] of narrative.follow_ups.entries()) {
    if (!isCatalogIntent(followUp.intent)) {
      return {
        ok: false,
        error: `follow_ups.${index}.intent: not in the intent catalog.`,
      };
    }
    if (!paramsAreSafe(followUp.params)) {
      return {
        ok: false,
        error: `follow_ups.${index}.params: forbidden field.`,
      };
    }
    if (!paramsValid(followUp.intent, followUp.params)) {
      return {
        ok: false,
        error: `follow_ups.${index}.params: invalid for the intent.`,
      };
    }
  }
  return { ok: true, value: narrative };
}

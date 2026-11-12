import { Decimal } from "decimal.js";

export interface ValidMandate {
  perAgreementMax: string;
  dailyCap: string;
  totalCap: string;
  allowedCategories: string[];
  missionScope: string[] | null;
  expiresAt: Date;
}

export interface MandateValidationContext {
  walletCurrency: string;
  now: Date;
  maxLifetimeDays: number;
  categoryCatalog: ReadonlySet<string>;
  ownedMissionIds: ReadonlySet<string> | null;
}

export type MandateValidation =
  | { ok: true; value: ValidMandate }
  | { ok: false; errors: Array<{ field: string; code: string }> };

const AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ZERO_DECIMAL_CURRENCIES = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

function minorUnits(currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}

function forbiddenFields(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const field = path ? `${path}.${key}` : key;
    if (/^(payee|recipient|payout[_-]?recipient|payment[_-]?state|owner|wallet_id)$/i.test(key)) {
      found.push(field);
    }
    found.push(...forbiddenFields(child, field));
  }
  return found;
}

export function validateMandateInput(
  input: unknown,
  ctx: MandateValidationContext,
): MandateValidation {
  const errors: Array<{ field: string; code: string }> = [];
  const body =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const required = ["per_agreement_max", "daily_cap", "total_cap", "allowed_categories", "expires_at"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      errors.push({ field, code: "required" });
    }
  }

  const forbidden = forbiddenFields(body);
  for (const field of [...new Set(forbidden)]) errors.push({ field, code: "forbidden_field" });
  if (body.currency !== undefined && String(body.currency).toUpperCase() !== ctx.walletCurrency.toUpperCase()) {
    errors.push({ field: "currency", code: "currency_mismatch" });
  }

  const currency = ctx.walletCurrency.toUpperCase();
  const amountValues = new Map<string, Decimal>();
  for (const field of ["per_agreement_max", "daily_cap", "total_cap"]) {
    const raw = body[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" || !AMOUNT_RE.test(raw)) {
      errors.push({ field, code: "invalid_decimal" });
      continue;
    }
    const decimals = raw.split(".")[1]?.length ?? 0;
    if (decimals > minorUnits(currency)) {
      errors.push({ field, code: "currency_precision" });
      continue;
    }
    const amount = new Decimal(raw);
    if (amount.lt("0.01") || amount.gt("999999999.99")) {
      errors.push({ field, code: "out_of_range" });
      continue;
    }
    amountValues.set(field, amount);
  }
  const per = amountValues.get("per_agreement_max");
  const daily = amountValues.get("daily_cap");
  const total = amountValues.get("total_cap");
  if (per && daily && per.gt(daily)) errors.push({ field: "per_agreement_max", code: "cap_order" });
  if (daily && total && daily.gt(total)) errors.push({ field: "daily_cap", code: "cap_order" });

  let allowedCategories: string[] = [];
  if (body.allowed_categories !== undefined && body.allowed_categories !== null) {
    const categories = body.allowed_categories;
    if (
      !Array.isArray(categories) ||
      categories.length < 1 ||
      categories.length > 20 ||
      categories.some((category) => typeof category !== "string" || !category.trim())
    ) {
      errors.push({ field: "allowed_categories", code: "category_count_or_format" });
    } else {
      allowedCategories = [...new Set(categories as string[])];
      if (allowedCategories.length !== categories.length) {
        errors.push({ field: "allowed_categories", code: "duplicate_category" });
      }
      if (allowedCategories.some((category) => !ctx.categoryCatalog.has(category))) {
        errors.push({ field: "allowed_categories", code: "unknown_category" });
      }
    }
  }

  let missionScope: string[] | null = null;
  if (body.mission_scope !== undefined && body.mission_scope !== null) {
    if (
      !Array.isArray(body.mission_scope) ||
      body.mission_scope.length < 1 ||
      body.mission_scope.length > 50 ||
      body.mission_scope.some((id) => typeof id !== "string")
    ) {
      errors.push({ field: "mission_scope", code: "mission_count_or_format" });
    } else {
      missionScope = [...new Set(body.mission_scope as string[])];
      if (
        missionScope.length !== body.mission_scope.length ||
        missionScope.some((id) => !ctx.ownedMissionIds?.has(id))
      ) {
        errors.push({ field: "mission_scope", code: "mission_not_owned" });
      }
    }
  }

  const expiresAt = typeof body.expires_at === "string" ? new Date(body.expires_at) : new Date(Number.NaN);
  if (Number.isNaN(expiresAt.getTime())) {
    errors.push({ field: "expires_at", code: "invalid_date" });
  } else {
    const maxDate = new Date(ctx.now.getTime() + ctx.maxLifetimeDays * 86_400_000);
    if (expiresAt <= ctx.now || expiresAt > maxDate) {
      errors.push({ field: "expires_at", code: "outside_lifetime" });
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      perAgreementMax: per!.toFixed(),
      dailyCap: daily!.toFixed(),
      totalCap: total!.toFixed(),
      allowedCategories,
      missionScope,
      expiresAt,
    },
  };
}

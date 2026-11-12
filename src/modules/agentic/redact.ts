import type { DbClient } from "../../db/connection.js";
import { recordRefusal as recordWalletRefusal } from "../wallet/wallet-events.js";

export const FORBIDDEN_KEY =
  /^(amount|currency|payee|recipient|payment[_-]?state|payout[_-]?recipient|receiver|payer)$/i;

export function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((item) => hasForbiddenKey(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) =>
      FORBIDDEN_KEY.test(key) || hasForbiddenKey(child, depth + 1),
  );
}

export function scrubForbidden<T>(value: T, depth = 0): T {
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubForbidden(item, depth + 1)) as T;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!FORBIDDEN_KEY.test(key))
      cleaned[key] = scrubForbidden(child, depth + 1);
  }
  return cleaned as T;
}

export function redactKeys(value: unknown, depth = 0): unknown {
  if (depth > 20 || value === null || typeof value !== "object")
    return undefined;
  if (Array.isArray(value))
    return value.map((item) => redactKeys(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      child !== null && typeof child === "object"
        ? redactKeys(child, depth + 1)
        : "[redacted]",
    ]),
  );
}

export async function recordRefusal(
  db: DbClient,
  input: Parameters<typeof recordWalletRefusal>[1],
): Promise<{ id: string }> {
  return recordWalletRefusal(db, input);
}

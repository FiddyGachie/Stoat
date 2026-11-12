/**
 * Mission Budget Wallet: PayPal call wrapper.
 *
 * - callWithOneRetry: one immediate retry on PAYPAL_UNREACHABLE or a 5xx rejection, reusing the
 *   same request ID (the caller bakes it into `fn`). 4xx, invalid state and declines are never
 *   retried. A malformed response becomes PAYPAL_BAD_RESPONSE (R16.4, R16.5, R16.6).
 * - Every call logs correlation ID, PayPal debug ID and outcome. Never secrets, tokens, headers
 *   or recipient data (R16.8).
 * - scrubFailureDetails: every PayPal failure leaves with an allowlisted details object only
 *   (R18.10, R19.9, R19.10).
 */
import { StoatError } from "../../common/errors.js";
import {
  PayPalApiError,
  PayPalNotConfiguredError,
} from "../paypal/paypal.gateway.js";

export interface PayPalCallContext {
  /** What the call does, for logs only, e.g. "capture order". */
  action: string;
  correlationId: string;
  environment: "sandbox" | "live";
  /** The PayPal-Request-Id used by `fn`. Included in failure details. */
  requestId?: string;
  /** Returns false when the response is malformed (missing id, wrong shape). */
  validate?: (result: any) => boolean;
  /** Log sink. Defaults to structured console output. Receives only safe fields. */
  log?: (entry: PayPalCallLogEntry) => void;
}

export interface PayPalCallLogEntry {
  event: "paypal_call";
  action: string;
  correlation_id: string;
  paypal_debug_id: string | null;
  attempt: number;
  outcome: "ok" | "retrying" | "failed";
  error_code?: string;
}

const defaultLog = (e: PayPalCallLogEntry) => console.info(JSON.stringify(e));

/** Fields that may survive in failure details. Everything else is dropped at every depth. */
const ALLOWED_KEYS = new Set([
  "environment",
  "correlation_id",
  "request_id",
  "paypal_issue",
  "paypal_debug_id",
  "paypal_status",
]);
const SECRET_PATTERN =
  /(bearer|basic)\s+[A-Za-z0-9._~+/=-]+|access[_-]?token|client[_-]?secret|authorization|[^\s@]+@[^\s@]+\.[^\s@]+/i;

function safePrimitive(v: unknown): string | number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    if (SECRET_PATTERN.test(v)) return undefined;
    return v.slice(0, 200);
  }
  return undefined; // objects, arrays, booleans, null: never carried
}

/**
 * Reduce failure details to environment, correlation ID, request ID (if returned) and the error
 * indication. Credentials, access tokens, authorization headers and payout recipient details are
 * stripped at any depth because nothing nested is kept and string values are screened.
 */
export function scrubFailureDetails(
  details: unknown,
  ctx: {
    environment: "sandbox" | "live";
    correlationId?: string;
    requestId?: string;
  },
): Record<string, string | number> {
  const out: Record<string, string | number> = { environment: ctx.environment };
  if (ctx.correlationId) out.correlation_id = ctx.correlationId;
  if (ctx.requestId) out.request_id = ctx.requestId;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
      if (!ALLOWED_KEYS.has(k) || k === "environment") continue;
      if (
        (k === "correlation_id" || k === "request_id") &&
        out[k] !== undefined
      )
        continue;
      const safe = safePrimitive(v);
      if (safe !== undefined) out[k] = safe;
    }
  }
  return out;
}

function debugId(err: unknown): string | null {
  const v = (err as { details?: Record<string, unknown> })?.details
    ?.paypal_debug_id;
  return typeof v === "string" && !SECRET_PATTERN.test(v)
    ? v.slice(0, 100)
    : null;
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof PayPalApiError)) return false;
  if (err.code === "PAYPAL_UNREACHABLE") return true;
  if (err.code === "PAYPAL_REQUEST_REJECTED") {
    const status = Number(
      (err.details as Record<string, unknown> | undefined)?.paypal_status,
    );
    return Number.isFinite(status) && status >= 500 && status <= 599;
  }
  return false;
}

/** Rebuild any PayPal failure with scrubbed details. Non-PayPal StoatErrors pass through. */
function scrubError(err: unknown, ctx: PayPalCallContext): never {
  const scrub = (d: unknown) => scrubFailureDetails(d, ctx);
  if (err instanceof PayPalApiError) {
    throw new PayPalApiError(
      err.code,
      err.message,
      err.statusCode,
      scrub(err.details),
    );
  }
  if (err instanceof PayPalNotConfiguredError) {
    throw new PayPalApiError(
      err.code,
      err.message,
      err.statusCode,
      scrub(undefined),
    );
  }
  if (err instanceof StoatError) throw err;
  // Anything else escaping a gateway call is an unreadable response, not a retryable outage.
  throw new PayPalApiError(
    "PAYPAL_BAD_RESPONSE",
    `PayPal returned a response Stoat could not read (${ctx.action}).`,
    502,
    scrub(undefined),
  );
}

export async function callWithOneRetry<T>(
  fn: () => Promise<T>,
  ctx: PayPalCallContext,
): Promise<T> {
  const log = ctx.log ?? defaultLog;
  const entry = (
    attempt: number,
    outcome: PayPalCallLogEntry["outcome"],
    err?: unknown,
  ): PayPalCallLogEntry => ({
    event: "paypal_call",
    action: ctx.action,
    correlation_id: ctx.correlationId,
    paypal_debug_id: err ? debugId(err) : null,
    attempt,
    outcome,
    ...(err instanceof StoatError ? { error_code: err.code } : {}),
  });

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fn();
      if (ctx.validate && !ctx.validate(result)) {
        // Not transient, so the catch below logs once, scrubs and rethrows. Upstream flags Reconciliation.
        throw new PayPalApiError(
          "PAYPAL_BAD_RESPONSE",
          `PayPal returned a malformed response (${ctx.action}).`,
          502,
        );
      }
      log(entry(attempt, "ok"));
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt === 1 && isTransient(err)) {
        log(entry(attempt, "retrying", err));
        continue;
      }
      log(entry(attempt, "failed", err));
      return scrubError(err, ctx);
    }
  }
  return scrubError(lastErr, ctx);
}

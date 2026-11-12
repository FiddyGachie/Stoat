import { StoatError } from './errors.js';

/**
 * In-memory failed-attempt throttle for credential endpoints.
 *
 * Counts FAILURES per key inside a sliding window; once a key reaches the limit every
 * further attempt (even with the right secret) is refused until the window passes.
 * Keys: per-account (stops guessing one account) and per-IP (stops spraying many).
 *
 * Limitation: state is per-process. With several API instances the effective limit is
 * multiplied by the instance count. Move to a shared store before scaling out.
 */
interface Bucket { failures: number; windowStart: number }

const WINDOW_MS = 15 * 60 * 1000;
const MAX_KEYS = 50_000;
const buckets = new Map<string, Bucket>();

function limits() {
  return {
    account: Number(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT ?? 5),
    ip: Number(process.env.LOGIN_MAX_FAILURES_PER_IP ?? 100),
  };
}

function live(key: string, now: number): Bucket | undefined {
  const b = buckets.get(key);
  if (!b) return undefined;
  if (now - b.windowStart >= WINDOW_MS) {
    buckets.delete(key);
    return undefined;
  }
  return b;
}

function prune(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, b] of buckets) if (now - b.windowStart >= WINDOW_MS) buckets.delete(k);
  // Still full of live entries: drop the oldest so memory stays bounded under attack.
  while (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value as string);
}

function throttled(b: Bucket, now: number): StoatError {
  const retry = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000));
  return new StoatError('RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.', 429, { retry_after_seconds: retry });
}

export const loginThrottle = {
  /** Throws RATE_LIMITED if the account or the source IP has used up its failures. */
  assertAllowed(accountKey: string, ip: string | undefined, now = Date.now()): void {
    const max = limits();
    const a = live(`acct:${accountKey}`, now);
    if (a && a.failures >= max.account) throw throttled(a, now);
    if (ip) {
      const i = live(`ip:${ip}`, now);
      if (i && i.failures >= max.ip) throw throttled(i, now);
    }
  },

  recordFailure(accountKey: string, ip: string | undefined, now = Date.now()): void {
    prune(now);
    for (const key of [`acct:${accountKey}`, ip ? `ip:${ip}` : '']) {
      if (!key) continue;
      const b = live(key, now);
      if (b) b.failures += 1;
      else buckets.set(key, { failures: 1, windowStart: now });
    }
  },

  recordSuccess(accountKey: string): void {
    buckets.delete(`acct:${accountKey}`);
  },

  /** Test helper. */
  reset(): void {
    buckets.clear();
  },
};

/** Cap account creation per source IP so signup cannot be used to bloat the database. */
const signups = new Map<string, Bucket>();
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

export function assertSignupAllowed(ip: string | undefined, now = Date.now()): void {
  if (!ip) return;
  const max = Number(process.env.SIGNUP_MAX_PER_IP_PER_HOUR ?? 20);
  if (signups.size >= MAX_KEYS) signups.clear();
  const b = signups.get(ip);
  if (!b || now - b.windowStart >= SIGNUP_WINDOW_MS) {
    signups.set(ip, { failures: 1, windowStart: now });
    return;
  }
  if (b.failures >= max) {
    const retry = Math.max(1, Math.ceil((b.windowStart + SIGNUP_WINDOW_MS - now) / 1000));
    throw new StoatError('RATE_LIMITED', 'Too many accounts created from this address. Try again later.', 429, { retry_after_seconds: retry });
  }
  b.failures += 1;
}

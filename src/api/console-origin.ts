import type { Request } from 'express';

/**
 * The console origin a payment request came from, if it is one we trust to redirect to.
 * Trusted: the configured CONSOLE_URL, the API's own host (same-origin deploys such as Vercel),
 * or a localhost / 127.0.0.1 address outside production. Anything else is ignored, so the
 * PayPal return link can never become an open redirect.
 */
export function trustedConsoleOrigin(req: Request): string | undefined {
  const raw = req.headers.origin ?? (typeof req.headers.referer === 'string' ? req.headers.referer : undefined);
  if (!raw || Array.isArray(raw)) return undefined;
  let origin: URL;
  try { origin = new URL(raw); } catch { return undefined; }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return undefined;
  const configured = configuredConsoleOrigin();
  if (configured && origin.origin === configured) return origin.origin;
  if (req.headers.host && origin.host === req.headers.host) return origin.origin;
  if (process.env.NODE_ENV !== 'production' && (origin.hostname === 'localhost' || origin.hostname === '127.0.0.1')) return origin.origin;
  return undefined;
}

export function configuredConsoleOrigin(): string | undefined {
  const v = process.env.CONSOLE_URL?.trim();
  if (!v) return undefined;
  try { return new URL(v).origin; } catch { return undefined; }
}

/**
 * Where to hand the buyer back after PayPal: the origin remembered with the payment (re-checked),
 * else CONSOLE_URL, else this API's own origin (the console served alongside it), else the local
 * development default.
 */
export function consoleReturnBase(req: Request, remembered?: string | null): string {
  if (remembered) {
    try {
      const u = new URL(remembered);
      const configured = configuredConsoleOrigin();
      const local = process.env.NODE_ENV !== 'production' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
      if (u.origin === configured || local || u.host === req.headers.host) return u.origin;
    } catch { /* fall through */ }
  }
  return configuredConsoleOrigin() ?? 'http://localhost:5173';
}

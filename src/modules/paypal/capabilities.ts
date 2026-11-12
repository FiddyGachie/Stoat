import { StoatError } from '../../common/errors.js';
import { readPayPalConfig } from './paypal.gateway.js';

/**
 * PayPal-only invariant and capability gates (SPEC v2.1 sections 2.1, 7 and FR-036, FR-046).
 *
 * Payouts are enabled only when BOTH hold, and neither is controllable from a browser:
 *   PAYPAL_PAYOUTS_ENABLED=true                (operator feature flag, default false)
 *   PAYPAL_PAYOUTS_CAPABILITY_STATUS=enabled   (set only after `npm run paypal:spike` passes)
 * If PayPal later refuses payouts at runtime the capability reads as 'degraded' until restart.
 */
export type CapabilityStatus = 'enabled' | 'blocked' | 'unknown' | 'degraded';

let runtimeDegradedReason: string | null = null;

export function markPayoutsDegraded(reason: string): void {
  runtimeDegradedReason = reason;
}
export function resetPayoutsDegraded(): void {
  runtimeDegradedReason = null;
}

export function ordersCapability(): { status: CapabilityStatus; reason?: string } {
  return readPayPalConfig()
    ? { status: 'enabled' }
    : { status: 'blocked', reason: 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set.' };
}

export function payoutsCapability(): { status: CapabilityStatus; enabled: boolean; reason?: string } {
  if (!readPayPalConfig()) return { status: 'blocked', enabled: false, reason: 'PayPal credentials are not set.' };
  if (process.env.PAYPAL_PAYOUTS_ENABLED !== 'true') return { status: 'blocked', enabled: false, reason: 'PAYPAL_PAYOUTS_ENABLED is not true.' };
  const declared = (process.env.PAYPAL_PAYOUTS_CAPABILITY_STATUS ?? 'unknown').toLowerCase();
  if (declared === 'blocked') return { status: 'blocked', enabled: false, reason: 'The capability spike found Payouts blocked for this PayPal app.' };
  if (declared !== 'enabled') return { status: 'unknown', enabled: false, reason: 'Run `npm run paypal:spike`, then set PAYPAL_PAYOUTS_CAPABILITY_STATUS=enabled.' };
  if (runtimeDegradedReason) return { status: 'degraded', enabled: false, reason: runtimeDegradedReason };
  return { status: 'enabled', enabled: true };
}

export class PayoutsUnavailableError extends StoatError {
  constructor(reason?: string) {
    super(
      'PAYPAL_PAYOUTS_UNAVAILABLE',
      'Provider payout unavailable: no provider payment was sent.',
      503,
      reason ? { reason } : undefined
    );
  }
}

export function assertPayoutsEnabled(): void {
  const cap = payoutsCapability();
  if (!cap.enabled) throw new PayoutsUnavailableError(cap.reason);
}

/**
 * FR-036: PayPal is the only payment provider. Called at startup and when the app is built.
 * Any other value is a configuration error, not a feature to be enabled.
 */
export function assertPayPalOnly(env: NodeJS.ProcessEnv = process.env): void {
  const configured = env.PAYMENT_PROVIDER?.trim();
  if (configured && configured.toUpperCase() !== 'PAYPAL') {
    throw new Error(`PAYMENT_PROVIDER=${configured} is not allowed. Stoat moves money only through PayPal.`);
  }
}

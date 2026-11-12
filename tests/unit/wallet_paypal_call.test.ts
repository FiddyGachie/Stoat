import { describe, it, expect } from 'vitest';
import { callWithOneRetry, scrubFailureDetails } from '../../src/modules/wallet/paypal-call.js';
import { PayPalApiError } from '../../src/modules/paypal/paypal.gateway.js';

const base = { action: 'capture order', correlationId: 'corr-1', environment: 'sandbox' as const, requestId: 'wallet-cap-1' };

describe('callWithOneRetry', () => {
  it('retries once on PAYPAL_UNREACHABLE and succeeds', async () => {
    let n = 0;
    const logs: any[] = [];
    const out = await callWithOneRetry(async () => {
      if (++n === 1) throw new PayPalApiError('PAYPAL_UNREACHABLE', 'down', 502);
      return { id: 'x' };
    }, { ...base, log: (e) => logs.push(e) });
    expect(out).toEqual({ id: 'x' });
    expect(n).toBe(2);
    expect(logs.map((l) => l.outcome)).toEqual(['retrying', 'ok']);
  });

  it('retries only once, then fails with scrubbed details', async () => {
    let n = 0;
    const err: any = await callWithOneRetry(async () => {
      n++;
      throw new PayPalApiError('PAYPAL_REQUEST_REJECTED', 'x', 502, { paypal_status: 503, paypal_debug_id: 'dbg', access_token: 'SECRET', nested: { email: 'a@b.com' } });
    }, base).catch((e) => e);
    expect(n).toBe(2);
    expect(err.details).toEqual({ environment: 'sandbox', correlation_id: 'corr-1', request_id: 'wallet-cap-1', paypal_status: 503, paypal_debug_id: 'dbg' });
  });

  it('does not retry 4xx or order-not-approved', async () => {
    for (const e of [
      new PayPalApiError('PAYPAL_REQUEST_REJECTED', 'x', 422, { paypal_status: 422 }),
      new PayPalApiError('PAYPAL_ORDER_NOT_APPROVED', 'x', 409),
    ]) {
      let n = 0;
      await callWithOneRetry(async () => { n++; throw e; }, base).catch(() => {});
      expect(n).toBe(1);
    }
  });

  it('turns a malformed response into PAYPAL_BAD_RESPONSE without retry', async () => {
    let n = 0;
    const err: any = await callWithOneRetry(async () => { n++; return {}; }, { ...base, validate: (r) => !!r.id }).catch((e) => e);
    expect(err.code).toBe('PAYPAL_BAD_RESPONSE');
    expect(n).toBe(1);
  });
});

describe('scrubFailureDetails', () => {
  it('keeps only allowlisted primitives and drops secrets at any depth', () => {
    const out = scrubFailureDetails(
      { paypal_issue: 'Bearer abc.def', paypal_debug_id: 'd1', headers: { authorization: 'x' }, receiver: 'p@x.com', deep: { a: { client_secret: 's' } } },
      { environment: 'live', correlationId: 'c' },
    );
    expect(out).toEqual({ environment: 'live', correlation_id: 'c', paypal_debug_id: 'd1' });
  });
});

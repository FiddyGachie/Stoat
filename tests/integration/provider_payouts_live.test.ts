import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { getPayPalGateway } from '../../src/modules/paypal/paypal.gateway.js';

// Talks to the real PayPal Sandbox Payouts API (0.01 USD to a placeholder address).
const ready = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

describe.skipIf(!ready)('PayPal Payouts API (real Sandbox)', () => {
  it('accepts a payout and reports its real status back', async () => {
    const id = `stoat-live-test-${Date.now()}`;
    const gw = getPayPalGateway();
    const created = await gw.createPayout({
      senderBatchId: id,
      emailSubject: 'Stoat sandbox payout test',
      items: [{ senderItemId: `${id}-1`, receiver: 'stoat-payout-test@example.com', amount: '0.01', currency: 'USD', note: 'Stoat integration test' }],
    });
    expect(created.batchId).toBeTruthy();
    expect(created.items).toHaveLength(1);
    expect(['PENDING', 'SUCCESS', 'UNCLAIMED', 'ONHOLD']).toContain(created.items[0].status);
    const read = await gw.getPayout(created.batchId);
    expect(read.batchId).toBe(created.batchId);
  });
});

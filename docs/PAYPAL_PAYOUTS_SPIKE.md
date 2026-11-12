# PayPal Payouts Capability Spike

Run at: 2026-11-09T23:33:22.169Z
Environment: PayPal Sandbox (https://api-m.sandbox.paypal.com)
Recipient: s***@example.com (placeholder, masked)

## Decision: GO. Payouts capability is ENABLED for this Sandbox app.

| # | Step | Result | HTTP | Detail |
|---|---|---|---|---|
| 1 | OAuth token with Payouts scope | PASS | 200 | token issued; payouts scope PRESENT (https://uri.paypal.com/payments/payouts); 15 scopes in total |
| 2 | Create payout batch (1 item, 0.01 USD, EMAIL) | PASS | 201 | batch 9KLA…M58 status PENDING |
| 3 | Query payout batch | PASS | 200 | batch_status PENDING, 1 item(s) |
| 4 | Query payout item | PASS | 200 | item NX8A…PQA transaction_status PENDING; sender_item_id echoed: true |
| 5 | Repeat the same sender_batch_id | PASS | 400 | PayPal REJECTED the duplicate: USER_BUSINESS_ERROR (User business error.). Stoat therefore never resends an unconfirmed create. |
| 6 | Ambiguous timeout handling | PASS |  | client aborted; the server may or may not have created the batch. PayPal offers no lookup by sender_batch_id, so Stoat marks the payout "requested", never resends, and waits for the PayPal payout webhook (or an operator checks PayPal Activity). |

## Apply

```
PAYPAL_PAYOUTS_ENABLED=true
PAYPAL_PAYOUTS_CAPABILITY_STATUS=enabled
```

## Limits of this evidence

- A Sandbox result proves the API path in Sandbox only. It does not prove production approval, marketplace compliance, payout limits or recipient onboarding.
- The payout went to a placeholder address and may stay UNCLAIMED/PENDING; the spike proves submission and query, not that a person received money.
- Identifiers are partially masked. No credentials appear in this file.

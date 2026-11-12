# Stoat v2.1 Demo: an autonomous deal that pays for itself

**Story.** A buyer agent needs a security review. It can hire a provider agent, but it has a strict budget and cannot pay for unverified work. Stoat lets the agents negotiate and execute the deal, then routes both the buyer's payment and the provider's payout through PayPal. Closing line: "AI negotiated and did the work. Evidence unlocked the obligation. PayPal moved the money. Stoat can prove what happened."

Target: under 3 minutes. Every call shown is real: the model, PayPal Sandbox orders and payouts. Label anything replayed on screen. Never show a canned or edited-in success.

Set up once: `npm run paypal:spike` (Payouts GO), `npm run dev`, `npm run console`, sign in as the operator.

| Time | Scene | What to show | Honest caveat to say |
|---|---|---|---|
| 0:00 | Mission | Buyer portal: mission with budget and a service that allows negotiation | |
| 0:15 | The AI negotiates | **Let my buyer agent negotiate**: model name, "live", recommendation, counteroffer with accepted or rejected-by-the-checks badge and reason | "The model proposes. The server checks the price against what the provider allows and the budget." |
| 0:40 | Deal and payment | **Accept this deal and pay**: redirected to PayPal Sandbox, approve with the Sandbox buyer | "Sandbox money. The PayPal app opens on a phone." |
| 1:00 | Work is proven | Provider model reviews the real fixture; Integrity or Deliveries shows the verifier result. If the verifier rejects, show the exact reasons and the revision | "Whatever the model returned is what we show, including a rejection." |
| 1:30 | Money Flow | Agreement row: buyer collection **captured**, provider **unpaid** | "A payable is not a payment." |
| 1:45 | Pay the provider | Settlement: release the funded batch, save and confirm the provider's masked PayPal address, **Review and approve payout**, **Send payout via PayPal** | "A separate approval, bound to the exact recipient and amounts." |
| 2:15 | Proof | Money Flow: payout batch id, item id, status from PayPal. Show **processing** until PayPal says SUCCESS; only then green | "Paid means PayPal confirmed the payout item." |
| 2:35 | Close | Integrity: all checks healthy | "AI negotiated and worked. Evidence unlocked the obligation. PayPal moved the money in both directions." |

If Payouts is unavailable the screen says **Provider payout unavailable: no provider payment was sent.** Show that state and the buyer capture. Do not substitute anything.

Rules: no credentials, full recipient addresses or tokens on screen; no private model reasoning; record a failed live attempt honestly.

## Evidence to capture during the run

Agreement and proposal ids; model id and mode; verifier checks and verdict; revision count; obligation and journal ids; PayPal order and capture ids; batch and approval ids; PayPal payout batch id, item id and item status; integrity response; `docs/EVIDENCE.md` regenerated with `npm run evidence`. Redact anything sensitive.

## Honest narration

Say "verified" only when the deterministic checks passed, "captured" only when PayPal confirmed the capture, "reconciled" only after amount, currency and ids matched, and "provider paid" only when PayPal reported the payout item SUCCESS. Rehearse with live calls at least once a day; label any replayed model output on screen.

## Recording rules

- Under 3 minutes (check the current Devpost limit before recording).
- Show the model name and live, recorded or replayed mode; show the PayPal Sandbox context.
- No private model reasoning, credentials, full recipient addresses or tokens on screen.
- Label anything replayed, on screen and in the narration.
- Never edit a failed live attempt into a success. Prefer one continuous transaction with readable statuses, and keep a short fallback recording of a genuine run.

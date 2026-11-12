# Stoat v2.1 Upgrade Report

Baseline commit: `bdfcbfc` plus uncommitted work (nothing in this upgrade is committed).
Source: the v2.1 strategic upgrade brief, now merged into the root documents (`SPEC.md` section 11, `PAYPAL.md`, `DATABASE.md`, `TEST_PLAN.md`, `CHANGES_v2.1.md`).
Tests are run with `npm run check` (type-checks, vitest, `verify:auth`, `verify:platform`, `verify:ui`).

## 1. Audit of the starting point (prompt 01)

| Area | Finding at the start of v2.1 | Action |
|---|---|---|
| Orders v2 collection | Real PayPal SDK calls, working (done in the v2.0 follow-up) | Kept; regression tested |
| Buyer pays at acceptance | Real order per agreement, capture via return link / webhook / sweep | Kept |
| Provider payouts | Plain-text PayPal email, button sent payouts directly, no approval | **Replaced**: encrypted recipient, bound one-time approval, item-level truth |
| Model output | **Unsafe**: with no `FIREWORKS_API_KEY` the adapter silently returned canned findings, and `.env` used `LLM_API_KEY`, so the "live" agent was fake. The demo and evidence scripts also hard-coded the provider's findings | **Fixed**: canned output deleted; missing key is `LLM_NOT_CONFIGURED`; scripts call the real model |
| Model configuration | Default `llama-v3p3-70b-instruct` is no longer served on the account (HTTP 404) | Default is now `gpt-oss-120b` (verified live) |
| Model sees the code | Prompt only named a fixture; the model never saw the files | Prompt now contains the real fixture files, marked as untrusted data |
| Negotiation | None | Real buyer-agent comparison and counteroffer with deterministic validation |
| PayPal-only guard | None | Startup guard, API guard, DB constraints, integrity metric |
| Money Flow view | None | New workspace and `GET /v1/money-flow` |
| API contract | `API_SPEC.yaml` listed 3 routes that do not exist | Corrected; v2.1 routes added; checked by `verify:ui` |

## 1a. Gap register status (from the strategic gap analysis)

| ID | Gap | Status |
|---|---|---|
| G01 | Orders capture pays the merchant only | Done: PayPal Payouts disbursement. Sandbox create and query real; a payout reaching a real receiver not yet shown |
| G02 | One capture treated as settlement | Done: separate collection and payout state machines |
| G03 | No payout recipient model | Done: encrypted, masked, human-verified recipient; snapshot on approval |
| G04 | No payout idempotency | Done: sender ids persisted first; DB uniqueness; unknown outcomes never resent |
| G05 | No provider payment status | Done: item-level status with the raw PayPal status kept |
| G06 | One approval for everything | Done: separate payout approval bound to amount, recipients, obligations, policy version |
| G07 | Negotiation not visible | Done: live comparison and counteroffer with deterministic verdicts |
| G08 | Payment confused with obligation | Done: `agreement_payments` and `payouts`; obligation `paid` only from a payout item |
| G09 | No partial-failure handling | Done: see `PAYPAL.md` section 7 |
| G10 | Merchant balance not modelled | Done by design: no balance is inferred; an insufficient-funds refusal leaves the payout failed and the obligation unpaid. No preflight balance query |
| G11 | Capture-only webhooks | Done: order, capture and payout events verified and deduplicated; query on ambiguity |
| G12 | Demo shows a payable, not a paid provider | Done in `docs/DEMO_SCRIPT.md`; recording not made yet |
| G13 | Provider-neutral payment adapter | Done: PayPal-only config, API and DB guards |
| G14 | Generic payment shape in the API | Partial: v2.1 routes and PayPal ids in responses; response schemas in `API_SPEC.yaml` are not fully typed |
| G15 | Two-stage economics hidden | Done: guides, Money Flow and submission text describe both legs |

## 2. PayPal Payouts capability spike (prompt 02)

`npm run paypal:spike` against the Sandbox app: **GO**. Token carries the payouts scope, a 0.01 USD payout was created and queried at batch and item level, a repeated `sender_batch_id` is **rejected** by PayPal (HTTP 400) rather than returning the original, and an aborted request leaves the outcome unknowable because PayPal has no lookup by sender id. Evidence: `docs/PAYPAL_PAYOUTS_SPIKE.md`.
Consequence in code: an unconfirmed create is never resent; it stays `requested` and waits for PayPal's payout webhook.

## 3. Migrations (forward only)

- `005_v2_1_paypal_governance.sql`: PayPal-only CHECK constraints and `direction` on payment tables (existing capture rows become `BUYER_COLLECTION`); `commercial_proposals`; `services.min_price`; `agreements.commercial_proposal_id`; `provider_paypal_profiles` (encrypted, keyed hash, masked); `payouts` snapshot columns; `approvals` bound columns.
- No payout id is ever backfilled. Existing obligations stay unpaid until a payout item is confirmed by PayPal.
- Obligation states added: `disbursement_pending`, `paid`, `payout_failed`, `payout_unknown`, `returned`. `settled` keeps its meaning: buyer money collected, provider unpaid.

## 4. Deliberate differences from the pack

- The pack models separate `paypal_payout_batches` and `paypal_payout_items` tables. Stoat pays one provider per PayPal batch, so one `payouts` row is both batch and item. It carries `sender_batch_id`, `sender_item_id`, the PayPal batch and item ids, and the item status. Splitting it would add a table with a 1:1 relationship.
- Collection approval and payout approval are separate approvals. Collection approval at acceptance is the buyer approving at PayPal.
- Negotiation floor (`min_price`) is set by the provider and never shown to the buyer or the model.

## 5. Acceptance matrix

PASS means a test or verifier check ran and passed. "Double" means PayPal's or the model's replies came from a test double, so the check proves Stoat's handling, not the provider.

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| AT-036 | Non-PayPal provider rejected by config and API | PASS | `provider_payouts.test.ts` "PayPal-only" (config, API 400, DB CHECK) |
| AT-037 | Counteroffer generated by a live model, validated deterministically | PASS | `verify:platform` PLAT-18 (live Fireworks model, `record` mode); bounds in `buyer_negotiation.test.ts` (double) |
| AT-038 | Accepted agreement cannot be mutated; price snapshot fixed | PASS | v2.0 `commerce_and_policy.test.ts` P0-08/09; negotiated terms snapshot checked in `buyer_negotiation.test.ts` |
| AT-039 | Orders collection creates, approves, captures, reconciles | PARTIAL | Create and refusal-before-approval: PASS (real Sandbox: PLAT-16, `agreement_funding_live.test.ts`). Capture and reconcile: PASS with a PayPal **double** (`agreement_funding.test.ts`). A real buyer approval at PayPal was **not** performed |
| AT-040 | Payouts capability spike with evidence | PASS | `docs/PAYPAL_PAYOUTS_SPIKE.md` (GO) |
| AT-041 | Payout batch created and queried; item reconciled | PARTIAL | Real Sandbox create and query: PASS (spike, `provider_payouts_live.test.ts`). Item reconciliation to `paid`: PASS with a **double** (`provider_payouts.test.ts`). No real money reached a real recipient |
| AT-042 | Duplicate payout submission pays once | PASS | `provider_payouts.test.ts` (approval replay, one `createPayout`); real duplicate behaviour in the spike |
| AT-043 | Collection success + payout failure leaves obligation unpaid | PASS | `provider_payouts.test.ts` "batch SUCCESS with a failed item" |
| AT-044 | Collection unresolved blocks payout | PASS | `provider_payouts.test.ts` "collection that is not captured" |
| AT-045 | Only reconciled PayPal item success marks obligation paid | PASS | `provider_payouts.test.ts` (UNCLAIMED/ONHOLD/PENDING stay unpaid; `paid_without_payout` integrity metric) |
| AT-046 | Dashboard shows both legs and exact statuses | PASS (API) / NOT RENDERED | `verify:platform` PLAT-19 and `provider_payouts.test.ts` Money Flow assertions. The workspace was type-checked and built, **not** viewed in a browser |
| AT-047 | Recipient immutable after payout approval; substitution denied and audited | PASS | `provider_payouts.test.ts` "recipient substituted after approval" (403, `PAYOUT_APPROVAL_REJECTED` event, no payout) |
| AT-048 | v2.0 P0 tests still pass | PASS | full vitest run, 13 files |

## 6. Security checks (prompt 06)

| Threat | Result |
|---|---|
| Recipient changed after approval | Blocked and audited (approval binds the recipient hash) |
| Prompt injection to move payee, amount or currency | Marked as data; the model has no payee field; counteroffers are re-validated; test with a "compromised" double |
| Approval replay or forged approval | Single use, expires in 15 minutes, bound to batch; forged ids refused |
| Duplicate or timed-out payout | One payout per approval; unknown outcomes are never resent |
| Batch SUCCESS with a failed item | Item status decides |
| Forged webhook | Verified by PayPal's API; fails closed |
| Agent reading or setting a recipient, approving or sending a payout | 403 on every route |
| Tenant leakage in recipients, payouts, money flow | Tenant scoped; checked in PLAT-17 and PLAT-19 |
| Recipient in logs, prompts, UI | Encrypted at rest, masked everywhere; plaintext decrypted only to build the PayPal request |
| Non-PayPal provider | Startup error, API 400, database CHECK |

## 7. Not done or not provable here

- A real buyer approval and capture at PayPal, and a payout that reaches a real recipient account (needs a person and a Sandbox buyer/receiver).
- The new workspaces were not opened in a browser.
- Webhook registration needs a public HTTPS URL (`npm run paypal:webhook`).
- Sandbox success does not show production approval for Payouts, marketplace compliance, limits or recipient onboarding. Stoat does not claim escrow, custody or atomic split settlement.
- **Decision needed:** you asked for LangChain TypeScript agents, but the pack's gap analysis says not to add a second model framework. Stoat's existing adapter and runtime already give structured, schema-validated, recorded model calls, so I did not add LangChain. Say so if you want it anyway and I will wrap the same two calls (comparison, counteroffer) and the review call with it.

## 8. Agents that finish the mission (after the upgrade)

| Change | Why |
|---|---|
| Provider prompt includes the mission and negotiated terms (as data); output adds `summary`, `files_reviewed` (every file) and a `recommendation` per finding | The review now answers the buyer's actual mission and says what to fix |
| `LlmAdapter.executeValidated`: one corrective retry with the exact error, then fail closed; used by the provider, negotiation and treasury calls | Live models occasionally return malformed JSON; one retry fixes that without ever inventing output |
| Fireworks JSON Schema mode (`response_format: json_schema`) for every agent call, from the same zod schemas Stoat validates with (`zod-to-json-schema` 3.25.2, pinned) | Constrains generation to the right shape at the source. In 8 live negotiations after the change, no answer needed a retry (before: 2 of 6), and PLAT-18 passed |
| `GET /v1/agreements/{id}/result` and **View result** in the Buyer portal | The buyer can read and act on the verified work |
| Treasury agent: `POST /v1/settlement/treasury-plan` and **Let the treasury agent plan payment** in Settlement | A model proposes batches and the PayPal route; deterministic checks decide; a person approves |

Live check (Fireworks `gpt-oss-120b`, embedded database): the hosted review covered all three files, returned four grounded findings with fixes and passed verification on the first attempt; the treasury agent then proposed one `collect_via_paypal_order` batch, awaiting approval. The new console panels were type-checked but not opened in a browser.

## 9. Cleanup pass (after the upgrade)

| Change | Why |
|---|---|
| Removed the second copy of 27 unversioned routes (about 585 lines in `src/api/app.ts`); unversioned paths now alias the `/v1` handlers with a `Deprecation` header | The copies were weaker: no role checks on missions, quotes and agreements, no human-only guard on PayPal create-order and capture, and agent runs not scoped to the caller. One implementation now enforces every rule |
| One `toPayPalAmount` and one `fetchPayPalToken` in the PayPal gateway | Three copies of the amount formatter and three token requests |
| Payout totals and approval comparison use exact decimals | Floating-point sums and comparisons were used on money |
| Removed unused code: dead exports in `decimal.ts`, `errors.ts`, `connection.ts`; unused imports and locals across server, scripts and tests; `noUnusedLocals` enabled in both tsconfigs | Keeps it from coming back |
| Removed unused dependencies `@modelcontextprotocol/sdk`, `supertest`, `@types/supertest` | Never imported |
| Removed unread settings `APP_BASE_URL`, `API_BASE_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `DEMO_MODE`, `LOG_LEVEL`, `LLM_MODEL_FAST`, `VITE_LLM_MODE`; wired `AGENT_MAX_*` into the runtime | Documented but never read |
| Console model badge now reads `GET /v1/health` | A build flag could disagree with the server |
| Deployment default `LLM_MODE=record` | `replay` made new negotiation prompts fail |
| `RECIPIENT_ENCRYPTION_KEY` accepts any random value of 32 or more characters | A generated deployment secret might not decode to exactly 32 bytes |
| MCP deny list includes every v2.1 money action | Explicit refusal instead of "unknown tool" |
| Version 2.1.0 everywhere (`package.json`, health, MCP, landing page); root design docs and guides updated; `ui-ux-redesign-agent.md` archived (superseded) | One consistent version and document set |

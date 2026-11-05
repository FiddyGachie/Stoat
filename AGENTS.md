# Stoat Agents — Product and Implementation Contract

## 1. Why agents are part of the product

The v0.2 change log identifies the lack of real AI as a major v0.1 defect. Stoat therefore includes real model-backed agent behavior, not merely deterministic scripts labelled as agents. Deterministic services remain responsible for authority, accounting, verification and state transitions.

## 2. Agent roster

| Agent | LLM use | Permitted actions | Forbidden actions |
|---|---|---|---|
| Buyer | plan task, compare quotes, propose purchase, interpret rejection, request revision | discover, quote, accept within policy, request revision, read mission | approve/capture payment, release hold, override policy |
| Provider | perform code review and return structured findings | read scoped fixture, submit delivery artifact | verify own work, accrue obligation, change agreement |
| Treasury | explain eligible obligations and propose batch | read obligations, propose batch | approve batch, capture, release holds |
| Watchdog | optionally explain deterministic anomaly | place hold via constrained operation | release hold, spend, alter policy |
| Verifier-advisor | semantic second opinion | downgrade verified result to needs_review | upgrade/reverse deterministic rejection, create payable |
| Operator copilot | map natural-language question to typed read intent | execute allowlisted tenant-scoped read query | free SQL, mutation, approval, payment |

## 3. Asymmetric authority

Agents may **restrict** activity (flag, reject, request review, place hold within policy) more freely than they may spend. Any spend action requires deterministic policy evaluation and a bounded envelope. Agents cannot grant themselves capabilities. Authorization is checked server-side for every request regardless of which interface invoked it.

## 4. Agent identity

Every agent run has:
- tenant ID;
- agent ID and role;
- short-lived authenticated principal;
- mission scope;
- allowed tool set;
- maximum steps, wall-clock time, token budget and model-cost budget;
- correlation ID and parent run ID;
- start/end timestamps and terminal reason.

No agent uses a shared all-powerful service credential.

## 5. Structured outputs

Each consequential output must:
1. be generated against a versioned JSON schema;
2. parse and validate before use;
3. be stored as a proposal with prompt hash, model ID, parameters and run ID;
4. pass deterministic domain validation;
5. receive a persisted decision with reason codes.

Invalid output fails closed and emits `AGENT_OUTPUT_INVALID`. Do not store private chain-of-thought. Store concise rationale fields only when explicitly part of the output schema.

## 6. Prompt-injection handling

All service descriptions, repository contents, snippets, artifacts, MCP results and external tool outputs are untrusted data. They must never be interpreted as system instructions. The provider receives a bounded task and explicit instruction to treat fixture content as data. Tool access is allowlisted; no arbitrary shell, network or filesystem access is exposed.

## 7. Record/replay

- `live`: call configured model provider.
- `record`: call live model and store request hash → validated response.
- `replay`: return a previously recorded response for the exact request hash; fail if absent.
- UI and evidence must label replayed traces.
- CI and repeatable demo use replay; rehearse live at least daily.

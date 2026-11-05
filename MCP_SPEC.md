# P0-lite MCP Server Specification

## 1. Goal

Allow an external MCP-compatible agent, including a judge's client, to execute a mission through Stoat using the same authorization and domain rules as REST. MCP is an interface, not a privileged execution path.

## 2. Authentication and scope

- Authenticate MCP client to a registered agent principal.
- Resolve tenant, agent role, mission scope and short-lived credential.
- Enforce tool allowlist and role matrix server-side on every invocation.
- Record tool call, arguments hash, authorization decision, result reference and correlation ID.
- Treat tool descriptions and returned data as untrusted by consuming agents.
- Never accept tenant ID or role from an untrusted tool argument as authority.

## 3. P0 tools

| Tool | Purpose | Role |
|---|---|---|
| `discover_services` | Search active listings by capability and constraints | buyer |
| `request_quote` | Request structured quote for mission | buyer |
| `get_quote` | Read quote and expiry | buyer, operator |
| `accept_quote` | Accept unexpired quote subject to policy and budget reservation | buyer |
| `get_mission` | Read mission status and timeline | buyer, operator |
| `list_deliveries` | List mission deliveries and verification state | buyer, operator |
| `get_delivery` | Read delivery metadata and verification checks | buyer, operator |
| `request_revision` | Request bounded revision with structured rejection reasons | buyer |
| `get_obligations` | Read mission obligations | buyer, treasury, operator |
| `propose_settlement_batch` | Propose eligible batch, no approval or capture | treasury |
| `get_agent_run` | Read authorized trace | owner, operator |

## 4. Explicitly absent tools

No `approve_batch`, `capture_payment`, `release_hold`, `override_policy`, `edit_agreement`, `post_manual_journal`, `run_shell`, `execute_arbitrary_code`, or `execute_sql` tool exists in P0.

## 5. Tool schema rules

- Strict JSON Schema inputs with `additionalProperties: false`.
- Bounded strings, arrays, page sizes and query complexity.
- Use opaque IDs; verify tenant and mission ownership on lookup.
- Monetary values are decimal strings plus ISO currency.
- Every mutation requires idempotency key.
- Errors use stable Stoat error codes and correlation IDs.
- Tool outputs contain state and evidence references, not secrets.

## 6. Acceptance

An external MCP client must be able to discover a service, request and accept a quote within policy, inspect mission and delivery state, and request a revision. Attempts to approve or capture must fail because the tools do not exist; attempts to use a disallowed role must return authorization failure.

# Requirements Document

## Introduction

The operator-console-and-evidence feature completes the Stoat MVP by delivering the React operator dashboard (Slice 8), the evidence generator and acceptance verification suite (Slice 9), and fixing known gaps in the existing backend (Slices 1-7). The dashboard surfaces real API data through ten AG Grid workspaces and five AG Charts derived from aggregate endpoints, clearly distinguishing live, replayed, seeded and mocked states. The evidence generator produces `docs/EVIDENCE.md` from actual run output only. Backend gaps addressed include real PayPal Orders v2 Sandbox integration with labelled fallback, audit logging for sensitive actions, the `/v1` API version prefix, health and readiness endpoints, a served OpenAPI 3.1 contract, server and worker entry points, and TypeScript compilation fixes. A demo runner script executes the four-beat signature mission end to end. This feature satisfies acceptance gates P0-23 (dashboard), P0-24 (charts), P0-26 (evidence), and P0-30 (demo honesty), and contributes to P0-17, P0-18, P0-19, P0-20 and P0-29.

## Glossary

- **Operator_Console**: The React + Vite single-page application serving the Stoat control centre.
- **API**: The Express backend exposing REST endpoints under the /v1 prefix.
- **Dashboard**: The AG Grid and AG Charts control centre rendered inside the Operator_Console.
- **Workspace**: A single AG Grid panel within the Dashboard (e.g., Economy overview, Agents, Integrity).
- **Integrity_Panel**: The Dashboard workspace showing the live integrity report from `GET /v1/integrity`.
- **Evidence_Generator**: The `pnpm evidence` script that runs the demo and writes `docs/EVIDENCE.md`.
- **Demo_Runner**: The `pnpm demo` script that executes the four-beat end-to-end mission.
- **Agent_Trace**: The ordered agent_steps and llm_proposals recorded for an agent run.
- **Live_Mode**: `LLM_MODE=live` — the LLM adapter calls the configured model provider.
- **Replay_Mode**: `LLM_MODE=replay` — the LLM adapter serves recorded responses by request hash.
- **Record_Mode**: `LLM_MODE=record` — the LLM adapter calls the provider and stores responses.
- **Seeded_Data**: Records inserted by the seed script (tenants, agents, services, accounts, policy).
- **Mocked_PayPal**: The PayPal_Service operating without real Sandbox credentials, generating deterministic IDs.
- **PayPal_Service**: The payment adapter implementing Orders v2 create, capture, webhook and reconciliation.
- **Audit_Log**: A record in the `audit_logs` table capturing actor, action, resource, outcome, reason and correlation.
- **OpenAPI_Contract**: The versioned OpenAPI 3.1 document describing the /v1 API.
- **/v1_Prefix**: The mandatory version prefix on all API routes.
- **Readiness_Endpoint**: `GET /v1/ready` reporting application and database readiness.
- **Server_Entry**: The `src/index.ts` module that starts the API process.
- **Worker_Entry**: The `src/worker.ts` module that starts the PostgreSQL job worker.
- **Aggregate_Endpoint**: A backend read endpoint returning computed summary data for a chart.
- **Money_Column**: Any Dashboard column displaying a monetary amount.

## Requirements

### Requirement 1: Operator Console Application Shell

**User Story:** As an operator, I want a web console that connects to the Stoat API, so that I can monitor and control autonomous agent commerce.

#### Acceptance Criteria

1. THE Operator_Console SHALL render a single-page application built with React and Vite.
2. THE Operator_Console SHALL provide navigation between the ten Dashboard workspaces defined in AG_GRID.md.
3. WHEN the API is unreachable, THE Operator_Console SHALL display an error state with a retry action.
4. WHILE a workspace is loading data, THE Operator_Console SHALL display a loading state.
5. THE Operator_Console SHALL authenticate to the API using a bearer token provided through configuration.

### Requirement 2: AG Grid Data Binding

**User Story:** As an operator, I want AG Grid workspaces populated from real API data, so that I can inspect actual system state instead of mock arrays.

#### Acceptance Criteria

1. THE Dashboard SHALL render all workspace rows from API responses, not hardcoded mock arrays.
2. THE Dashboard SHALL use a stable `getRowId` based on each row's immutable identifier.
3. WHEN an operator sorts or filters a workspace, THE Dashboard SHALL map the operation to allowlisted API query parameters.
4. WHILE a workspace dataset exceeds one page, THE Dashboard SHALL request additional rows using server-side or cursor pagination.
5. WHEN an operator selects a row, THE Dashboard SHALL display a detail panel with drill-down information.
6. IF a workspace query returns zero rows, THE Dashboard SHALL display an empty state.
7. THE Dashboard SHALL display currency in every Money_Column.

### Requirement 3: Economy Overview Workspace

**User Story:** As an operator, I want an economy overview, so that I can see mission counts, obligations by status, captured and reconciled totals, policy denials and integrity status at a glance.

#### Acceptance Criteria

1. THE Dashboard SHALL render an Economy Overview workspace showing mission counts, obligations by status, captured totals, reconciled totals, policy denials and the integrity status.
2. WHILE the integrity status is `violation_detected`, THE Economy Overview workspace SHALL display a visible warning indicator.
3. THE Economy Overview workspace SHALL source every displayed value from API responses.

### Requirement 4: Agents Workspace and Trace Drill-Down

**User Story:** As an operator, I want to inspect agents and drill into their run traces, so that I can verify agent identity, role, status, limits and step-by-step behaviour.

#### Acceptance Criteria

1. THE Dashboard SHALL render an Agents workspace listing agent identity, role, status, current run and run limits.
2. WHEN an operator selects an agent run, THE Dashboard SHALL display the Agent_Trace including agent_steps and llm_proposals.
3. WHERE an agent run executed in Replay_Mode, THE Dashboard SHALL label the trace as a replayed agent trace.

### Requirement 5: Exchange Workspace

**User Story:** As an operator, I want to browse the service registry, so that I can see provider, capability, price and verification profile for each service.

#### Acceptance Criteria

1. THE Dashboard SHALL render an Exchange workspace listing services with provider, capability, price, currency and verification profile.
2. THE Exchange workspace SHALL display the unit price as a decimal string with currency in the Money_Column.

### Requirement 6: Quotes and Agreements Workspace

**User Story:** As an operator, I want to review quotes and agreements, so that I can verify scope, price, expiry, policy decision and agreement immutability.

#### Acceptance Criteria

1. THE Dashboard SHALL render a Quotes and Agreements workspace showing scope, price, currency, expiry and policy decision.
2. WHEN an operator opens an agreement, THE Dashboard SHALL display an immutable agreement view that cannot be edited.
3. THE Quotes and Agreements workspace SHALL display the policy decision identifier and result for each agreement.

### Requirement 7: Event Stream Workspace

**User Story:** As an operator, I want to view the ordered economic event stream, so that I can audit actor actions, mission correlation and hash-chain continuity.

#### Acceptance Criteria

1. THE Dashboard SHALL render an Event Stream workspace listing events ordered by sequence with actor, mission, correlation identifier and event type.
2. THE API SHALL expose an endpoint that lists economic events scoped to the authenticated tenant.
3. THE Event Stream workspace SHALL display hash-chain status for each event.
4. WHEN an event hash chain is broken, THE Event Stream workspace SHALL display a broken-chain indicator.

### Requirement 8: Deliveries Workspace

**User Story:** As an operator, I want to inspect deliveries, so that I can review the artifact, provider run, verifier verdict, individual checks and revision history.

#### Acceptance Criteria

1. THE Dashboard SHALL render a Deliveries workspace listing artifact identifier, provider run, verifier verdict and revision history.
2. WHEN an operator expands a delivery, THE Dashboard SHALL display the individual verification checks stored in `verifications.checks`.
3. THE Deliveries workspace SHALL display the delivery status as one of `pending`, `verified`, `rejected` or `needs_review`.

### Requirement 9: Obligations Workspace

**User Story:** As an operator, I want to review obligations, so that I can see amount, currency, agreement, status, reservation and hold for each payable.

#### Acceptance Criteria

1. THE Dashboard SHALL render an Obligations workspace listing amount, currency, agreement, status, reservation and hold.
2. WHILE an obligation has an active hold, THE Obligations workspace SHALL display a hold indicator.
3. THE Obligations workspace SHALL display the amount as a decimal string with currency in the Money_Column.

### Requirement 10: Settlement Workspace

**User Story:** As an operator, I want to inspect settlement batches, so that I can verify batch items, approval, PayPal order and capture, webhook and reconciliation state.

#### Acceptance Criteria

1. THE Dashboard SHALL render a Settlement workspace listing batch items, approval status, PayPal order identifier, capture identifier, webhook status and reconciliation verdict.
2. THE Settlement workspace SHALL display batch total and item amounts as decimal strings with currency in the Money_Column.
3. WHEN a batch has not been reconciled, THE Settlement workspace SHALL display the payment status as pending or unknown rather than reconciled.

### Requirement 11: Policy and Trust Workspace

**User Story:** As an operator, I want to review policy and trust events, so that I can inspect policy versions, denials, holds, approvals and watchdog events.

#### Acceptance Criteria

1. THE Dashboard SHALL render a Policy and Trust workspace showing policy version, denials, holds, approvals and watchdog events.
2. THE Policy and Trust workspace SHALL display the reason codes for each policy denial.
3. WHERE a hold is active, THE Policy and Trust workspace SHALL display the hold reason and the actor who placed the hold.

### Requirement 12: Integrity Workspace

**User Story:** As an operator, I want a live integrity panel, so that I can confirm that the ledger balances, the event chain is continuous and no invariants are violated.

#### Acceptance Criteria

1. THE Dashboard SHALL render an Integrity_Panel sourced from `GET /v1/integrity`.
2. THE Integrity_Panel SHALL display balance by currency, chain continuity, duplicate obligations count, orphan reservations count, batch sum mismatch count and capture reconciliation status.
3. WHILE every integrity metric is zero and the journal balances, THE Integrity_Panel SHALL display a healthy status.
4. IF any integrity metric is non-zero, THE Integrity_Panel SHALL display a violation_detected status.

### Requirement 13: AG Charts From Real Aggregates

**User Story:** As an operator, I want charts derived from real API aggregates, so that I can visualise obligations by status, mission spend versus budget, event volume, capture and reconciliation outcomes, and policy denials by reason.

#### Acceptance Criteria

1. THE Dashboard SHALL render five AG Charts: obligations by status, mission spend versus budget, event volume over time, capture and reconciliation outcomes, and policy denials by reason.
2. THE Dashboard SHALL source every chart from a real Aggregate_Endpoint, not simulated data.
3. WHEN an operator clicks a chart segment, THE Dashboard SHALL filter the corresponding workspace to the selected value.
4. THE API SHALL expose Aggregate_Endpoints returning obligations by status, mission spend versus budget, event volume over time, capture and reconciliation outcomes, and policy denials by reason.

### Requirement 14: Status Honesty Labelling

**User Story:** As an operator, I want live, replayed, seeded and mocked states visibly distinguished, so that I never mistake a replayed trace, seeded record or mocked payment for a real one.

#### Acceptance Criteria

1. WHERE an agent run executed in Replay_Mode, THE Dashboard SHALL label the trace as replayed agent trace.
2. WHERE the PayPal_Service operates as Mocked_PayPal, THE Dashboard SHALL label payment states as mocked.
3. WHEN a record originates from Seeded_Data, THE Dashboard SHALL distinguish seeded records from live-produced records.
4. THE Dashboard SHALL display a visible indicator distinguishing live, replayed, seeded and mocked states.

### Requirement 15: Dashboard Accessibility

**User Story:** As an operator, I want keyboard navigation and accessible labels, so that I can use the Dashboard without a mouse and with assistive technology.

#### Acceptance Criteria

1. THE Dashboard SHALL support keyboard navigation across workspaces and grid rows.
2. THE Dashboard SHALL provide accessible labels for interactive controls and status indicators.
3. THE Dashboard SHALL display currency in every Money_Column so that monetary values are never ambiguous.

### Requirement 16: Backend API Endpoints for Dashboard

**User Story:** As an operator, I want the API to expose the read endpoints the Dashboard needs, so that every workspace and chart is backed by real data.

#### Acceptance Criteria

1. THE API SHALL expose an endpoint listing agents scoped to the authenticated tenant.
2. THE API SHALL expose an endpoint listing economic events scoped to the authenticated tenant.
3. THE API SHALL expose an endpoint listing deliveries with verification checks scoped to the authenticated tenant.
4. THE API SHALL expose an endpoint listing policy decisions scoped to the authenticated tenant.
5. THE API SHALL expose an endpoint listing holds scoped to the authenticated tenant.
6. THE API SHALL expose an endpoint listing journal transactions and journal lines scoped to the authenticated tenant.

### Requirement 17: Evidence Generator

**User Story:** As an operator, I want `pnpm evidence` to write an evidence document from real run output, so that acceptance can be verified from actual data.

#### Acceptance Criteria

1. THE Evidence_Generator SHALL execute the Demo_Runner in Replay_Mode.
2. THE Evidence_Generator SHALL execute selected live checks using the configured model.
3. THE Evidence_Generator SHALL write `docs/EVIDENCE.md` from actual run output only.
4. THE Evidence_Generator SHALL never fabricate identifiers, transaction states, provider responses or screenshots.
5. IF the Demo_Runner fails at any beat, THE Evidence_Generator SHALL record the failure honestly in `docs/EVIDENCE.md`.
6. THE Evidence_Generator SHALL label replayed traces and mocked payments in the evidence document.

### Requirement 18: Demo Runner

**User Story:** As an operator, I want `pnpm demo` to run the four-beat signature mission end to end, so that I can demonstrate the verified-delivery payments flow.

#### Acceptance Criteria

1. THE Demo_Runner SHALL create a mission targeting the controlled repository fixture.
2. THE Demo_Runner SHALL discover a service, request a quote and accept the quote after deterministic policy and budget reservation.
3. THE Demo_Runner SHALL execute the provider LLM code review and submit the delivery artifact.
4. THE Demo_Runner SHALL run the grounded verifier including at least one rejection and one revision recovery.
5. THE Demo_Runner SHALL accrue one obligation after verified delivery, post balanced journal entries and propose a settlement batch.
6. THE Demo_Runner SHALL approve the batch as a human, create a PayPal order, capture the payment and reconcile the result.
7. THE Demo_Runner SHALL compute and report the integrity status at the end of the run.

### Requirement 19: Real PayPal Orders v2 Integration

**User Story:** As an operator, I want real PayPal Sandbox orders created and captured server-side, so that the payment proof is genuine.

#### Acceptance Criteria

1. WHERE real PayPal Sandbox credentials are configured, THE PayPal_Service SHALL obtain an OAuth token server-side and create a real Orders v2 order.
2. WHERE real PayPal Sandbox credentials are configured, THE PayPal_Service SHALL capture the order server-side after buyer approval.
3. THE PayPal_Service SHALL use a deterministic PayPal request identifier for order creation idempotency.
4. THE PayPal_Service SHALL verify webhook signatures using a documented verification method.
5. WHERE real PayPal Sandbox credentials are absent, THE PayPal_Service SHALL fall back to Mocked_PayPal and label every payment state as mocked.
6. IF a capture request times out after submission, THE PayPal_Service SHALL mark the transaction status as unknown and query PayPal before retrying.

### Requirement 20: Audit Logging

**User Story:** As an operator, I want sensitive actions recorded in the audit log, so that every approval, capture, policy decision and hold is traceable to an actor.

#### Acceptance Criteria

1. WHEN a human approves or rejects a settlement batch, THE API SHALL write an Audit_Log recording actor, resource, outcome, reason and correlation identifier.
2. WHEN a PayPal capture is submitted, THE API SHALL write an Audit_Log recording actor, resource and outcome.
3. WHEN a policy decision is recorded, THE API SHALL write an Audit_Log recording actor, resource, outcome and reason codes.
4. WHEN a hold is placed, THE API SHALL write an Audit_Log recording actor, resource and reason.
5. THE Audit_Log SHALL record actor type, actor identifier, action, resource type, resource identifier, correlation identifier, outcome and reason.
6. THE Audit_Log SHALL never store credentials or full prompts containing secrets.

### Requirement 21: API Versioning /v1 Prefix

**User Story:** As an operator, I want all API routes under the /v1 prefix, so that the API contract is versioned as specified.

#### Acceptance Criteria

1. THE API SHALL serve every route under the /v1_Prefix.
2. WHEN a client requests a route without the /v1_Prefix, THE API SHALL return a 404 response.

### Requirement 22: Health and Readiness Endpoints

**User Story:** As an operator, I want health and readiness endpoints, so that I can verify application and database readiness.

#### Acceptance Criteria

1. THE API SHALL expose `GET /v1/health` returning the application status and version.
2. THE API SHALL expose a Readiness_Endpoint returning the application status and database connectivity.
3. WHEN the database is unreachable, THE Readiness_Endpoint SHALL return a not-ready status.

### Requirement 23: OpenAPI Contract Serving

**User Story:** As an operator, I want the OpenAPI contract served and validated, so that SDK tooling can consume a versioned contract.

#### Acceptance Criteria

1. THE API SHALL serve an OpenAPI_Contract document at a public endpoint.
2. THE OpenAPI_Contract SHALL describe every /v1 route, request schema, response schema and error code.
3. THE OpenAPI_Contract SHALL use OpenAPI 3.1 format.

### Requirement 24: Server and Worker Entry Points

**User Story:** As a developer, I want server and worker entry points, so that the API process and the job worker start from the documented package scripts.

#### Acceptance Criteria

1. THE Server_Entry SHALL start the Express API process and listen on the configured port.
2. THE Worker_Entry SHALL start the PostgreSQL job worker that claims queued jobs using `FOR UPDATE SKIP LOCKED`.
3. WHEN the Server_Entry starts, THE API SHALL validate required environment variables and fail closed if a required variable is absent.

### Requirement 25: TypeScript Compilation

**User Story:** As a developer, I want the project to compile without errors, so that the build passes before deployment.

#### Acceptance Criteria

1. THE project SHALL pass `tsc --noEmit` with zero compilation errors.
2. THE API SHALL cast request header values to single strings where a string is required.
3. THE MCP server SHALL construct the MissionsService with the parameter signature declared by the service.

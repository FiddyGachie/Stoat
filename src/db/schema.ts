/**
 * Drizzle ORM schema — mirrors all SQL migrations 001–008.
 *
 * This file is the single source of truth for schema generation (`pnpm db:generate`)
 * and direct pushes (`pnpm db:push`). The raw SQL migrations in src/db/migrations/
 * are still used for the custom migration runner; Drizzle migrations (in src/db/drizzle/)
 * are used when working directly with Supabase via Drizzle Kit.
 */

import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── 1. Tenants ────────────────────────────────────────────────────────────────
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 2. Users ──────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("operator"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 3. Agents ─────────────────────────────────────────────────────────────────
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // added by migration 002
  ownerUserId: uuid("owner_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  role: text("role").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  scopes: jsonb("scopes").notNull().default([]),
  credentialHash: text("credential_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 4. Agent Delegations ──────────────────────────────────────────────────────
export const agentDelegations = pgTable("agent_delegations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  delegatorId: uuid("delegator_id")
    .notNull()
    .references(() => agents.id),
  delegateId: uuid("delegate_id")
    .notNull()
    .references(() => agents.id),
  allowedActions: jsonb("allowed_actions").notNull().default([]),
  serviceScope: jsonb("service_scope").notNull().default([]),
  maxAmount: numeric("max_amount", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 5. Services ───────────────────────────────────────────────────────────────
export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => agents.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  pricingModel: text("pricing_model").notNull().default("fixed_unit"),
  unitPrice: numeric("unit_price", { precision: 20, scale: 6 }).notNull(),
  // added by migration 005 — may be null (listed price is final)
  minPrice: numeric("min_price", { precision: 20, scale: 6 }),
  currency: text("currency").notNull().default("USD"),
  unit: text("unit").notNull().default("run"),
  constraints: jsonb("constraints").notNull().default({}),
  schema: jsonb("schema").notNull().default({}),
  verificationProfile: jsonb("verification_profile").notNull().default({}),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 6. Missions ───────────────────────────────────────────────────────────────
export const missions = pgTable("missions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  buyerId: uuid("buyer_id")
    .notNull()
    .references(() => agents.id),
  title: text("title").notNull(),
  brief: text("brief").notNull(),
  budget: numeric("budget", { precision: 20, scale: 6 }).notNull(),
  reservedBudget: numeric("reserved_budget", { precision: 20, scale: 6 })
    .notNull()
    .default("0"),
  currency: text("currency").notNull().default("USD"),
  deadline: timestamp("deadline", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("created"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 7. Quote Requests ─────────────────────────────────────────────────────────
export const quoteRequests = pgTable("quote_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  buyerId: uuid("buyer_id")
    .notNull()
    .references(() => agents.id),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => services.id),
  requestedScope: jsonb("requested_scope").notNull().default({}),
  quantity: numeric("quantity", { precision: 20, scale: 6 })
    .notNull()
    .default("1"),
  currency: text("currency").notNull().default("USD"),
  deadline: timestamp("deadline", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("requested"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 8. Quotes ─────────────────────────────────────────────────────────────────
export const quotes = pgTable("quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  quoteRequestId: uuid("quote_request_id").references(() => quoteRequests.id, {
    onDelete: "set null",
  }),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => services.id),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => agents.id),
  price: numeric("price", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  terms: jsonb("terms").notNull().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("offered"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 9. Policy Versions ────────────────────────────────────────────────────────
export const policyVersions = pgTable("policy_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  rules: jsonb("rules").notNull().default({}),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 10. Policy Decisions ──────────────────────────────────────────────────────
export const policyDecisions = pgTable("policy_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id").notNull(),
  policyVersionId: uuid("policy_version_id").references(
    () => policyVersions.id,
  ),
  result: text("result").notNull(),
  reasonCodes: jsonb("reason_codes").notNull().default([]),
  context: jsonb("context").notNull().default({}),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 11. Agreements ────────────────────────────────────────────────────────────
export const agreements = pgTable("agreements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id")
    .notNull()
    .references(() => missions.id),
  quoteId: uuid("quote_id")
    .notNull()
    .references(() => quotes.id),
  buyerId: uuid("buyer_id")
    .notNull()
    .references(() => agents.id),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => agents.id),
  terms: jsonb("terms").notNull().default({}),
  price: numeric("price", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  maxRevisions: integer("max_revisions").notNull().default(2),
  revisionCount: integer("revision_count").notNull().default(0),
  status: text("status").notNull().default("accepted"),
  policyDecisionId: uuid("policy_decision_id")
    .notNull()
    .references(() => policyDecisions.id),
  // added by migration 003
  fundingStatus: text("funding_status").notNull().default("unfunded"),
  // added by migration 005
  commercialProposalId: uuid("commercial_proposal_id"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 12. Economic Events (append-only hash chain) ──────────────────────────────
export const economicEvents = pgTable("economic_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  sequence: integer("sequence").notNull(),
  eventType: text("event_type").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: uuid("actor_id").notNull(),
  correlationId: uuid("correlation_id").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  amount: numeric("amount", { precision: 20, scale: 6 }),
  currency: text("currency"),
  payload: jsonb("payload").notNull().default({}),
  payloadHash: text("payload_hash").notNull(),
  previousHash: text("previous_hash"),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 13. Artifacts ─────────────────────────────────────────────────────────────
export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  contentHash: text("content_hash").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  contentType: text("content_type").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 14. Deliveries ────────────────────────────────────────────────────────────
export const deliveries = pgTable("deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreements.id),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => agents.id),
  agentRunId: uuid("agent_run_id"),
  artifactId: uuid("artifact_id")
    .notNull()
    .references(() => artifacts.id),
  declaredResult: jsonb("declared_result").notNull().default({}),
  revisionNumber: integer("revision_number").notNull().default(0),
  status: text("status").notNull().default("submitted"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 15. Verifications ─────────────────────────────────────────────────────────
export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  deliveryId: uuid("delivery_id")
    .notNull()
    .references(() => deliveries.id),
  verdict: text("verdict").notNull(),
  checks: jsonb("checks").notNull().default([]),
  verifierVersion: text("verifier_version").notNull(),
  reasons: jsonb("reasons").notNull().default([]),
  verifiedAt: timestamp("verified_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 16. Obligations ───────────────────────────────────────────────────────────
export const obligations = pgTable("obligations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreements.id),
  missionId: uuid("mission_id")
    .notNull()
    .references(() => missions.id),
  buyerId: uuid("buyer_id")
    .notNull()
    .references(() => agents.id),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => agents.id),
  amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("payable"),
  accruedAt: timestamp("accrued_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 17. Chart of Accounts ─────────────────────────────────────────────────────
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  accountCode: text("account_code").notNull(),
  name: text("name").notNull(),
  normalBalance: text("normal_balance").notNull(),
  currency: text("currency").notNull().default("USD"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 18. Journal Transactions ──────────────────────────────────────────────────
export const journalTransactions = pgTable("journal_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  sourceEventId: uuid("source_event_id").references(() => economicEvents.id),
  reference: text("reference").notNull(),
  status: text("status").notNull().default("posted"),
  effectiveAt: timestamp("effective_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // 008: ledger entry sequence (GENERATED BY DEFAULT AS IDENTITY)
  postingSeq: bigint("posting_seq", {
    mode: "number",
  }).generatedByDefaultAsIdentity(),
});

// ── 19. Journal Lines ─────────────────────────────────────────────────────────
export const journalLines = pgTable("journal_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => journalTransactions.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  debit: numeric("debit", { precision: 20, scale: 6 }).notNull().default("0"),
  credit: numeric("credit", { precision: 20, scale: 6 }).notNull().default("0"),
  currency: text("currency").notNull().default("USD"),
  sequence: integer("sequence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // 008: set on every line of account 2103
  walletId: uuid("wallet_id").references((): AnyPgColumn => wallets.id),
});

// ── 20. Settlement Batches ────────────────────────────────────────────────────
export const settlementBatches = pgTable("settlement_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("USD"),
  totalAmount: numeric("total_amount", { precision: 20, scale: 6 }).notNull(),
  status: text("status").notNull().default("proposed"),
  proposedBy: uuid("proposed_by").notNull(),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 21. Settlement Batch Items ────────────────────────────────────────────────
export const settlementBatchItems = pgTable("settlement_batch_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => settlementBatches.id, { onDelete: "cascade" }),
  obligationId: uuid("obligation_id")
    .notNull()
    .references(() => obligations.id),
  amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 22. Payment Transactions ──────────────────────────────────────────────────
export const paymentTransactions = pgTable("payment_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => settlementBatches.id),
  provider: text("provider").notNull().default("paypal"),
  // added by migration 005
  direction: text("direction").notNull().default("BUYER_COLLECTION"),
  providerOrderId: text("provider_order_id"),
  providerCaptureId: text("provider_capture_id"),
  amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("order_created"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 23. Webhook Events ────────────────────────────────────────────────────────
export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().default("paypal"),
  providerEventId: text("provider_event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  signatureStatus: text("signature_status").notNull(),
  payload: jsonb("payload").notNull(),
  processingStatus: text("processing_status").notNull().default("pending"),
  error: text("error"),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

// ── 24. Reconciliation Records ────────────────────────────────────────────────
export const reconciliationRecords = pgTable("reconciliation_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  paymentTransactionId: uuid("payment_transaction_id")
    .notNull()
    .references(() => paymentTransactions.id),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => settlementBatches.id),
  expectedAmount: numeric("expected_amount", {
    precision: 20,
    scale: 6,
  }).notNull(),
  actualAmount: numeric("actual_amount", { precision: 20, scale: 6 }).notNull(),
  expectedCurrency: text("expected_currency").notNull(),
  actualCurrency: text("actual_currency").notNull(),
  providerOrderId: text("provider_order_id"),
  providerCaptureId: text("provider_capture_id"),
  verdict: text("verdict").notNull(),
  details: jsonb("details").notNull().default({}),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 25. Approvals ─────────────────────────────────────────────────────────────
export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  approverId: uuid("approver_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  policySnapshot: jsonb("policy_snapshot").notNull().default({}),
  status: text("status").notNull(),
  reason: text("reason"),
  // added by migration 005
  transactionDirection: text("transaction_direction"),
  amount: numeric("amount", { precision: 20, scale: 6 }),
  currency: text("currency"),
  recipientSnapshotHash: text("recipient_snapshot_hash"),
  obligationIdsHash: text("obligation_ids_hash"),
  policyVersion: text("policy_version"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 26. Holds ─────────────────────────────────────────────────────────────────
export const holds = pgTable("holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull(),
  scopeId: uuid("scope_id").notNull(),
  reason: text("reason").notNull(),
  placedBy: uuid("placed_by").notNull(),
  releasedBy: uuid("released_by"),
  status: text("status").notNull().default("active"),
  placedAt: timestamp("placed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
});

// ── 27. Idempotency Keys ──────────────────────────────────────────────────────
export const idempotencyKeys = pgTable("idempotency_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  principalId: uuid("principal_id").notNull(),
  route: text("route").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  responseCode: integer("response_code"),
  responseBody: jsonb("response_body"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 28. Agent Runs ────────────────────────────────────────────────────────────
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  role: text("role").notNull(),
  missionId: uuid("mission_id").references(() => missions.id),
  parentRunId: uuid("parent_run_id"),
  model: text("model").notNull(),
  limits: jsonb("limits").notNull().default({}),
  stepsCount: integer("steps_count").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 10, scale: 4 })
    .notNull()
    .default("0"),
  status: text("status").notNull().default("created"),
  terminalReason: text("terminal_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 29. Agent Steps ───────────────────────────────────────────────────────────
export const agentSteps = pgTable("agent_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agentRunId: uuid("agent_run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  stepNumber: integer("step_number").notNull(),
  toolName: text("tool_name").notNull(),
  inputHash: text("input_hash").notNull(),
  inputPayload: jsonb("input_payload").notNull().default({}),
  authorizationResult: text("authorization_result").notNull(),
  outputHash: text("output_hash"),
  outputPayload: jsonb("output_payload"),
  durationMs: integer("duration_ms"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 30. LLM Proposals ────────────────────────────────────────────────────────
export const llmProposals = pgTable("llm_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agentRunId: uuid("agent_run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id").references(() => missions.id),
  proposalType: text("proposal_type").notNull(),
  schemaVersion: text("schema_version").notNull().default("1.0"),
  payload: jsonb("payload").notNull(),
  promptHash: text("prompt_hash").notNull(),
  model: text("model").notNull(),
  parameters: jsonb("parameters").notNull().default({}),
  decisionReference: uuid("decision_reference"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 31. Jobs ──────────────────────────────────────────────────────────────────
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, {
    onDelete: "cascade",
  }),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("queued"),
  priority: integer("priority").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  runAfter: timestamp("run_after", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 32. Audit Logs ────────────────────────────────────────────────────────────
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  actorType: text("actor_type").notNull(),
  actorId: uuid("actor_id").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id").notNull(),
  correlationId: uuid("correlation_id").notNull(),
  outcome: text("outcome").notNull(),
  reason: text("reason"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 33. Recorded LLM Responses ────────────────────────────────────────────────
export const recordedLlmResponses = pgTable("recorded_llm_responses", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestHash: text("request_hash").notNull().unique(),
  schemaVersion: text("schema_version").notNull().default("1.0"),
  promptPreview: text("prompt_preview"),
  responsePayload: jsonb("response_payload").notNull(),
  modelMetadata: jsonb("model_metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 003: Agreement Payments (PayPal orders for individual agreements) ─────────
export const agreementPayments = pgTable("agreement_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreements.id),
  provider: text("provider").notNull().default("paypal"),
  providerOrderId: text("provider_order_id").notNull().unique(),
  providerCaptureId: text("provider_capture_id"),
  providerRefundId: text("provider_refund_id"),
  amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("awaiting_payment"),
  approveUrl: text("approve_url"),
  environment: text("environment"),
  attempt: integer("attempt").notNull().default(1),
  capturedAmount: numeric("captured_amount", { precision: 20, scale: 6 }),
  capturedCurrency: text("captured_currency"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 005: Commercial Proposals (negotiation trace) ─────────────────────────────
export const commercialProposals = pgTable("commercial_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  quoteId: uuid("quote_id").references(() => quotes.id),
  agentRunId: uuid("agent_run_id"),
  proposalType: text("proposal_type").notNull(),
  schemaVersion: text("schema_version").notNull().default("1.0"),
  payload: jsonb("payload").notNull(),
  promptHash: text("prompt_hash"),
  modelId: text("model_id"),
  llmMode: text("llm_mode"),
  deterministicValidation: text("deterministic_validation")
    .notNull()
    .default("pending"),
  reasonCodes: jsonb("reason_codes").notNull().default([]),
  decisionReason: text("decision_reason"),
  acceptedAgreementId: uuid("accepted_agreement_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 005: Provider PayPal Profiles ─────────────────────────────────────────────
export const providerPaypalProfiles = pgTable("provider_paypal_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  recipientType: text("recipient_type").notNull(),
  recipientCiphertext: text("recipient_ciphertext").notNull(),
  recipientHash: text("recipient_hash").notNull(),
  recipientMasked: text("recipient_masked").notNull(),
  verificationStatus: text("verification_status").notNull().default("pending"),
  verificationSource: text("verification_source"),
  consentAt: timestamp("consent_at", { withTimezone: true }).notNull(),
  setBy: uuid("set_by").notNull(),
  verifiedBy: uuid("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 004+005: Payouts ──────────────────────────────────────────────────────────
export const payouts = pgTable("payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => settlementBatches.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("requested"),
  senderBatchId: text("sender_batch_id").notNull().unique(),
  provider: text("provider").notNull().default("paypal"),
  recipientProfileId: uuid("recipient_profile_id"),
  recipientType: text("recipient_type"),
  recipientSnapshotCiphertext: text("recipient_snapshot_ciphertext"),
  recipientSnapshotHash: text("recipient_snapshot_hash"),
  recipientMasked: text("recipient_masked"),
  approvalId: uuid("approval_id"),
  obligationIds: jsonb("obligation_ids").notNull().default([]),
  senderItemId: text("sender_item_id"),
  providerBatchId: text("provider_batch_id"),
  providerItemId: text("provider_item_id"),
  providerItemStatus: text("provider_item_status"),
  failureReason: text("failure_reason"),
  errorCode: text("error_code"),
  requestedBy: uuid("requested_by"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 007: Spending Budgets ─────────────────────────────────────────────────────
export const spendingBudgets = pgTable("spending_budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull(),
  ownerType: text("owner_type").notNull(),
  missionId: uuid("mission_id").references(() => missions.id),
  amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  paypalOrderId: text("paypal_order_id"),
  paypalCaptureId: text("paypal_capture_id"),
  paypalEnvironment: text("paypal_environment"),
  approveUrl: text("approve_url"),
  balance: numeric("balance", { precision: 20, scale: 6 })
    .notNull()
    .default("0"),
  totalDebited: numeric("total_debited", { precision: 20, scale: 6 })
    .notNull()
    .default("0"),
  status: text("status").notNull().default("pending_approval"),
  returnOrigin: text("return_origin"),
  walletDepositId: uuid("wallet_deposit_id"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  paypalRequestId: text("paypal_request_id").unique(),
  failureReason: text("failure_reason"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 007: Budget Debits ────────────────────────────────────────────────────────
export const budgetDebits = pgTable("budget_debits", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  budgetId: uuid("budget_id")
    .notNull()
    .references(() => spendingBudgets.id, { onDelete: "cascade" }),
  actorType: text("actor_type").notNull(),
  actorId: uuid("actor_id").notNull(),
  reason: text("reason").notNull(),
  referenceType: text("reference_type"),
  referenceId: uuid("reference_id"),
  amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  balanceAfter: numeric("balance_after", { precision: 20, scale: 6 }).notNull(),
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 007: Budget Decisions ─────────────────────────────────────────────────────
export const budgetDecisions = pgTable("budget_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  budgetId: uuid("budget_id")
    .notNull()
    .references(() => spendingBudgets.id, { onDelete: "cascade" })
    .unique(),
  decision: text("decision").notNull(),
  decidedBy: uuid("decided_by").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  paypalRefundId: text("paypal_refund_id"),
  refundStatus: text("refund_status"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── 008: Mission Budget Wallet ────────────────────────────────────────────────
// The SQL migration is the source of truth (CHECKs, triggers, partial indexes);
// these definitions give typed access only.
const money = (name: string) => numeric(name, { precision: 20, scale: 6 });
const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const wallets = pgTable("wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  currency: text("currency").notNull(),
  paypalEnvironment: text("paypal_environment").notNull(),
  status: text("status").notNull().default("active"),
  blockedReason: text("blocked_reason"),
  balanceCache: money("balance_cache").notNull().default("0"),
  lastActivityAt: tstz("last_activity_at"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const walletDeposits = pgTable("wallet_deposits", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  walletId: uuid("wallet_id")
    .notNull()
    .references(() => wallets.id),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  missionId: uuid("mission_id").references(() => missions.id),
  isTopUp: boolean("is_top_up").notNull().default(false),
  provider: text("provider").notNull().default("paypal"),
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  paypalRequestId: text("paypal_request_id").notNull().unique(),
  paypalOrderId: text("paypal_order_id").unique(),
  approveUrl: text("approve_url"),
  paypalCaptureId: text("paypal_capture_id").unique(),
  capturedAmount: money("captured_amount"),
  capturedCurrency: text("captured_currency"),
  creditedAmount: money("credited_amount").notNull().default("0"),
  paypalFee: money("paypal_fee"),
  capturedAt: tstz("captured_at"),
  paypalEnvironment: text("paypal_environment").notNull(),
  captureAttempts: integer("capture_attempts").notNull().default(0),
  lastCheckedAt: tstz("last_checked_at"),
  failureReason: text("failure_reason"),
  returnOrigin: text("return_origin"),
  migratedFromBudgetId: uuid("migrated_from_budget_id").unique(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const walletReservations = pgTable("wallet_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  walletId: uuid("wallet_id")
    .notNull()
    .references(() => wallets.id),
  missionId: uuid("mission_id")
    .notNull()
    .references(() => missions.id),
  agreementId: uuid("agreement_id")
    .notNull()
    .unique()
    .references(() => agreements.id),
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("active"),
  releaseReason: text("release_reason"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  closedAt: tstz("closed_at"),
});

export const walletCharges = pgTable("wallet_charges", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  walletId: uuid("wallet_id")
    .notNull()
    .references(() => wallets.id),
  reservationId: uuid("reservation_id")
    .notNull()
    .unique()
    .references(() => walletReservations.id),
  obligationId: uuid("obligation_id")
    .notNull()
    .unique()
    .references(() => obligations.id),
  agreementId: uuid("agreement_id")
    .notNull()
    .unique()
    .references(() => agreements.id),
  missionId: uuid("mission_id")
    .notNull()
    .references(() => missions.id),
  amount: money("amount").notNull(),
  releasedDifference: money("released_difference").notNull().default("0"),
  currency: text("currency").notNull(),
  reasonCode: text("reason_code").notNull(),
  journalTransactionId: uuid("journal_transaction_id").references(
    () => journalTransactions.id,
  ),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const remainderDecisions = pgTable("remainder_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id")
    .notNull()
    .unique()
    .references(() => missions.id),
  walletId: uuid("wallet_id")
    .notNull()
    .references(() => wallets.id),
  decision: text("decision").notNull(),
  remainderAmount: money("remainder_amount").notNull(),
  refundAmount: money("refund_amount").notNull().default("0"),
  decidedBy: uuid("decided_by")
    .notNull()
    .references(() => users.id),
  decidedAt: tstz("decided_at").notNull().defaultNow(),
});

export const walletRefunds = pgTable("wallet_refunds", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  walletId: uuid("wallet_id")
    .notNull()
    .references(() => wallets.id),
  kind: text("kind").notNull(),
  decisionId: uuid("decision_id").references(() => remainderDecisions.id),
  missionId: uuid("mission_id").references(() => missions.id),
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("planned"),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id),
  actorRole: text("actor_role").notNull(),
  reason: text("reason"),
  idempotencyKey: text("idempotency_key").notNull(),
  paypalEnvironment: text("paypal_environment").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const walletRefundItems = pgTable("wallet_refund_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  refundId: uuid("refund_id")
    .notNull()
    .references(() => walletRefunds.id, { onDelete: "cascade" }),
  depositId: uuid("deposit_id")
    .notNull()
    .references(() => walletDeposits.id),
  paypalCaptureId: text("paypal_capture_id").notNull(),
  amount: money("amount").notNull(),
  status: text("status").notNull().default("planned"),
  paypalRequestId: text("paypal_request_id").notNull().unique(),
  paypalRefundId: text("paypal_refund_id").unique(),
  paypalStatus: text("paypal_status"),
  failureReason: text("failure_reason"),
  attempts: integer("attempts").notNull().default(0),
  journalTransactionId: uuid("journal_transaction_id").references(
    () => journalTransactions.id,
  ),
  completedAt: tstz("completed_at"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const missionFunding = pgTable("mission_funding", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id")
    .notNull()
    .unique()
    .references(() => missions.id),
  walletId: uuid("wallet_id")
    .notNull()
    .references(() => wallets.id),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  state: text("state").notNull().default("active"),
  shortfall: money("shortfall").notNull().default("0"),
  completedAt: tstz("completed_at"),
  closedAt: tstz("closed_at"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  recipientUserId: uuid("recipient_user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  eventId: text("event_id").notNull(),
  missionId: uuid("mission_id"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  readAt: tstz("read_at"),
  updatedAt: tstz("updated_at"),
  resolvedAt: tstz("resolved_at"),
  emailStatus: text("email_status").notNull().default("none"),
  emailAttempts: integer("email_attempts").notNull().default(0),
});

export const reconciliationRuns = pgTable("reconciliation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull(),
  requestedBy: uuid("requested_by").references(() => users.id),
  status: text("status").notNull().default("running"),
  paypalEnvironment: text("paypal_environment").notNull(),
  counts: jsonb("counts").notNull().default({}),
  trialBalance: jsonb("trial_balance").notNull().default([]),
  startedAt: tstz("started_at").notNull().defaultNow(),
  finishedAt: tstz("finished_at"),
});

export const reconciliationExceptions = pgTable("reconciliation_exceptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  firstRunId: uuid("first_run_id")
    .notNull()
    .references(() => reconciliationRuns.id),
  lastRunId: uuid("last_run_id")
    .notNull()
    .references(() => reconciliationRuns.id),
  itemType: text("item_type").notNull(),
  paypalId: text("paypal_id").notNull(),
  kind: text("kind").notNull(),
  currency: text("currency"),
  stoatAmount: money("stoat_amount"),
  paypalAmount: money("paypal_amount"),
  difference: money("difference"),
  status: text("status").notNull().default("open"),
  resolvedAt: tstz("resolved_at"),
  resolvedRunId: uuid("resolved_run_id").references(
    () => reconciliationRuns.id,
  ),
  detail: jsonb("detail").notNull().default({}),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const walletMigrationReport = pgTable("wallet_migration_report", {
  id: uuid("id").primaryKey().defaultRandom(),
  budgetId: uuid("budget_id").notNull().unique(),
  outcome: text("outcome").notNull(),
  reason: text("reason"),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

// ── Relations (optional — only needed for Drizzle query builder joins) ────────
export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  agents: many(agents),
  missions: many(missions),
  spendingBudgets: many(spendingBudgets),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  tenant: one(tenants, { fields: [agents.tenantId], references: [tenants.id] }),
  ownerUser: one(users, {
    fields: [agents.ownerUserId],
    references: [users.id],
  }),
  agentRuns: many(agentRuns),
}));

export const spendingBudgetsRelations = relations(
  spendingBudgets,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [spendingBudgets.tenantId],
      references: [tenants.id],
    }),
    mission: one(missions, {
      fields: [spendingBudgets.missionId],
      references: [missions.id],
    }),
    debits: many(budgetDebits),
    decision: one(budgetDecisions, {
      fields: [spendingBudgets.id],
      references: [budgetDecisions.budgetId],
    }),
  }),
);

export const budgetDebitsRelations = relations(budgetDebits, ({ one }) => ({
  budget: one(spendingBudgets, {
    fields: [budgetDebits.budgetId],
    references: [spendingBudgets.id],
  }),
  agentRun: one(agentRuns, {
    fields: [budgetDebits.agentRunId],
    references: [agentRuns.id],
  }),
}));

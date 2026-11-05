import { getDb, DbClient } from './connection.js';

export const SEED_IDS = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  buyerAgentId: '00000000-0000-0000-0000-000000000010',
  providerAgentId: '00000000-0000-0000-0000-000000000020',
  competingProviderAgentId: '00000000-0000-0000-0000-000000000021',
  treasuryAgentId: '00000000-0000-0000-0000-000000000030',
  watchdogAgentId: '00000000-0000-0000-0000-000000000040',
  verifierAdvisorId: '00000000-0000-0000-0000-000000000050',
  copilotAgentId: '00000000-0000-0000-0000-000000000060',
  aiServiceId: '00000000-0000-0000-0000-000000000100',
  staticServiceId: '00000000-0000-0000-0000-000000000101',
  policyVersion1Id: '00000000-0000-0000-0000-000000000200',
  buyerExpenseAccountId: '00000000-0000-0000-0000-000000000301',
  providerPayableAccountId: '00000000-0000-0000-0000-000000000302',
  settlementClearingAccountId: '00000000-0000-0000-0000-000000000303',
};

export async function seedDatabase(customDb?: DbClient): Promise<void> {
  const db = customDb || getDb();

  // 1. Tenant
  await db.query(`
    INSERT INTO tenants (id, name, status, settings)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO NOTHING;
  `, [
    SEED_IDS.tenantId,
    'Acme Autonomous Org',
    'active',
    JSON.stringify({ default_currency: 'USD', max_revisions: 2 }),
  ]);

  // 2. Human Operator User
  await db.query(`
    INSERT INTO users (id, tenant_id, email, role)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO NOTHING;
  `, [
    SEED_IDS.userId,
    SEED_IDS.tenantId,
    'operator@stoat.local',
    'operator',
  ]);

  // 3. Chart of Accounts
  await db.query(`
    INSERT INTO accounts (id, tenant_id, account_code, name, normal_balance, currency, is_active)
    VALUES 
      ($1, $4, '5001', 'Buyer Service Expense', 'debit', 'USD', TRUE),
      ($2, $4, '2001', 'Provider Payable', 'credit', 'USD', TRUE),
      ($3, $4, '2002', 'Settlement Clearing', 'credit', 'USD', TRUE)
    ON CONFLICT (id) DO NOTHING;
  `, [
    SEED_IDS.buyerExpenseAccountId,
    SEED_IDS.providerPayableAccountId,
    SEED_IDS.settlementClearingAccountId,
    SEED_IDS.tenantId,
  ]);

  // 4. Policy Version 1
  const policyRules = {
    max_mission_budget: '50.00',
    max_transaction_amount: '10.00',
    daily_spend_limit: '100.00',
    allowed_categories: ['code_review', 'security_scan'],
    require_human_approval_above: '0.00', // Human approval required for all batches
    max_revisions: 2,
  };

  await db.query(`
    INSERT INTO policy_versions (id, tenant_id, version, rules, description, is_active)
    VALUES ($1, $2, 1, $3, 'Default Autonomous Procurement Policy v1', TRUE)
    ON CONFLICT (id) DO NOTHING;
  `, [
    SEED_IDS.policyVersion1Id,
    SEED_IDS.tenantId,
    JSON.stringify(policyRules),
  ]);

  // 5. Agents
  const agents = [
    {
      id: SEED_IDS.buyerAgentId,
      role: 'buyer',
      name: 'BuyerAgent Alpha',
      scopes: ['discover', 'quote', 'accept', 'revision', 'read_mission'],
      credential_hash: 'buyer_secret_hash_demo',
    },
    {
      id: SEED_IDS.providerAgentId,
      role: 'provider',
      name: 'LLM Code Reviewer Provider',
      scopes: ['service_publish', 'quote_offer', 'deliver'],
      credential_hash: 'provider_secret_hash_demo',
    },
    {
      id: SEED_IDS.competingProviderAgentId,
      role: 'provider',
      name: 'FastStatic Reviewer',
      scopes: ['service_publish', 'quote_offer', 'deliver'],
      credential_hash: 'competing_provider_secret_hash_demo',
    },
    {
      id: SEED_IDS.treasuryAgentId,
      role: 'treasury',
      name: 'Treasury Agent',
      scopes: ['propose_batch', 'read_ledger', 'read_reconciliation'],
      credential_hash: 'treasury_secret_hash_demo',
    },
    {
      id: SEED_IDS.watchdogAgentId,
      role: 'watchdog',
      name: 'Watchdog Agent',
      scopes: ['place_hold', 'read_anomalies'],
      credential_hash: 'watchdog_secret_hash_demo',
    },
    {
      id: SEED_IDS.verifierAdvisorId,
      role: 'verifier_advisor',
      name: 'Verifier Advisor',
      scopes: ['advise', 'downgrade'],
      credential_hash: 'advisor_secret_hash_demo',
    },
    {
      id: SEED_IDS.copilotAgentId,
      role: 'copilot',
      name: 'Operator Copilot',
      scopes: ['read_query_intent'],
      credential_hash: 'copilot_secret_hash_demo',
    },
  ];

  for (const agent of agents) {
    await db.query(`
      INSERT INTO agents (id, tenant_id, role, name, status, scopes, credential_hash)
      VALUES ($1, $2, $3, $4, 'active', $5, $6)
      ON CONFLICT (id) DO NOTHING;
    `, [
      agent.id,
      SEED_IDS.tenantId,
      agent.role,
      agent.name,
      JSON.stringify(agent.scopes),
      agent.credential_hash,
    ]);
  }

  // 6. Services
  // Service A: AI Code Review ($0.12 USD)
  const aiServiceVerificationProfile = {
    method: 'grounded_verification',
    version: '1.0.0',
    required_checks: [
      'file_exists',
      'valid_line_range',
      'snippet_match',
      'rule_allowlisted',
      'severity_valid',
      'no_duplicates',
      'max_findings_limit',
      'scope_coverage',
    ],
    allowed_rules: [
      'SEC-001', // SQL Injection / unsafe interpolation
      'SEC-002', // Hardcoded secret or key
      'SEC-003', // Unbounded memory allocation
      'BUG-001', // Off-by-one boundary error
      'BUG-002', // Unhandled Promise rejection
      'PERF-001', // Unindexed lookup in tight loop
    ],
    allowed_severities: ['low', 'medium', 'high', 'critical'],
    max_findings: 10,
    min_coverage_pct: 100,
  };

  await db.query(`
    INSERT INTO services (
      id, tenant_id, provider_id, name, description, category,
      pricing_model, unit_price, currency, unit, constraints,
      schema, verification_profile, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      'fixed_unit', $7, 'USD', 'review', $8,
      $9, $10, 'active'
    ) ON CONFLICT (id) DO NOTHING;
  `, [
    SEED_IDS.aiServiceId,
    SEED_IDS.tenantId,
    SEED_IDS.providerAgentId,
    'AI Deep Code Review',
    'Model-driven code review identifying security vulnerabilities and functional bugs with grounded line citations.',
    'code_review',
    '0.12',
    JSON.stringify({ max_files: 10, max_lines_per_file: 500 }),
    JSON.stringify({ input: 'repo_fixture', output: 'structured_findings' }),
    JSON.stringify(aiServiceVerificationProfile),
  ]);

  // Service B: Static Linter Scan ($0.05 USD)
  const staticServiceVerificationProfile = {
    method: 'deterministic_lint',
    version: '1.0.0',
    required_checks: ['file_exists', 'rule_allowlisted', 'no_duplicates'],
    allowed_rules: ['LINT-001', 'LINT-002', 'LINT-003'],
    allowed_severities: ['low', 'medium'],
    max_findings: 20,
  };

  await db.query(`
    INSERT INTO services (
      id, tenant_id, provider_id, name, description, category,
      pricing_model, unit_price, currency, unit, constraints,
      schema, verification_profile, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      'fixed_unit', $7, 'USD', 'scan', $8,
      $9, $10, 'active'
    ) ON CONFLICT (id) DO NOTHING;
  `, [
    SEED_IDS.staticServiceId,
    SEED_IDS.tenantId,
    SEED_IDS.competingProviderAgentId,
    'Static Linter Scan',
    'Deterministic syntax, style, and import hygiene scanner.',
    'code_review',
    '0.05',
    JSON.stringify({ max_files: 50 }),
    JSON.stringify({ input: 'repo_fixture', output: 'lint_report' }),
    JSON.stringify(staticServiceVerificationProfile),
  ]);

  console.log('[Seed] Database seeded with tenant, users, agents, services, accounts, and policies.');
}

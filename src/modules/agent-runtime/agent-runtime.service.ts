import { DbClient } from '../../db/connection.js';
import { sha256 } from '../../common/crypto.js';
import { LlmAdapter, LlmMode } from './llm-adapter.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { DeliveriesService } from '../deliveries/deliveries.service.js';
import { NotFoundError, StoatError } from '../../common/errors.js';

export interface AgentRunLimits {
  max_steps: number;
  max_seconds: number;
  max_cost_usd: number;
}

export class AgentRuntimeService {
  private llmAdapter: LlmAdapter;
  private artifactsService: ArtifactsService;
  private deliveriesService: DeliveriesService;

  constructor(private db: DbClient, llmMode?: LlmMode, fixtureDir?: string) {
    this.llmAdapter = new LlmAdapter(db, llmMode);
    this.artifactsService = new ArtifactsService(db);
    this.deliveriesService = new DeliveriesService(db, fixtureDir);
  }

  getLlmAdapter(): LlmAdapter {
    return this.llmAdapter;
  }

  async startRun(params: {
    tenantId: string;
    agentId: string;
    role: string;
    missionId?: string;
    parentRunId?: string;
    model?: string;
    limits?: Partial<AgentRunLimits>;
  }): Promise<any> {
    const defaultLimits: AgentRunLimits = {
      max_steps: 12,
      max_seconds: 90,
      max_cost_usd: 0.25,
      ...params.limits,
    };

    const res = await this.db.query(
      `INSERT INTO agent_runs (
        id, tenant_id, agent_id, role, mission_id, parent_run_id,
        model, limits, steps_count, cost_usd, status, started_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, 0, 0, 'running', now()
      ) RETURNING id, tenant_id, agent_id, role, mission_id, model, limits, status, started_at`,
      [
        params.tenantId,
        params.agentId,
        params.role,
        params.missionId || null,
        params.parentRunId || null,
        params.model || 'claude-3-5-sonnet-20241022',
        JSON.stringify(defaultLimits),
      ]
    );

    return res.rows[0];
  }

  async recordStep(params: {
    tenantId: string;
    agentRunId: string;
    stepNumber: number;
    toolName: string;
    inputPayload: any;
    authorizationResult: 'allowed' | 'denied';
    outputPayload?: any;
    durationMs?: number;
    errorCode?: string;
  }): Promise<any> {
    const inputHash = sha256(params.inputPayload || {});
    const outputHash = params.outputPayload ? sha256(params.outputPayload) : null;

    const res = await this.db.query(
      `INSERT INTO agent_steps (
        id, tenant_id, agent_run_id, step_number, tool_name,
        input_hash, input_payload, authorization_result,
        output_hash, output_payload, duration_ms, error_code
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11
      ) RETURNING id`,
      [
        params.tenantId,
        params.agentRunId,
        params.stepNumber,
        params.toolName,
        inputHash,
        JSON.stringify(params.inputPayload || {}),
        params.authorizationResult,
        outputHash,
        params.outputPayload ? JSON.stringify(params.outputPayload) : null,
        params.durationMs || 0,
        params.errorCode || null,
      ]
    );

    // Update steps count on run
    await this.db.query('UPDATE agent_runs SET steps_count = steps_count + 1 WHERE id = $1', [
      params.agentRunId,
    ]);

    return res.rows[0];
  }

  async recordProposal(params: {
    tenantId: string;
    agentRunId: string;
    missionId?: string;
    proposalType: string;
    payload: any;
    promptHash: string;
    model: string;
    parameters?: any;
    decisionReference?: string;
  }): Promise<any> {
    const res = await this.db.query(
      `INSERT INTO llm_proposals (
        id, tenant_id, agent_run_id, mission_id, proposal_type,
        schema_version, payload, prompt_hash, model, parameters, decision_reference
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4,
        '1.0', $5, $6, $7, $8, $9
      ) RETURNING id`,
      [
        params.tenantId,
        params.agentRunId,
        params.missionId || null,
        params.proposalType,
        JSON.stringify(params.payload),
        params.promptHash,
        params.model,
        JSON.stringify(params.parameters || {}),
        params.decisionReference || null,
      ]
    );

    return res.rows[0];
  }

  async completeRun(
    agentRunId: string,
    status: 'completed' | 'terminated_limit' | 'failed_closed',
    terminalReason?: string,
    costUsd: number = 0.005
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_runs 
       SET status = $1, terminal_reason = $2, cost_usd = cost_usd + $3, completed_at = now() 
       WHERE id = $4`,
      [status, terminalReason || null, costUsd, agentRunId]
    );
  }

  async getRunTrace(tenantId: string, runId: string): Promise<any> {
    const runRes = await this.db.query(
      `SELECT r.id, r.agent_id, r.role, r.mission_id, r.model, r.limits, r.steps_count,
              r.cost_usd, r.status, r.terminal_reason, r.started_at, r.completed_at
       FROM agent_runs r
       WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, runId]
    );

    if (runRes.rows.length === 0) {
      throw new NotFoundError('AgentRun', runId);
    }

    const stepsRes = await this.db.query(
      `SELECT step_number, tool_name, authorization_result, input_payload, output_payload, duration_ms, error_code, created_at
       FROM agent_steps
       WHERE tenant_id = $1 AND agent_run_id = $2
       ORDER BY step_number ASC`,
      [tenantId, runId]
    );

    const proposalsRes = await this.db.query(
      `SELECT id, proposal_type, payload, prompt_hash, model, decision_reference, created_at
       FROM llm_proposals
       WHERE tenant_id = $1 AND agent_run_id = $2
       ORDER BY created_at ASC`,
      [tenantId, runId]
    );

    return {
      run: runRes.rows[0],
      steps: stepsRes.rows,
      proposals: proposalsRes.rows,
    };
  }

  async executeCodeReview(params: {
    tenantId: string;
    agreementId: string;
    providerAgentId: string;
    prompt?: string;
  }): Promise<any> {
    // 1. Fetch agreement
    const agRes = await this.db.query(
      'SELECT id, mission_id, quote_id, status FROM agreements WHERE tenant_id = $1 AND id = $2',
      [params.tenantId, params.agreementId]
    );
    if (agRes.rows.length === 0) {
      throw new NotFoundError('Agreement', params.agreementId);
    }
    const agreement = agRes.rows[0];

    // 2. Start Agent Run
    const run = await this.startRun({
      tenantId: params.tenantId,
      agentId: params.providerAgentId,
      role: 'provider',
      missionId: agreement.mission_id,
      model: 'claude-3-5-sonnet-20241022',
    });

    const startTime = Date.now();
    const prompt =
      params.prompt ||
      'Perform a deep code review on repository fixture fixtures/repo-fixture. Report all security vulnerabilities and functional bugs.';

    // 3. Step 1: Call LLM
    const llmRes = await this.llmAdapter.execute({
      prompt,
      schemaName: 'code_review_findings',
      model: run.model,
      tenantId: params.tenantId,
      agentRunId: run.id,
    });

    await this.recordStep({
      tenantId: params.tenantId,
      agentRunId: run.id,
      stepNumber: 1,
      toolName: 'llm_generate_findings',
      inputPayload: { prompt, schemaName: 'code_review_findings' },
      authorizationResult: 'allowed',
      outputPayload: llmRes.data,
      durationMs: Date.now() - startTime,
    });

    // 4. Record proposal
    await this.recordProposal({
      tenantId: params.tenantId,
      agentRunId: run.id,
      missionId: agreement.mission_id,
      proposalType: 'delivery_findings',
      payload: llmRes.data,
      promptHash: llmRes.requestHash,
      model: llmRes.model,
    });

    // 5. Upload artifact
    const artifact = await this.artifactsService.uploadArtifact({
      tenantId: params.tenantId,
      payload: llmRes.data,
    });

    await this.recordStep({
      tenantId: params.tenantId,
      agentRunId: run.id,
      stepNumber: 2,
      toolName: 'upload_delivery_artifact',
      inputPayload: { artifactId: artifact.id },
      authorizationResult: 'allowed',
      outputPayload: { storage_key: artifact.storage_key, hash: artifact.content_hash },
    });

    // 6. Submit delivery (this automatically runs the Grounded Verifier!)
    const deliveryResult = await this.deliveriesService.submitDelivery({
      tenantId: params.tenantId,
      agreementId: params.agreementId,
      providerId: params.providerAgentId,
      agentRunId: run.id,
      artifactId: artifact.id,
      declaredResult: { summary: 'Code review completed with structured findings' },
    });

    // 7. Complete agent run
    await this.completeRun(run.id, 'completed', undefined, llmRes.usage?.costUsd || 0.003);

    return {
      runId: run.id,
      replayed: llmRes.replayed,
      mode: llmRes.mode,
      requestHash: llmRes.requestHash,
      delivery: deliveryResult.delivery,
      verification: deliveryResult.verification,
    };
  }
}

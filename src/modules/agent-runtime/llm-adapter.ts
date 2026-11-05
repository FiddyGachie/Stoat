/**
 * LLM Adapter — supports Fireworks AI serverless (primary), Anthropic (legacy), and a
 * deterministic fallback for tests / offline use.
 *
 * Fireworks AI uses an OpenAI-compatible chat-completions endpoint:
 *   POST https://api.fireworks.ai/inference/v1/chat/completions
 *   Authorization: Bearer <FIREWORKS_API_KEY>
 *   Model IDs use the format: accounts/fireworks/models/<model-name>
 *
 * Select provider via LLM_PROVIDER env var:
 *   fireworks  (default — Fireworks AI serverless)
 *   anthropic  (legacy Anthropic Messages API)
 *
 * Record/replay mode is provider-agnostic: request hash is keyed to prompt + schema + model,
 * so a recorded Fireworks response replays regardless of which provider is active.
 */

import { DbClient } from "../../db/connection.js";
import { sha256 } from "../../common/crypto.js";
import { StoatError } from "../../common/errors.js";

export type LlmMode = "live" | "record" | "replay";
export type LlmProvider = "fireworks" | "anthropic";

export interface LlmRequestOptions {
  prompt: string;
  systemPrompt?: string;
  schemaName: string;
  model?: string;
  tenantId?: string;
  agentRunId?: string;
}

export interface LlmResponse<T = any> {
  data: T;
  mode: LlmMode;
  replayed: boolean;
  requestHash: string;
  model: string;
  provider: LlmProvider;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

// ── Fireworks serverless pricing (approximate, per 1M tokens, Nov 2024) ──────
// Using Llama 3.3 70B Instruct as the default agent model.
// https://fireworks.ai/pricing
const FIREWORKS_PRICE_PER_1M_INPUT = 0.9; // USD
const FIREWORKS_PRICE_PER_1M_OUTPUT = 0.9; // USD

function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * FIREWORKS_PRICE_PER_1M_INPUT +
    (outputTokens / 1_000_000) * FIREWORKS_PRICE_PER_1M_OUTPUT
  );
}

export class LlmAdapter {
  private mode: LlmMode;
  private provider: LlmProvider;
  private defaultModel: string;

  constructor(
    private db: DbClient,
    mode?: LlmMode,
  ) {
    this.mode =
      mode ?? (process.env.LLM_MODE as LlmMode | undefined) ?? "replay";

    // Determine provider — default to fireworks, fall back to anthropic if the old key is set
    const providerEnv = process.env.LLM_PROVIDER as LlmProvider | undefined;
    if (providerEnv === "anthropic") {
      this.provider = "anthropic";
      this.defaultModel =
        process.env.LLM_MODEL_AGENT ?? "claude-3-5-sonnet-20241022";
    } else {
      this.provider = "fireworks";
      // Fireworks serverless model IDs use: accounts/fireworks/models/<name>
      this.defaultModel =
        process.env.LLM_MODEL_AGENT ??
        "accounts/fireworks/models/llama-v3p3-70b-instruct";
    }
  }

  getMode(): LlmMode {
    return this.mode;
  }
  getProvider(): LlmProvider {
    return this.provider;
  }
  setMode(mode: LlmMode): void {
    this.mode = mode;
  }

  computeHash(options: LlmRequestOptions): string {
    return sha256({
      prompt: options.prompt.trim(),
      systemPrompt: options.systemPrompt?.trim() ?? "",
      schemaName: options.schemaName,
      model: options.model ?? this.defaultModel,
    });
  }

  async execute<T = any>(options: LlmRequestOptions): Promise<LlmResponse<T>> {
    const model = options.model ?? this.defaultModel;
    const requestHash = this.computeHash(options);

    // ── 1. Replay mode ────────────────────────────────────────────────────
    if (this.mode === "replay") {
      const recorded = await this.db.query<{
        response_payload: unknown;
        model_metadata: unknown;
      }>(
        "SELECT response_payload, model_metadata FROM recorded_llm_responses WHERE request_hash = $1",
        [requestHash],
      );

      if (recorded.rows.length === 0) {
        throw new StoatError(
          "REPLAY_NOT_FOUND",
          `No recorded LLM response found for hash ${requestHash}. Run in 'record' or 'live' mode first.`,
          422,
          { requestHash },
        );
      }

      const row = recorded.rows[0];
      const payload =
        typeof row.response_payload === "string"
          ? (JSON.parse(row.response_payload) as T)
          : (row.response_payload as T);

      const meta =
        typeof row.model_metadata === "string"
          ? JSON.parse(row.model_metadata)
          : ((row.model_metadata as Record<string, unknown> | null) ?? {});

      return {
        data: payload,
        mode: "replay",
        replayed: true,
        requestHash,
        model,
        provider:
          (meta?.["provider"] as LlmProvider | undefined) ?? this.provider,
        usage: { inputTokens: 350, outputTokens: 210, costUsd: 0.0002 },
      };
    }

    // ── 2. Live call ──────────────────────────────────────────────────────
    let generatedData: T;
    let inputTokens = 0;
    let outputTokens = 0;

    if (this.provider === "fireworks") {
      ({
        data: generatedData,
        inputTokens,
        outputTokens,
      } = await this.callFireworks<T>(options, model));
    } else {
      ({
        data: generatedData,
        inputTokens,
        outputTokens,
      } = await this.callAnthropic<T>(options, model));
    }

    const costUsd = estimateCostUsd(inputTokens, outputTokens);

    // ── 3. Record mode — persist to DB ────────────────────────────────────
    if (this.mode === "record") {
      await this.db.query(
        `INSERT INTO recorded_llm_responses
           (id, request_hash, schema_version, prompt_preview, response_payload, model_metadata)
         VALUES (gen_random_uuid(), $1, '1.0', $2, $3, $4)
         ON CONFLICT (request_hash)
         DO UPDATE SET response_payload = EXCLUDED.response_payload,
                       model_metadata   = EXCLUDED.model_metadata`,
        [
          requestHash,
          options.prompt.substring(0, 100),
          JSON.stringify(generatedData),
          JSON.stringify({
            model,
            provider: this.provider,
            recorded_at: new Date().toISOString(),
          }),
        ],
      );
    }

    return {
      data: generatedData,
      mode: this.mode,
      replayed: false,
      requestHash,
      model,
      provider: this.provider,
      usage: { inputTokens, outputTokens, costUsd },
    };
  }

  // ── Fireworks AI serverless (OpenAI-compatible chat completions) ──────────
  private async callFireworks<T>(
    options: LlmRequestOptions,
    model: string,
  ): Promise<{ data: T; inputTokens: number; outputTokens: number }> {
    const apiKey = process.env.FIREWORKS_API_KEY;

    if (!apiKey) {
      // No credentials — fall back to deterministic response (offline / CI)
      return {
        data: this.generateDeterministicFallback(options) as T,
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    const systemPrompt =
      options.systemPrompt ??
      "You are an autonomous code reviewer. Respond ONLY with valid JSON matching the requested schema. Do not include markdown fences or explanation.";

    const body = {
      model,
      max_tokens: 1024,
      temperature: 0.1, // low temperature → deterministic structured output
      response_format: { type: "json_object" }, // JSON mode: guaranteed valid JSON
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: options.prompt },
      ],
    };

    let response: Response;
    try {
      response = await fetch(
        "https://api.fireworks.ai/inference/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
      );
    } catch (err: unknown) {
      throw new StoatError(
        "PROVIDER_ERROR",
        `Fireworks AI network error: ${(err as Error).message}`,
        502,
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new StoatError(
        "PROVIDER_ERROR",
        `Fireworks AI API error ${response.status}: ${errText}`,
        502,
      );
    }

    const resJson = (await response.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const content = resJson.choices?.[0]?.message?.content;
    if (!content) {
      throw new StoatError(
        "AGENT_OUTPUT_INVALID",
        "Fireworks AI returned empty content.",
        422,
      );
    }

    let parsed: T;
    try {
      parsed = JSON.parse(content) as T;
    } catch {
      throw new StoatError(
        "AGENT_OUTPUT_INVALID",
        `Fireworks AI response is not valid JSON: ${content.substring(0, 200)}`,
        422,
      );
    }

    return {
      data: parsed,
      inputTokens: resJson.usage?.prompt_tokens ?? 0,
      outputTokens: resJson.usage?.completion_tokens ?? 0,
    };
  }

  // ── Anthropic Messages API (legacy / alternative) ─────────────────────────
  private async callAnthropic<T>(
    options: LlmRequestOptions,
    model: string,
  ): Promise<{ data: T; inputTokens: number; outputTokens: number }> {
    const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return {
        data: this.generateDeterministicFallback(options) as T,
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system:
            options.systemPrompt ??
            "You are an autonomous code reviewer. Respond only in valid JSON.",
          messages: [{ role: "user", content: options.prompt }],
        }),
      });
    } catch (err: unknown) {
      throw new StoatError(
        "PROVIDER_ERROR",
        `Anthropic network error: ${(err as Error).message}`,
        502,
      );
    }

    if (!response.ok) {
      throw new StoatError(
        "PROVIDER_ERROR",
        `Anthropic API error: ${response.statusText}`,
        502,
      );
    }

    const resJson = (await response.json()) as {
      content: Array<{ text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const text = resJson.content?.[0]?.text;
    if (!text) {
      throw new StoatError(
        "AGENT_OUTPUT_INVALID",
        "Anthropic returned empty content.",
        422,
      );
    }

    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new StoatError(
        "AGENT_OUTPUT_INVALID",
        `Anthropic response is not valid JSON: ${text.substring(0, 200)}`,
        422,
      );
    }

    return {
      data: parsed,
      inputTokens: resJson.usage?.input_tokens ?? 400,
      outputTokens: resJson.usage?.output_tokens ?? 250,
    };
  }

  // ── Deterministic fallback — no API key, used in offline / CI without replay
  private generateDeterministicFallback(options: LlmRequestOptions): unknown {
    if (options.schemaName === "code_review_findings") {
      if (
        options.prompt.includes("REVISE") ||
        options.prompt.includes("REVISED")
      ) {
        return {
          findings: [
            {
              file: "src/auth.ts",
              line_start: 4,
              line_end: 4,
              snippet:
                'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
              rule_id: "SEC-002",
              severity: "critical",
              title: "Hardcoded Secret",
              description: "Hardcoded secret key in repository file.",
            },
            {
              file: "src/auth.ts",
              line_start: 15,
              line_end: 15,
              snippet:
                "const query = `SELECT * FROM users WHERE email = '${email}' AND is_active = true`;",
              rule_id: "SEC-001",
              severity: "high",
              title: "SQL Injection",
              description: "Unsafe SQL query string interpolation.",
            },
          ],
        };
      }
      // Initial review — includes an ungrounded finding to exercise Beat 2A rejection
      return {
        findings: [
          {
            file: "src/auth.ts",
            line_start: 4,
            line_end: 4,
            snippet:
              'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
            rule_id: "SEC-002",
            severity: "critical",
            title: "Hardcoded Secret",
          },
          {
            // Ungrounded — file not in manifest; grounding verifier will reject
            file: "src/crypto_vault.ts",
            line_start: 10,
            line_end: 12,
            snippet: 'const cipher = crypto.createCipher("des", key);',
            rule_id: "SEC-003",
            severity: "high",
            title: "Deprecated Cipher",
          },
        ],
      };
    }
    return { result: "ok" };
  }
}


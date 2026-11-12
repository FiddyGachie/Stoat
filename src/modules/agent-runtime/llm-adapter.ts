/**
 * LLM Adapter: Fireworks AI serverless (primary) and Anthropic (legacy). There is no canned
 * fallback; tests inject an explicit transport (a test double).
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
 * When a call carries a response schema, Fireworks enforces it during generation (JSON Schema
 * mode), and Stoat still validates the answer afterwards. A schema the model cannot satisfy is
 * caught by that validation, never trusted.
 *
 * Record/replay mode is provider-agnostic: request hash is keyed to prompt + schema + model,
 * so a recorded Fireworks response replays regardless of which provider is active.
 */

import { DbClient } from "../../db/connection.js";
import { sha256 } from "../../common/crypto.js";
import { StoatError } from "../../common/errors.js";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type LlmMode = "live" | "record" | "replay";
export type LlmProvider = "fireworks" | "anthropic";

/**
 * How a live model call is made. Production uses the provider's real API (Fireworks or Anthropic).
 * Tests may inject their own transport to exercise Stoat's handling of model output; such a
 * transport is a TEST DOUBLE and is never configured by the application.
 */
export type LlmTransport = (req: { options: LlmRequestOptions; model: string }) => Promise<{ data: any; inputTokens: number; outputTokens: number }>;

export interface LlmRequestOptions {
  prompt: string;
  systemPrompt?: string;
  schemaName: string;
  /** The answer's schema. Sent to the provider for constrained decoding; the caller still validates. */
  responseSchema?: ZodTypeAny;
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
// Default agent model: gpt-oss-120b (override with LLM_MODEL_AGENT). Prices are estimates.
// https://fireworks.ai/pricing
const FIREWORKS_PRICE_PER_1M_INPUT = 0.9; // USD
const FIREWORKS_PRICE_PER_1M_OUTPUT = 0.9; // USD

/** zod schema to the JSON Schema the provider enforces (inline, no $ref). */
function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  return rest;
}

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
  private transport?: LlmTransport;
  constructor(
    private db: DbClient,
    mode?: LlmMode,
    opts?: { transport?: LlmTransport },
  ) {
    this.transport = opts?.transport;
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
        "accounts/fireworks/models/gpt-oss-120b";
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

  /** The model every agent run uses unless it names another (LLM_MODEL_AGENT, per provider). */
  getDefaultModel(): string {
    return this.defaultModel;
  }

  computeHash(options: LlmRequestOptions): string {
    return sha256({
      prompt: options.prompt.trim(),
      systemPrompt: options.systemPrompt?.trim() ?? "",
      schemaName: options.schemaName,
      ...(options.responseSchema ? { responseSchema: toJsonSchema(options.responseSchema) } : {}),
      model: options.model ?? this.defaultModel,
    });
  }

  /**
   * A model call whose answer must pass `validate`. If the answer is malformed (bad JSON, wrong shape,
   * or a semantic rule such as "cover every file"), the model is told exactly what was wrong and asked
   * once more. Every attempt is a real call and is returned for the trace. Nothing is invented: if the
   * last attempt is still invalid, `value` is null and the caller fails closed.
   */
  async executeValidated<T>(
    options: LlmRequestOptions,
    validate: (data: unknown) => { ok: true; value: T } | { ok: false; error: string },
    maxAttempts = 2,
  ): Promise<{ value: T | null; response: LlmResponse; responses: LlmResponse[]; error: string | null }> {
    const responses: LlmResponse[] = [];
    let prompt = options.prompt;
    let lastError = 'no answer';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: LlmResponse;
      try {
        res = await this.execute({ ...options, prompt });
      } catch (err) {
        // Unparseable output is retryable; configuration and provider errors are not.
        if (err instanceof StoatError && err.code === "AGENT_OUTPUT_INVALID" && attempt < maxAttempts) {
          lastError = err.message.slice(0, 300);
          prompt = `${options.prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED: ${lastError}\nAnswer again with JSON only, exactly in the requested shape.`;
          continue;
        }
        throw err;
      }
      responses.push(res);
      const v = validate(res.data);
      if (v.ok) return { value: v.value, response: res, responses, error: null };
      lastError = v.error.slice(0, 500);
      prompt = `${options.prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED: ${lastError}\nAnswer again with JSON only, exactly in the requested shape.`;
    }
    const last = responses[responses.length - 1];
    if (!last) throw new StoatError("AGENT_OUTPUT_INVALID", `The model gave no usable answer: ${lastError}`, 422);
    return { value: null, response: last, responses, error: lastError };
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

    if (this.transport) {
      ({ data: generatedData, inputTokens, outputTokens } = await this.transport({ options, model }));
    } else if (this.provider === "fireworks") {
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
    const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.LLM_API_KEY;
    if (!apiKey) {
      throw new StoatError(
        "LLM_NOT_CONFIGURED",
        "No model API key is configured (set FIREWORKS_API_KEY or LLM_API_KEY). Stoat never substitutes canned output for a live model call.",
        503,
      );
    }

    const systemPrompt =
      options.systemPrompt ??
      "You are an autonomous code reviewer. Respond ONLY with valid JSON matching the requested schema. Do not include markdown fences or explanation.";

    const body = {
      model,
      max_tokens: 2048,
      temperature: 0.1, // low temperature → deterministic structured output
      // JSON Schema mode constrains generation to the answer's shape; plain JSON mode otherwise.
      response_format: options.responseSchema
        ? { type: "json_schema", json_schema: { name: options.schemaName, schema: toJsonSchema(options.responseSchema) } }
        : { type: "json_object" },
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
      throw new StoatError(
        "LLM_NOT_CONFIGURED",
        "No model API key is configured (set FIREWORKS_API_KEY or LLM_API_KEY). Stoat never substitutes canned output for a live model call.",
        503,
      );
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
}

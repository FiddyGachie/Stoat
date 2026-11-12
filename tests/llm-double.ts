import type { LlmTransport } from '../src/modules/agent-runtime/llm-adapter.js';

/**
 * TEST DOUBLE for a model provider. It exists only in tests, is injected explicitly, and the
 * application can never configure it. It lets tests check what Stoat does with model OUTPUT
 * (schema validation, grounded verification, revision loop). It says nothing about model quality.
 * Real model behaviour is covered by the live smoke checks, not by these tests.
 */
/** The fixture manifest's files; a complete review must list every one. */
export const FIXTURE_FILES = ['src/auth.ts', 'src/math.ts', 'src/worker.ts'];

export const GROUNDED_FINDINGS = {
  summary: 'Reviewed all three files. The JWT signing secret is hardcoded in src/auth.ts; rotate it and load it from the environment first.',
  files_reviewed: FIXTURE_FILES,
  findings: [
    {
      file: 'src/auth.ts', line_start: 4, line_end: 4,
      snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
      rule_id: 'SEC-002', severity: 'critical', title: 'Hardcoded Secret',
      recommendation: 'Read JWT_SECRET from process.env, fail at startup if it is missing, and rotate the leaked value.',
    },
  ],
};

export const UNGROUNDED_FINDINGS = {
  ...GROUNDED_FINDINGS,
  findings: [
    ...GROUNDED_FINDINGS.findings,
    { file: 'src/crypto_vault.ts', line_start: 10, line_end: 12, snippet: 'const cipher = crypto.createCipher("des", key);', rule_id: 'SEC-003', severity: 'high', title: 'Deprecated Cipher', recommendation: 'Replace DES with AES-256-GCM via crypto.createCipheriv.' },
  ],
};

/** Replies "ungrounded" until the prompt carries verifier feedback (REVISE), then "grounded". */
export function reviewDouble(): LlmTransport & { prompts: string[] } {
  const prompts: string[] = [];
  const t = (async ({ options }) => {
    prompts.push(options.prompt);
    const revised = options.prompt.includes('REVISE:');
    return { data: revised ? GROUNDED_FINDINGS : UNGROUNDED_FINDINGS, inputTokens: 100, outputTokens: 50 };
  }) as LlmTransport & { prompts: string[] };
  t.prompts = prompts;
  return t;
}

export const groundedOnlyDouble: LlmTransport = async () => ({ data: GROUNDED_FINDINGS, inputTokens: 100, outputTokens: 50 });
export const echoDouble: LlmTransport = async () => ({ data: { result: 'ok' }, inputTokens: 1, outputTokens: 1 });
export const invalidDouble: LlmTransport = async () => ({ data: { findings: 'not an array' }, inputTokens: 1, outputTokens: 1 });

/**
 * TEST DOUBLE for the buyer agent's model. Routes by schema name and answers from a script, so
 * tests can check Stoat's deterministic validation of whatever a model might say, including a
 * hostile or malformed model.
 */
export function negotiationDouble(script: {
  /** Counteroffer amounts to return, one per round. */
  counters?: string[];
  recommend?: 'first' | 'last' | string;
  comparison?: 'ok' | 'invalid' | 'unknown_id';
  counterCurrency?: string;
} = {}): LlmTransport & { prompts: { schema: string; prompt: string }[] } {
  const prompts: { schema: string; prompt: string }[] = [];
  let round = 0;
  const t = (async ({ options }) => {
    prompts.push({ schema: options.schemaName, prompt: options.prompt });
    const ids = [...options.prompt.matchAll(/"quote_id":"([0-9a-f-]{36})"/g)].map((m) => m[1]);
    const unique = [...new Set(ids)];
    if (options.schemaName === 'offer_comparison') {
      if (script.comparison === 'invalid') return { data: { ranking: 'nope' }, inputTokens: 1, outputTokens: 1 };
      const pick = script.recommend === 'last' ? unique[unique.length - 1] : script.recommend && script.recommend !== 'first' ? script.recommend : unique[0];
      return {
        data: {
          ranking: unique.map((id, i) => ({ quote_id: id, score: 90 - i * 10, strengths: ['price'], risks: [] })),
          recommended_quote_id: script.comparison === 'unknown_id' ? '00000000-0000-4000-8000-000000000000' : pick,
          alternatives_considered: unique.filter((id) => id !== pick).map((id) => ({ quote_id: id, reason: 'higher price' })),
          rationale_summary: 'Best price with strong verification coverage.',
        },
        inputTokens: 10, outputTokens: 10,
      };
    }
    const amounts = script.counters ?? ['0.10'];
    const amount = amounts[Math.min(round++, amounts.length - 1)];
    return {
      data: {
        quote_id: unique[0], proposed_amount: amount, currency: script.counterCurrency ?? 'USD',
        scope_delta: 'Review src/auth.ts first', deadline_hours: 24,
        acceptance_criteria: ['Every finding cites a real line', 'Only allowed rules'],
        rationale_summary: 'Asking for a modest discount for a prompt, well-scoped job.', alternatives_considered: [],
      },
      inputTokens: 10, outputTokens: 10,
    };
  }) as LlmTransport & { prompts: { schema: string; prompt: string }[] };
  t.prompts = prompts;
  return t;
}

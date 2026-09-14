/**
 * Providers disagree on what `inputTokens` means. Anthropic reports only the
 * fresh (uncached) prompt tokens, with cache reads separate; OpenAI-style
 * usage counts the whole prompt, cache hits included, so `inputTokens` already
 * contains `cachedInputTokens`. Paseo's AgentUsage passes both through without
 * defining which convention applies.
 *
 * The ledger stores values exactly as reported (so history can always be
 * reinterpreted) and normalizes at read time to the canonical form that loses
 * no information: input = fresh uncached prompt tokens, cached = cache reads.
 * Inclusive-input providers are converted (input − cached); the reverse
 * direction would be unrecoverable, which is why Anthropic semantics is the
 * canonical one.
 *
 * Entries are added only after checking a real turn record against the
 * provider's documented counting rules (see AGENTS.md for the workflow).
 * Unknown providers get null and their numbers pass through unchanged —
 * displayed as reported, never guessed.
 */
export type UsageSemantics = {
  /** True when the provider's inputTokens already includes cachedInputTokens. */
  inputIncludesCached: boolean;
};

/** Aggregation is a harness contract. A model name cannot establish it. */
export function providerSemantics(provider: string | null): {
  tokens: 'turn' | 'request' | 'unknown'; cost: 'session' | 'unknown';
} {
  if (/claude|anthropic/i.test(provider ?? '')) return { tokens: 'turn', cost: 'session' };
  if (/codex/i.test(provider ?? '')) return { tokens: 'request', cost: 'unknown' };
  return { tokens: 'unknown', cost: 'unknown' };
}

const SEMANTICS_TABLE: Array<[RegExp, UsageSemantics]> = [
  [/claude|anthropic/i, { inputIncludesCached: false }],
  [/codex|openai|gpt/i, { inputIncludesCached: true }],
];

/** Looks up verified usage semantics by provider, falling back to model. */
export function usageSemantics(provider: string | null, model: string | null): UsageSemantics | null {
  for (const key of [provider, model]) {
    if (!key) continue;
    for (const [pattern, semantics] of SEMANTICS_TABLE) {
      if (pattern.test(key)) return semantics;
    }
  }
  return null;
}

/**
 * Canonical fresh-input count for a single observation or record: subtracts
 * cache reads when the provider counts them inside inputTokens, passes the
 * value through otherwise (including unknown semantics).
 */
export function freshInput(
  semantics: UsageSemantics | null,
  input: number | null,
  cached: number | null,
): number | null {
  if (!semantics?.inputIncludesCached || input === null) return input;
  return Math.max(0, input - (cached ?? 0));
}

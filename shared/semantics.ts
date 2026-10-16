/** Usage belongs to the harness contract, never to the selected model name. */
export type UsageSemantics = { inputIncludesCached: boolean };
export type TokenScope = 'turn' | 'session' | 'unknown';

const CLAUDE = /^(?:claude|anthropic)(?:$|[-/:])/i;
const CODEX = /^codex(?:$|[-/:])/i;
const OMP = /^omp(?:$|[-/:])/i;

export function providerSemantics(provider: string | null): {
  tokens: 'turn' | 'request' | 'session' | 'unknown'; cost: 'session' | 'unknown';
} {
  if (CLAUDE.test(provider ?? '')) return { tokens: 'turn', cost: 'session' };
  if (CODEX.test(provider ?? '')) return { tokens: 'request', cost: 'unknown' };
  // OMP exposes current-branch session totals, not monotonic billing counters.
  // Without branch epochs and final-drain ordering, neither tokens nor cost
  // can safely be differenced into turns.
  if (OMP.test(provider ?? '')) return { tokens: 'session', cost: 'unknown' };
  return { tokens: 'unknown', cost: 'unknown' };
}

export function tokenScope(record: { provider: string | null; tokenScope?: TokenScope }): TokenScope {
  if (record.tokenScope) return record.tokenScope;
  const scope = providerSemantics(record.provider).tokens;
  return scope === 'request' ? 'turn' : scope;
}

export function usageSemantics(provider: string | null): UsageSemantics | null {
  if (CLAUDE.test(provider ?? '') || OMP.test(provider ?? '')) return { inputIncludesCached: false };
  if (CODEX.test(provider ?? '')) return { inputIncludesCached: true };
  return null;
}

/** Uncached input; when writes are unavailable it can still contain writes. */
export function freshInput(
  semantics: UsageSemantics | null,
  input: number | null,
  cached: number | null,
  cacheWrite?: number | null,
): number | null {
  if (!semantics?.inputIncludesCached || input === null) return input;
  if (cached === null) return null;
  const remaining = input - cached - (cacheWrite ?? 0);
  return remaining >= 0 ? remaining : null;
}

/** Complete prompt size from raw usage; missing counts are not measured zero. */
export function promptTokens(provider: string | null, usage: {
  input: number | null; cached: number | null; cacheWrite?: number | null;
}): number | null {
  const semantics = usageSemantics(provider);
  if (!semantics || usage.input === null) return null;
  if (semantics.inputIncludesCached) {
    if (usage.cached != null && usage.cached + (usage.cacheWrite ?? 0) > usage.input) return null;
    return usage.input;
  }
  if (usage.cached === null || usage.cacheWrite == null) return null;
  return usage.input + usage.cached + usage.cacheWrite;
}

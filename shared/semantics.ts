/** Usage belongs to the harness contract, never to the selected model name. */
export type UsageSemantics = { inputIncludesCached: boolean };
export type TokenScope = 'turn' | 'session' | 'unknown';

const CLAUDE = /^(?:claude|anthropic)(?:$|[-/:])/i;
const CODEX = /^codex(?:$|[-/:])/i;
const OMP = /^omp(?:$|[-/:])/i;
const known = (provider: string) => CLAUDE.test(provider) || CODEX.test(provider) || OMP.test(provider);

// Custom providers declared with `extends` in the daemon config run their base harness.
let bases = new Map<string, string>();
let basesRevision = 0;

export function setProviderBases(next: Record<string, string>) {
  const map = new Map(Object.entries(next));
  if (JSON.stringify([...map]) === JSON.stringify([...bases])) return;
  bases = map;
  basesRevision++;
}
export const providerBasesRevision = () => basesRevision;

/** The harness whose usage contract a provider follows; unresolved names stay as they are. */
export function harnessOf(provider: string | null): string | null {
  let current = provider;
  for (let depth = 0; current && !known(current) && depth < 4; depth++) {
    const base = bases.get(current);
    if (!base) break;
    current = base;
  }
  return current && known(current) ? current : provider;
}

export function providerSemantics(provider: string | null): {
  tokens: 'turn' | 'request' | 'session' | 'unknown'; cost: 'session' | 'unknown';
} {
  const harness = harnessOf(provider) ?? '';
  if (CLAUDE.test(harness)) return { tokens: 'turn', cost: 'session' };
  if (CODEX.test(harness)) return { tokens: 'request', cost: 'unknown' };
  // OMP exposes current-branch session totals, not monotonic billing counters.
  // Without branch epochs and final-drain ordering, neither tokens nor cost
  // can safely be differenced into turns.
  if (OMP.test(harness)) return { tokens: 'session', cost: 'unknown' };
  return { tokens: 'unknown', cost: 'unknown' };
}

export function tokenScope(record: { provider: string | null; harness?: string | null; tokenScope?: TokenScope }): TokenScope {
  if (record.tokenScope) return record.tokenScope;
  const scope = providerSemantics(record.harness ?? record.provider).tokens;
  return scope === 'request' ? 'turn' : scope;
}

export function usageSemantics(provider: string | null): UsageSemantics | null {
  const harness = harnessOf(provider) ?? '';
  if (CLAUDE.test(harness) || OMP.test(harness)) return { inputIncludesCached: false };
  if (CODEX.test(harness)) return { inputIncludesCached: true };
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

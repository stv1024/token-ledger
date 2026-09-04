/**
 * Per-model pricing used to estimate a cost breakdown per turn. Upstream only
 * reports a total costUsd, never per-component costs, so the split shown in
 * the UI is an estimate: token counts × list price, rescaled so the three
 * components sum to the reported total when one exists.
 *
 * Prices are $/MTok. Cache read is billed at 0.1× the input price.
 */
export type ModelPricing = {
  input: number;
  cacheRead: number;
  output: number;
};

const PRICING_TABLE: Array<[RegExp, ModelPricing]> = [
  [/fable-5|mythos/i, { input: 10, cacheRead: 1.0, output: 50 }],
  [/opus/i, { input: 5, cacheRead: 0.5, output: 25 }],
  [/sonnet/i, { input: 3, cacheRead: 0.3, output: 15 }],
  [/haiku/i, { input: 1, cacheRead: 0.1, output: 5 }],
];

export function modelPricing(model: string | null): ModelPricing | null {
  if (!model) return null;
  for (const [pattern, pricing] of PRICING_TABLE) {
    if (pattern.test(model)) return pricing;
  }
  return null;
}

export type CostBreakdown = {
  inUsd: number;
  cacheUsd: number;
  outUsd: number;
};

const PER_MTOK = 1_000_000;

/**
 * Estimates per-component costs for a turn. When the turn carries a real
 * total (costUsd), the estimate is rescaled so components sum to it exactly —
 * the total stays authoritative, only the split is estimated. Returns null
 * when the model has no known pricing or no token counts were reported.
 */
export function costBreakdown(turn: {
  model: string | null;
  input: number | null;
  cached: number | null;
  output: number | null;
  costUsd: number | null;
}): CostBreakdown | null {
  const pricing = modelPricing(turn.model);
  if (!pricing) return null;
  if (turn.input === null && turn.cached === null && turn.output === null) return null;
  let inUsd = ((turn.input ?? 0) * pricing.input) / PER_MTOK;
  let cacheUsd = ((turn.cached ?? 0) * pricing.cacheRead) / PER_MTOK;
  let outUsd = ((turn.output ?? 0) * pricing.output) / PER_MTOK;
  const estimated = inUsd + cacheUsd + outUsd;
  if (turn.costUsd !== null && estimated > 0) {
    const scale = turn.costUsd / estimated;
    inUsd *= scale;
    cacheUsd *= scale;
    outUsd *= scale;
  }
  return { inUsd, cacheUsd, outUsd };
}

/** Share of prompt tokens served from cache: cached / (input + cached). */
export function cacheRatio(input: number | null, cached: number | null): number | null {
  if (cached === null) return null;
  const prompt = (input ?? 0) + cached;
  if (prompt <= 0) return null;
  return cached / prompt;
}

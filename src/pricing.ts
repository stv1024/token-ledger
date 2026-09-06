/**
 * Per-model pricing used to estimate a cost breakdown per turn. Upstream only
 * reports a total costUsd, never per-component costs, so the split shown in
 * the UI is an estimate: token counts × list price. When a real total exists,
 * the difference between it and the estimate is surfaced as `otherUsd` rather
 * than smeared across the components — for Claude turns that residual is
 * mostly cache writes, which Paseo drops from AgentUsage (its Claude provider
 * only maps cache_read_input_tokens; cache creation is billed at 1.25× the
 * input price but never reported as tokens).
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
  /**
   * costUsd minus the list-price estimate of the three components; null when
   * no real total was reported. Positive residual is cost the reported token
   * counts can't account for (chiefly cache writes on Claude); a small
   * negative residual just means the hardcoded list prices overestimate.
   */
  otherUsd: number | null;
};

const PER_MTOK = 1_000_000;

/**
 * Estimates per-component costs for a turn at list prices. When the turn
 * carries a real total (costUsd), the gap between total and estimate is
 * returned as otherUsd instead of being folded into the components. Returns
 * null when the model has no known pricing or no token counts were reported.
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
  const inUsd = ((turn.input ?? 0) * pricing.input) / PER_MTOK;
  const cacheUsd = ((turn.cached ?? 0) * pricing.cacheRead) / PER_MTOK;
  const outUsd = ((turn.output ?? 0) * pricing.output) / PER_MTOK;
  const otherUsd = turn.costUsd !== null ? turn.costUsd - (inUsd + cacheUsd + outUsd) : null;
  return { inUsd, cacheUsd, outUsd, otherUsd };
}

/**
 * Share of prompt tokens served from cache: cached / (input + cached).
 * Expects input in canonical fresh-token form (see semantics.ts) — the server
 * normalizes inclusive-input providers before values reach clients.
 */
export function cacheRatio(input: number | null, cached: number | null): number | null {
  if (cached === null) return null;
  const prompt = (input ?? 0) + cached;
  if (prompt <= 0) return null;
  return cached / prompt;
}

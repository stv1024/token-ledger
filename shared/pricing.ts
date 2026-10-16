/**
 * Per-model pricing used to estimate a cost breakdown per turn. Upstream only
 * reports a total costUsd, never per-component costs, so the split shown in
 * the UI is an estimate: token counts × reference price. Reported runtime cost
 * is not proof of an invoice. Its difference from known estimated components
 * is a residual, not an inferred cache-write charge.
 *
 * Prices are $/MTok. Cache write is independent of the input/read rates;
 * neither cache lifetime nor a provider's write premium is inferred.
 */
export type ModelPricing = {
  input: number;
  cacheRead?: number;
  /** Missing means the write rate is unknown; zero is an explicitly free rate. */
  cacheWrite?: number;
  output: number;
};

// Standard-mode list prices verified 2026-09-23:
// https://platform.claude.com/docs/en/about-claude/pricing
// Explicit versions prevent new models or Fast/Batch suffixes inheriting old rates.
const PRICING_TABLE: Array<[RegExp, ModelPricing]> = [
  [/^claude-(?:fable|mythos)-5-1$/, { input: 10, cacheRead: 0.25, output: 50 }],
  [/^claude-(?:fable|mythos)-5$/, { input: 10, cacheRead: 1, output: 50 }],
  [/^claude-opus-5-5$/, { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }],
  [/^claude-opus-(?:5|4-[5-8])$/, { input: 5, cacheRead: 0.5, output: 25 }],
  [/^claude-opus-4(?:-1)?$/, { input: 15, cacheRead: 1.5, output: 75 }],
  [/^claude-sonnet-5$/, { input: 2, cacheRead: 0.2, output: 10 }],
  [/^claude-sonnet-4(?:-[56])?$/, { input: 3, cacheRead: 0.3, output: 15 }],
  [/^claude-haiku-4-5$/, { input: 1, cacheRead: 0.1, output: 5 }],
  [/^claude-haiku-3-5$/, { input: 0.8, cacheRead: 0.08, output: 4 }],
];

export function canonicalModel(value: string): string {
  const model = value.trim().toLowerCase();
  // Standard Claude numeric versions use both 4.5 and 4-5 spellings. Preserve
  // namespaces, context/mode suffixes and arbitrary model identities.
  return /^(?:anthropic\/)?claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:[.-]\d+)*$/.test(model)
    ? model.replace(/\./g, '-') : model;
}

export function modelPricing(model: string | null): ModelPricing | null {
  if (!model) return null;
  const canonical = canonicalModel(model).replace(/^anthropic\//, '').replace(/-\d{8}$/, '').replace(/(?<=\d)\.(?=\d)/g, '-');
  for (const [pattern, pricing] of PRICING_TABLE) {
    if (pattern.test(canonical)) return pricing;
  }
  return null;
}

export type CostBreakdown = {
  inUsd: number | null;
  cacheUsd: number | null;
  cacheWriteUsd?: number | null;
  outUsd: number | null;
  /**
   * Reported runtime cost minus the sum of known estimated components.
   * This includes price/source differences as well as unobserved categories;
   * it does not establish actual billing or identify missing token counts.
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
  cacheWrite?: number | null;
  output: number | null;
  costUsd: number | null;
}): CostBreakdown | null {
  const pricing = modelPricing(turn.model);
  if (!pricing) return null;
  return costBreakdownWithPricing(turn, pricing);
}

/** Computes a breakdown with pricing selected by the server. */
export function costBreakdownWithPricing(
  turn: { input: number | null; cached: number | null; cacheWrite?: number | null; output: number | null; costUsd: number | null },
  pricing: ModelPricing,
): CostBreakdown | null {
  if (turn.input === null && turn.cached === null && turn.output === null && turn.cacheWrite == null) return null;
  const inUsd = turn.input === null ? null : turn.input * pricing.input / PER_MTOK;
  const cacheUsd = turn.cached === null ? null : turn.cached === 0 ? 0
    : pricing.cacheRead === undefined ? null : turn.cached * pricing.cacheRead / PER_MTOK;
  const cacheWriteUsd = turn.cacheWrite == null ? null : turn.cacheWrite === 0 ? 0
    : pricing.cacheWrite === undefined ? null : turn.cacheWrite * pricing.cacheWrite / PER_MTOK;
  const outUsd = turn.output === null ? null : turn.output * pricing.output / PER_MTOK;
  const known = (inUsd ?? 0) + (cacheUsd ?? 0) + (cacheWriteUsd ?? 0) + (outUsd ?? 0);
  const otherUsd = turn.costUsd !== null ? turn.costUsd - known : null;
  return { inUsd, cacheUsd, cacheWriteUsd, outUsd, otherUsd };
}

/** Ratio only when the complete prompt denominator is available. */
export function cacheRatio(cached: number | null, prompt: number | null): number | null {
  if (cached === null || prompt === null || prompt <= 0 || cached > prompt) return null;
  return cached / prompt;
}

/** Known components only; callers must preserve the separate completeness flag. */
export function knownCost(split: CostBreakdown | null): number | null {
  if (!split) return null;
  let sum: number | null = null;
  for (const value of [split.inUsd, split.cacheUsd, split.cacheWriteUsd, split.outUsd]) {
    if (value != null) sum = (sum ?? 0) + value;
  }
  return sum;
}

export function partialCost(split: CostBreakdown | null): boolean {
  return !split || split.inUsd === null || split.cacheUsd === null || split.cacheWriteUsd == null || split.outUsd === null;
}

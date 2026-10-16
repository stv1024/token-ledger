import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheRatio, costBreakdown, costBreakdownWithPricing, knownCost, modelPricing, partialCost } from "./pricing.ts";

test("model matching covers known families and rejects unknown", () => {
  assert.deepEqual(modelPricing("claude-opus-5"), { input: 5, cacheRead: 0.5, output: 25 });
  assert.deepEqual(modelPricing("claude-sonnet-4-6"), { input: 3, cacheRead: 0.3, output: 15 });
  assert.deepEqual(modelPricing("claude-haiku-4-5"), { input: 1, cacheRead: 0.1, output: 5 });
  assert.deepEqual(modelPricing("claude-fable-5"), { input: 10, cacheRead: 1.0, output: 50 });
  assert.equal(modelPricing("gpt-5-codex"), null);
  assert.equal(modelPricing(null), null);
});

test('Opus 5.5 uses verified standard prices across aliases without guessing Fast Mode or future models', () => {
  const standard = { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 };
  for (const model of ['claude-opus-5.5', 'claude-opus-5-5', 'anthropic/claude-opus-5.5']) {
    assert.deepEqual(modelPricing(model), standard);
  }
  for (const model of ['claude-opus-5-5[1m]', 'vendor/claude-opus-5-5', '["claude-opus-4","claude-opus-5"]', 'claude-opus-5.5-fast', 'claude-opus-5.5:batch', 'claude-opus-6', 'claude-opus-5.6']) {
    assert.equal(modelPricing(model), null);
  }
  assert.deepEqual(modelPricing('claude-opus-4-1-20250805'), { input: 15, cacheRead: 1.5, output: 75 });
});

test("breakdown estimates from list prices when no total is reported", () => {
  const split = costBreakdown({
    model: "claude-opus-5",
    input: 1_000_000,
    cached: 1_000_000,
    output: 1_000_000,
    costUsd: null,
  });
  assert.ok(split);
  assert.equal(split.inUsd, 5);
  assert.equal(split.cacheUsd, 0.5);
  assert.equal(split.outUsd, 25);
  assert.equal(split.otherUsd, null);
});

test("breakdown surfaces the gap between reported total and estimate as otherUsd", () => {
  const split = costBreakdown({
    model: "claude-opus-5",
    input: 1_000_000,
    cached: 1_000_000,
    output: 1_000_000,
    costUsd: 35.5, // $5 above the 30.5 list-price estimate (e.g. unreported cache writes)
  });
  assert.ok(split);
  // Components stay at list price — the residual is not smeared into them.
  assert.equal(split.inUsd, 5);
  assert.equal(split.cacheUsd, 0.5);
  assert.equal(split.outUsd, 25);
  assert.ok(split.otherUsd !== null && Math.abs(split.otherUsd - 5) < 1e-9);
});

test("otherUsd goes negative when list prices overestimate the reported total", () => {
  const split = costBreakdown({
    model: "claude-opus-5",
    input: 1_000_000,
    cached: 0,
    output: 0,
    costUsd: 4,
  });
  assert.ok(split);
  assert.ok(split.otherUsd !== null && Math.abs(split.otherUsd - -1) < 1e-9);
});

test("breakdown is null for unknown models or missing usage", () => {
  assert.equal(costBreakdown({ model: "gpt-5-codex", input: 100, cached: 0, output: 10, costUsd: 1 }), null);
  assert.equal(costBreakdown({ model: "claude-opus-5", input: null, cached: null, output: null, costUsd: 1 }), null);
});

test("zero-token turn with a real total attributes everything to otherUsd", () => {
  const split = costBreakdown({ model: "claude-opus-5", input: 0, cached: 0, cacheWrite: 0, output: 0, costUsd: 0.5 });
  assert.deepEqual(split, { inUsd: 0, cacheUsd: 0, cacheWriteUsd: 0, outUsd: 0, otherUsd: 0.5 });
});

test('cache rate requires a complete, consistent denominator', () => {
  assert.equal(cacheRatio(8000, 10000), 0.8);
  assert.equal(cacheRatio(8000, null), null);
  assert.equal(cacheRatio(null, 10000), null);
  assert.equal(cacheRatio(0, 0), null);
  assert.equal(cacheRatio(10001, 10000), null);
  assert.equal(cacheRatio(0, 10000), 0);
});

test('cache writes have an independent price and do not increase reported totals', () => {
  const usage = { input: 10, cached: 60, cacheWrite: 30, output: 5, costUsd: 1 };
  const split = costBreakdownWithPricing(usage, { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 5 })!;
  assert.equal(split.inUsd, 0.00001);
  assert.equal(split.cacheWriteUsd, 0.00006);
  assert.equal(knownCost(split)! + split.otherUsd!, 1);
  assert.equal(costBreakdownWithPricing(usage, { input: 1, cacheRead: 0.1, output: 5 })!.cacheWriteUsd, null);
  assert.equal(costBreakdownWithPricing(usage, { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 5 })!.cacheWriteUsd, 0);
});

test('unknown token counts and rates stay unknown, while explicit zero remains free', () => {
  const missing = costBreakdownWithPricing({ input: null, cached: 8000, output: null, costUsd: null }, { input: 1, cacheRead: 0.1, output: 5 })!;
  assert.equal(missing.inUsd, null);
  assert.equal(missing.outUsd, null);
  assert.equal(missing.cacheWriteUsd, null);
  assert.equal(knownCost(missing), 0.0008);
  assert.equal(partialCost(missing), true);
  const zero = costBreakdownWithPricing({ input: 0, cached: 0, cacheWrite: 0, output: 0, costUsd: null }, { input: 1, output: 5 })!;
  assert.equal(knownCost(zero), 0);
  assert.equal(partialCost(zero), false);
});

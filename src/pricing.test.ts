import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheRatio, costBreakdown, modelPricing } from "./pricing.ts";

test("model matching covers known families and rejects unknown", () => {
  assert.deepEqual(modelPricing("claude-opus-5"), { input: 5, cacheRead: 0.5, output: 25 });
  assert.deepEqual(modelPricing("claude-sonnet-4-6"), { input: 3, cacheRead: 0.3, output: 15 });
  assert.deepEqual(modelPricing("claude-haiku-4-5"), { input: 1, cacheRead: 0.1, output: 5 });
  assert.deepEqual(modelPricing("claude-fable-5"), { input: 10, cacheRead: 1.0, output: 50 });
  assert.equal(modelPricing("gpt-5-codex"), null);
  assert.equal(modelPricing(null), null);
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
});

test("breakdown rescales so components sum to the reported total", () => {
  const split = costBreakdown({
    model: "claude-opus-5",
    input: 1_000_000,
    cached: 1_000_000,
    output: 1_000_000,
    costUsd: 61, // 2× the 30.5 list-price estimate
  });
  assert.ok(split);
  assert.ok(Math.abs(split.inUsd + split.cacheUsd + split.outUsd - 61) < 1e-9);
  assert.ok(Math.abs(split.inUsd - 10) < 1e-9);
  assert.ok(Math.abs(split.cacheUsd - 1) < 1e-9);
  assert.ok(Math.abs(split.outUsd - 50) < 1e-9);
});

test("breakdown is null for unknown models or missing usage", () => {
  assert.equal(costBreakdown({ model: "gpt-5-codex", input: 100, cached: 0, output: 10, costUsd: 1 }), null);
  assert.equal(costBreakdown({ model: "claude-opus-5", input: null, cached: null, output: null, costUsd: 1 }), null);
});

test("zero-token turn with a real total does not divide by zero", () => {
  const split = costBreakdown({ model: "claude-opus-5", input: 0, cached: 0, output: 0, costUsd: 0.5 });
  assert.deepEqual(split, { inUsd: 0, cacheUsd: 0, outUsd: 0 });
});

test("cacheRatio", () => {
  assert.equal(cacheRatio(2000, 8000), 0.8);
  assert.equal(cacheRatio(null, 8000), 1);
  assert.equal(cacheRatio(2000, null), null);
  assert.equal(cacheRatio(0, 0), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenRouterDefaultPricing } from "./pricing.ts";

test("TokenRouter quota prices are converted to USD per million tokens", () => {
  assert.deepEqual(tokenRouterDefaultPricing("gpt-5.6-sol", 100_000), {
    input: 5.000222,
    cacheRead: 0.499948,
    output: 29.999852,
  });
});

test("TokenRouter aliases normalize dots, hyphens, vendor prefixes, and 1m suffixes", () => {
  assert.deepEqual(tokenRouterDefaultPricing("tokenrouter/claude-opus-4-6[1m]", 100_000), {
    input: 5.000222,
    cacheRead: 0.499948,
    output: 25.000369,
  });
});

test("TokenRouter tiered pricing selects the prompt-size tier", () => {
  assert.deepEqual(tokenRouterDefaultPricing("gpt-6-astra", 272_000), {
    input: 9.999705,
    cacheRead: 0.999897,
    output: 50,
  });
  assert.deepEqual(tokenRouterDefaultPricing("gpt-6-astra", 272_001), {
    input: 20.000148,
    cacheRead: 1.999793,
    output: 75.000369,
  });
});

test("unknown TokenRouter model has no invented price", () => {
  assert.equal(tokenRouterDefaultPricing("future-model", 100), null);
});

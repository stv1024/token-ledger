import assert from "node:assert/strict";
import { test } from "node:test";
import { freshInput, usageSemantics } from "./semantics.ts";

test("semantics lookup matches provider first, then model, else null", () => {
  assert.deepEqual(usageSemantics("claude-tokenrouter", null), { inputIncludesCached: false });
  assert.deepEqual(usageSemantics("codex-tokenrouter", null), { inputIncludesCached: true });
  assert.deepEqual(usageSemantics(null, "gpt-5.6-sol"), { inputIncludesCached: true });
  assert.deepEqual(usageSemantics("some-router", "claude-fable-5"), { inputIncludesCached: false });
  assert.equal(usageSemantics("mystery-provider", "mystery-model"), null);
  assert.equal(usageSemantics(null, null), null);
});

test("freshInput subtracts cache reads for inclusive-input providers", () => {
  const codex = usageSemantics("codex-tokenrouter", null);
  // Real gpt-5.6-sol turn: inputTokens counts the whole prompt, cache hits included.
  assert.equal(freshInput(codex, 213818, 213252), 566);
  assert.equal(freshInput(codex, 100, null), 100);
  assert.equal(freshInput(codex, null, 5000), null);
  // Clamped rather than negative if a provider ever over-reports cache reads.
  assert.equal(freshInput(codex, 100, 150), 0);
});

test("freshInput passes through for exclusive-input and unknown providers", () => {
  const claude = usageSemantics("claude-tokenrouter", null);
  assert.equal(freshInput(claude, 78, 2_974_078), 78);
  assert.equal(freshInput(null, 78, 2_974_078), 78);
  assert.equal(freshInput(null, null, null), null);
});

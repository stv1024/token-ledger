import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshInput, promptTokens, tokenScope, usageSemantics } from './semantics.ts';

test('harness-normalized input is not normalized a second time', () => {
  assert.equal(freshInput(usageSemantics('omp'), 160290, 2511639), 160290);
  assert.equal(freshInput(usageSemantics('claude-router'), 6, 70751), 6);
  assert.equal(freshInput(usageSemantics('codex-router'), 213818, 213252), 566);
  assert.equal(tokenScope({ provider: 'omp' }), 'session');
  assert.equal(tokenScope({ provider: 'custom-gpt' }), 'unknown');
  assert.equal(usageSemantics('not-claude'), null);
});

test('missing and inconsistent cache counts cannot fabricate fresh input', () => {
  const codex = usageSemantics('codex');
  assert.equal(freshInput(codex, 100, null), null);
  assert.equal(freshInput(codex, 100, 150), null);
  assert.equal(freshInput(codex, 100, 60, 30), 10);
  assert.equal(freshInput(codex, null, 60), null);
});

test('prompt coverage follows the raw harness convention, not missing-value arithmetic', () => {
  const usage = { input: 6, cached: 70751 };
  assert.equal(promptTokens('claude', usage), null);
  assert.equal(promptTokens('claude', { ...usage, cacheWrite: 45829 }), 116586);
  assert.equal(promptTokens('claude', { ...usage, cacheWrite: 0 }), 70757);
  assert.equal(promptTokens('codex', { input: 100, cached: 80 }), 100);
  assert.equal(promptTokens('codex', { input: 100, cached: 120 }), null);
  assert.equal(promptTokens('unknown', { input: 100, cached: 80, cacheWrite: 0 }), null);
});

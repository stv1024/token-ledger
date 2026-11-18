import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeTurn } from '../shared/aggregate.ts';
import { enrichTurn } from './pricing.ts';
import { addSummary, EMPTY_SUMMARY, summaryFromRows } from './read-model.ts';

const base = { agentId: 'a', turnId: 't', provider: 'omp', model: 'gpt-model', startedAt: null,
  endedAt: '2026-10-14T00:00:00Z', status: 'completed' as const, observations: [], prevSessionCostUsd: null };

test('historical cumulative snapshots remain visible without duplicating turn totals or prices', () => {
  const first = finalizeTurn({ ...base, finalUsage: { inputTokens: 1000, cachedInputTokens: 4000, outputTokens: 100, totalCostUsd: 1 } });
  const next = finalizeTurn({ ...base, finalUsage: { inputTokens: 2000, cachedInputTokens: 9000, outputTokens: 200, totalCostUsd: 2 } });
  const rows = [first, next].map((r, i) => enrichTurn({ ...r, tokenScope: undefined, costUsd: 9 }, i + 1));
  assert.equal(rows[1].input, 2000);
  assert.equal(rows[1].tokenScope, 'session');
  assert.equal(rows[1].effectiveCostUsd, null);
  const summary = summaryFromRows(rows);
  assert.equal(summary.input, null);
  assert.equal(summary.cached, null);
  assert.equal(summary.effectiveCostUsd, null);
  assert.equal(summary.unmeasuredTurns, 2);
  assert.equal(summary.unpricedTurns, 2);
});

test('known turn values and measured zero survive beside unknown scope without hiding coverage', () => {
  const known = finalizeTurn({ ...base, provider: 'claude', finalUsage: { inputTokens: 0, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 0, totalCostUsd: 1 } });
  const unknown = finalizeTurn({ ...base, provider: 'custom', finalUsage: { inputTokens: 9000, outputTokens: 9000, totalCostUsd: 20 } });
  const summary = summaryFromRows([enrichTurn(known, 1), enrichTurn(unknown, 2)]);
  assert.equal(summary.input, 0);
  assert.equal(summary.cached, 10);
  assert.equal(summary.output, 0);
  assert.equal(summary.effectiveCostUsd, 1);
  assert.equal(summary.unmeasuredTurns, 1);
  assert.equal(summary.incompleteTurns, 1);
  assert.equal(summary.unpricedTurns, 1);
});

test('summary keeps complete prompts apart from prompt floors and counts the rest as unknown', () => {
  // Codex input includes cache read: prompt 10000, read 8000.
  const codex = finalizeTurn({ ...base, provider: 'codex', finalUsage: { inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 50 } });
  // Claude with a known write: prompt 1000 + 3000 + 1000 = 5000, read 3000.
  const claudeKnown = finalizeTurn({ ...base, provider: 'claude', finalUsage: { inputTokens: 1000, cachedInputTokens: 3000, cacheWriteInputTokens: 1000, outputTokens: 50 } });
  // Claude without the write (Paseo drops it): the prompt is at least 1000 + 9000, not exactly that.
  const claudeMissing = finalizeTurn({ ...base, provider: 'claude', finalUsage: { inputTokens: 1000, cachedInputTokens: 9000, outputTokens: 50 } });
  // Session snapshots are not turn totals.
  const snapshot = finalizeTurn({ ...base, finalUsage: { inputTokens: 1000, cachedInputTokens: 4000, outputTokens: 100 } });
  const summary = summaryFromRows([codex, claudeKnown, claudeMissing, snapshot].map((r, i) => enrichTurn(r, i + 1)));
  assert.equal(summary.promptTokens, 15000);
  assert.equal(summary.promptCached, 11000);
  assert.equal(summary.promptFloorTokens, 10000);
  assert.equal(summary.promptFloorCached, 9000);
  assert.equal(summary.unknownPromptTurns, 1);
  assert.equal(summary.cached, 20000);
});

test('a turn without a cache write gives only a prompt floor, never a complete prompt', () => {
  const claudeMissing = finalizeTurn({ ...base, provider: 'claude', finalUsage: { inputTokens: 1000, cachedInputTokens: 9000, outputTokens: 50 } });
  const row = enrichTurn(claudeMissing, 1);
  assert.equal(row.promptTokens, null);
  assert.equal(row.minPromptTokens, 10000);
  const summary = summaryFromRows([row]);
  assert.equal(summary.promptTokens, null);
  assert.equal(summary.promptCached, null);
  assert.equal(summary.promptFloorTokens, 10000);
  assert.equal(summary.promptFloorCached, 9000);
  assert.equal(summary.unknownPromptTurns, 0);
});

test('summary hit rate stays unknown when no turn has a prompt or a floor', () => {
  const claudeNoReads = finalizeTurn({ ...base, provider: 'claude', finalUsage: { inputTokens: 1000, outputTokens: 50 } });
  const summary = summaryFromRows([enrichTurn(claudeNoReads, 1)]);
  assert.equal(summary.promptTokens, null);
  assert.equal(summary.promptFloorTokens, null);
  assert.equal(summary.unknownPromptTurns, 1);
});

test('overview totals add complete prompts and prompt floors separately', () => {
  const codex = finalizeTurn({ ...base, provider: 'codex', finalUsage: { inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 50 } });
  const claudeMissing = finalizeTurn({ ...base, provider: 'claude', finalUsage: { inputTokens: 1000, cachedInputTokens: 9000, outputTokens: 50 } });
  const totals = { ...EMPTY_SUMMARY };
  addSummary(totals, summaryFromRows([enrichTurn(codex, 1)]));
  addSummary(totals, summaryFromRows([enrichTurn(claudeMissing, 1)]));
  assert.equal(totals.turns, 2);
  assert.equal(totals.promptTokens, 10000);
  assert.equal(totals.promptCached, 8000);
  assert.equal(totals.promptFloorTokens, 10000);
  assert.equal(totals.promptFloorCached, 9000);
  assert.equal(totals.unknownPromptTurns, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeTurn } from '../shared/aggregate.ts';
import { enrichTurn } from './pricing.ts';
import { summaryFromRows } from './read-model.ts';

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

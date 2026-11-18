import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeTurn } from '../shared/aggregate.ts';

test('reads include closed turns that are not on disk yet, without counting them twice', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-read-model-'));
  const previousHome = process.env.PASEO_HOME;
  // The store resolves its path on import; never append to a real ledger.
  process.env.PASEO_HOME = home;
  const store = await import('./store.ts');
  const { readModel } = await import('./read-model.ts');
  try {
    const record = finalizeTurn({ agentId: 'a', turnId: 't', provider: 'claude', model: 'claude-sonnet-4-5',
      startedAt: null, endedAt: '2026-11-18T00:00:00Z', status: 'completed', observations: [], prevSessionCostUsd: null,
      finalUsage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalCostUsd: 1 } });
    assert.equal(readModel().groups.get('a'), undefined);
    const staged = readModel([record]);
    assert.equal(staged.groups.get('a')?.summary.turns, 1);
    await store.appendRecord(record);
    const stored = readModel([record]);
    assert.equal(stored.groups.get('a')?.summary.turns, 1);
    assert.notEqual(stored.revision, staged.revision);
    assert.equal(readModel().revision, stored.revision);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

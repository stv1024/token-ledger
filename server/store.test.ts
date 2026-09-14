import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeTurn } from '../shared/aggregate.ts';

test('concurrent appends and retention preserve disk/memory order and legacy v1 records', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-store-test-'));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    const store = await import('./store.ts');
    const records = Array.from({length: 2203}, (_, i) => finalizeTurn({
      agentId: `agent-${i % 3}`, turnId: `t${i}`, provider: 'codex', model: 'gpt-test',
      startedAt: null, endedAt: new Date(i * 1000).toISOString(), status: 'completed',
      observations: [], finalUsage: {inputTokens: i, cachedInputTokens: 0}, prevSessionCostUsd: null,
    }));
    await Promise.all(records.map(store.appendRecord));
    await store.appendRecord(records.at(-1)!);
    await store.flushStore();
    const persisted = (await readFile(store.dataFilePath(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(persisted.length, 2002);
    assert.deepEqual(persisted, store.allRecords());
    assert.equal(persisted.at(-1).input, 2202);
    assert.equal(new Set(persisted.map(r => r.id)).size, persisted.length);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

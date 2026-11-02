import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import { createState } from './turns.ts';
import { ownedSnapshot } from '../shared/subscription-test-helpers.ts';

test('retired agents leave the frequent checkpoint and return with their cost baseline', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-retired-'));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const dir = join(home, 'plugins', 'token-ledger');
  await mkdir(dir, { recursive: true });
  // A pre-v0.8.3 journal: the closed agent has no ledger record, so only its
  // journal state knows the session cost already reported.
  const closed = { ...createState(), provider: 'claude', sessionId: 's1', prevSessionCostUsd: 5 };
  await writeFile(join(dir, 'tracker-state.json'), JSON.stringify({ v: 1, states: [['live', createState()], ['closed', closed], ['deleted', createState()]], pending: [] }));
  await writeFile(join(dir, 'pricing.json'), JSON.stringify({ version: 1, currency: 'USD', prices: [] }));
  await writeFile(join(dir, 'openrouter-pricing.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), prices: [] }));
  const agent = (id: string, status: string) => ({ id, provider: 'claude', model: 'claude-sonnet-4-5', status, runtimeInfo: { sessionId: 's1' } });
  const paseo = { agents: {
    subscribe: () => () => {},
    list: async () => ownedSnapshot({ entries: [{ agent: agent('live', 'idle') }, { agent: agent('closed', 'closed') }], pageInfo: { nextCursor: null } }).page,
    ref: () => ({ timeline: { subscribe: () => Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} }),
      append: async () => ({ seq: 1, epoch: 'test' }) } }),
  } } as unknown as PaseoApi;
  const tracker = await import('./tracker.ts');
  const ids = async (name: string) => JSON.parse(await readFile(join(dir, name), 'utf8')).states.map(([id]: [string]) => id).sort();
  try {
    await tracker.ensureTracker(paseo);
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the debounced checkpoint land
    assert.deepEqual(await ids('tracker-state.json'), ['live']);
    assert.deepEqual(await ids('tracker-retired.json'), ['closed', 'deleted']);

    tracker.observeStream({ agentId: 'closed', timestamp: '2026-11-02T00:00:00Z', event: { type: 'turn_started', provider: 'claude', turnId: 't1' } });
    tracker.observeStream({ agentId: 'closed', timestamp: '2026-11-02T00:00:01Z', event: { type: 'turn_completed', provider: 'claude', turnId: 't1',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalCostUsd: 7 } } } as never);
    const synced = await tracker.handleSync({ agentId: 'closed' }, { paseo });
    assert.equal(synced.records[0].costUsd, 2);
    await tracker.stopTracker();
    assert.deepEqual(await ids('tracker-state.json'), ['closed', 'live']);
    assert.deepEqual(await ids('tracker-retired.json'), ['deleted']);
  } finally {
    await tracker.stopTracker();
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

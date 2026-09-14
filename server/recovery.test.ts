import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi, PaseoAgentTimelineEvent } from '@getpaseo/client';
import { createState, noteUsage, closeTurn } from './turns.ts';

test('startup replays pending writes idempotently, settles missing agents, and preserves live observations without backfilling timeline', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-recovery-'));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const dir = join(home, 'plugins', 'token-ledger');
  await mkdir(dir, { recursive: true });
  const snapshot = { id: 'live', provider: 'codex', model: 'gpt-5', status: 'running',
    runtimeInfo: { sessionId: 's' }, activeTurn: {turnId: 't', startedAt: '2026-09-14T00:00:00Z'},
    lastUsage: {inputTokens: 100, cachedInputTokens: 50, outputTokens: 10} };
  const live = createState(); noteUsage(live, snapshot);
  const missing = createState(); noteUsage(missing, {...snapshot, id: 'missing'});
  const pendingState = createState(); noteUsage(pendingState, {...snapshot, id: 'pending'});
  const pending = closeTurn('pending', pendingState, 'completed', null, '2026-09-14T00:00:01Z')!;
  await writeFile(join(dir, 'ledger.jsonl'), JSON.stringify(pending) + '\n');
  await writeFile(join(dir, 'tracker-state.json'), JSON.stringify({v:1, states:[['live', live], ['missing', missing]], pending:[pending]}));
  await writeFile(join(dir, 'pricing.json'), JSON.stringify({version:1, currency:'USD', prices:[]}));
  await writeFile(join(dir, 'openrouter-pricing.json'), JSON.stringify({fetchedAt:new Date().toISOString(), prices:[]}));
  let observe!: (event: PaseoAgentTimelineEvent) => void;
  const published: unknown[] = [];
  const paseo = { agents: {
    subscribe: () => () => {},
    list: async () => ({entries:[{agent:snapshot}], pageInfo:{nextCursor:null}}),
    ref: () => ({timeline:{subscribe: (fn: typeof observe) => {
      observe = fn; return Object.assign(() => {}, {ready:Promise.resolve()});
    }, append: async (item: unknown) => {published.push(item); return {seq:1, epoch:'test'};}}}),
  }} as unknown as PaseoApi;
  const tracker = await import('./tracker.ts');
  const store = await import('./store.ts');
  try {
    await tracker.ensureTracker(paseo);
    const before = await tracker.handleSync({agentId:'live'}, {paseo});
    assert.equal(before.inFlight?.input, 50);
    assert.equal(store.allRecords().filter((r) => r.id === pending.id).length, 1);
    assert.match(store.allRecords().find((r) => r.agentId === 'missing')!.source, /^recovered_interruption:/);
    assert.equal(published.length, 0);
    observe({agentId:'live', timestamp:'2026-09-14T00:00:02Z', event:{type:'turn_completed', provider:'codex', turnId:'t', usage:{inputTokens:120, cachedInputTokens:60, outputTokens:20}}});
    const after = await tracker.handleSync({agentId:'live'}, {paseo});
    assert.equal(after.records[0].id, live.open!.key);
    assert.equal(after.records[0].input, 110);
    assert.equal(after.records[0].requests?.length, 2);
    await tracker.stopTracker();
    assert.equal(published.length, 1);
  } finally {
    await tracker.stopTracker();
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    await rm(home, {recursive:true, force:true});
  }
});

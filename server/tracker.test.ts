import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi, PaseoAgentTimelineEvent, PaseoAgentUpdate } from '@getpaseo/client';
import { ledgerSync, ledgerOverview } from '../shared/ledger.ts';

test('tracker starts without UI, serves validated RPCs, normalizes raw disk usage, and cleans up', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-tracker-test-'));
  const oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const dir = join(home, 'plugins', 'token-ledger');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pricing.json'), JSON.stringify({version: 1, currency: 'USD', prices: []}));
  await writeFile(join(dir, 'openrouter-pricing.json'), JSON.stringify({fetchedAt: new Date().toISOString(), prices: []}));
  let update: (event: PaseoAgentUpdate) => void = () => {};
  let timeline: (event: PaseoAgentTimelineEvent) => void = () => {};
  let removed = 0;
  let catalogSubscriptions = 0;
  let listCalls = 0;
  const snapshot = { id: 'a', provider: 'codex', model: 'gpt-5', workspaceId: 'w', title: 'Test',
    status: 'idle', updatedAt: '2026-09-14T00:00:00Z', lastUsage: undefined };
  const handle = { refresh: async () => snapshot, current: () => snapshot,
    timeline: { subscribe: (fn: typeof timeline) => { timeline = fn; return Object.assign(() => { removed++; }, { ready: Promise.resolve() }); } } };
  const paseo = { agents: {
    subscribe: (fn: typeof update) => { update = fn; catalogSubscriptions++; return () => { removed++; }; },
    list: async (options: {page?: {cursor?: string}}) => {
      listCalls++;
      return options.page?.cursor ? { entries: [{agent: {...snapshot, id: "page-two", status: "closed"}}], pageInfo: {nextCursor: null} }
        : { entries: [{agent: snapshot}], pageInfo: {nextCursor: "next"} };
    }, ref: () => handle,
  }, workspaces: { subscribe: () => () => { removed++; }, list: async () => ({ entries: [{id: 'w', title: 'Workspace', name: 'workspace'}], pageInfo: {nextCursor: null} }) } } as unknown as PaseoApi;
  const tracker = await import('./tracker.ts');
  const store = await import('./store.ts');
  try {
    await Promise.all([tracker.prepareAgent(paseo, 'a'), tracker.ensureTracker(paseo)]);
    assert.equal(catalogSubscriptions, 1);
    timeline({ agentId: 'a', timestamp: '2026-09-14T00:00:00Z', event: {type: 'turn_started', provider: 'codex', turnId: 't1'} });
    update({kind: 'upsert', agent: {...snapshot, activeTurn: {turnId: 't1', startedAt: '2026-09-14T00:00:00Z'},
      lastUsage: {inputTokens: 100, cachedInputTokens: 80, outputTokens: 5}}} as PaseoAgentUpdate);
    const live = await tracker.handleSync({agentId: 'a'}, {paseo});
    assert.equal(live.inFlight?.input, 20);
    timeline({ agentId: 'a', timestamp: '2026-09-14T00:00:01Z', event: {type: 'turn_completed', provider: 'codex', turnId: 't1'} });
    const result = ledgerSync.output.parse(await tracker.handleSync({agentId: 'a'}, {paseo}));
    assert.equal(result.summary.turns, 1); assert.equal(result.records[0].input, 20);
    assert.equal(result.records[0].quality, 'partial'); assert.equal(store.allRecords()[0].input, 100);
    const unchanged = await tracker.handleSync({agentId: "a", knownRecordsRevision: result.recordsRevision}, {paseo});
    assert.deepEqual(unchanged.records, []);
    assert.deepEqual(unchanged.summary, result.summary);
    const beforeOverview = listCalls;
    const overview = ledgerOverview.output.parse(await tracker.handleOverview({}, {paseo}));
    assert.equal(overview.totals.turns, 1); assert.equal(overview.groups[0].workspaceName, 'Workspace');
    assert.equal(overview.groups[0].agents.length, 2);
    await tracker.handleOverview({}, {paseo});
    assert.equal(listCalls, beforeOverview);
    await tracker.stopTracker(); assert.equal(removed, 3);
    timeline({ agentId: 'a', timestamp: '2026-09-14T00:00:02Z', event: {type: 'turn_started', provider: 'codex', turnId: 't2'} });
    assert.equal(store.allRecords().length, 1);
  } finally {
    await tracker.stopTracker();
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

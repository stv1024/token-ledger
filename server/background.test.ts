import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi, PaseoAgentTimelineEvent, PaseoAgentUpdate } from '@getpaseo/client';
import { ownedSnapshot } from '../shared/subscription-test-helpers.ts';

test('a catalog remove for an agent that still exists keeps its turn open; a confirmed removal settles it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-background-'));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const dir = join(home, 'plugins', 'token-ledger');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pricing.json'), JSON.stringify({version: 1, currency: 'USD', prices: []}));
  await writeFile(join(dir, 'openrouter-pricing.json'), JSON.stringify({fetchedAt: new Date().toISOString(), prices: []}));
  const running = (id: string, turnId: string) => ({ id, provider: 'codex', model: 'gpt-5', workspaceId: 'w', status: 'running',
    runtimeInfo: { sessionId: 's' }, activeTurn: { turnId, startedAt: '2026-10-23T00:00:00Z' },
    lastUsage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 } });
  // The background agent still resolves by ID; the deleted one does not.
  const current = new Map<string, unknown>([['bg', running('bg', 't1')], ['gone', running('gone', 't2')]]);
  const timelines = new Map<string, (event: PaseoAgentTimelineEvent) => void>();
  const listFilters: unknown[] = [];
  let update: (event: PaseoAgentUpdate) => void = () => {};
  const paseo = { agents: {
    subscribe: () => () => {},
    list: async (options: { filter?: unknown; subscribe?: object }) => {
      listFilters.push(options.filter);
      const owned = ownedSnapshot({ entries: [...current.values()].map((agent) => ({ agent })), pageInfo: { nextCursor: null } });
      update = (event) => owned.update({ type: 'agent_update', payload: event });
      return owned.page;
    },
    ref: (id: string) => ({
      refresh: async () => current.get(id) ?? null,
      current: () => current.get(id) ?? null,
      timeline: {
        subscribe: (fn: (event: PaseoAgentTimelineEvent) => void) => {
          timelines.set(id, fn);
          return Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} });
        },
        append: async () => ({ seq: 1, epoch: 'test' }),
      },
    }),
  }, workspaces: { list: async (options: { filter?: unknown }) => {
    listFilters.push(options.filter);
    return ownedSnapshot({ entries: [], pageInfo: { nextCursor: null } }).page;
  } } } as unknown as PaseoApi;
  const tracker = await import('./tracker.ts');
  const store = await import('./store.ts');
  const records = () => store.allRecords().map((record) => [record.agentId, record.status]);
  const waitForRecords = async (count: number) => {
    for (let i = 0; i < 200 && records().length < count; i++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  };
  try {
    await tracker.ensureTracker(paseo);
    for (const [id, turnId] of [['bg', 't1'], ['gone', 't2']]) {
      timelines.get(id)!({ agentId: id, timestamp: '2026-10-23T00:00:00Z', event: { type: 'turn_started', provider: 'codex', turnId } });
    }
    current.delete('gone');
    update({ kind: 'remove', agentId: 'bg' });
    update({ kind: 'remove', agentId: 'gone' });
    await waitForRecords(1);
    // Let the background agent's confirmation finish too.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(records(), [['gone', 'canceled']]);
    timelines.get('bg')!({ agentId: 'bg', timestamp: '2026-10-23T00:00:02Z', event: { type: 'turn_completed', provider: 'codex', turnId: 't1',
      usage: { inputTokens: 120, cachedInputTokens: 60, outputTokens: 20 } } });
    // Terminal usage settles after the tracker's short stream window.
    await waitForRecords(2);
    assert.deepEqual(records(), [['gone', 'canceled'], ['bg', 'completed']]);
    await tracker.handleOverview({}, { paseo });
    assert.ok(listFilters.length >= 2);
    for (const filter of listFilters) assert.deepEqual(filter, { includeBackground: true });
  } finally {
    await tracker.stopTracker();
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

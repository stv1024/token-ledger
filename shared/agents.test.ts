import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPaseoApi, type PaseoApi } from '@getpaseo/client';
import { listAgents, subscribeAgents } from './agents.ts';
import { ownedSnapshot } from './subscription-test-helpers.ts';

test('one-off catalog reads traverse all pages without creating subscriptions', async () => {
  const calls: unknown[] = [];
  const paseo = { agents: { list: async (options: {page: {cursor?: string}}) => {
    calls.push(options);
    return options.page.cursor ? { entries: [{ agent: { id: 'b' } }], pageInfo: { nextCursor: null } }
      : { entries: [{ agent: { id: 'a' } }], pageInfo: { nextCursor: 'next' } };
  } } } as unknown as PaseoApi;
  assert.deepEqual((await listAgents(paseo)).map(a => a.id), ['a', 'b']);
  assert.deepEqual(calls, [
    { filter: { includeBackground: true }, page: { limit: 200 } },
    { filter: { includeBackground: true }, page: { limit: 200, cursor: 'next' } },
  ]);
});

test('real 0.9 SDK accepts host-assigned catalog IDs, forwards restored pages and releases demand', async () => {
  const first = { entries: [{ agent: { id: 'a' } }], pageInfo: { nextCursor: 'next' } };
  let releases = 0;
  const owned = ownedSnapshot(first, () => { releases++; });
  const calls: unknown[] = [];
  const paseo = createPaseoApi({
    observeAgents: (options: unknown) => { calls.push(options); return owned.page.subscription; },
    fetchAgents: async () => ({ entries: [{ agent: { id: 'b' } }], pageInfo: { nextCursor: null } }),
  } as unknown as Parameters<typeof createPaseoApi>[0]);
  const snapshots: string[][] = [];
  const subscription = subscribeAgents(paseo, {
    onSnapshot: (agents) => snapshots.push(agents.map((agent) => agent.id)),
    onUpdate: () => {}, onError: (error) => { throw error; },
  });
  try {
    await subscription.ready;
    assert.deepEqual(calls, [{ subscribe: {}, filter: { includeBackground: true }, page: { limit: 200 } }]);
    assert.deepEqual(snapshots, [['a', 'b']]);
    owned.snapshot({ entries: [{ agent: { id: 'new' } }], pageInfo: { nextCursor: 'next' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(snapshots.at(-1), ['new', 'b']);
  } finally { await subscription.release(); await paseo.dispose(); }
  assert.equal(releases, 1);
});
test('repeated pagination cursor fails instead of looping forever', async () => {
  const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { nextCursor: 'same' } }) } } as unknown as PaseoApi;
  await assert.rejects(listAgents(paseo), /Repeated/);
});

test('hosts without background workspaces get unfiltered lists on every page', async () => {
  const calls: unknown[] = [];
  const first = { entries: [{ agent: { id: 'a' } }], pageInfo: { nextCursor: 'next' } };
  const owned = ownedSnapshot(first);
  // A 0.12+ client SDK rejects the filter before sending it to an older host.
  const paseo = { agents: { list: async (options: { filter?: { includeBackground?: boolean }; subscribe?: {}; page: { cursor?: string } }) => {
    calls.push(options);
    if (options.filter?.includeBackground) throw new Error('Update the host to use background workspaces.');
    if (options.page.cursor) return { entries: [{ agent: { id: 'b' } }], pageInfo: { nextCursor: null } };
    return options.subscribe ? owned.page : first;
  } } } as unknown as PaseoApi;
  assert.deepEqual((await listAgents(paseo)).map((a) => a.id), ['a', 'b']);
  assert.deepEqual(calls.splice(0), [
    { filter: { includeBackground: true }, page: { limit: 200 } },
    { filter: {}, page: { limit: 200 } },
    { filter: {}, page: { limit: 200, cursor: 'next' } },
  ]);
  const snapshots: string[][] = [];
  const subscription = subscribeAgents(paseo, {
    onSnapshot: (agents) => snapshots.push(agents.map((agent) => agent.id)),
    onUpdate: () => {}, onError: (error) => { throw error; },
  });
  try {
    await subscription.ready;
    assert.deepEqual(snapshots, [['a', 'b']]);
    assert.deepEqual(calls, [
      { subscribe: {}, filter: { includeBackground: true }, page: { limit: 200 } },
      { subscribe: {}, filter: {}, page: { limit: 200 } },
      { filter: {}, page: { limit: 200, cursor: 'next' } },
    ]);
  } finally { await subscription.release(); }
});

test('other list failures are not retried without the filter', async () => {
  let calls = 0;
  const paseo = { agents: { list: async () => { calls++; throw new Error('offline'); } } } as unknown as PaseoApi;
  await assert.rejects(listAgents(paseo), /offline/);
  assert.equal(calls, 1);
});

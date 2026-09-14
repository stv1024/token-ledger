import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaseoApi } from '@getpaseo/client';
import { listAgents } from './agents.ts';

test('catalog traverses pages and subscribes only once', async () => {
  const calls: unknown[] = [];
  const paseo = { agents: { list: async (options: {page: {cursor?: string}}) => {
    calls.push(options);
    return options.page.cursor ? { entries: [{ agent: { id: 'b' } }], pageInfo: { nextCursor: null } }
      : { entries: [{ agent: { id: 'a' } }], pageInfo: { nextCursor: 'next' } };
  } } } as unknown as PaseoApi;
  assert.deepEqual((await listAgents(paseo, true)).map(a => a.id), ['a', 'b']);
  assert.deepEqual(calls, [
    { subscribe: { subscriptionId: 'token-ledger' }, page: { limit: 200 } },
    { page: { limit: 200, cursor: 'next' } },
  ]);
});
test('repeated pagination cursor fails instead of looping forever', async () => {
  const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { nextCursor: 'same' } }) } } as unknown as PaseoApi;
  await assert.rejects(listAgents(paseo), /Repeated/);
});

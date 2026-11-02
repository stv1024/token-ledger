import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState } from './turns.ts';

test('stopping a tracker that never started leaves the journal intact', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-stop-'));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const dir = join(home, 'plugins', 'token-ledger');
  await mkdir(dir, { recursive: true });
  // A plugin reload or daemon stop with no session, turn, or RPC since load.
  const journal = JSON.stringify({ v: 1, states: [['a', { ...createState(), prevSessionCostUsd: 5 }]], pending: [] });
  await writeFile(join(dir, 'tracker-state.json'), journal);
  const tracker = await import('./tracker.ts');
  try {
    await tracker.stopTracker();
    assert.equal(await readFile(join(dir, 'tracker-state.json'), 'utf8'), journal);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

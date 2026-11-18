import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, type AgentState } from './turns.ts';

// The journal resolves its paths on import, so one home serves this file.
const home = await mkdtemp(join(tmpdir(), 'token-ledger-journal-'));
const previousHome = process.env.PASEO_HOME;
process.env.PASEO_HOME = home;
const dir = join(home, 'plugins', 'token-ledger');
const journal = await import('./journal.ts');
const state = (cost: number): AgentState => ({ ...createState(), provider: 'claude', sessionId: 's', prevSessionCostUsd: cost });
const cost = (entries: [string, AgentState][], id: string) => entries.find(([key]) => key === id)?.[1].prevSessionCostUsd;
const snapshotFile = join(dir, 'tracker-retired.json');
const logFile = join(dir, 'tracker-retired.jsonl');

async function reset(files: Record<string, string> = {}): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  await journal.loadJournal();
}

test.after(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

test('the first save replaces a v0.8.3 snapshot; later retirements append one line each', async () => {
  await reset({ 'tracker-retired.json': JSON.stringify({ v: 1, states: [['old', state(1)]] }) });
  const all = new Map([['old', state(1)], ['new', state(2)]]);
  await journal.saveJournal(new Map(), new Map(), { changed: [['new', all.get('new')!]], all });
  const compacted = await readFile(snapshotFile, 'utf8');
  assert.equal(JSON.parse(compacted).gen, 1);
  assert.equal(await readFile(logFile, 'utf8'), '');
  all.set('later', state(3));
  await journal.saveJournal(new Map(), new Map(), { changed: [['later', all.get('later')!]], all });
  assert.equal(await readFile(snapshotFile, 'utf8'), compacted);
  assert.equal((await readFile(logFile, 'utf8')).trim().split('\n').length, 1);
  const loaded = await journal.loadJournal();
  assert.deepEqual(loaded.retired.map(([id]) => id).sort(), ['later', 'new', 'old']);
  assert.equal(cost(loaded.retired, 'later'), 3);
});

test('the latest line wins, and a line cut by a crash keeps the earlier copy', async () => {
  await reset();
  const all = new Map([['a', state(1)]]);
  await journal.saveJournal(new Map(), new Map(), { changed: [['a', state(1)]], all });
  await journal.saveJournal(new Map(), new Map(), { changed: [['a', state(5)]], all });
  await writeFile(logFile, `${await readFile(logFile, 'utf8')}{"g":0,"id":"a","s":{"provider":`);
  assert.equal(cost((await journal.loadJournal()).retired, 'a'), 5);
});

test('a long log compacts into the snapshot; lines from before the compaction are ignored', async () => {
  await reset();
  const all = new Map<string, AgentState>();
  for (let i = 0; i < 300; i++) {
    all.set(`a${i}`, state(i));
    await journal.saveJournal(new Map(), new Map(), { changed: [[`a${i}`, all.get(`a${i}`)!]], all });
  }
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  assert.equal(snapshot.gen, 2);
  assert.ok((await readFile(logFile, 'utf8')).trim().split('\n').length < 300);
  const loaded = await journal.loadJournal();
  assert.equal(loaded.retired.length, 300);
  assert.equal(cost(loaded.retired, 'a299'), 299);

  // A crash after the snapshot but before the log is cleared: the old line is
  // older than the snapshot and must not overwrite it.
  await writeFile(logFile, `{"g":1,"id":"a0","s":${JSON.stringify(state(-1))}}\n`);
  assert.equal(cost((await journal.loadJournal()).retired, 'a0'), 0);
});

test('after a downgrade rewrote the snapshot, older log lines only fill in missing agents', async () => {
  await reset();
  const all = new Map([['a', state(3)], ['b', state(4)]]);
  await journal.saveJournal(new Map(), new Map(), { changed: [...all], all });
  // v0.8.3 reads only the snapshot, so it does not know `b`, and it writes no `gen`.
  await writeFile(snapshotFile, JSON.stringify({ v: 1, states: [['a', state(7)]] }));
  const loaded = await journal.loadJournal();
  assert.equal(cost(loaded.retired, 'a'), 7);
  assert.equal(cost(loaded.retired, 'b'), 4);
  await journal.saveJournal(new Map(), new Map(), { changed: [], all: new Map(loaded.retired) });
  assert.equal(JSON.parse(await readFile(snapshotFile, 'utf8')).gen, 2, 'the next generation is above every line seen');
});

test('a forced compaction rewrites the snapshot even with a short log', async () => {
  await reset();
  const all = new Map([['a', { ...state(1), usageGapPending: true }]]);
  await journal.saveJournal(new Map(), new Map(), { changed: [], all, compact: true });
  assert.equal(JSON.parse(await readFile(snapshotFile, 'utf8')).states[0][1].usageGapPending, true);
  assert.equal(await readFile(logFile, 'utf8'), '');
});

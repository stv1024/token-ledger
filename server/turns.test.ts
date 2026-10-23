import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaseoAgentStream } from '@getpaseo/client';
import { AgentStateSchema, closeTurn, createState, endLifecycleTurn, markUsageGap, reconcileUsage, noteUsage, startLifecycleTurn, streamTurn } from './turns.ts';
const start = '2026-09-14T00:00:00.000Z';
const end = '2026-09-14T00:00:01.000Z';
const usage = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 };
const event = (event: PaseoAgentStream['event'], timestamp = end): PaseoAgentStream => ({ agentId: 'a', event, timestamp });
const begin = (turnId = 't1') => event({ type: 'turn_started', turnId, provider: 'codex' }, start);
const finish = (turnId = 't1') => event({ type: 'turn_completed', turnId, provider: 'codex', usage });

test('snapshot before start preserves observations and does not create canceled phantom', () => {
  const state = createState();
  noteUsage(state, { id: 'a', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: usage });
  assert.equal(streamTurn(state, begin()), null);
  assert.equal(state.open?.observations.length, 1);
  const record = streamTurn(state, finish())!;
  assert.equal(record.durationMs, 1000);
  assert.equal(record.input, 100);
  assert.equal(streamTurn(state, finish()), null);
  noteUsage(state, { id: 'a', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: usage });
  assert.equal(state.open, null);
});
test('stale previous usage is not billed when new turn fails', () => {
  const state = createState();
  streamTurn(state, begin()); streamTurn(state, finish());
  streamTurn(state, begin('t2'));
  noteUsage(state, { id: 'a', activeTurn: { turnId: 't2', startedAt: end }, lastUsage: usage });
  const record = streamTurn(state, event({ type: 'turn_failed', provider: 'codex', turnId: 't2', error: 'failed' }))!;
  assert.equal(record.input, null);
  assert.equal(record.quality, 'unavailable');
});
test('late terminal and snapshot cannot close or contaminate a newer turn', () => {
  const state = createState(); streamTurn(state, begin()); streamTurn(state, finish()); streamTurn(state, begin('t2'));
  assert.equal(streamTurn(state, finish()), null);
  noteUsage(state, { id: 'a', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: { inputTokens: 999 } });
  assert.equal(state.open?.turnId, 't2');
  assert.equal(state.open?.observations.length, 0);
});
test('replacement invalidates history without creating or ending live usage', () => {
  const state = createState(); streamTurn(state, begin());
  assert.equal(streamTurn(state, { agentId: 'a', event: { type: 'replacement', epoch: 'next' } }), null);
  assert.equal(state.open?.turnId, 't1');
});
test('active snapshot with no usage still opens a turn', () => {
  const state = createState(); noteUsage(state, { id: 'a', activeTurn: { turnId: 't1', startedAt: start } });
  assert.equal(state.open?.turnId, 't1');
});
test('partial observed usage remains partial on cancellation', () => {
  const state = createState(); streamTurn(state, begin()); noteUsage(state, { id: 'a', lastUsage: usage });
  const record = streamTurn(state, event({ type: 'turn_canceled', provider: 'codex', turnId: 't1', reason: 'test' }))!;
  assert.equal(record.input, 100); assert.equal(record.quality, 'partial');
});
test('provider session restart resets billing baseline and permits reused turn ID', () => {
  const state = createState(); state.prevSessionCostUsd = 1; state.lastClosedTurnId = 't1'; state.sessionId = 'old-session';
  streamTurn(state, event({ type: 'thread_started', provider: 'claude', sessionId: 'new-session' }));
  noteUsage(state, { id: 'a', provider: 'claude', activeTurn: { turnId: 't1', startedAt: start } });
  const record = streamTurn(state, event({ type: 'turn_completed', provider: 'claude', turnId: 't1', usage: { ...usage, totalCostUsd: 2 } }))!;
  assert.equal(record.costUsd, 2);
});
test('resuming the same provider session preserves cumulative billing baseline', () => {
  const state = createState(); state.sessionId = 'same-session'; state.prevSessionCostUsd = 2;
  streamTurn(state, event({ type: 'thread_started', provider: 'claude', sessionId: 'same-session' }));
  streamTurn(state, begin());
  const record = streamTurn(state, event({ type: 'turn_completed', provider: 'claude', turnId: 't1', usage: { ...usage, totalCostUsd: 2.5 } }))!;
  assert.equal(record.costUsd, 0.5);
  assert.equal(record.sessionId, 'same-session');
});
test('idle snapshot supplies billing baseline for plugin reload', () => {
  const state = createState(); noteUsage(state, { id: 'a', provider: 'claude', lastUsage: { ...usage, totalCostUsd: 3 } });
  streamTurn(state, begin());
  const record = streamTurn(state, event({ type: 'turn_completed', provider: 'claude', turnId: 't1', usage: { ...usage, totalCostUsd: 3.5 } }))!;
  assert.equal(record.costUsd, 0.5);
});

test('snapshot restores session identity and changing it resets cumulative cost', () => {
  const state = createState();
  noteUsage(state, { id: 'a', runtimeInfo: { sessionId: 's1' }, lastUsage: { totalCostUsd: 9 } });
  noteUsage(state, { id: 'a', runtimeInfo: { sessionId: 's2' }, activeTurn: {turnId: 't1', startedAt: start} });
  assert.equal(state.sessionId, 's2'); assert.equal(state.prevSessionCostUsd, null);
});
test('checkpoint round trip preserves observations, record identity and model attribution', () => {
  const state = createState();
  noteUsage(state, { id: 'a', provider: 'codex', model: 'original', runtimeInfo: {sessionId: 's'}, activeTurn: {turnId: 't1', startedAt: start}, lastUsage: usage });
  const key = state.open!.key;
  const restored = AgentStateSchema.parse(JSON.parse(JSON.stringify(state)));
  noteUsage(restored, { id: 'a', model: 'new-selection', activeTurn: {turnId: 't1', startedAt: start}, lastUsage: usage });
  noteUsage(restored, { id: 'a', lastUsage: {...usage, inputTokens: 120} });
  const record = streamTurn(restored, finish())!;
  assert.equal(record.id, key); assert.equal(record.model, 'original'); assert.equal(record.modelCalls, 2);
  assert.equal(record.input, 220);
});
test('delayed lifecycle start does not resurrect a settled turn', () => {
  const state = createState(); streamTurn(state, begin()); streamTurn(state, finish());
  assert.equal(startLifecycleTurn('a', state, 't1', end), null);
  assert.equal(state.open, null);
});

test('checkpoint preserves cache writes without duplicating a replayed observation', () => {
  const state = createState();
  const writing = { ...usage, cacheWriteInputTokens: 10 };
  noteUsage(state, { id: 'a', provider: 'codex', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: writing });
  const restored = AgentStateSchema.parse(JSON.parse(JSON.stringify(state)));
  noteUsage(restored, { id: 'a', lastUsage: writing });
  const record = streamTurn(restored, finish())!;
  assert.equal(record.cacheWrite, 10);
  assert.equal(record.requests?.[0].cacheWrite, 10);
  assert.equal(record.modelCalls, 1);
});

test('sparser snapshots cannot erase known cache writes or reported cost', () => {
  const state = createState();
  noteUsage(state, { id: 'a', provider: 'claude', activeTurn: { turnId: 't1', startedAt: start },
    lastUsage: { ...usage, cacheWriteInputTokens: 10, totalCostUsd: 0.5 } });
  noteUsage(state, { id: 'a', lastUsage: usage });
  const record = streamTurn(state, event({ type: 'turn_canceled', provider: 'claude', turnId: 't1', reason: 'test' }))!;
  assert.equal(record.cacheWrite, 10);
  assert.equal(record.costUsd, 0.5);
});

test('restored idle snapshot settles unknown outcome without attributing later usage or session charges', () => {
  const state = createState();
  noteUsage(state, { id: 'a', provider: 'claude', lastUsage: { totalCostUsd: 2 } });
  noteUsage(state, { id: 'a', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: { ...usage, totalCostUsd: 2.5 } });
  const [record] = reconcileUsage(state, { id: 'a', activeTurn: null, lastUsage: { inputTokens: 9999, totalCostUsd: 5 } });
  assert.equal(record.status, 'unknown');
  assert.equal(record.input, 100);
  assert.equal(record.costUsd, null);
  assert.equal(record.usageGap, true);
  assert.equal(state.open, null);
  streamTurn(state, begin('t2'));
  const next = streamTurn(state, event({ type: 'turn_completed', provider: 'claude', turnId: 't2', usage: { ...usage, totalCostUsd: 5.5 } }))!;
  assert.equal(next.costUsd, 0.5);
});

test('gap and uncertain cost baseline survive checkpoints; a final aggregate does not hide the gap', () => {
  const state = createState();
  noteUsage(state, { id: 'a', provider: 'claude', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: usage });
  markUsageGap(state);
  const restored = AgentStateSchema.parse(JSON.parse(JSON.stringify(state)));
  const record = streamTurn(restored, event({ type: 'turn_completed', provider: 'claude', turnId: 't1', usage: { ...usage, totalCostUsd: 5 } }))!;
  assert.equal(record.quality, 'partial');
  assert.equal(record.costUsd, null);
  assert.equal(record.sessionCostUsd, 5);
  assert.equal(record.usageGap, true);
  assert.equal(restored.costBaselineUncertain, false);
});

test('restored newer turn cannot mix its usage into the interrupted turn', () => {
  const state = createState();
  noteUsage(state, { id: 'a', provider: 'codex', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: usage });
  const [record] = reconcileUsage(state, { id: 'a', activeTurn: { turnId: 't2', startedAt: end }, lastUsage: { inputTokens: 1000 } });
  assert.equal(record.input, 100);
  assert.equal(record.status, 'unknown');
  assert.equal(state.open?.turnId, 't2');
  assert.equal(state.open?.observations[0].input, 1000);
  assert.equal(state.open?.usageGap, true);
});

test('a Codex delivery gap does not mark every subsequent uninterrupted turn as gapped', () => {
  const state = createState();
  noteUsage(state, { id: 'a', provider: 'codex', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: usage });
  markUsageGap(state);
  const first = streamTurn(state, finish())!;
  assert.equal(first.usageGap, true);
  streamTurn(state, begin('t2'));
  const next = streamTurn(state, finish('t2'))!;
  assert.equal(next.usageGap, undefined);
});

test('late OMP usage settles a deferred turn once, then only refreshes the snapshot', () => {
  const state = createState();
  const activeTurn = { turnId: 't1', startedAt: start };
  noteUsage(state, { id: 'a', provider: 'omp', model: 'gpt-model', activeTurn,
    runtimeInfo: { sessionId: 's' }, lastUsage: { inputTokens: 1000, cachedInputTokens: 4000, outputTokens: 100 } });
  assert.equal(streamTurn(state, event({ type: 'turn_completed', provider: 'omp', turnId: 't1' })), null);
  // OMP publishes the drain while its activeTurnId still names the ending turn.
  const record = noteUsage(state, { id: 'a', provider: 'omp', activeTurn,
    lastUsage: { inputTokens: 1300, cachedInputTokens: 4500, outputTokens: 200 } })!;
  assert.equal(record.tokenScope, 'session');
  assert.equal(record.input, 1300);
  assert.equal(record.status, 'completed');
  assert.equal(record.endedAt, end);
  assert.equal(state.open, null);
  noteUsage(state, { id: 'a', provider: 'omp', activeTurn,
    lastUsage: { inputTokens: 1400, cachedInputTokens: 4600, outputTokens: 210 } });
  assert.equal(state.open, null, 'a replayed activeTurn does not reopen the settled turn');
  const restored = AgentStateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.lastObservation?.input, 1400);
  assert.equal(restored.lastObservation?.output, 210);
  // A lower branch-view snapshot is not a fresh billing counter or a turn delta.
  noteUsage(restored, { id: 'a', provider: 'omp', activeTurn: null,
    lastUsage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 } });
  assert.equal(restored.lastObservation?.input, 100);
  assert.equal(restored.open, null);
  assert.equal(record.costUsd, null);
});

const omp = (type: 'turn_started' | 'turn_completed', turnId: string, timestamp = type === 'turn_started' ? start : end) =>
  event({ type, provider: 'omp', turnId }, timestamp);

// Issue sample A (turn 83010c14): the second call's usage arrived 17ms after the terminal event.
test('OMP sample A: a final snapshot after the terminal event is not dropped', () => {
  const state = createState();
  const activeTurn = { turnId: 't1', startedAt: start };
  streamTurn(state, omp('turn_started', 't1'));
  noteUsage(state, { id: 'a', provider: 'omp', activeTurn,
    lastUsage: { inputTokens: 2078, cachedInputTokens: 9984, outputTokens: 484, totalCostUsd: 0.00943752 } });
  assert.equal(streamTurn(state, omp('turn_completed', 't1')), null);
  const record = noteUsage(state, { id: 'a', provider: 'omp', activeTurn,
    lastUsage: { inputTokens: 2751, cachedInputTokens: 22016, outputTokens: 1103, totalCostUsd: 0.01553148 } })!;
  assert.equal(record.input, 2751); assert.equal(record.cached, 22016); assert.equal(record.output, 1103);
  assert.equal(record.sessionCostUsd, 0.01553148);
  assert.equal(record.costUsd, null, 'OMP session cost is not differenced into turns');
  assert.equal(record.modelCalls, null, 'a snapshot count is not a model-call count');
});

// Issue sample B (turn afd69f4c): the only call's usage arrived 9ms after the terminal event.
test('OMP sample B: a turn whose only snapshot drains late is not empty', () => {
  const state = createState();
  noteUsage(state, { id: 'a', provider: 'omp', lastUsage: { inputTokens: 2751, cachedInputTokens: 22016, outputTokens: 1103 } });
  streamTurn(state, omp('turn_started', 't2'));
  assert.equal(streamTurn(state, omp('turn_completed', 't2')), null);
  const record = noteUsage(state, { id: 'a', provider: 'omp', activeTurn: { turnId: 't2', startedAt: start },
    lastUsage: { inputTokens: 3206, cachedInputTokens: 34688, outputTokens: 1410 } })!;
  assert.equal(record.input, 3206);
  assert.equal(record.source, 'last_observation');
  assert.equal(record.modelCalls, null);
});

test('OMP drain does not absorb a snapshot twice, and a new turn settles an unchanged drain', () => {
  const state = createState();
  const s1 = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 };
  streamTurn(state, omp('turn_started', 't1'));
  streamTurn(state, omp('turn_completed', 't1'));
  assert.equal(noteUsage(state, { id: 'a', provider: 'omp', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: s1 })!.input, 100);
  streamTurn(state, omp('turn_started', 't2', end));
  // A replay of the absorbed snapshot is not new usage for the next turn.
  assert.equal(noteUsage(state, { id: 'a', provider: 'omp', activeTurn: { turnId: 't2', startedAt: end }, lastUsage: s1 }), null);
  assert.equal(state.open?.observations.length, 0);
  // Unchanged usage publishes no drain; the next turn start settles the ending one.
  streamTurn(state, omp('turn_completed', 't2', '2026-09-14T00:00:02.000Z'));
  const second = streamTurn(state, omp('turn_started', 't3', '2026-09-14T00:00:03.000Z'))!;
  assert.equal(second.turnId, 't2');
  assert.equal(second.status, 'completed', 'a known outcome is not rewritten as canceled');
  assert.equal(second.endedAt, '2026-09-14T00:00:02.000Z');
  assert.equal(second.source, 'none');
  assert.equal(state.open?.turnId, 't3');
});

test('OMP failures settle at once; Codex still counts its requests', () => {
  const state = createState();
  streamTurn(state, omp('turn_started', 't1'));
  assert.ok(streamTurn(state, event({ type: 'turn_failed', provider: 'omp', turnId: 't1', error: 'x' })));
  const codex = createState(); streamTurn(codex, begin());
  noteUsage(codex, { id: 'a', lastUsage: usage });
  assert.equal(streamTurn(codex, finish())!.modelCalls, 1);
});

test('a deferred outcome survives a checkpoint and keeps its reported status and time', () => {
  const state = createState();
  streamTurn(state, omp('turn_started', 't1'));
  streamTurn(state, omp('turn_completed', 't1'));
  const restored = AgentStateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.open?.ending?.status, 'completed');
  const record = closeTurn('a', restored, 'canceled', null, '2026-09-14T00:00:09.000Z')!;
  assert.equal(record.status, 'completed'); assert.equal(record.endedAt, end);
});

test('the stream outcome overrides an earlier hook outcome', () => {
  const state = createState();
  streamTurn(state, omp('turn_started', 't1'));
  assert.equal(endLifecycleTurn(state, 'other', 'failed', end), false);
  assert.equal(endLifecycleTurn(state, 't1', 'unknown', '2026-09-14T00:00:00.500Z'), true);
  streamTurn(state, omp('turn_completed', 't1'));
  const record = noteUsage(state, { id: 'a', provider: 'omp', activeTurn: { turnId: 't1', startedAt: start }, lastUsage: usage })!;
  assert.equal(record.status, 'completed'); assert.equal(record.endedAt, end);
});

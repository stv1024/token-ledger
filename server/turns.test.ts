import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaseoAgentStream } from '@getpaseo/client';
import { AgentStateSchema, createState, markUsageGap, reconcileUsage, noteUsage, startLifecycleTurn, streamTurn } from './turns.ts';
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

test('late OMP usage refreshes the persisted snapshot without reopening or billing a closed turn', () => {
  const state = createState();
  const activeTurn = { turnId: 't1', startedAt: start };
  noteUsage(state, { id: 'a', provider: 'omp', model: 'gpt-model', activeTurn,
    runtimeInfo: { sessionId: 's' }, lastUsage: { inputTokens: 1000, cachedInputTokens: 4000, outputTokens: 100 } });
  const record = streamTurn(state, event({ type: 'turn_completed', provider: 'omp', turnId: 't1' }))!;
  assert.equal(record.tokenScope, 'session');
  noteUsage(state, { id: 'a', provider: 'omp', activeTurn,
    lastUsage: { inputTokens: 1300, cachedInputTokens: 4500, outputTokens: 200 } });
  assert.equal(state.open, null);
  const restored = AgentStateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.lastObservation?.input, 1300);
  assert.equal(restored.lastObservation?.output, 200);
  // A lower branch-view snapshot is not a fresh billing counter or a turn delta.
  noteUsage(restored, { id: 'a', provider: 'omp', activeTurn: null,
    lastUsage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 } });
  assert.equal(restored.lastObservation?.input, 100);
  assert.equal(restored.open, null);
  assert.equal(record.costUsd, null);
});

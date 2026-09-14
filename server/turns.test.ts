import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaseoAgentStream } from '@getpaseo/client';
import { createState, noteUsage, streamTurn } from './turns.ts';
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
  const state = createState(); noteUsage(state, { id: 'a', lastUsage: { ...usage, totalCostUsd: 3 } });
  streamTurn(state, begin());
  const record = streamTurn(state, event({ type: 'turn_completed', provider: 'claude', turnId: 't1', usage: { ...usage, totalCostUsd: 3.5 } }))!;
  assert.equal(record.costUsd, 0.5);
});

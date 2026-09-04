import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeTurn, sameTokens, tokenObservation, type Observation } from "./aggregate.ts";

const base = {
  agentId: "agent-1",
  turnId: "turn-1",
  provider: "claude",
  model: "claude-opus-5",
  startedAt: "2026-09-04T10:00:00.000Z",
  endedAt: "2026-09-04T10:00:30.000Z",
  status: "completed" as const,
  observations: [] as Observation[],
  finalUsage: null,
  prevSessionCostUsd: null,
};

test("context-window-only usage yields no observation", () => {
  assert.equal(tokenObservation({ contextWindowUsedTokens: 5000, contextWindowMaxTokens: 200000 }), null);
  assert.equal(tokenObservation(null), null);
  assert.equal(tokenObservation({}), null);
});

test("negative and non-finite values are ignored", () => {
  const observation = tokenObservation({ inputTokens: -5, outputTokens: Number.NaN, cachedInputTokens: 10 });
  assert.deepEqual(observation, { input: null, cached: 10, output: null, cost: null });
});

test("claude-style: terminal usage is used as-is, exact", () => {
  const record = finalizeTurn({
    ...base,
    finalUsage: { inputTokens: 120, cachedInputTokens: 4000, outputTokens: 900, totalCostUsd: 0.05 },
  });
  assert.equal(record.input, 120);
  assert.equal(record.cached, 4000);
  assert.equal(record.output, 900);
  assert.equal(record.quality, "exact");
  assert.equal(record.source, "turn_usage");
  assert.equal(record.modelCalls, 0);
  assert.equal(record.durationMs, 30000);
});

test("codex-style: multiple per-request observations are summed, partial", () => {
  const record = finalizeTurn({
    ...base,
    provider: "codex",
    observations: [
      { input: 100, cached: 0, output: 50, cost: null },
      { input: 200, cached: 100, output: 80, cost: null },
      { input: 300, cached: 250, output: 20, cost: null },
    ],
    finalUsage: { inputTokens: 300, cachedInputTokens: 250, outputTokens: 20 },
  });
  assert.equal(record.input, 600);
  assert.equal(record.cached, 350);
  assert.equal(record.output, 150);
  assert.equal(record.quality, "partial");
  assert.equal(record.source, "summed_observations");
  assert.equal(record.modelCalls, 3);
});

test("single observation without terminal usage, partial", () => {
  const record = finalizeTurn({
    ...base,
    status: "canceled",
    observations: [{ input: 100, cached: null, output: 50, cost: null }],
  });
  assert.equal(record.input, 100);
  assert.equal(record.quality, "partial");
  assert.equal(record.source, "last_observation");
});

test("no usage at all is unavailable, never estimated", () => {
  const record = finalizeTurn({ ...base, status: "failed" });
  assert.equal(record.input, null);
  assert.equal(record.output, null);
  assert.equal(record.costUsd, null);
  assert.equal(record.quality, "unavailable");
  assert.equal(record.source, "none");
});

test("cumulative session cost produces a per-turn delta", () => {
  const record = finalizeTurn({
    ...base,
    finalUsage: { inputTokens: 10, outputTokens: 10, totalCostUsd: 0.08 },
    prevSessionCostUsd: 0.05,
  });
  assert.equal(record.costUsd, 0.03);
  assert.equal(record.sessionCostUsd, 0.08);
});

test("cost lower than previous raw is treated as a reset, raw kept", () => {
  const record = finalizeTurn({
    ...base,
    finalUsage: { inputTokens: 10, outputTokens: 10, totalCostUsd: 0.02 },
    prevSessionCostUsd: 0.05,
  });
  assert.equal(record.costUsd, 0.02);
  assert.equal(record.sessionCostUsd, 0.02);
});

test("missing startedAt yields null duration", () => {
  const record = finalizeTurn({ ...base, startedAt: null });
  assert.equal(record.durationMs, null);
  assert.equal(record.id, "agent-1:turn-1");
});

test("sameTokens compares only token fields", () => {
  assert.ok(
    sameTokens(
      { input: 1, cached: 2, output: 3, cost: 0.1 },
      { input: 1, cached: 2, output: 3, cost: 0.9 },
    ),
  );
  assert.ok(!sameTokens({ input: 1, cached: 2, output: 3, cost: null }, { input: 1, cached: 2, output: 4, cost: null }));
});

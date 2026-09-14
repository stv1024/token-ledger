import type { PaseoAgentTimelineEvent } from "@getpaseo/client";
import { finalizeTurn, sameTokens, tokenObservation, type Observation, type UsageLike } from "../shared/aggregate.ts";
import type { Ctx, TurnRecord } from "../shared/ledger.ts";

export type AgentSnapshotLike = {
  id: string; provider?: string; model?: string | null;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  lastUsage?: UsageLike;
};
export type AgentState = {
  provider: string | null; model: string | null;
  sessionId: string | null;
  open: { turnId: string | null; startedAt: string; observations: Observation[]; lastUsage: UsageLike | null } | null;
  prevSessionCostUsd: number | null;
  lastObservation: Observation | null;
  lastCtx: Ctx | null;
  lastClosedTurnId: string | null;
};
export function createState(previous: TurnRecord | null = null): AgentState {
  return { provider: previous?.provider ?? null, model: previous?.model ?? null, sessionId: previous?.sessionId ?? null, open: null,
    prevSessionCostUsd: previous?.sessionCostUsd ?? null, lastObservation: null, lastCtx: null,
    lastClosedTurnId: previous?.turnId ?? null };
}
function openTurn(state: AgentState, turnId: string | null, startedAt: string) {
  state.open = { turnId, startedAt, observations: [], lastUsage: null };
  // Keep the previous ID as a guard against a delayed terminal event/snapshot.
  return state.open;
}
export function closeTurn(agentId: string, state: AgentState, status: TurnRecord["status"], finalUsage: UsageLike | null, endedAt: string): TurnRecord | null {
  const open = state.open;
  if (!open) return null;
  state.open = null;
  state.lastClosedTurnId = open.turnId;
  const final = tokenObservation(finalUsage);
  if (final) state.lastObservation = final;
  const record = finalizeTurn({ agentId, turnId: open.turnId, provider: state.provider, model: state.model,
    startedAt: open.startedAt, endedAt, status, observations: open.observations,
    finalUsage, prevSessionCostUsd: state.prevSessionCostUsd });
  record.sessionId = state.sessionId;
  state.prevSessionCostUsd = record.sessionCostUsd ?? state.prevSessionCostUsd;
  return record;
}
export function noteUsage(state: AgentState, snapshot: AgentSnapshotLike): void {
  if (snapshot.provider) state.provider = snapshot.provider;
  if (snapshot.model !== undefined) state.model = snapshot.model;
  const usage = snapshot.lastUsage;
  if (usage && Number.isFinite(usage.contextWindowUsedTokens) && Number.isFinite(usage.contextWindowMaxTokens)) {
    state.lastCtx = { used: usage.contextWindowUsedTokens!, max: usage.contextWindowMaxTokens! };
  }
  const observation = tokenObservation(usage);
  const isNew = observation !== null && (state.lastObservation === null || !sameTokens(state.lastObservation, observation));
  const active = snapshot.activeTurn;
  // Never replay a previous turn's snapshot into the current turn.
  if (active && active.turnId === state.lastClosedTurnId && active.turnId !== state.open?.turnId) return;
  if (active && state.open && active.turnId !== state.open.turnId) return;
  if (observation) state.lastObservation = observation;
  if (!state.open && !active) {
    if (typeof usage?.totalCostUsd === "number" && Number.isFinite(usage.totalCostUsd)) state.prevSessionCostUsd = usage.totalCostUsd;
    return;
  }
  const open = state.open ?? openTurn(state, active?.turnId ?? null, active?.startedAt ?? new Date().toISOString());
  // Context-only/stale snapshots must not become terminal usage on cancellation.
  if (usage) open.lastUsage = { ...open.lastUsage,
    contextWindowUsedTokens: usage.contextWindowUsedTokens,
    contextWindowMaxTokens: usage.contextWindowMaxTokens };
  if (observation && isNew) open.observations.push(observation);
}
export function streamTurn(state: AgentState, payload: PaseoAgentTimelineEvent): TurnRecord | null {
  const event = payload.event;
  if (event.type === "replacement") return null; // historical timeline invalidation, not a live turn
  const at = "timestamp" in payload ? payload.timestamp : new Date().toISOString();
  switch (event.type) {
    case "thread_started":
      // Resume emits thread_started too. Reset billing only for a known new
      // provider session; legacy records retain the raw-cost reset heuristic.
      if (state.sessionId !== null && state.sessionId !== event.sessionId) {
        state.prevSessionCostUsd = null;
        state.lastObservation = null;
        state.lastClosedTurnId = null;
      }
      state.sessionId = event.sessionId;
      return null;
    case "turn_started": {
      const id = event.turnId ?? null;
      if (state.open?.turnId === id) return null; // snapshot or lifecycle hook arrived first
      const previous = closeTurn(payload.agentId, state, "canceled", null, at);
      openTurn(state, id, at);
      return previous;
    }
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
      if (event.turnId && state.open?.turnId && event.turnId !== state.open.turnId) return null;
      return closeTurn(payload.agentId, state,
        event.type === "turn_completed" ? "completed" : event.type === "turn_failed" ? "failed" : "canceled",
        event.type === "turn_completed" ? event.usage ?? null : null, at);
    default: return null;
  }
}

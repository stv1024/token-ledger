import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PaseoAgentTimelineEvent } from "@getpaseo/client";
import { finalizeTurn, sameTokens, tokenObservation, type UsageLike } from "../shared/aggregate.ts";
import type { TurnRecord } from "../shared/ledger.ts";

const nullableCount = z.number().finite().nonnegative().nullable();
const observationSchema = z.object({ input: nullableCount, cached: nullableCount, output: nullableCount, cost: nullableCount });
const contextSchema = z.object({ contextWindowUsedTokens: z.number().optional(), contextWindowMaxTokens: z.number().optional() });
export const AgentStateSchema = z.object({
  provider: z.string().nullable(), model: z.string().nullable(), sessionId: z.string().nullable(),
  open: z.object({ key: z.string(), turnId: z.string().nullable(), startedAt: z.string(),
    provider: z.string().nullable(), model: z.string().nullable(), sessionId: z.string().nullable(),
    observations: z.array(observationSchema), lastUsage: contextSchema.nullable(),
  }).nullable(),
  prevSessionCostUsd: nullableCount, lastObservation: observationSchema.nullable(),
  lastCtx: z.object({ used: z.number(), max: z.number() }).nullable(),
  lastClosedTurnId: z.string().nullable(), lastClosedAt: z.string().nullable(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;
export type AgentSnapshotLike = {
  id: string; provider?: string; model?: string | null;
  runtimeInfo?: { sessionId: string | null; model?: string | null } | null;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  lastUsage?: UsageLike;
};
export function createState(previous: TurnRecord | null = null): AgentState {
  return { provider: previous?.provider ?? null, model: previous?.model ?? null, sessionId: previous?.sessionId ?? null,
    open: null, prevSessionCostUsd: previous?.sessionCostUsd ?? null, lastObservation: null, lastCtx: null,
    lastClosedTurnId: previous?.turnId ?? null, lastClosedAt: previous?.endedAt ?? null };
}
function openTurn(state: AgentState, turnId: string | null, startedAt: string) {
  state.open = { key: randomUUID(), turnId, startedAt, provider: state.provider, model: state.model,
    sessionId: state.sessionId, observations: [], lastUsage: null };
  return state.open;
}
export function closeTurn(agentId: string, state: AgentState, status: TurnRecord["status"], finalUsage: UsageLike | null, endedAt: string): TurnRecord | null {
  const open = state.open;
  if (!open) return null;
  state.open = null;
  state.lastClosedTurnId = open.turnId;
  state.lastClosedAt = endedAt;
  const final = tokenObservation(finalUsage);
  if (final) state.lastObservation = final;
  const record = finalizeTurn({ agentId, turnId: open.turnId, provider: open.provider ?? state.provider,
    model: open.model ?? state.model, startedAt: open.startedAt, endedAt, status,
    observations: open.observations, finalUsage, prevSessionCostUsd: state.prevSessionCostUsd });
  // Stable across replay/reload, even if settlement is retried at another time.
  record.id = open.key;
  record.sessionId = open.sessionId ?? state.sessionId;
  state.prevSessionCostUsd = record.sessionCostUsd ?? state.prevSessionCostUsd;
  return record;
}
function sessionChanged(agentId: string, state: AgentState, sessionId: string | null | undefined): TurnRecord | null {
  if (!sessionId || sessionId === state.sessionId) return null;
  let interrupted: TurnRecord | null = null;
  if (state.sessionId !== null) {
    interrupted = closeTurn(agentId, state, "canceled", null, new Date().toISOString());
    state.prevSessionCostUsd = null;
    state.lastObservation = null;
    state.lastClosedTurnId = null;
    state.lastClosedAt = null;
  }
  state.sessionId = sessionId;
  if (state.open && state.open.sessionId === null) state.open.sessionId = sessionId;
  return interrupted;
}
export function noteUsage(state: AgentState, snapshot: AgentSnapshotLike): TurnRecord | null {
  const interrupted = sessionChanged(snapshot.id, state, snapshot.runtimeInfo?.sessionId);
  if (snapshot.provider) state.provider = snapshot.provider;
  if (snapshot.model !== undefined) state.model = snapshot.model;
  // Fill metadata that wasn't available at start; don't reattribute an old turn
  // to a newly selected model at its end.
  if (state.open) {
    state.open.provider ??= state.provider;
    state.open.model ??= state.model;
  }
  const usage = snapshot.lastUsage;
  if (usage && Number.isFinite(usage.contextWindowUsedTokens) && Number.isFinite(usage.contextWindowMaxTokens)) {
    state.lastCtx = { used: usage.contextWindowUsedTokens!, max: usage.contextWindowMaxTokens! };
  }
  const active = snapshot.activeTurn;
  if (active && active.turnId === state.lastClosedTurnId && active.turnId !== state.open?.turnId) {
    if (!active.startedAt || !state.lastClosedAt || Date.parse(active.startedAt) <= Date.parse(state.lastClosedAt)) return interrupted;
    state.lastClosedTurnId = null; // verified newer occurrence of a reused ID
  }
  if (active && state.open && active.turnId !== state.open.turnId) return interrupted;
  const observation = tokenObservation(usage);
  const isNew = observation !== null && (state.lastObservation === null || !sameTokens(state.lastObservation, observation));
  if (observation) state.lastObservation = observation;
  if (!state.open && !active) {
    if (typeof usage?.totalCostUsd === "number" && Number.isFinite(usage.totalCostUsd) && usage.totalCostUsd >= 0) state.prevSessionCostUsd = usage.totalCostUsd;
    return interrupted;
  }
  const open = state.open ?? openTurn(state, active?.turnId ?? null, active?.startedAt ?? new Date().toISOString());
  if (usage) open.lastUsage = {
    contextWindowUsedTokens: usage.contextWindowUsedTokens ?? open.lastUsage?.contextWindowUsedTokens,
    contextWindowMaxTokens: usage.contextWindowMaxTokens ?? open.lastUsage?.contextWindowMaxTokens,
  };
  if (observation && isNew) open.observations.push(observation);
  return interrupted;
}
export function startLifecycleTurn(agentId: string, state: AgentState, turnId: string | null, at: string): TurnRecord | null {
  // A delayed hook must not resurrect the turn already completed on the stream.
  if (state.open?.turnId === turnId || state.lastClosedTurnId === turnId) return null;
  const previous = closeTurn(agentId, state, "canceled", null, at);
  openTurn(state, turnId, at);
  return previous;
}
export function streamTurn(state: AgentState, payload: PaseoAgentTimelineEvent): TurnRecord | null {
  const event = payload.event;
  if (event.type === "replacement") return null;
  if ("provider" in event) state.provider ??= event.provider;
  const at = "timestamp" in payload ? payload.timestamp : new Date().toISOString();
  switch (event.type) {
    case "thread_started": return sessionChanged(payload.agentId, state, event.sessionId);
    case "turn_started": {
      const id = event.turnId ?? null;
      if (state.open?.turnId === id) return null;
      if (id === state.lastClosedTurnId && state.lastClosedAt && Date.parse(at) <= Date.parse(state.lastClosedAt)) return null;
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

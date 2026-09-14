import { providerSemantics } from "./semantics.ts";
import type { TurnRecord } from "./ledger.ts";

/** Shape of Paseo's AgentUsage protocol field (all members optional upstream). */
export type UsageLike = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
};

export type Observation = {
  input: number | null;
  cached: number | null;
  output: number | null;
  cost: number | null;
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Extracts a token observation from a usage event. Returns null when the event
 * carries no token counts (e.g. Claude's mid-turn context-window-only updates),
 * so those never count as model-call observations.
 */
export function tokenObservation(usage: UsageLike | null | undefined): Observation | null {
  if (!usage) return null;
  const input = num(usage.inputTokens);
  const cached = num(usage.cachedInputTokens);
  const output = num(usage.outputTokens);
  if (input === null && cached === null && output === null) return null;
  return { input, cached, output, cost: num(usage.totalCostUsd) };
}

export function sameTokens(a: Observation, b: Observation): boolean {
  return a.input === b.input && a.cached === b.cached && a.output === b.output;
}

function sumField(observations: Observation[], field: "input" | "cached" | "output"): number | null {
  let total: number | null = null;
  for (const observation of observations) {
    const value = observation[field];
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

export type FinalizeInput = {
  agentId: string;
  turnId: string | null;
  provider: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string;
  status: TurnRecord["status"];
  /** Deduped token observations collected from usage_updated events during the turn. */
  observations: Observation[];
  /** Usage attached to the terminal event (turn_completed), or the last usage seen. */
  finalUsage: UsageLike | null;
  /** Raw sessionCostUsd of the previous finalized turn for this agent, if any. */
  prevSessionCostUsd: number | null;
};

/** Finalize only according to verified harness semantics; preserve raw facts. */
export function finalizeTurn(args: FinalizeInput): TurnRecord {
  const observations = [...args.observations];
  const final = tokenObservation(args.finalUsage);
  const semantics = providerSemantics(args.provider);
  if (semantics.tokens === "request" && final && !observations.some((observation) => sameTokens(observation, final))) observations.push(final);

  let tokens: Observation;
  let source: string;
  let quality: TurnRecord["quality"];
  if (semantics.tokens === "request" && observations.length > 0) {
    tokens = {
      input: sumField(observations, "input"),
      cached: sumField(observations, "cached"),
      output: sumField(observations, "output"),
      cost: null,
    };
    source = "summed_observations";
    quality = "partial";
  } else if (final) {
    tokens = final;
    source = "turn_usage";
    quality = semantics.tokens === "turn" ? "exact" : "partial";
  } else if (observations.length > 0) {
    tokens = observations.at(-1)!;
    source = "last_observation";
    quality = "partial";
  } else {
    tokens = { input: null, cached: null, output: null, cost: null };
    source = "none";
    quality = "unavailable";
  }

  const rawCost = num(args.finalUsage?.totalCostUsd) ?? observations.at(-1)?.cost ?? null;
  let costUsd: number | null = semantics.cost === "session" ? rawCost : null;
  if (semantics.cost === "session" && rawCost !== null && args.prevSessionCostUsd !== null && rawCost >= args.prevSessionCostUsd) {
    costUsd = Number((rawCost - args.prevSessionCostUsd).toFixed(6));
  }

  const durationMs =
    args.startedAt !== null ? Math.max(0, Date.parse(args.endedAt) - Date.parse(args.startedAt)) : null;

  return {
    v: 1,
    // endedAt is part of the id because Paseo turnIds ("foreground-turn-N")
    // restart from 1 on every session restart — agentId:turnId alone collides.
    id: `${args.agentId}:${args.turnId ?? "turn"}:${args.endedAt}`,
    agentId: args.agentId,
    turnId: args.turnId,
    provider: args.provider,
    model: args.model,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    durationMs,
    status: args.status,
    input: tokens.input,
    cached: tokens.cached,
    output: tokens.output,
    costUsd,
    sessionCostUsd: rawCost,
    costScope: semantics.cost,
    ...(semantics.tokens === "request" ? { requests: observations.map(({ input, cached, output }) => ({ input, cached, output })) } : {}),
    modelCalls: observations.length,
    quality,
    source,
  };
}

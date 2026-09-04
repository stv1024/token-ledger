import type { PaseoAgentStream, PaseoApi } from "@getpaseo/client";
import { finalizeTurn, sameTokens, tokenObservation, type Observation, type UsageLike } from "./aggregate";
import type { InFlight, Summary, TurnRecord } from "./ledger.shared";
import { appendRecord, lastRecordForAgent, loadStore, recordsForAgent, summaryForAgent } from "./store.server";

type OpenTurn = {
  turnId: string | null;
  startedAt: string;
  observations: Observation[];
  lastUsage: UsageLike | null;
};

type AgentState = {
  provider: string | null;
  model: string | null;
  open: OpenTurn | null;
  prevSessionCostUsd: number | null;
  /** Last token observation seen for this agent, across turns. Snapshot updates
   * replay the previous turn's usage into a new turn; deduping against this
   * baseline keeps stale values out of per-turn sums. */
  lastObservation: Observation | null;
};

const agents = new Map<string, AgentState>();
const subscriptions = new Map<string, () => void>();
let startPromise: Promise<void> | null = null;

function stateFor(agentId: string): AgentState {
  let state = agents.get(agentId);
  if (!state) {
    state = { provider: null, model: null, open: null, prevSessionCostUsd: null, lastObservation: null };
    agents.set(agentId, state);
  }
  return state;
}

function openTurn(state: AgentState, turnId: string | null, startedAt?: string | null): OpenTurn {
  const open: OpenTurn = {
    turnId,
    startedAt: startedAt ?? new Date().toISOString(),
    observations: [],
    lastUsage: null,
  };
  state.open = open;
  return open;
}

async function closeTurn(agentId: string, state: AgentState, status: TurnRecord["status"], finalUsage: UsageLike | null): Promise<void> {
  const open = state.open;
  if (!open) return;
  state.open = null;
  const record = finalizeTurn({
    agentId,
    turnId: open.turnId,
    provider: state.provider,
    model: state.model,
    startedAt: open.startedAt,
    endedAt: new Date().toISOString(),
    status,
    observations: open.observations,
    finalUsage: finalUsage ?? open.lastUsage,
    prevSessionCostUsd: state.prevSessionCostUsd,
  });
  state.prevSessionCostUsd = record.sessionCostUsd ?? state.prevSessionCostUsd;
  try {
    await appendRecord(record);
  } catch (error) {
    console.error("token-ledger: failed to persist turn record", error);
  }
}

function onStream(agentId: string, payload: PaseoAgentStream): void {
  const event = payload.event;
  const state = stateFor(agentId);
  switch (event.type) {
    case "turn_started": {
      if (state.open) {
        // A new turn implies the previous one ended without a terminal event.
        void closeTurn(agentId, state, "canceled", null);
      }
      openTurn(state, event.turnId ?? null);
      return;
    }
    case "turn_completed":
      void closeTurn(agentId, state, "completed", event.usage ?? null);
      return;
    case "turn_failed":
      void closeTurn(agentId, state, "failed", null);
      return;
    case "turn_canceled":
      void closeTurn(agentId, state, "canceled", null);
      return;
    default:
      return;
  }
}

type AgentSnapshotLike = {
  id: string;
  provider?: string;
  model?: string | null;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  lastUsage?: UsageLike;
};

/**
 * Mid-turn usage arrives as agent snapshot updates: the daemon folds each
 * provider usage_updated event into `lastUsage` and re-emits the agent. Token
 * observations are deduped against the previous one, so snapshot updates that
 * did not change usage are ignored.
 */
function noteUsage(state: AgentState, snapshot: AgentSnapshotLike): void {
  const usage = snapshot.lastUsage;
  if (!usage) return;
  const observation = tokenObservation(usage);
  const isNew =
    observation !== null && (state.lastObservation === null || !sameTokens(state.lastObservation, observation));
  if (observation) state.lastObservation = observation;
  const activeTurn = snapshot.activeTurn ?? null;
  if (!state.open && !activeTurn) return; // snapshot outside any turn: baseline only
  const open = state.open ?? openTurn(state, activeTurn?.turnId ?? null, activeTurn?.startedAt);
  open.lastUsage = usage;
  if (observation && isNew) open.observations.push(observation);
}

function watchAgent(paseo: PaseoApi, agent: AgentSnapshotLike): void {
  const state = stateFor(agent.id);
  if (agent.provider) state.provider = agent.provider;
  if (agent.model !== undefined) state.model = agent.model;
  if (state.prevSessionCostUsd === null) {
    state.prevSessionCostUsd = lastRecordForAgent(agent.id)?.sessionCostUsd ?? null;
  }
  noteUsage(state, agent);
  if (!subscriptions.has(agent.id)) {
    subscriptions.set(
      agent.id,
      paseo.agents.ref(agent.id).timeline.subscribe((payload) => onStream(agent.id, payload)),
    );
  }
}

export function ensureTracker(paseo: PaseoApi): Promise<void> {
  startPromise ??= (async () => {
    await loadStore();
    paseo.agents.subscribe((update) => {
      if (update.kind === "upsert") watchAgent(paseo, update.agent);
    });
    // subscribe: {} asks the daemon to keep streaming agent updates to this session.
    const page = await paseo.agents.list({ subscribe: {}, page: { limit: 200 } });
    for (const entry of page.entries) watchAgent(paseo, entry.agent);
    console.log(`token-ledger: tracking ${subscriptions.size} agent(s)`);
  })().catch((error) => {
    startPromise = null;
    throw error;
  });
  return startPromise;
}

function inFlightFor(agentId: string): InFlight | null {
  const open = agents.get(agentId)?.open;
  if (!open) return null;
  let input: number | null = null;
  let cached: number | null = null;
  let output: number | null = null;
  for (const observation of open.observations) {
    if (observation.input !== null) input = (input ?? 0) + observation.input;
    if (observation.cached !== null) cached = (cached ?? 0) + observation.cached;
    if (observation.output !== null) output = (output ?? 0) + observation.output;
  }
  const usage = open.lastUsage;
  return {
    turnId: open.turnId,
    startedAt: open.startedAt,
    modelCalls: open.observations.length,
    input,
    cached,
    output,
    ctxUsed: typeof usage?.contextWindowUsedTokens === "number" ? usage.contextWindowUsedTokens : null,
    ctxMax: typeof usage?.contextWindowMaxTokens === "number" ? usage.contextWindowMaxTokens : null,
  };
}

export async function handleSync(
  input: { agentId: string; limit?: number },
  context: { paseo: PaseoApi },
): Promise<{ inFlight: InFlight | null; records: TurnRecord[]; summary: Summary }> {
  await ensureTracker(context.paseo);
  return {
    inFlight: inFlightFor(input.agentId),
    records: recordsForAgent(input.agentId, input.limit ?? 50),
    summary: summaryForAgent(input.agentId),
  };
}

export async function handleEnsure(_input: object, context: { paseo: PaseoApi }): Promise<{ tracking: boolean }> {
  await ensureTracker(context.paseo);
  return { tracking: true };
}

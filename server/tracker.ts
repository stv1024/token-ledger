import { closeTurn, createState, noteUsage, startLifecycleTurn, streamTurn, type AgentState, type AgentSnapshotLike } from "./turns.ts";
import { loadJournal, saveJournal } from "./journal.ts";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { listAgents } from "../shared/agents.ts";
import type { PaseoAgentTimelineEvent, PaseoAgentTimelineSubscription, PaseoApi } from "@getpaseo/client";
import type { AgentUsageRow, InFlight, OverviewResult, Summary, SyncResult, TurnRecord } from "../shared/ledger.ts";
import { freshInput, usageSemantics } from "../shared/semantics.ts";
import { ensurePricing } from "./pricing.ts";
import {
  allRecords,
  flushStore,
  appendRecord,
  lastRecordForAgent,
  loadStore,
} from "./store.ts";

import { readModel, EMPTY_SUMMARY } from "./read-model.ts";
import { Catalog } from "./catalog.ts";
const catalog = new Catalog();

const agents = new Map<string, AgentState>();
const subscriptions = new Map<string, PaseoAgentTimelineSubscription>();
let startPromise: Promise<void> | null = null;
let unsubscribeAgents: (() => void) | null = null;
let stopped = false;
let trackerApi: PaseoApi | null = null;
let stopPromise: Promise<void> | null = null;
const pendingRecords = new Map<string, TurnRecord>();
const recovered = new Set<string>();
const terminalTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; settle: () => void }>();
let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
let persistence: Promise<void> = Promise.resolve();

function checkpoint(): void {
  if (stopped || checkpointTimer) return;
  checkpointTimer = setTimeout(() => {
    checkpointTimer = null;
    void saveJournal(agents, pendingRecords).catch((error) => console.error("token-ledger: checkpoint failed", error));
  }, 250);
}
async function drainRecords(): Promise<void> {
  // Write-ahead: a crash between append and checkpoint can safely retry the
  // same immutable record ID. Failed appends remain pending for the next drain.
  const batch = [...pendingRecords.values()];
  await saveJournal(agents, pendingRecords);
  for (const record of batch) {
    await appendRecord(record);
    pendingRecords.delete(record.id);
  }
  await saveJournal(agents, pendingRecords);
}
function persist(record: TurnRecord | null): void {
  checkpoint();
  if (!record) return;
  pendingRecords.set(record.id, record);
  persistence = persistence.catch(() => undefined).then(drainRecords);
  void persistence.catch((error) => console.error("token-ledger: failed to persist turn", error));
}

function stateFor(agentId: string): AgentState {
  let state = agents.get(agentId);
  if (!state) {
    state = createState(lastRecordForAgent(agentId));
    agents.set(agentId, state);
  }
  return state;
}
export function observeStream(payload: PaseoAgentTimelineEvent): void {
  if (!stopped) persist(streamTurn(stateFor(payload.agentId), payload));
}
export async function observeStart(event: PluginLifecycleEvents["agent.turn_started"], paseo: PaseoApi): Promise<void> {
  await ensureTracker(paseo);
  if (stopped) return;
  const state = stateFor(event.agent.id);
  state.provider = event.agent.provider;
  persist(startLifecycleTurn(event.agent.id, state, event.turnId, new Date().toISOString()));
  await prepareAgent(paseo, event.agent.id);
}
export async function observeEnd(event: PluginLifecycleEvents["agent.turn_ended"], paseo: PaseoApi): Promise<void> {
  await ensureTracker(paseo);
  if (stopped) return;
  const state = stateFor(event.agent.id);
  if (!state.open || state.open.turnId !== event.turnId) return;
  const key = state.open.key;
  const endedAt = new Date().toISOString();
  clearTimeout(terminalTimers.get(key)?.timer);
  // The stream carries terminal usage; the hook independently carries outcome.
  // Give the stream a brief chance to settle, then finalize observed facts only.
  const settle = () => {
    terminalTimers.delete(key);
    if (state.open?.key === key) persist(closeTurn(event.agent.id, state, event.outcome.kind, null, endedAt));
  };
  terminalTimers.set(key, { timer: setTimeout(settle, 250), settle });
}
function unwatchAgent(id: string): void {
  subscriptions.get(id)?.();
  subscriptions.delete(id);
}
function retireAgent(id: string): void {
  const state = agents.get(id);
  if (state) persist(closeTurn(id, state, "canceled", null, new Date().toISOString()));
  unwatchAgent(id);
}
function watchAgent(paseo: PaseoApi, agent: AgentSnapshotLike): void {
  if (stopped) return;
  if (recovered.delete(agent.id) && !agent.activeTurn && stateFor(agent.id).open) {
    const record = closeTurn(agent.id, stateFor(agent.id), "canceled", null, new Date().toISOString());
    if (record) record.source = `recovered_interruption:${record.source}`;
    persist(record);
  }
  persist(noteUsage(stateFor(agent.id), agent));
  if (subscriptions.has(agent.id)) return;
  const subscription = paseo.agents.ref(agent.id).timeline.subscribe(observeStream);
  subscriptions.set(agent.id, subscription);
  void subscription.ready.catch((error) => {
    if (subscriptions.get(agent.id) === subscription) unwatchAgent(agent.id);
    console.error("token-ledger: timeline subscription failed", agent.id, error);
  });
}
export async function prepareAgent(paseo: PaseoApi, agentId: string): Promise<void> {
  await ensureTracker(paseo);
  if (stopped) return;
  const handle = paseo.agents.ref(agentId);
  await handle.refresh();
  watchAgent(paseo, handle.current() ?? { id: agentId });
  await subscriptions.get(agentId)?.ready;
}
export function ensureTracker(paseo: PaseoApi): Promise<void> {
  if (stopped) return Promise.resolve();
  trackerApi = paseo;
  startPromise ??= (async () => {
    await loadStore();
    const journal = await loadJournal();
    for (const [id, state] of journal.states) {
      agents.set(id, state);
      if (state.open) recovered.add(id);
    }
    for (const record of journal.pending) pendingRecords.set(record.id, record);
    // Recover an already-appended turn from a checkpoint taken before closure.
    const recorded = new Map(allRecords().map((record) => [record.id, record]));
    for (const state of agents.values()) {
      const record = state.open ? recorded.get(state.open.key) : undefined;
      if (record) {
        state.open = null;
        state.lastClosedTurnId = record.turnId;
        state.lastClosedAt = record.endedAt;
        state.prevSessionCostUsd = record.sessionCostUsd ?? state.prevSessionCostUsd;
      }
    }
    await drainRecords();
    if (stopped) return;
    const changed = new Set<string>();
    let listing = true;
    unsubscribeAgents = paseo.agents.subscribe((update) => {
      if (update.kind === "upsert") {
        catalog.note(update.agent);
        if (listing) changed.add(update.agent.id);
        if (update.agent.archivedAt || update.agent.status === "closed") retireAgent(update.agent.id);
        else watchAgent(paseo, update.agent);
      } else {
        if (listing) changed.add(update.agentId);
        catalog.remove(update.agentId);
        retireAgent(update.agentId);
      }
    });
    try {
      const initial = await listAgents(paseo, true);
      for (const agent of initial) if (!changed.has(agent.id)) {
        catalog.note(agent);
        if (!agent.archivedAt && agent.status !== "closed") watchAgent(paseo, agent);
      }
      listing = false;
      changed.clear();
      await Promise.all([...subscriptions.values()].map((subscription) => subscription.ready));
      console.log(`token-ledger: tracking ${subscriptions.size} agent(s)`);
    } catch (error) {
      unsubscribeAgents?.();
      unsubscribeAgents = null;
      for (const id of subscriptions.keys()) unwatchAgent(id);
      throw error;
    }
  })().catch((error) => { startPromise = null; throw error; });
  return startPromise;
}
export function stopTracker(): Promise<void> {
  stopped = true;
  stopPromise ??= (async () => {
    unsubscribeAgents?.();
    unsubscribeAgents = null;
    catalog.dispose();
    for (const id of subscriptions.keys()) unwatchAgent(id);
    if (checkpointTimer) clearTimeout(checkpointTimer);
    for (const pending of [...terminalTimers.values()]) { clearTimeout(pending.timer); pending.settle(); }
    await persistence.catch(() => undefined);
    await drainRecords();
    await flushStore();
    // 0.8 schedules remote subscription updates from synchronous removers.
    // Round-trip on the same transport before the host closes it, allowing
    // those queued updates to settle instead of logging "Daemon client closed".
    await trackerApi?.agents.list({ page: { limit: 1 } }).catch(() => undefined);
  })();
  return stopPromise;
}

function inFlightFor(agentId: string): InFlight | null {
  const state = agents.get(agentId);
  const open = state?.open;
  if (!open) return null;
  const semantics = usageSemantics(open.provider, open.model);
  let input: number | null = null;
  let cached: number | null = null;
  let output: number | null = null;
  for (const observation of open.observations) {
    const fresh = freshInput(semantics, observation.input, observation.cached);
    if (fresh !== null) input = (input ?? 0) + fresh;
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
  input: { agentId: string; limit?: number; knownRecordsRevision?: string },
  context: { paseo: PaseoApi },
): Promise<SyncResult> {
  await ensureTracker(context.paseo);
  await ensurePricing();
  await persistence;
  await flushStore();
  const model = readModel();
  const group = model.groups.get(input.agentId);
  const summary = group?.summary ?? { ...EMPTY_SUMMARY };
  const recordsRevision = `${model.revision}:${input.agentId}:${input.limit ?? 50}`;
  return {
    inFlight: inFlightFor(input.agentId),
    recordsRevision,
    records: input.knownRecordsRevision === recordsRevision ? [] : (group?.rows.slice(0, input.limit ?? 50) ?? []),
    summary,
    ctx: agents.get(input.agentId)?.lastCtx ?? null,
  };
}

export async function handleOverview(_input: object, context: { paseo: PaseoApi }): Promise<OverviewResult> {
  await ensureTracker(context.paseo);
  await ensurePricing();
  await persistence;
  await flushStore();
  const byAgent = readModel().groups;
  await catalog.ensureWorkspaces(context.paseo);
  const snapshots = catalog.agents;
  const workspaceNames = catalog.workspaceNames;

  // Every agent with recorded usage, plus live agents the daemon knows about.
  const agentIds = new Set<string>([...byAgent.keys(), ...snapshots.keys()]);
  const rows = new Map<string | null, AgentUsageRow[]>();
  const totals: Summary = { ...EMPTY_SUMMARY };
  for (const agentId of agentIds) {
    const stored = byAgent.get(agentId);
    const snapshot = snapshots.get(agentId) ?? null;
    const state = agents.get(agentId);
    const open = state?.open ?? null;
    const summary = stored?.summary ?? { ...EMPTY_SUMMARY };
    totals.turns += summary.turns;
    totals.input += summary.input;
    totals.cached += summary.cached;
    totals.output += summary.output;
    if (summary.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + summary.costUsd;
    if (summary.effectiveCostUsd !== null) totals.effectiveCostUsd = (totals.effectiveCostUsd ?? 0) + summary.effectiveCostUsd;
    totals.estimatedTurns += summary.estimatedTurns;
    totals.unpricedTurns += summary.unpricedTurns;
    const row: AgentUsageRow = {
      agentId,
      title: snapshot?.title ?? null,
      provider: snapshot?.provider ?? state?.provider ?? null,
      model: snapshot?.model ?? state?.model ?? null,
      status: snapshot?.status ?? null,
      active: open !== null,
      lastActivityAt: open?.startedAt ?? stored?.lastEndedAt ?? snapshot?.updatedAt ?? null,
      summary,
    };
    const workspaceId = snapshot?.workspaceId ?? null;
    const group = rows.get(workspaceId);
    if (group) group.push(row);
    else rows.set(workspaceId, [row]);
  }
  if (totals.costUsd !== null) totals.costUsd = Number(totals.costUsd.toFixed(6));
  if (totals.effectiveCostUsd !== null) totals.effectiveCostUsd = Number(totals.effectiveCostUsd.toFixed(6));

  const groups = [...rows.entries()]
    .map(([workspaceId, groupAgents]) => ({
      workspaceId,
      workspaceName: workspaceId ? (workspaceNames.get(workspaceId) ?? null) : null,
      agents: groupAgents.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "")),
    }))
    .sort((a, b) => {
      if (a.workspaceId === null) return 1;
      if (b.workspaceId === null) return -1;
      return (a.workspaceName ?? a.workspaceId).localeCompare(b.workspaceName ?? b.workspaceId);
    });

  return { groups, totals };
}

export async function handleEnsure(_input: object, context: { paseo: PaseoApi }): Promise<{ tracking: boolean }> {
  await ensureTracker(context.paseo);
  return { tracking: true };
}

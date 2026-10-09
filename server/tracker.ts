import { closeTurn, createState, markUsageGap, reconcileUsage, noteUsage, startLifecycleTurn, streamTurn, type AgentState, type AgentSnapshotLike } from "./turns.ts";
import { loadJournal, saveJournal } from "./journal.ts";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { subscribeAgents } from "../shared/agents.ts";
import type { CatalogSubscription } from '../shared/catalog-subscription.ts';
import type { PaseoAgent, PaseoAgentTimelineEvent, PaseoApi } from "./paseo-types.ts";
import type { AgentUsageRow, InFlight, OverviewResult, Summary, SyncResult, TurnRecord } from "../shared/ledger.ts";
import { freshInput, usageSemantics, providerSemantics } from "../shared/semantics.ts";
import { ensurePricing, estimateUsageCost } from "./pricing.ts";
import {
  allRecords,
  flushStore,
  appendRecord,
  lastRecordForAgent,
  loadStore,
} from "./store.ts";

import { readModel, summaryFromRows, EMPTY_SUMMARY } from "./read-model.ts";
import { Catalog } from "./catalog.ts";
import { TimelinePublisher } from "./timeline.ts";
import { TimelineSubscriptions } from './subscriptions.ts';
const catalog = new Catalog();
const publisher = new TimelinePublisher();
const liveRecords = new Set<string>();

const agents = new Map<string, AgentState>();
let subscriptions: TimelineSubscriptions | null = null;
const agentRevisions = new Map<string, number>();
const needsReconcile = new Set<string>();
let startPromise: Promise<void> | null = null;
let agentCatalog: CatalogSubscription | null = null;
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
    if (liveRecords.delete(record.id) && trackerApi && !stopped) publisher.publish(trackerApi, record);
  }
  await saveJournal(agents, pendingRecords);
}
function persist(record: TurnRecord | null): void {
  checkpoint();
  if (!record) return;
  pendingRecords.set(record.id, record);
  if (!record.source.startsWith("recovered_")) liveRecords.add(record.id);
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
function retireAgent(id: string, gap = false): void {
  needsReconcile.delete(id);
  const state = agents.get(id);
  if (state) {
    if (gap) markUsageGap(state);
    const record = closeTurn(id, state, gap ? 'unknown' : 'canceled', null, new Date().toISOString());
    if (record && gap) record.source = `recovered_gap:${record.source}`;
    persist(record);
  }
  subscriptions?.unwatch(id);
}
function watchAgent(agent: AgentSnapshotLike, restored = false): void {
  if (stopped) return;
  if (recovered.delete(agent.id) && !agent.activeTurn && stateFor(agent.id).open) {
    const record = closeTurn(agent.id, stateFor(agent.id), "canceled", null, new Date().toISOString());
    if (record) record.source = `recovered_interruption:${record.source}`;
    persist(record);
  }
  if (restored) {
    for (const record of reconcileUsage(stateFor(agent.id), agent)) persist(record);
    checkpoint();
  } else persist(noteUsage(stateFor(agent.id), agent));
  void subscriptions?.watch(agent.id).catch(() => {});
}
export async function prepareAgent(paseo: PaseoApi, agentId: string): Promise<void> {
  await ensureTracker(paseo);
  if (stopped) return;
  const handle = paseo.agents.ref(agentId);
  await handle.refresh();
  if (stopped) return;
  watchAgent(handle.current() ?? { id: agentId });
  await subscriptions?.watch(agentId, true);
}
export function ensureTracker(paseo: PaseoApi): Promise<void> {
  if (stopped) return Promise.resolve();
  trackerApi = paseo;
  agentCatalog?.ensure();
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
    const bump = (id: string) => agentRevisions.set(id, (agentRevisions.get(id) ?? 0) + 1);
    subscriptions = new TimelineSubscriptions(paseo, {
      event: (event) => {
        bump(event.agentId);
        const open = agents.get(event.agentId)?.open;
        observeStream(event);
        if (open && !agents.get(event.agentId)?.open) needsReconcile.delete(event.agentId);
      },
      gap: (id) => { needsReconcile.add(id); markUsageGap(stateFor(id)); checkpoint(); },
      restored: async (id) => {
        const revision = agentRevisions.get(id);
        const handle = paseo.agents.ref(id);
        await handle.refresh();
        if (stopped || agentRevisions.get(id) !== revision) return;
        const snapshot = handle.current();
        if (!snapshot) { retireAgent(id, true); return; }
        applyAgent(snapshot, true);
      },
      error: (id, error) => console.error('token-ledger: timeline subscription failed', id, error),
    });
    const applyAgent = (agent: PaseoAgent, restored = false) => {
      restored = needsReconcile.delete(agent.id) || restored;
      bump(agent.id);
      catalog.note(agent);
      if (agent.archivedAt || agent.status === 'closed') retireAgent(agent.id, restored);
      else watchAgent(agent, restored);
    };
    try {
      agentCatalog = subscribeAgents(paseo, {
        onSnapshot: (entries, restored) => {
          if (stopped) return;
          const ids = new Set(entries.map((agent) => agent.id));
          for (const id of catalog.agents.keys()) if (!ids.has(id)) {
            bump(id); catalog.remove(id); retireAgent(id, restored);
          }
          for (const agent of entries) applyAgent(agent, restored);
        },
        onUpdate: (update) => {
          if (stopped) return;
          if (update.kind === 'upsert') applyAgent(update.agent);
          else { bump(update.agentId); catalog.remove(update.agentId); retireAgent(update.agentId); }
        },
        onError: (error) => {
          for (const [id, state] of agents) { needsReconcile.add(id); markUsageGap(state); }
          checkpoint();
          console.error('token-ledger: agent catalog failed', error);
        },
      });
      await agentCatalog.ready;
      // A checkpoint can outlive an archived/deleted agent. After a complete
      // catalog read, remaining recovered turns cannot still be active here.
      for (const id of recovered) {
        const record = closeTurn(id, stateFor(id), "canceled", null, new Date().toISOString());
        if (record) record.source = `recovered_interruption:${record.source}`;
        persist(record);
      }
      recovered.clear();
      await Promise.allSettled([...catalog.agents.values()].filter((agent) => agent.status !== 'closed' && !agent.archivedAt)
        .map((agent) => subscriptions!.watch(agent.id)));
      console.log(`token-ledger: tracking ${subscriptions.size} agent(s)`);
    } catch (error) {
      await agentCatalog?.release();
      agentCatalog = null;
      await subscriptions?.dispose();
      subscriptions = null;
      throw error;
    }
  })().catch((error) => { startPromise = null; throw error; });
  return startPromise;
}
export function stopTracker(): Promise<void> {
  stopped = true;
  stopPromise ??= (async () => {
    await agentCatalog?.release();
    agentCatalog = null;
    await subscriptions?.dispose();
    await catalog.dispose();
    if (checkpointTimer) clearTimeout(checkpointTimer);
    for (const pending of [...terminalTimers.values()]) { clearTimeout(pending.timer); pending.settle(); }
    await persistence.catch(() => undefined);
    await drainRecords();
    await flushStore();
    await publisher.flush();
  })();
  return stopPromise;
}

function inFlightFor(agentId: string): InFlight | null {
  const state = agents.get(agentId);
  const open = state?.open;
  if (!open) return null;
  const semantics = usageSemantics(open.provider, open.model);
  let input: number | null = null;
  let rawInput: number | null = null;
  let cached: number | null = null;
  let cacheWrite: number | null = null;
  let output: number | null = null;
  const observations = providerSemantics(open.provider).tokens === "request" ? open.observations : open.observations.slice(-1);
  for (const observation of observations) {
    const fresh = freshInput(semantics, observation.input, observation.cached, observation.cacheWrite);
    if (observation.input !== null) rawInput = (rawInput ?? 0) + observation.input;
    if (fresh !== null) input = (input ?? 0) + fresh;
    if (observation.cached !== null) cached = (cached ?? 0) + observation.cached;
    if (observation.cacheWrite != null) cacheWrite = (cacheWrite ?? 0) + observation.cacheWrite;
    if (observation.output !== null) output = (output ?? 0) + observation.output;
  }
  const usage = open.lastUsage;
  const estimated = estimateUsageCost({
    provider: open.provider,
    model: open.model,
    input: rawInput,
    cached,
    cacheWrite,
    output,
    ...(providerSemantics(open.provider).tokens === "request"
      ? { requests: open.observations.map(({ cost, ...tokens }) => tokens) }
      : {}),
  });
  return {
    ...(open.usageGap ? { usageGap: true } : {}),
    turnId: open.turnId,
    startedAt: open.startedAt,
    modelCalls: open.observations.length,
    input,
    cached,
    cacheWrite,
    output,
    effectiveCostUsd: estimated.effectiveCostUsd,
    costSource: estimated.costSource,
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

export async function handleOverview(input: { since?: string }, context: { paseo: PaseoApi }): Promise<OverviewResult> {
  const since = input.since ? Date.parse(input.since) : null;
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
    const summary = !stored ? { ...EMPTY_SUMMARY }
      : since === null ? stored.summary
      : summaryFromRows(stored.rows.filter((row) => Date.parse(row.endedAt) >= since));
    // A range lists only the agents that used tokens in it or that work now.
    if (since !== null && summary.turns === 0 && open === null) continue;
    totals.turns += summary.turns;
    totals.input += summary.input;
    totals.cached += summary.cached;
    if (summary.cacheWrite != null) totals.cacheWrite = (totals.cacheWrite ?? 0) + summary.cacheWrite;
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

  const byLatestActivity = (a: AgentUsageRow, b: AgentUsageRow) =>
    (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "");
  const groups = [...rows.entries()]
    .map(([workspaceId, groupAgents]) => ({
      workspaceId,
      workspaceName: workspaceId ? (workspaceNames.get(workspaceId) ?? null) : null,
      // The overview is a monitoring entry point: live sessions always lead,
      // followed by the most recently active history within the workspace.
      agents: groupAgents.sort((a, b) => Number(b.active) - Number(a.active) || byLatestActivity(a, b)),
    }))
    .sort((a, b) => {
      const aActive = a.agents.some((agent) => agent.active);
      const bActive = b.agents.some((agent) => agent.active);
      if (aActive !== bActive) return Number(bActive) - Number(aActive);
      // "Other sessions" participates by activity just like named workspaces.
      // A deterministic name/id fallback prevents equal timestamps from jumping.
      return byLatestActivity(a.agents[0]!, b.agents[0]!)
        || (a.workspaceName ?? a.workspaceId ?? "Other sessions")
          .localeCompare(b.workspaceName ?? b.workspaceId ?? "Other sessions");
    });

  return { groups, totals };
}

export async function handleEnsure(_input: object, context: { paseo: PaseoApi }): Promise<{ tracking: boolean }> {
  await ensureTracker(context.paseo);
  return { tracking: true };
}

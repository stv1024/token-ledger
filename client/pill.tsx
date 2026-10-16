import type { PaseoAgent } from "./paseo-types.ts";
import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useLedger } from "./data.ts";
import { useEffect } from "react";
import { subscribeAgents } from "../shared/agents.ts";
import { ledgerEnsure, type SyncResult } from "../shared/ledger.ts";
import { costOrTokens, fmtTokens } from "./ui.tsx";

import type { PanelPlacement } from "./layout.ts";

function pillLabel({ summary, inFlight, ctx, usageSnapshot }: SyncResult): string {
  let label: string;
  const snapshotHasTokens = usageSnapshot && (usageSnapshot.input !== null || usageSnapshot.cached !== null
    || usageSnapshot.cacheWrite !== null || usageSnapshot.output !== null);
  if (usageSnapshot && (snapshotHasTokens || usageSnapshot.reportedCostUsd !== null)) {
    if (usageSnapshot.scope === 'session' && snapshotHasTokens) {
      const partial = usageSnapshot.input === null || usageSnapshot.cached === null
        || usageSnapshot.cacheWrite === null || usageSnapshot.output === null;
      const total = (usageSnapshot.input ?? 0) + (usageSnapshot.cached ?? 0)
        + (usageSnapshot.cacheWrite ?? 0) + (usageSnapshot.output ?? 0);
      label = `Session ${partial ? '≈' : ''}${fmtTokens(total)} tok`;
    } else label = usageSnapshot.scope === 'session' ? 'Session snapshot' : 'Usage snapshot · scope unknown';
  } else {
    const live = inFlight?.tokenScope === 'turn' ? inFlight : null;
    const liveCost = live?.effectiveCostUsd;
    const combined = { ...summary,
      effectiveCostUsd: summary.effectiveCostUsd === null && liveCost == null ? null
        : (summary.effectiveCostUsd ?? 0) + (liveCost ?? 0),
      estimatedTurns: summary.estimatedTurns + (liveCost != null && live?.costSource !== 'reported' ? 1 : 0),
      partialCostTurns: summary.partialCostTurns + (liveCost != null && live?.partialCost ? 1 : 0),
      unpricedTurns: summary.unpricedTurns + (live && liveCost == null ? 1 : 0),
      pricingWarningTurns: summary.pricingWarningTurns + (live?.pricingWarning ? 1 : 0),
      incompleteTurns: summary.incompleteTurns + (live ? 1 : 0),
    };
    if (live) for (const field of ['input', 'cached', 'cacheWrite', 'output'] as const) {
      if (live[field] != null) combined[field] = (combined[field] ?? 0) + live[field];
    }
    const hasUsage = combined.effectiveCostUsd !== null || combined.input !== null || combined.cached !== null
      || combined.cacheWrite != null || combined.output !== null;
    label = hasUsage || combined.pricingWarningTurns > 0 ? costOrTokens(combined)
      : inFlight ? 'Waiting for usage' : 'No usage reported';
  }
  const parts = [label];
  const liveCtx = inFlight?.ctxUsed != null && inFlight.ctxMax != null
    ? { used: inFlight.ctxUsed, max: inFlight.ctxMax } : ctx;
  if (liveCtx && liveCtx.max > 0) parts.push(`ctx ${Math.round(liveCtx.used / liveCtx.max * 100)}%`);
  return parts.join(' · ');
}

export function contributePills(client: PluginClientContext, placement: PanelPlacement): () => Promise<void> {
  let disposed = false;
  const pills = new Map<string, { workspaceId: string; handle: PluginButtonRegistration }>();
  const remove = (id: string) => {
    pills.get(id)?.handle.remove();
    pills.delete(id);
  };
  const upsert = (agent: PaseoAgent) => {
    if (disposed) return;
    const workspaceId = agent.workspaceId;
    if (!workspaceId || agent.status === "closed" || agent.archivedAt) return remove(agent.id);
    if (pills.get(agent.id)?.workspaceId === workspaceId) return;
    remove(agent.id);
    let handle: PluginButtonRegistration;
    // Only visible pills poll. The descriptor owns the label, the component
    // owns the icon and subscribes to the usage query while mounted.
    function UsageIcon(props: PluginButtonIconProps) {
      useEffect(() => placement.observe(agent.id, props.layout.compact), [props.layout.compact]);
      const { data, error } = useLedger(agent.id);
      useEffect(() => {
        handle.update({ label: error ? "Usage unavailable" : data ? pillLabel(data) : "…" });
      }, [data, error]);
      return <Icon name={data?.inFlight ? "Activity" : "Coins"} size={props.size} color={props.color} />;
    }
    handle = client.addComposerPill({
      id: `ledger-pill-${agent.id}`, workspaceId, agentId: agent.id,
      button: {
        title: "Open TokenLedger Session Ledger", icon: UsageIcon, label: "…",
        behavior: { kind: "action", onPress: () => client.openPanel("ledger", {
          workspaceId, agentId: agent.id, ...placement.options(agent.id),
        }) },
      },
    });
    pills.set(agent.id, { workspaceId, handle });
  };
  const subscription = subscribeAgents(client.paseo, {
    onSnapshot: (agents) => {
      if (disposed) return;
      const ids = new Set(agents.map((agent) => agent.id));
      for (const id of pills.keys()) if (!ids.has(id)) remove(id);
      for (const agent of agents) upsert(agent);
    },
    onUpdate: (update) => {
      if (update.kind === 'upsert') upsert(update.agent);
      else remove(update.agentId);
    },
    onError: (error) => console.error('token-ledger: failed to list composer agents', error),
  });
  void client.rpc(ledgerEnsure, {}).catch((error) => console.error("token-ledger: tracker startup failed", error));
  return async () => {
    disposed = true;
    for (const id of pills.keys()) remove(id);
    await subscription.release();
  };
}

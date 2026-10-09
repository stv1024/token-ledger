import type { PaseoAgent } from "./paseo-types.ts";
import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useLedger } from "./data.ts";
import { useEffect } from "react";
import { subscribeAgents } from "../shared/agents.ts";
import { ledgerEnsure, type SyncResult } from "../shared/ledger.ts";
import { fmtCost, fmtTokens } from "./ui.tsx";

import type { PanelPlacement } from "./layout.ts";

function pillLabel({ summary, inFlight, ctx }: SyncResult): string {
  const combinedCost = summary.effectiveCostUsd === null && inFlight?.effectiveCostUsd == null
    ? null
    : (summary.effectiveCostUsd ?? 0) + (inFlight?.effectiveCostUsd ?? 0);
  const cost = fmtCost(combinedCost);
  const estimated = summary.estimatedTurns > 0 || inFlight?.effectiveCostUsd != null;
  const parts = [cost
    ? `${estimated ? "≈" : ""}${cost}`
    : `${fmtTokens(summary.input + summary.cached + (summary.cacheWrite ?? 0) + summary.output)} tok`];
  const liveCtx = inFlight?.ctxUsed != null && inFlight.ctxMax != null
    ? { used: inFlight.ctxUsed, max: inFlight.ctxMax } : ctx;
  if (liveCtx && liveCtx.max > 0) parts.push(`ctx ${Math.round(liveCtx.used / liveCtx.max * 100)}%`);
  return parts.join(" · ");
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

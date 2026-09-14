import type { PaseoAgent } from "@getpaseo/client";
import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { listAgents } from "../shared/agents.ts";
import { ledgerEnsure, ledgerSync, type SyncResult } from "../shared/ledger.ts";
import { fmtCost, fmtTokens } from "./ui.tsx";

// Default to the visible main pane until a rendered icon supplies the layout.
let hostLayoutCompact = true;
export const isHostLayoutCompact = () => hostLayoutCompact;

function pillLabel({ summary, inFlight, ctx }: SyncResult): string {
  const cost = fmtCost(summary.effectiveCostUsd);
  const parts = [cost
    ? `${summary.estimatedTurns > 0 ? "≈" : ""}${cost}`
    : `${fmtTokens(summary.input + summary.cached + summary.output)} tok`];
  const liveCtx = inFlight?.ctxUsed != null && inFlight.ctxMax != null
    ? { used: inFlight.ctxUsed, max: inFlight.ctxMax } : ctx;
  if (liveCtx && liveCtx.max > 0) parts.push(`ctx ${Math.round(liveCtx.used / liveCtx.max * 100)}%`);
  return parts.join(" · ");
}

export function contributePills(client: PluginClientContext): () => void {
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
    let compact = true;
    let handle: PluginButtonRegistration;
    // Only visible pills poll. The descriptor owns the label, the component
    // owns the icon and subscribes to the usage query while mounted.
    function UsageIcon(props: PluginButtonIconProps) {
      compact = props.layout.compact;
      hostLayoutCompact = compact;
      const sync = useRpc(ledgerSync);
      const { data, error } = useQuery({
        queryKey: ["token-ledger", "pill", agent.id],
        queryFn: () => sync({ agentId: agent.id, limit: 1 }),
        refetchInterval: 3000,
      });
      useEffect(() => {
        handle.update({ label: error ? "Usage unavailable" : data ? pillLabel(data) : "…" });
      }, [data, error]);
      return <Icon name={data?.inFlight ? "Activity" : "Coins"} size={props.size} color={props.color} />;
    }
    handle = client.addComposerPill({
      id: `ledger-pill-${agent.id}`, workspaceId, agentId: agent.id,
      button: {
        title: "TokenLedger", icon: UsageIcon, label: "…",
        behavior: { kind: "action", onPress: () => client.openPanel("ledger", {
          workspaceId, agentId: agent.id, ...(compact ? {} : { location: "explorer" }),
        }) },
      },
    });
    pills.set(agent.id, { workspaceId, handle });
  };
  const changed = new Set<string>();
  let listing = true;
  const unsubscribe = client.paseo.agents.subscribe((update) => {
    const id = update.kind === "upsert" ? update.agent.id : update.agentId;
    if (listing) changed.add(id);
    if (update.kind === "upsert") upsert(update.agent);
    else remove(update.agentId);
  });
  void listAgents(client.paseo, true).then((agents) => {
    for (const agent of agents) if (!changed.has(agent.id)) upsert(agent);
  }).catch((error) => console.error("token-ledger: failed to list composer agents", error))
    .finally(() => { listing = false; changed.clear(); });
  void client.rpc(ledgerEnsure, {}).catch((error) => console.error("token-ledger: tracker startup failed", error));
  return () => {
    disposed = true;
    unsubscribe();
    for (const id of pills.keys()) remove(id);
  };
}

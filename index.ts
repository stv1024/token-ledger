import type { PaseoAgent } from "@getpaseo/client";
import type { PluginCleanup, PluginContext } from "@getpaseo/plugin";
import { ledgerEnsure, ledgerOverview, ledgerSync } from "./src/ledger.shared";
import { TokenLedgerOverview } from "./src/overview.client";
import { TokenLedgerPanel } from "./src/panel.client";
import { TokenLedgerPill } from "./src/pill.client";
import { handleEnsure, handleOverview, handleSync } from "./src/tracker.server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(ledgerSync, handleSync);
  plugin.handle(ledgerEnsure, handleEnsure);
  plugin.handle(ledgerOverview, handleOverview);
  plugin.addWorkspacePanel({
    id: "ledger",
    title: "TokenLedger",
    icon: "Coins",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: TokenLedgerPanel,
  });
  plugin.addSurface("ledger-overview", TokenLedgerOverview);
  plugin.addSidebarItem({
    id: "ledger-overview",
    title: "TokenLedger",
    icon: "Coins",
    surface: "ledger-overview",
  });
  plugin.addCommandCenterItem({
    id: "open-ledger",
    title: "Open TokenLedger",
    icon: "Coins",
    keywords: ["token", "usage", "cost", "ledger"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("ledger");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-ledger-overview",
    title: "Open TokenLedger Overview",
    icon: "Coins",
    keywords: ["token", "usage", "cost", "ledger", "overview", "all"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("ledger-overview");
    },
  });
  plugin.addClientSide((client) => {
    // Kick the daemon-side tracker as soon as any client connects, so turns are
    // recorded even before the panel is first opened.
    void client.rpc(ledgerEnsure, {}).catch(() => undefined);

    // One usage pill per live agent, rendered in that agent's composer. The
    // pill is the visible per-session binding: split views each carry their own.
    const pills = new Map<string, PluginCleanup>();
    const removePill = (agentId: string) => {
      const cleanup = pills.get(agentId);
      if (!cleanup) return;
      pills.delete(agentId);
      void cleanup();
    };
    const upsertPill = (agent: PaseoAgent) => {
      if (agent.status === "closed" || agent.archivedAt) {
        removePill(agent.id);
        return;
      }
      const workspaceId = agent.workspaceId;
      if (!workspaceId || pills.has(agent.id)) return;
      pills.set(
        agent.id,
        client.addComposerPill({
          id: `ledger-pill-${agent.id}`,
          title: "TokenLedger",
          workspaceId,
          agentId: agent.id,
          Component: TokenLedgerPill,
          onPress: () => client.openPanel("ledger", { workspaceId, agentId: agent.id }),
        }),
      );
    };
    const unsubscribe = client.paseo.agents.subscribe((update) => {
      if (update.kind === "upsert") upsertPill(update.agent);
      else if (update.kind === "remove") removePill(update.agentId);
    });
    void client.paseo.agents
      .list({ subscribe: {}, page: { limit: 200 } })
      .then((page) => {
        for (const entry of page.entries) upsertPill(entry.agent);
      })
      .catch(() => undefined);
    return () => {
      unsubscribe();
      for (const agentId of [...pills.keys()]) removePill(agentId);
    };
  });
  return () => {};
}

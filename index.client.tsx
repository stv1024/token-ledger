import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TokenLedgerOverview } from "./client/overview.tsx";
import { TokenLedgerPanel } from "./client/panel.tsx";
import { contributePills } from "./client/pill.tsx";

import { PanelPlacement } from "./client/layout.ts";
import { UsageTimelineRow } from "./client/timeline.tsx";
import { UsageTimelineSchema, USAGE_TIMELINE_KIND } from "./shared/timeline.ts";

export default function contribute(client: PluginClientContext) {
  const placement = new PanelPlacement();
  client.addTimelineRenderer({ kind: USAGE_TIMELINE_KIND, version: 1, schema: UsageTimelineSchema, Component: UsageTimelineRow });
  client.addWorkspacePanel({
    id: "ledger",
    title: "TokenLedger Session Ledger",
    icon: "Coins",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: TokenLedgerPanel,
  });
  client.addSurface("ledger-overview", TokenLedgerOverview);
  client.addSidebarItem({
    id: "ledger-overview",
    title: "TokenLedger Overview",
    icon: "Coins",
    surface: "ledger-overview",
  });
  client.addCommandCenterItem({
    id: "open-ledger",
    title: "Open TokenLedger Session Ledger",
    icon: "Coins",
    keywords: ["token", "usage", "cost", "ledger"],
    context: "agent",
    onSelect({ openPanel, agent }) {
      openPanel("ledger", placement.options(agent.id));
    },
  });
  client.addCommandCenterItem({
    id: "open-ledger-overview",
    title: "Open TokenLedger Overview",
    icon: "Coins",
    keywords: ["token", "usage", "cost", "ledger", "overview", "all"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("ledger-overview");
    },
  });
  return contributePills(client, placement);
}

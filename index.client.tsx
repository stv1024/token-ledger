import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TokenLedgerOverview } from "./client/overview.tsx";
import { TokenLedgerPanel } from "./client/panel.tsx";
import { contributePills } from "./client/pill.tsx";
import { OVERVIEW_SCREEN } from "./client/range.ts";
import { LedgerSidebarItem } from "./client/sidebar.tsx";

import { createPanelPlacement } from "./client/layout.ts";
import { UsageTimelineRow } from "./client/timeline.tsx";
import { UsageTimelineSchema, USAGE_TIMELINE_KIND } from "./shared/timeline.ts";
import { TokenLedgerSettings } from './client/settings.tsx';

const SETTINGS_SCREEN = 'preferences';

export default function contribute(client: PluginClientContext) {
  const placement = createPanelPlacement();
  client.addSettingsScreen({ id: SETTINGS_SCREEN, title: 'TokenLedger', icon: 'Coins', Component: TokenLedgerSettings });
  client.addTimelineRenderer({ kind: USAGE_TIMELINE_KIND, version: 1, schema: UsageTimelineSchema, Component: UsageTimelineRow });
  client.addWorkspacePanel({
    id: "ledger",
    title: "TokenLedger Session Ledger",
    icon: "Coins",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: TokenLedgerPanel,
  });
  client.addScreen({
    id: OVERVIEW_SCREEN,
    title: "TokenLedger",
    Component: (props) => <TokenLedgerOverview {...props} openSettings={() => client.openSettings(SETTINGS_SCREEN)} />,
  });
  client.addSidebarFooterItem({ id: "ledger-today", title: "TokenLedger", Component: LedgerSidebarItem });
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
    onSelect({ openScreen }) {
      openScreen({ screenId: OVERVIEW_SCREEN });
    },
  });
  client.addCommandCenterItem({
    id: "open-ledger-settings",
    title: "Open TokenLedger Settings",
    icon: "Settings",
    keywords: ["token", "usage", "cost", "ledger", "settings", "pricing"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_SCREEN);
    },
  });
  return contributePills(client, placement);
}

import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TokenLedgerOverview } from "./client/overview.tsx";
import { TokenLedgerPanel } from "./client/panel.tsx";
import { contributePills, isHostLayoutCompact } from "./client/pill.tsx";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "ledger",
    title: "TokenLedger",
    icon: "Coins",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: TokenLedgerPanel,
  });
  client.addSurface("ledger-overview", TokenLedgerOverview);
  client.addSidebarItem({
    id: "ledger-overview",
    title: "TokenLedger",
    icon: "Coins",
    surface: "ledger-overview",
  });
  client.addCommandCenterItem({
    id: "open-ledger",
    title: "Open TokenLedger",
    icon: "Coins",
    keywords: ["token", "usage", "cost", "ledger"],
    context: "agent",
    onSelect({ openPanel }) {
      // Prefer the explorer side pane so the agent view stays visible on the
      // left. On compact layouts the explorer pane is never rendered (and the
      // host doesn't throw — it opens into the invisible pane), so use the
      // default main-pane placement there.
      if (isHostLayoutCompact()) {
        openPanel("ledger");
      } else {
        openPanel("ledger", { location: "explorer" });
      }
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
  return contributePills(client);
}

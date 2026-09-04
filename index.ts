import type { PluginContext } from "@getpaseo/plugin";
import { ledgerEnsure, ledgerSync } from "./src/ledger.shared";
import { TokenLedgerPanel } from "./src/panel.client";
import { handleEnsure, handleSync } from "./src/tracker.server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(ledgerSync, handleSync);
  plugin.handle(ledgerEnsure, handleEnsure);
  plugin.addWorkspacePanel({
    id: "ledger",
    title: "TokenLedger",
    icon: "Coins",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: TokenLedgerPanel,
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
  plugin.addClientSide((client) => {
    // Kick the daemon-side tracker as soon as any client connects, so turns are
    // recorded even before the panel is first opened.
    void client.rpc(ledgerEnsure, {}).catch(() => undefined);
    return () => {};
  });
  return () => {};
}

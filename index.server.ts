import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ledgerEnsure, ledgerOverview, ledgerSync } from "./shared/ledger.ts";
import { ensureTracker, handleEnsure, handleOverview, handleSync, prepareAgent, stopTracker } from "./server/tracker.ts";

export default function contribute(server: PluginServerContext) {
  server.handle(ledgerSync, handleSync);
  server.handle(ledgerEnsure, handleEnsure);
  server.handle(ledgerOverview, handleOverview);
  // Establish timeline demand before the provider can emit its first turn.
  // Lifecycle hooks run even with no desktop/mobile client connected.
  const beforeOpen = server.before("agent.session_open", async ({ request }, { paseo }) => {
    if (request.purpose !== "interactive") return;
    // A newly-created agent is not in the daemon catalog until session_open
    // returns. Establish catalog demand now; its first upsert attaches usage.
    try {
      if (request.reason === "create") await ensureTracker(paseo);
      else await prepareAgent(paseo, request.agentId);
    } catch (error) {
      console.error("token-ledger: could not prepare tracking", error);
    }
  });
  // Covers a plugin reload while an existing provider session stays open.
  const onStart = server.on("agent.turn_started", async ({ agent }, { paseo }) => {
    try { await prepareAgent(paseo, agent.id); }
    catch (error) { console.error("token-ledger: could not attach turn tracking", error); }
  });
  return async () => {
    beforeOpen();
    onStart();
    await stopTracker();
  };
}

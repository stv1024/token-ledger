import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ledgerEnsure, ledgerOverview, ledgerSync } from "./shared/ledger.ts";
import { ensureTracker, handleEnsure, handleOverview, handleSync, observeStart, observeEnd, prepareAgent, stopTracker } from "./server/tracker.ts";
import { initializePreferences } from './server/preferences.ts';
import { refreshProviderBases } from './server/providers.ts';
import type { PaseoApi } from './server/paseo-types.ts';

export default function contribute(server: PluginServerContext) {
  const preferences = initializePreferences(server);
  const ready = async (paseo: PaseoApi) => { await preferences.ready; await refreshProviderBases(paseo); };
  server.handle(ledgerSync, async (input, context) => { await ready(context.paseo); return handleSync(input, context); });
  server.handle(ledgerEnsure, async (input, context) => { await ready(context.paseo); return handleEnsure(input, context); });
  server.handle(ledgerOverview, async (input, context) => { await ready(context.paseo); return handleOverview(input, context); });
  // Establish timeline demand before the provider can emit its first turn.
  // Lifecycle hooks run even with no desktop/mobile client connected.
  const beforeOpen = server.before("agent.session_open", async ({ request }, { paseo }) => {
    if (request.purpose !== "interactive") return;
    // A newly-created agent is not in the daemon catalog until session_open
    // returns. Establish catalog demand now; its first upsert attaches usage.
    try {
      await ready(paseo);
      if (request.reason === "create") await ensureTracker(paseo);
      else await prepareAgent(paseo, request.agentId);
    } catch (error) {
      console.error("token-ledger: could not prepare tracking", error);
    }
  });
  // Covers a plugin reload while an existing provider session stays open.
  const onStart = server.on("agent.turn_started", async (event, { paseo }) => {
    try { await ready(paseo); await observeStart(event, paseo); }
    catch (error) { console.error("token-ledger: could not attach turn tracking", error); }
  });
  const onEnd = server.on("agent.turn_ended", async (event, { paseo }) => { await ready(paseo); await observeEnd(event, paseo); });
  return async () => {
    beforeOpen();
    onStart();
    onEnd();
    await stopTracker();
    await preferences.dispose();
  };
}

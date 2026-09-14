import type { PaseoAgent, PaseoApi } from "@getpaseo/client";

/** A list page is not the complete catalog. Subscribe only on the first page. */
export async function listAgents(paseo: PaseoApi, subscribe = false): Promise<PaseoAgent[]> {
  const agents = new Map<string, PaseoAgent>();
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await paseo.agents.list({
      ...(subscribe && !cursor ? { subscribe: { subscriptionId: "token-ledger" } } : {}),
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of page.entries) agents.set(agent.id, agent);
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Repeated agent pagination cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...agents.values()];
}

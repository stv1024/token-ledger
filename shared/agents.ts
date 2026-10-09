import { subscribeCatalog, type CatalogSubscription, type OwnedSubscription } from './catalog-subscription.ts';

// Shared code cannot import host client or server SDK types. Callers pass the
// host PaseoApi, and the agent type is inferred from it.
type AgentPage<A> = { entries: readonly { agent: A }[]; pageInfo: { nextCursor?: string | null } };
export type AgentUpdate<A> = { kind: 'upsert'; agent: A } | { kind: 'remove'; agentId: string };
export interface AgentCatalogApi<A> {
  readonly agents: {
    list(options: { subscribe: {}; page: { limit: number } }): Promise<AgentPage<A> & { subscription: OwnedSubscription<AgentPage<A>> }>;
    list(options: { page: { limit: number; cursor?: string } }): Promise<AgentPage<A>>;
  };
}

/** A list page is not the complete catalog. Subscribe only on the first page. */
export async function listAgents<A extends { id: string }>(paseo: AgentCatalogApi<A>): Promise<A[]> {
  const agents = new Map<string, A>();
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await paseo.agents.list({
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of page.entries) agents.set(agent.id, agent);
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Repeated agent pagination cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...agents.values()];
}

export function subscribeAgents<A extends { id: string }>(paseo: AgentCatalogApi<A>, handlers: {
  onSnapshot(agents: A[], restored: boolean): void;
  onUpdate(update: AgentUpdate<A>): void;
  onError(error: unknown): void;
}): CatalogSubscription {
  return subscribeCatalog({
    open: () => paseo.agents.list({ subscribe: {}, page: { limit: 200 } }),
    next: (cursor) => paseo.agents.list({ page: { limit: 200, cursor } }),
    entries: (page) => page.entries.map(({ agent }) => agent),
    id: (agent) => agent.id,
    update: (value) => {
      const message = value as { type?: unknown; payload: AgentUpdate<A> };
      if (message.type !== 'agent_update') return null;
      const update = message.payload;
      return update.kind === 'upsert' ? { id: update.agent.id, item: update.agent, value: update }
        : { id: update.agentId, item: null, value: update };
    },
    ...handlers,
  });
}

import type { PaseoAgent, PaseoApi } from '@getpaseo/client';

type Metadata = Pick<PaseoAgent, 'id' | 'workspaceId' | 'title' | 'provider' | 'model' | 'status' | 'updatedAt'>;

/** Metadata only: live usage belongs to the tracker, not the overview catalog. */
export class Catalog {
  readonly agents = new Map<string, Metadata>();
  readonly workspaceNames = new Map<string, string>();
  private loading: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  note(agent: PaseoAgent): void {
    const { id, workspaceId, title, provider, model, status, updatedAt } = agent;
    this.agents.set(id, { id, workspaceId, title, provider, model, status, updatedAt });
  }
  remove(id: string): void { this.agents.delete(id); }

  ensureWorkspaces(paseo: PaseoApi): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.loading ??= (async () => {
      const changed = new Set<string>();
      let listing = true;
      this.unsubscribe = paseo.workspaces.subscribe((update) => {
        if (update.kind === 'upsert') {
          const w = update.workspace;
          if (listing) changed.add(w.id);
          this.workspaceNames.set(w.id, w.title ?? w.name);
        } else {
          if (listing) changed.add(update.id);
          this.workspaceNames.delete(update.id);
        }
      });
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await paseo.workspaces.list({
          ...(!cursor ? { subscribe: { subscriptionId: 'token-ledger-workspaces' } } : {}),
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        if (this.disposed) return;
        for (const w of page.entries) if (!changed.has(w.id)) this.workspaceNames.set(w.id, w.title ?? w.name);
        cursor = page.pageInfo.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Repeated workspace pagination cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      listing = false;
      changed.clear();
    })().catch((error) => {
      this.unsubscribe?.(); this.unsubscribe = null; this.loading = null;
      console.error('token-ledger: workspace catalog failed', error);
    });
    return this.loading;
  }

  dispose(): void { this.disposed = true; this.unsubscribe?.(); this.unsubscribe = null; }
}

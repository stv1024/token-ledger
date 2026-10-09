import type { PaseoAgent, PaseoApi, PaseoWorkspace, PaseoWorkspaceListResult, PaseoWorkspaceUpdate } from './paseo-types.ts';
import { subscribeCatalog, type CatalogSubscription } from '../shared/catalog-subscription.ts';

type Metadata = Pick<PaseoAgent, 'id' | 'workspaceId' | 'title' | 'provider' | 'model' | 'status' | 'updatedAt' | 'archivedAt'>;

/** Metadata only: live usage belongs to the tracker, not the overview catalog. */
export class Catalog {
  readonly agents = new Map<string, Metadata>();
  readonly workspaceNames = new Map<string, string>();
  private subscription: CatalogSubscription | null = null;
  private disposed = false;

  note(agent: PaseoAgent): void {
    const { id, workspaceId, title, provider, model, status, updatedAt, archivedAt } = agent;
    this.agents.set(id, { id, workspaceId, title, provider, model, status, updatedAt, archivedAt });
  }
  remove(id: string): void { this.agents.delete(id); }

  ensureWorkspaces(paseo: PaseoApi): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.subscription ??= subscribeCatalog<PaseoWorkspace, PaseoWorkspaceListResult, PaseoWorkspaceUpdate>({
      open: () => paseo.workspaces.list({ subscribe: {}, page: { limit: 200 } }),
      next: (cursor) => paseo.workspaces.list({ page: { limit: 200, cursor } }),
      entries: (page) => page.entries,
      id: (workspace) => workspace.id,
      update: (value) => {
        const message = value as { type?: unknown; payload: PaseoWorkspaceUpdate };
        if (message.type !== 'workspace_update') return null;
        const update = message.payload;
        return update.kind === 'upsert' ? { id: update.workspace.id, item: update.workspace, value: update }
          : { id: update.id, item: null, value: update };
      },
      onSnapshot: (workspaces) => {
        this.workspaceNames.clear();
        for (const w of workspaces) this.workspaceNames.set(w.id, w.title ?? w.name);
      },
      onUpdate: (update) => {
        if (update.kind === 'upsert') {
          const w = update.workspace;
          this.workspaceNames.set(w.id, w.title ?? w.name);
        } else {
          this.workspaceNames.delete(update.id);
        }
      },
      onError: (error) => console.error('token-ledger: workspace catalog failed', error),
    });
    this.subscription.ensure();
    return this.subscription.ready.catch(() => {});
  }

  async dispose(): Promise<void> { this.disposed = true; await this.subscription?.release(); this.subscription = null; }
}

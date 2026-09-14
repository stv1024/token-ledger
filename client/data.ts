import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import type { PaseoApi } from '@getpaseo/client';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ledgerSync, ledgerOverview, type SyncResult } from '../shared/ledger.ts';

const coordinators = new WeakMap<QueryClient, Map<PaseoApi, { count: number; dispose: () => void }>>();

/** One catalog listener per mounted client, with bounded trailing invalidation. */
function useRefresh(): void {
  const paseo = usePaseo();
  const cache = useQueryClient();
  useEffect(() => {
    let clients = coordinators.get(cache);
    if (!clients) { clients = new Map(); coordinators.set(cache, clients); }
    let coordinator = clients.get(paseo);
    if (!coordinator) {
      const fingerprints = new Map<string, string>();
      const dirty = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = paseo.agents.subscribe((event) => {
        const id = event.kind === 'upsert' ? event.agent.id : event.agentId;
        const fingerprint = event.kind === 'upsert' ? JSON.stringify([
          event.agent.activeTurn, event.agent.lastUsage, event.agent.status,
          event.agent.model, event.agent.title, event.agent.workspaceId,
        ]) : 'removed';
        if (fingerprints.get(id) === fingerprint) return;
        fingerprints.set(id, fingerprint);
        dirty.add(id);
        timer ??= setTimeout(() => {
          timer = undefined;
          for (const agentId of dirty) void cache.invalidateQueries({ queryKey: ['token-ledger', 'agent', agentId] });
          dirty.clear();
          void cache.invalidateQueries({ queryKey: ['token-ledger', 'overview'] });
        }, 500);
      });
      coordinator = { count: 0, dispose: () => { unsubscribe(); clearTimeout(timer); } };
      clients.set(paseo, coordinator);
    }
    coordinator.count++;
    return () => {
      if (--coordinator.count === 0) { coordinator.dispose(); clients.delete(paseo); }
    };
  }, [paseo, cache]);
}

export function useLedger(agentId: string) {
  const sync = useRpc(ledgerSync);
  const cache = useQueryClient();
  useRefresh();
  const queryKey = ['token-ledger', 'agent', agentId] as const;
  return useQuery({
    queryKey,
    queryFn: async () => {
      const previous = cache.getQueryData<SyncResult>(queryKey);
      const next = await sync({ agentId, knownRecordsRevision: previous?.recordsRevision });
      return previous?.recordsRevision === next.recordsRevision ? { ...next, records: previous.records } : next;
    },
    staleTime: 1000,
    refetchInterval: (query) => query.state.data?.inFlight ? 3000 : 30000,
  });
}

export function useOverview() {
  const overview = useRpc(ledgerOverview);
  useRefresh();
  return useQuery({
    queryKey: ['token-ledger', 'overview'],
    queryFn: () => overview({}),
    staleTime: 1000,
    refetchInterval: (query) => query.state.data?.groups.some((g) => g.agents.some((a) => a.active)) ? 3000 : 30000,
  });
}

import { usePaseo, useRpc, useSettings } from '@getpaseo/plugin/client';
import type { PaseoApi } from './paseo-types.ts';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ledgerSync, ledgerOverview, type SyncResult } from '../shared/ledger.ts';
import { preferences, refreshIntervalMs } from '../shared/preferences.ts';

const coordinators = new WeakMap<QueryClient, Map<PaseoApi, { count: number; dispose: () => void }>>();

// Live usage changes many times a second while an agent streams.
const AGENT_REFRESH_MS = 1000;
const OVERVIEW_REFRESH_MS = 500;

/**
 * One catalog listener per mounted client, with bounded trailing invalidation.
 * Only agent queries show live usage. The overview shows ledger totals and
 * which agents are active, so usage snapshots do not refresh it.
 */
function useRefresh(pricingKey: string | null): void {
  const paseo = usePaseo();
  const cache = useQueryClient();
  useEffect(() => {
    if (pricingKey !== null) void cache.invalidateQueries({ queryKey: ['token-ledger'] });
  }, [pricingKey, cache]);
  useEffect(() => {
    let clients = coordinators.get(cache);
    if (!clients) { clients = new Map(); coordinators.set(cache, clients); }
    let coordinator = clients.get(paseo);
    if (!coordinator) {
      const usage = new Map<string, string>();
      const shape = new Map<string, string>();
      const dirty = new Set<string>();
      let agentTimer: ReturnType<typeof setTimeout> | undefined;
      let overviewTimer: ReturnType<typeof setTimeout> | undefined;
      const changed = (seen: Map<string, string>, id: string, fingerprint: string) => {
        if (seen.get(id) === fingerprint) return false;
        seen.set(id, fingerprint);
        return true;
      };
      const unsubscribe = paseo.agents.subscribe((event) => {
        const id = event.kind === 'upsert' ? event.agent.id : event.agentId;
        const metadata = event.kind === 'upsert' ? JSON.stringify([
          event.agent.activeTurn, event.agent.status, event.agent.model, event.agent.title, event.agent.workspaceId,
        ]) : 'removed';
        const live = event.kind === 'upsert' ? `${metadata}${JSON.stringify(event.agent.lastUsage)}` : metadata;
        if (changed(usage, id, live)) {
          dirty.add(id);
          agentTimer ??= setTimeout(() => {
            agentTimer = undefined;
            for (const agentId of dirty) void cache.invalidateQueries({ queryKey: ['token-ledger', 'agent', agentId] });
            dirty.clear();
          }, AGENT_REFRESH_MS);
        }
        if (changed(shape, id, metadata)) {
          overviewTimer ??= setTimeout(() => {
            overviewTimer = undefined;
            void cache.invalidateQueries({ queryKey: ['token-ledger', 'overview'] });
          }, OVERVIEW_REFRESH_MS);
        }
      });
      coordinator = { count: 0, dispose: () => { unsubscribe(); clearTimeout(agentTimer); clearTimeout(overviewTimer); } };
      clients.set(paseo, coordinator);
    }
    coordinator.count++;
    return () => {
      if (--coordinator.count === 0) { coordinator.dispose(); clients.delete(paseo); }
    };
  }, [paseo, cache]);
}

export function useLedger(agentId: string) {
  const settings = useSettings(preferences);
  const sync = useRpc(ledgerSync);
  const cache = useQueryClient();
  useRefresh(settings.status === 'ready' ? `${settings.values.openRouterPricing}:${settings.values.builtinPricing}` : null);
  const queryKey = ['token-ledger', 'agent', agentId] as const;
  return useQuery({
    queryKey,
    queryFn: async () => {
      const previous = cache.getQueryData<SyncResult>(queryKey);
      const next = await sync({ agentId, knownRecordsRevision: previous?.recordsRevision });
      return previous?.recordsRevision === next.recordsRevision ? { ...next, records: previous.records } : next;
    },
    staleTime: 1000,
    refetchInterval: (query) => refreshIntervalMs(settings.status === 'ready' ? settings.values.refreshInterval : 'normal', !!query.state.data?.inFlight),
  });
}

/** `since` is an ISO bound for the range; null means all time. */
export function useOverview(since: string | null) {
  const settings = useSettings(preferences);
  const overview = useRpc(ledgerOverview);
  useRefresh(settings.status === 'ready' ? `${settings.values.openRouterPricing}:${settings.values.builtinPricing}` : null);
  return useQuery({
    queryKey: ['token-ledger', 'overview', since],
    queryFn: () => overview(since === null ? {} : { since }),
    staleTime: 1000,
    refetchInterval: (query) => refreshIntervalMs(settings.status === 'ready' ? settings.values.refreshInterval : 'normal', !!query.state.data?.groups.some((g) => g.agents.some((a) => a.active))),
  });
}

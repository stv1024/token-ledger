import type { PaseoApi } from './paseo-types.ts';
import { setProviderBases } from '../shared/semantics.ts';

const MAX_AGE_MS = 30_000;
let loadedAt = 0;
let pending: Promise<void> | null = null;

/** Reads `extends` from custom provider entries; only provider names and base names are kept. */
export function refreshProviderBases(paseo: PaseoApi): Promise<void> {
  if (pending) return pending;
  if (Date.now() - loadedAt < MAX_AGE_MS) return Promise.resolve();
  pending = (async () => {
    try {
      const { config } = await paseo.config.get();
      const bases: Record<string, string> = {};
      for (const [name, entry] of Object.entries(config.providers ?? {})) {
        const base = (entry as { extends?: unknown }).extends;
        if (typeof base === 'string' && base && base !== name) bases[name] = base;
      }
      setProviderBases(bases);
    } catch (error) {
      console.error('token-ledger: could not read provider config; keeping known provider names', error instanceof Error ? error.message : error);
    } finally {
      loadedAt = Date.now();
      pending = null;
    }
  })();
  return pending;
}

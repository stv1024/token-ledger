import { useState } from 'react';

/** Pane width is independent of the host's mobile/desktop layout. */
export function useDenseLayout(compact: boolean) {
  const [width, setWidth] = useState(0);
  return { dense: width > 0 ? width < 410 : compact, setWidth };
}

/** Scoped to one client contribution, using only currently mounted icons. */
export function createPanelPlacement() {
  const layouts = new Map<string, Map<symbol, boolean>>();

  return {
    observe(agentId: string, compact: boolean): () => void {
      const token = Symbol();
      const entries = layouts.get(agentId) ?? new Map<symbol, boolean>();
      entries.set(token, compact);
      layouts.set(agentId, entries);
      return () => {
        entries.delete(token);
        if (!entries.size) layouts.delete(agentId);
      };
    },
    options(agentId: string): { location?: 'explorer' } {
      const entries = layouts.get(agentId);
      return entries?.size && [...entries.values()].every((compact) => !compact) ? { location: 'explorer' } : {};
    },
  };
}

export type PanelPlacement = ReturnType<typeof createPanelPlacement>;

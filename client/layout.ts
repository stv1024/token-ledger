import { useState } from 'react';

/** Pane width is independent of the host's mobile/desktop layout. */
export function useDenseLayout(compact: boolean) {
  const [width, setWidth] = useState(0);
  return { dense: width > 0 ? width < 410 : compact, setWidth };
}

/** Scoped to one client contribution, using only currently mounted icons. */
export class PanelPlacement {
  private layouts = new Map<string, Map<symbol, boolean>>();
  observe(agentId: string, compact: boolean): () => void {
    const token = Symbol();
    const entries = this.layouts.get(agentId) ?? new Map<symbol, boolean>();
    entries.set(token, compact); this.layouts.set(agentId, entries);
    return () => { entries.delete(token); if (!entries.size) this.layouts.delete(agentId); };
  }
  options(agentId: string): { location?: 'explorer' } {
    const entries = this.layouts.get(agentId);
    return entries?.size && [...entries.values()].every((compact) => !compact) ? { location: 'explorer' } : {};
  }
}

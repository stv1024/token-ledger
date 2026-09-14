import type { PaseoApi } from '@getpaseo/client';
import type { TurnRecord } from '../shared/ledger.ts';
import { UsageTimelineSchema, USAGE_TIMELINE_KIND } from '../shared/timeline.ts';
import { enrichTurn, ensurePricing } from './pricing.ts';

/** Called only after durable append, never for records recovered on startup. */
export class TimelinePublisher {
  private queued = new Set<string>();
  private pending = new Set<Promise<void>>();

  publish(paseo: PaseoApi, record: TurnRecord): void {
    if (this.queued.has(record.id)) return;
    this.queued.add(record.id);
    const work = (async () => {
      await ensurePricing();
      const item = { type: 'plugin' as const, id: `token-ledger:${record.id}`,
        kind: USAGE_TIMELINE_KIND, version: 1, data: UsageTimelineSchema.parse(enrichTurn(record, 1)) };
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await paseo.agents.ref(record.agentId).timeline.append(item); return; }
        catch (error) {
          if (attempt === 1) console.error('token-ledger: timeline summary unavailable; ledger retained', record.id, error);
        }
      }
    })().catch((error) => console.error('token-ledger: timeline summary failed; ledger retained', error));
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  async flush(): Promise<void> { await Promise.all([...this.pending]); }
}

import type { Summary, TurnRecord, TurnRow } from '../shared/ledger.ts';
import { allRecords, storeRevision } from './store.ts';
import { enrichTurn, pricingRevision } from './pricing.ts';
export const EMPTY_SUMMARY: Summary = {
  turns: 0,
  input: 0,
  cached: 0,
  output: 0,
  costUsd: null,
  effectiveCostUsd: null,
  estimatedTurns: 0,
  unpricedTurns: 0,
};

function summaryFromRecords(records: readonly TurnRecord[]): Summary {
  const summary: Summary = { ...EMPTY_SUMMARY };
  for (const record of records) {
    const row = enrichTurn(record, 1);
    summary.turns += 1;
    summary.input += row.input ?? 0;
    summary.cached += row.cached ?? 0;
    summary.output += row.output ?? 0;
    if (record.costUsd !== null) summary.costUsd = (summary.costUsd ?? 0) + record.costUsd;
    if (row.effectiveCostUsd !== null) {
      summary.effectiveCostUsd = (summary.effectiveCostUsd ?? 0) + row.effectiveCostUsd;
      if (row.costSource !== "reported") summary.estimatedTurns += 1;
    } else {
      summary.unpricedTurns += 1;
    }
  }
  if (summary.costUsd !== null) summary.costUsd = Number(summary.costUsd.toFixed(6));
  if (summary.effectiveCostUsd !== null) summary.effectiveCostUsd = Number(summary.effectiveCostUsd.toFixed(6));
  return summary;
}


let revision = '';
let groups = new Map<string, {summary: Summary; rows: TurnRow[]; lastEndedAt: string | null}>();
export function readModel() {
  const current = storeRevision() + ':' + pricingRevision();
  if (current !== revision) {
    const raw = new Map<string, TurnRecord[]>();
    for (const record of allRecords()) {
      const group = raw.get(record.agentId) ?? [];
      group.push(record); raw.set(record.agentId, group);
    }
    groups = new Map([...raw].map(([id, records]) => [id, {
      summary: summaryFromRecords(records),
      rows: records.map((r, i) => enrichTurn(r, i + 1)).reverse(),
      lastEndedAt: records.at(-1)?.endedAt ?? null,
    }]));
    revision = current;
  }
  return { revision, groups };
}

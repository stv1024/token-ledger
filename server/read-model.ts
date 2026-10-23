import type { Summary, TurnRecord, TurnRow } from '../shared/ledger.ts';
import { allRecords, storeRevision } from './store.ts';
import { enrichTurn, pricingRevision } from './pricing.ts';
export const EMPTY_SUMMARY: Summary = {
  turns: 0,
  input: null,
  cached: null,
  output: null,
  costUsd: null,
  effectiveCostUsd: null,
  estimatedTurns: 0,
  unpricedTurns: 0,
  unmeasuredTurns: 0,
  incompleteTurns: 0,
  partialCostTurns: 0,
  pricingWarningTurns: 0,
};

/** Sums enriched rows, so a caller can summarize any subset of the read model. */
export function summaryFromRows(rows: readonly TurnRow[]): Summary {
  const summary: Summary = { ...EMPTY_SUMMARY };
  for (const row of rows) {
    summary.turns += 1;
    if (row.incompleteUsage) summary.incompleteTurns += 1;
    if (row.pricingWarning) summary.pricingWarningTurns += 1;
    if (row.tokenScope !== 'turn') {
      summary.unmeasuredTurns += 1;
      summary.unpricedTurns += 1;
      continue;
    }
    if (row.input !== null) summary.input = (summary.input ?? 0) + row.input;
    if (row.cached !== null) summary.cached = (summary.cached ?? 0) + row.cached;
    if (row.cacheWrite != null) summary.cacheWrite = (summary.cacheWrite ?? 0) + row.cacheWrite;
    if (row.output !== null) summary.output = (summary.output ?? 0) + row.output;
    if (row.costUsd !== null) summary.costUsd = (summary.costUsd ?? 0) + row.costUsd;
    if (row.effectiveCostUsd !== null) {
      summary.effectiveCostUsd = (summary.effectiveCostUsd ?? 0) + row.effectiveCostUsd;
      if (row.costSource !== "reported") summary.estimatedTurns += 1;
      if (row.partialCost) summary.partialCostTurns += 1;
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
    groups = new Map([...raw].map(([id, records]) => {
      const rows = records.map((r, i) => enrichTurn(r, i + 1));
      return [id, { summary: summaryFromRows(rows), rows: rows.reverse(), lastEndedAt: records.at(-1)?.endedAt ?? null }];
    }));
    revision = current;
  }
  return { revision, groups };
}

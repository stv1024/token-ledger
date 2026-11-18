import type { Summary, TurnRecord, TurnRow } from '../shared/ledger.ts';
import { allRecords, hasRecord, storeRevision } from './store.ts';
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
  promptTokens: null,
  promptCached: null,
  promptFloorTokens: null,
  promptFloorCached: null,
  unknownPromptTurns: 0,
};

/** Adds one summary into another; the hit-rate fields stay paired. */
export function addSummary(totals: Summary, summary: Summary): void {
  totals.turns += summary.turns;
  if (summary.input !== null) totals.input = (totals.input ?? 0) + summary.input;
  if (summary.cached !== null) totals.cached = (totals.cached ?? 0) + summary.cached;
  if (summary.cacheWrite != null) totals.cacheWrite = (totals.cacheWrite ?? 0) + summary.cacheWrite;
  if (summary.output !== null) totals.output = (totals.output ?? 0) + summary.output;
  if (summary.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + summary.costUsd;
  if (summary.effectiveCostUsd !== null) totals.effectiveCostUsd = (totals.effectiveCostUsd ?? 0) + summary.effectiveCostUsd;
  if (summary.promptTokens != null && summary.promptCached != null) {
    totals.promptTokens = (totals.promptTokens ?? 0) + summary.promptTokens;
    totals.promptCached = (totals.promptCached ?? 0) + summary.promptCached;
  }
  if (summary.promptFloorTokens != null && summary.promptFloorCached != null) {
    totals.promptFloorTokens = (totals.promptFloorTokens ?? 0) + summary.promptFloorTokens;
    totals.promptFloorCached = (totals.promptFloorCached ?? 0) + summary.promptFloorCached;
  }
  totals.estimatedTurns += summary.estimatedTurns;
  totals.unpricedTurns += summary.unpricedTurns;
  totals.unmeasuredTurns += summary.unmeasuredTurns;
  totals.incompleteTurns += summary.incompleteTurns;
  totals.partialCostTurns += summary.partialCostTurns;
  totals.pricingWarningTurns += summary.pricingWarningTurns;
  totals.unknownPromptTurns = (totals.unknownPromptTurns ?? 0) + (summary.unknownPromptTurns ?? 0);
}

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
      summary.unknownPromptTurns! += 1;
      continue;
    }
    // A missing cache write is unknown, not zero: such turns only give a prompt floor, kept apart.
    const floor = row.minPromptTokens ?? null;
    if (row.promptTokens !== null && row.promptTokens > 0 && row.cached !== null && row.cached <= row.promptTokens) {
      summary.promptTokens = (summary.promptTokens ?? 0) + row.promptTokens;
      summary.promptCached = (summary.promptCached ?? 0) + row.cached;
    } else if (row.promptTokens === null && floor !== null && floor > 0 && row.cached !== null && row.cached <= floor) {
      summary.promptFloorTokens = (summary.promptFloorTokens ?? 0) + floor;
      summary.promptFloorCached = (summary.promptFloorCached ?? 0) + row.cached;
    } else {
      summary.unknownPromptTurns! += 1;
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
/**
 * `pending` holds closed turns that are not appended yet, so a read does not
 * wait for disk. A record already in the store is not counted twice.
 */
export function readModel(pending: Iterable<TurnRecord> = []) {
  const staged = [...pending].filter((record) => !hasRecord(record.id));
  const current = storeRevision() + ':' + pricingRevision() + (staged.length ? ':' + staged.map((record) => record.id).join(',') : '');
  if (current !== revision) {
    const raw = new Map<string, TurnRecord[]>();
    for (const record of [...allRecords(), ...staged]) {
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

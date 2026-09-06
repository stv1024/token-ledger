import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TurnRecordSchema, type Summary, type TurnRecord } from "./ledger.shared";
import { freshInput, usageSemantics } from "./semantics";

const DATA_DIR = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugins", "token-ledger");
const DATA_FILE = join(DATA_DIR, "ledger.jsonl");
const MAX_RECORDS = 2000;
const TRIM_THRESHOLD = 2200;

let records: TurnRecord[] = [];
let loadPromise: Promise<void> | null = null;

export function dataFilePath(): string {
  return DATA_FILE;
}

export function loadStore(): Promise<void> {
  loadPromise ??= (async () => {
    let text: string;
    try {
      text = await readFile(DATA_FILE, "utf8");
    } catch {
      return; // first run
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(TurnRecordSchema.parse(JSON.parse(trimmed)));
      } catch {
        // skip corrupt lines rather than losing the whole ledger
      }
    }
  })();
  return loadPromise;
}

export async function appendRecord(record: TurnRecord): Promise<void> {
  records.push(record);
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(DATA_FILE, `${JSON.stringify(record)}\n`, "utf8");
  if (records.length > TRIM_THRESHOLD) {
    records = records.slice(-MAX_RECORDS);
    const tmp = `${DATA_FILE}.tmp`;
    await writeFile(tmp, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    await rename(tmp, DATA_FILE);
  }
}

/** Newest first. */
export function recordsForAgent(agentId: string, limit: number): TurnRecord[] {
  const matching: TurnRecord[] = [];
  for (let i = records.length - 1; i >= 0 && matching.length < limit; i--) {
    if (records[i].agentId === agentId) matching.push(records[i]);
  }
  return matching;
}

export function lastRecordForAgent(agentId: string): TurnRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].agentId === agentId) return records[i];
  }
  return null;
}

/** Per-agent totals across all retained records; input is normalized to fresh (uncached) tokens. */
export function summariesByAgent(): Map<string, { summary: Summary; lastEndedAt: string | null }> {
  const byAgent = new Map<string, { summary: Summary; lastEndedAt: string | null }>();
  for (const record of records) {
    let entry = byAgent.get(record.agentId);
    if (!entry) {
      entry = { summary: { turns: 0, input: 0, cached: 0, output: 0, costUsd: null }, lastEndedAt: null };
      byAgent.set(record.agentId, entry);
    }
    entry.summary.turns += 1;
    entry.summary.input += freshInput(usageSemantics(record.provider, record.model), record.input, record.cached) ?? 0;
    entry.summary.cached += record.cached ?? 0;
    entry.summary.output += record.output ?? 0;
    if (record.costUsd !== null) entry.summary.costUsd = (entry.summary.costUsd ?? 0) + record.costUsd;
    if (entry.lastEndedAt === null || record.endedAt > entry.lastEndedAt) entry.lastEndedAt = record.endedAt;
  }
  for (const entry of byAgent.values()) {
    if (entry.summary.costUsd !== null) entry.summary.costUsd = Number(entry.summary.costUsd.toFixed(6));
  }
  return byAgent;
}

export function summaryForAgent(agentId: string): Summary {
  const summary: Summary = { turns: 0, input: 0, cached: 0, output: 0, costUsd: null };
  for (const record of records) {
    if (record.agentId !== agentId) continue;
    summary.turns += 1;
    summary.input += freshInput(usageSemantics(record.provider, record.model), record.input, record.cached) ?? 0;
    summary.cached += record.cached ?? 0;
    summary.output += record.output ?? 0;
    if (record.costUsd !== null) summary.costUsd = (summary.costUsd ?? 0) + record.costUsd;
  }
  if (summary.costUsd !== null) summary.costUsd = Number(summary.costUsd.toFixed(6));
  return summary;
}

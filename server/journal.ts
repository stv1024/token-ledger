import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { TurnRecordSchema, type TurnRecord } from "../shared/ledger.ts";
import { AgentStateSchema, type AgentState } from "./turns.ts";
import { dataFilePath } from "./store.ts";

const states = z.array(z.tuple([z.string(), AgentStateSchema]));
const schema = z.object({ v: z.literal(1), states, pending: z.array(TurnRecordSchema) });
// `gen` was added in v0.8.4; older snapshots have no log and read as generation 0.
const retiredSchema = z.object({ v: z.literal(1), gen: z.number().int().nonnegative().optional(), states });
const logEntry = z.object({ g: z.number().int().nonnegative(), id: z.string(), s: AgentStateSchema });
const file = join(dirname(dataFilePath()), "tracker-state.json");
// Retired agents change only when they retire, so they stay out of the frequent
// checkpoint. Their full state keeps cost baselines exact. A retirement appends
// one line to the log; the snapshot is rewritten only to compact the log.
const retiredFile = join(dirname(dataFilePath()), "tracker-retired.json");
const retiredLog = join(dirname(dataFilePath()), "tracker-retired.jsonl");
const MIN_COMPACT_LINES = 256;
let writes: Promise<void> = Promise.resolve();
// Lines with this generation are newer than the snapshot.
let generation = 1;
let maxGeneration = 1;
let logLines = 0;
// A snapshot without `gen` is from v0.8.3 or older; the first save replaces it.
let legacySnapshot = false;
async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}
async function readJson<T>(path: string, parse: (value: unknown) => T, empty: T): Promise<T> {
  const text = await readText(path);
  return text === null ? empty : parse(JSON.parse(text));
}
export async function loadJournal(): Promise<{ states: [string, AgentState][]; pending: TurnRecord[]; retired: [string, AgentState][] }> {
  const journal = await readJson(file, (value) => schema.parse(value), { v: 1 as const, states: [], pending: [] });
  const snapshotText = await readText(retiredFile);
  const snapshot = snapshotText === null ? null : retiredSchema.parse(JSON.parse(snapshotText));
  const retired = new Map(snapshot?.states ?? []);
  legacySnapshot = snapshot !== null && snapshot.gen === undefined;
  generation = snapshot?.gen ?? (legacySnapshot ? 0 : 1);
  maxGeneration = generation;
  logLines = 0;
  for (const line of (await readText(retiredLog))?.split("\n") ?? []) {
    if (!line.trim()) continue;
    logLines++;
    let entry: z.infer<typeof logEntry>;
    // A crash can cut the last line. Its agent keeps the copy written before it.
    try { entry = logEntry.parse(JSON.parse(line)); } catch { continue; }
    maxGeneration = Math.max(maxGeneration, entry.g);
    // Other lines can be older than the snapshot: from before a compaction cut
    // short by a crash, or from before a downgrade rewrote the snapshot. They
    // only fill in agents that the snapshot does not have.
    if (entry.g === generation || !retired.has(entry.id)) retired.set(entry.id, entry.s);
  }
  return { states: journal.states, pending: journal.pending, retired: [...retired] };
}
function queue(task: () => Promise<void>): Promise<void> {
  const write = writes.then(task);
  writes = write.catch(() => undefined);
  return write;
}
async function replace(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${text}\n`, "utf8");
  await rename(`${path}.tmp`, path);
}
export type RetiredUpdate = {
  /** Agents that retired, or changed while retired, since the last save. */
  changed: [string, AgentState][];
  /** Every retired agent, for a compaction. */
  all: Map<string, AgentState>;
  /** Rewrites the snapshot even if the log is still short. */
  compact?: boolean;
};
/**
 * Writes retirements before the live journal, so a crash between the files
 * cannot lose an agent: a copy in both files resolves to the live one.
 */
export function saveJournal(live: Map<string, AgentState>, pending: Map<string, TurnRecord>, retired?: RetiredUpdate): Promise<void> {
  const tasks: Promise<void>[] = [];
  // Serialize now: the state objects can change before the queued write runs.
  const lines = retired?.changed.map(([id, state]) => `,"id":${JSON.stringify(id)},"s":${JSON.stringify(state)}}`) ?? [];
  if (lines.length) tasks.push(queue(async () => {
    await mkdir(dirname(retiredLog), { recursive: true });
    await appendFile(retiredLog, lines.map((line) => `{"g":${generation}${line}\n`).join(""), "utf8");
    logLines += lines.length;
  }));
  const liveText = JSON.stringify({ v: 1, states: [...live], pending: [...pending.values()] });
  tasks.push(queue(() => replace(file, liveText)));
  if (retired && (retired.compact || legacySnapshot || logLines + lines.length >= Math.max(MIN_COMPACT_LINES, retired.all.size / 2))) {
    legacySnapshot = false;
    const statesText = JSON.stringify([...retired.all]);
    tasks.push(queue(async () => {
      // A crash before the log is cleared leaves lines of an older generation.
      const next = maxGeneration + 1;
      await replace(retiredFile, `{"v":1,"gen":${next},"states":${statesText}}`);
      generation = maxGeneration = next;
      await writeFile(retiredLog, "", "utf8");
      logLines = 0;
    }).catch((error) => { legacySnapshot ||= generation === 0; throw error; }));
  }
  return Promise.all(tasks).then(() => undefined);
}

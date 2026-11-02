import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { TurnRecordSchema, type TurnRecord } from "../shared/ledger.ts";
import { AgentStateSchema, type AgentState } from "./turns.ts";
import { dataFilePath } from "./store.ts";

const states = z.array(z.tuple([z.string(), AgentStateSchema]));
const schema = z.object({ v: z.literal(1), states, pending: z.array(TurnRecordSchema) });
const retiredSchema = z.object({ v: z.literal(1), states });
const file = join(dirname(dataFilePath()), "tracker-state.json");
// Retired agents change only when they retire or return, so they stay out of
// the frequent checkpoint. Their full state keeps cost baselines exact.
const retiredFile = join(dirname(dataFilePath()), "tracker-retired.json");
let writes: Promise<void> = Promise.resolve();
async function readJson<T>(path: string, parse: (value: unknown) => T, empty: T): Promise<T> {
  try { return parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return empty;
  }
}
export async function loadJournal(): Promise<{ states: [string, AgentState][]; pending: TurnRecord[]; retired: [string, AgentState][] }> {
  const journal = await readJson(file, (value) => schema.parse(value), { v: 1 as const, states: [], pending: [] });
  const retired = await readJson(retiredFile, (value) => retiredSchema.parse(value), { v: 1 as const, states: [] });
  return { states: journal.states, pending: journal.pending, retired: retired.states };
}
function replace(path: string, text: string): Promise<void> {
  const write = writes.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, `${text}\n`, "utf8");
    await rename(`${path}.tmp`, path);
  });
  writes = write.catch(() => undefined);
  return write;
}
/** Writes retired states first, so a crash between the files cannot lose an agent. */
export function saveJournal(live: Map<string, AgentState>, pending: Map<string, TurnRecord>, retired?: Map<string, AgentState>): Promise<void> {
  const writesRetired = retired ? replace(retiredFile, JSON.stringify({ v: 1, states: [...retired] })) : Promise.resolve();
  const writesLive = replace(file, JSON.stringify({ v: 1, states: [...live], pending: [...pending.values()] }));
  return Promise.all([writesRetired, writesLive]).then(() => undefined);
}

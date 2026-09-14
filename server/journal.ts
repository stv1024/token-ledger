import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { TurnRecordSchema, type TurnRecord } from "../shared/ledger.ts";
import { AgentStateSchema, type AgentState } from "./turns.ts";
import { dataFilePath } from "./store.ts";

const schema = z.object({ v: z.literal(1), states: z.array(z.tuple([z.string(), AgentStateSchema])), pending: z.array(TurnRecordSchema) });
const file = join(dirname(dataFilePath()), "tracker-state.json");
let writes: Promise<void> = Promise.resolve();
export async function loadJournal(): Promise<{ states: [string, AgentState][]; pending: TurnRecord[] }> {
  try { return schema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { states: [], pending: [] };
  }
}
export function saveJournal(states: Map<string, AgentState>, pending: Map<string, TurnRecord>): Promise<void> {
  const text = JSON.stringify({ v: 1, states: [...states], pending: [...pending.values()] });
  const write = writes.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, `${text}\n`, "utf8");
    await rename(`${file}.tmp`, file);
  });
  writes = write.catch(() => undefined);
  return write;
}

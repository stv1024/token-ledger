import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { CostSource, TurnRecord, TurnRow } from "../shared/ledger.ts";
import { costBreakdownWithPricing, modelPricing, type ModelPricing } from "../shared/pricing.ts";
import { freshInput, usageSemantics } from "../shared/semantics.ts";

type PriceTier = ModelPricing & { upToInputTokens?: number };
type PriceEntry = { providers?: string[]; model: string; tiers: PriceTier[] };

const PriceFileSchema = z.object({
  version: z.literal(1),
  currency: z.literal("USD"),
  updatedAt: z.string().optional(),
  prices: z.array(
    z.object({
      providers: z.array(z.string()).optional(),
      model: z.string(),
      tiers: z.array(
        z.object({
          upToInputTokens: z.number().int().positive().optional(),
          input: z.number().nonnegative(),
          cacheRead: z.number().nonnegative(),
          output: z.number().nonnegative(),
        }),
      ),
    }),
  ),
});

const DATA_DIR = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugins", "token-ledger");
const PRICE_FILE = join(DATA_DIR, "pricing.json");
const OPENROUTER_CACHE_FILE = join(DATA_DIR, "openrouter-pricing.json");
const OPENROUTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TOKENROUTER_QUOTA_PER_USD = 13.5414; // 1 quota = CNY 0.5 at CNY 6.7707 / USD

/* model|max prompt tokens|input quota|cache-read quota|output quota. Blank max = final tier. */
const TOKENROUTER_ROWS = `
claude-fable-5||135.41|13.54|677.07
claude-haiku-4.5||13.54|1.35|67.71
claude-opus-4.5||67.71|6.77|338.54
claude-opus-4.6||67.71|6.77|338.54
claude-opus-4.6-hq||67.71|6.77|338.54
claude-opus-4.7||67.71|6.77|338.54
claude-opus-4.8||67.71|6.77|338.54
claude-opus-5||67.71|6.77|338.54
claude-sonnet-4.5||40.62|4.06|203.12
claude-sonnet-4.6||40.62|4.06|203.12
claude-sonnet-5||27.08|2.71|135.41
deepseek-v3.2||2|0.4|3
deepseek-v4-flash||3|0.1|9
deepseek-v4-flash-vision-exp||3|0.1|9
deepseek-v4-pro||9|0.3|27
gemini-3-flash-preview||6.77|0.68|40.62
gemini-3.1-flash-lite||3.39|0.34|20.31
gemini-3.1-pro-preview|200000|27.08|2.71|162.5
gemini-3.1-pro-preview||54.17|5.42|243.75
gemini-3.5-flash||20.31|2.03|121.87
gemini-3.7-flash||10.16|1.02|50.78
glm-5|32000|4|1|18
glm-5||6|1.5|22
glm-5-turbo|32000|5|1.2|22
glm-5-turbo||7|1.8|26
glm-5.1|32000|6|1.3|24
glm-5.1||8|2|28
glm-5.2||8|2|28
glm-5.3||8|2|28
glm-5.3-flash||0.8|0.23|2.8
glm-5v-turbo|32000|5|1.2|22
glm-5v-turbo||7|1.8|26
google.gemini-2.5-pro|200000|16.93|1.69|135.41
google.gemini-2.5-pro||33.85|3.39|203.12
gpt-4o-mini||2.03|1.02|8.12
gpt-5-mini||3.39|0.34|27.08
gpt-5.4||33.85|3.39|203.12
gpt-5.4-mini||10.16|1.02|60.94
gpt-5.5||67.71|6.77|406.24
gpt-5.6-luna||13.54|1.35|81.25
gpt-5.6-sol||67.71|6.77|406.24
gpt-5.6-terra||33.85|3.39|203.12
gpt-6-astra|272000|135.41|13.54|677.07
gpt-6-astra||270.83|27.08|1015.61
hy3||1|0.25|4
hy3-preview|15999|1.2|0.4|4
hy3-preview|31999|1.6|0.6|6.4
hy3-preview||2|0.8|8
hy4-preview||6|0.3|18
kimi-k2.5||4|0.7|21
kimi-k2.6||6.5|1.1|27
kimi-k2.7-code||6.43|1.29|27.08
kimi-k2.7-code-highspeed||12.86|2.57|54.17
kimi-k3||20|2|100
mimo-v2.5-pro||3|0.03|6
minimax-m2.5||2.1|0.21|8.4
minimax-m2.7||2.1|0.42|8.4
minimax-m3|512000|2.1|0.42|8.4
minimax-m3||4.2|0.84|16.8
qwen3.5-35b-a3b||0.95|0.95|6.77
qwen3.5-flash|128000|0.2|0.02|2
qwen3.5-flash|256000|0.8|0.08|8
qwen3.5-flash||1.2|0.12|12
qwen3.5-plus|128000|0.8|0.08|4.8
qwen3.5-plus|256000|2|0.2|12
qwen3.5-plus||4|0.4|24
qwen3.6-27b||1.9|1.9|13.47
qwen3.8-max-0902||12|1.5|36
xai.grok-3|199999|16.93|2.71|33.85
xai.grok-3||33.85|5.42|67.71
xai.grok-4|199999|16.93|2.71|33.85
xai.grok-4||33.85|5.42|67.71
xai.grok-4.20-0309-non-reasoning|199999|16.93|2.71|33.85
xai.grok-4.20-0309-non-reasoning||33.85|5.42|67.71
xai.grok-4.20-0309-reasoning|199999|16.93|2.71|33.85
xai.grok-4.20-0309-reasoning||33.85|5.42|67.71
xai.grok-4.20-multi-agent|199999|16.93|2.71|33.85
xai.grok-4.20-multi-agent||33.85|5.42|67.71
xai.grok-4.20-multi-agent-0309|199999|16.93|2.71|33.85
xai.grok-4.20-multi-agent-0309||33.85|5.42|67.71
xai.grok-4.20-non-reasoning|199999|16.93|2.71|33.85
xai.grok-4.20-non-reasoning||33.85|5.42|67.71
xai.grok-4.20-reasoning|199999|16.93|2.71|33.85
xai.grok-4.20-reasoning||33.85|5.42|67.71
xai.grok-4.3|199999|16.93|2.71|33.85
xai.grok-4.3||33.85|5.42|67.71
xai.grok-4.6|199999|27.08|6.77|81.25
xai.grok-4.6||54.17|13.54|162.5`;

function seedPrices(): PriceEntry[] {
  const usd = (quota: string) => Number((Number(quota) / TOKENROUTER_QUOTA_PER_USD).toFixed(6));
  const grouped = new Map<string, PriceEntry>();
  for (const line of TOKENROUTER_ROWS.trim().split("\n")) {
    const [model, max, input, cacheRead, output] = line.split("|");
    let entry = grouped.get(model);
    if (!entry) {
      entry = { providers: ["tokenrouter", "deepseek-harness"], model, tiers: [] };
      grouped.set(model, entry);
    }
    entry.tiers.push({
      ...(max ? { upToInputTokens: Number(max) } : {}),
      input: usd(input),
      cacheRead: usd(cacheRead),
      output: usd(output),
    });
  }
  return [...grouped.values()];
}

function canonicalModel(value: string): string {
  let model = value.trim().toLowerCase();
  if (model.startsWith("[")) {
    try {
      const parsed = JSON.parse(model) as unknown;
      if (Array.isArray(parsed) && typeof parsed.at(-1) === "string") model = parsed.at(-1) as string;
    } catch {}
  }
  model = model.split("/").at(-1) ?? model;
  return model.replace(/\[1m\]$/i, "").replace(/[._]/g, "-").replace(/-+/g, "-");
}

function providerMatches(entry: PriceEntry, provider: string | null, model: string | null): boolean {
  if (!entry.providers?.length) return true;
  const haystack = `${provider ?? ""} ${model ?? ""}`.toLowerCase();
  return entry.providers.some((part) => haystack.includes(part.toLowerCase()));
}

function chooseTier(entry: PriceEntry, promptTokens: number): PriceTier {
  return entry.tiers.find((tier) => tier.upToInputTokens === undefined || promptTokens <= tier.upToInputTokens) ?? entry.tiers.at(-1)!;
}

/** Exposed for deterministic verification of the shipped TokenRouter seed table. */
export function tokenRouterDefaultPricing(model: string, promptTokens: number): ModelPricing | null {
  const entry = seedPrices().find((candidate) => canonicalModel(candidate.model) === canonicalModel(model));
  if (!entry) return null;
  const { input, cacheRead, output } = chooseTier(entry, promptTokens);
  return { input, cacheRead, output };
}

type OpenRouterPrice = { id: string; prompt: number; completion: number; cacheRead: number };
type OpenRouterCache = { fetchedAt: string; prices: OpenRouterPrice[] };

let overridePrices: PriceEntry[] = [];
let openRouterPrices: OpenRouterPrice[] = [];
let loadPromise: Promise<void> | null = null;
let revision = 0;
export const pricingRevision = () => revision;

async function loadOverrides(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    overridePrices = PriceFileSchema.parse(JSON.parse(await readFile(PRICE_FILE, "utf8"))).prices;
  } catch (error) {
    const seeded = { version: 1, currency: "USD", updatedAt: "2026-09-14", prices: seedPrices() } as const;
    overridePrices = seeded.prices.map((entry) => ({ ...entry, tiers: [...entry.tiers] }));
    try {
      await writeFile(PRICE_FILE, `${JSON.stringify(seeded, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.error("token-ledger: invalid pricing.json; using TokenRouter defaults", error);
      }
    }
  }
}

async function loadOpenRouter(): Promise<void> {
  let cached: OpenRouterCache | null = null;
  try {
    cached = JSON.parse(await readFile(OPENROUTER_CACHE_FILE, "utf8")) as OpenRouterCache;
    openRouterPrices = cached.prices;
  } catch {}
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < OPENROUTER_MAX_AGE_MS) return;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id?: string; pricing?: Record<string, string> }> };
    const prices = (body.data ?? []).flatMap((item): OpenRouterPrice[] => {
      const prompt = Number(item.pricing?.prompt);
      const completion = Number(item.pricing?.completion);
      if (!item.id || !Number.isFinite(prompt) || !Number.isFinite(completion)) return [];
      const rawCache = Number(item.pricing?.input_cache_read);
      return [{
        id: item.id,
        prompt: prompt * 1_000_000,
        completion: completion * 1_000_000,
        cacheRead: (Number.isFinite(rawCache) ? rawCache : prompt) * 1_000_000,
      }];
    });
    openRouterPrices = prices;
    await writeFile(OPENROUTER_CACHE_FILE, `${JSON.stringify({ fetchedAt: new Date().toISOString(), prices })}\n`, "utf8");
  } catch (error) {
    console.error("token-ledger: OpenRouter pricing refresh failed; using cached prices", error);
  }
}

export function ensurePricing(): Promise<void> {
  loadPromise ??= Promise.all([loadOverrides(), loadOpenRouter()]).then(() => { revision++; });
  return loadPromise;
}

function lookupOpenRouter(model: string): ModelPricing | null {
  const canonical = canonicalModel(model);
  const matches = openRouterPrices.filter((price) => canonicalModel(price.id) === canonical);
  if (matches.length !== 1) return null;
  const price = matches[0];
  return { input: price.prompt, cacheRead: price.cacheRead, output: price.completion };
}

function resolvePricing(provider: string | null, model: string | null, promptTokens: number): { pricing: ModelPricing; source: Exclude<CostSource, "reported"> } | null {
  if (!model) return null;
  const canonical = canonicalModel(model);
  const override = overridePrices.find((entry) => canonicalModel(entry.model) === canonical && providerMatches(entry, provider, model));
  if (override) return { pricing: chooseTier(override, promptTokens), source: "override" };
  const openrouter = lookupOpenRouter(model);
  if (openrouter) return { pricing: openrouter, source: "openrouter" };
  const builtin = modelPricing(model);
  return builtin ? { pricing: builtin, source: "builtin" } : null;
}

export function enrichTurn(record: TurnRecord, seq: number): TurnRow {
  const input = freshInput(usageSemantics(record.provider, record.model), record.input, record.cached);
  const promptTokens = (input ?? 0) + (record.cached ?? 0);
  const resolved = resolvePricing(record.provider, record.model, promptTokens);
  const breakdown = resolved ? costBreakdownWithPricing({ ...record, input }, resolved.pricing) : null;
  const estimate = breakdown ? breakdown.inUsd + breakdown.cacheUsd + breakdown.outUsd : null;
  return {
    ...record,
    input,
    seq,
    effectiveCostUsd: record.costUsd ?? estimate,
    costSource: record.costUsd !== null ? "reported" : (resolved?.source ?? null),
    costBreakdown: breakdown,
  };
}

export function pricingFilePath(): string {
  return PRICE_FILE;
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { CostSource, TurnRecord, TurnRow } from "../shared/ledger.ts";
import { canonicalModel, costBreakdownWithPricing, knownCost, modelPricing, partialCost, type CostBreakdown, type ModelPricing } from "../shared/pricing.ts";
import { freshInput, promptTokens, tokenScope, usageSemantics } from "../shared/semantics.ts";
import { getPreferences, preferencesRevision } from './preferences.ts';

type PriceTier = ModelPricing & { upToInputTokens?: number };
type PriceEntry = { providers?: string[]; model: string; aliases?: string[]; tiers: PriceTier[] };

export const PriceFileSchema = z.object({
  version: z.literal(1),
  currency: z.literal("USD"),
  updatedAt: z.string().optional(),
  prices: z.array(
    z.object({
      providers: z.array(z.string()).optional(),
      model: z.string(),
      aliases: z.array(z.string().min(1)).optional(),
      tiers: z.array(
        z.object({
          upToInputTokens: z.number().int().positive().optional(),
          input: z.number().nonnegative(),
          cacheRead: z.number().finite().nonnegative().optional(),
          cacheWrite: z.number().finite().nonnegative().optional(),
          output: z.number().nonnegative(),
        }),
      ).min(1).refine((tiers) => tiers.every((tier, i) =>
        i === tiers.length - 1 ? tier.upToInputTokens === undefined :
          tier.upToInputTokens !== undefined && (i === 0 || tier.upToInputTokens > tiers[i - 1].upToInputTokens!)
      ), 'Tiers must increase and end with an unbounded tier'),
    }),
  ),
});

const DATA_DIR = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugins", "token-ledger");
const PRICE_FILE = join(DATA_DIR, "pricing.json");
const OPENROUTER_CACHE_FILE = join(DATA_DIR, "openrouter-pricing.json");
const OPENROUTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function providerMatches(entry: PriceEntry, provider: string | null): boolean {
  if (!entry.providers?.length) return true;
  return entry.providers.some((part) => (provider ?? '').toLowerCase().includes(part.toLowerCase()));
}

function chooseTier(entry: PriceEntry, prompt: number | null): PriceTier | null {
  if (entry.tiers.length === 1) return entry.tiers[0];
  if (prompt === null) return null;
  return entry.tiers.find((tier) => tier.upToInputTokens === undefined || prompt <= tier.upToInputTokens) ?? null;
}


type OpenRouterPrice = { id: string; prompt: number; completion: number; cacheRead?: number; cacheWrite?: number };
const OpenRouterCacheSchema = z.object({
  fetchedAt: z.string().datetime(),
  prices: z.array(z.object({ id: z.string(), prompt: z.number().finite().nonnegative(),
    completion: z.number().finite().nonnegative(), cacheRead: z.number().finite().nonnegative().optional(),
    cacheWrite: z.number().finite().nonnegative().optional() })),
});

let overridePrices: PriceEntry[] = [];
let openRouterPrices: OpenRouterPrice[] = [];
let loadPromise: Promise<void> | null = null;
let revision = 0;
export const pricingRevision = () => `${revision}:${preferencesRevision()}`;

async function loadOverrides(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    overridePrices = PriceFileSchema.parse(JSON.parse(await readFile(PRICE_FILE, "utf8"))).prices;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      console.error('token-ledger: invalid pricing.json; custom estimates unavailable', error);
      return;
    }
    // Community installations start with no account-specific pricing policy.
    const empty = { version: 1, currency: 'USD', prices: [] };
    try {
      await writeFile(PRICE_FILE, `${JSON.stringify(empty, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (writeError) {
      if (!(writeError instanceof Error && 'code' in writeError && writeError.code === 'EEXIST')) throw writeError;
      overridePrices = PriceFileSchema.parse(JSON.parse(await readFile(PRICE_FILE, 'utf8'))).prices;
    }
  }
}

let refreshPromise: Promise<void> | null = null;
let nextRefresh = 0;
let nextOverrideCheck = 0;
async function loadCachedPrices(): Promise<void> {
  try {
    const cached = OpenRouterCacheSchema.parse(JSON.parse(await readFile(OPENROUTER_CACHE_FILE, "utf8")));
    openRouterPrices = cached.prices;
    nextRefresh = Math.min(Date.parse(cached.fetchedAt), Date.now()) + OPENROUTER_MAX_AGE_MS;
  } catch {}
}
function refreshPrices(): void {
  if (!getPreferences().openRouterPricing || refreshPromise || Date.now() < nextRefresh) return;
  nextRefresh = Date.now() + 5 * 60 * 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  refreshPromise = (async () => {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id?: string; pricing?: Record<string, string> }> };
    const prices = (body.data ?? []).flatMap((item): OpenRouterPrice[] => {
      const prompt = Number(item.pricing?.prompt);
      const completion = Number(item.pricing?.completion);
      if (!item.id || !Number.isFinite(prompt) || prompt < 0 || !Number.isFinite(completion) || completion < 0) return [];
      const readPrice = item.pricing?.input_cache_read;
      const rawCache = typeof readPrice === 'string' && readPrice.trim() !== '' ? Number(readPrice) : NaN;
      const writePrice = item.pricing?.input_cache_write;
      const rawWrite = typeof writePrice === 'string' && writePrice.trim() !== '' ? Number(writePrice) : NaN;
      return [{
        id: item.id,
        prompt: prompt * 1_000_000,
        completion: completion * 1_000_000,
        ...(Number.isFinite(rawCache) && rawCache >= 0 ? { cacheRead: rawCache * 1_000_000 } : {}),
        ...(Number.isFinite(rawWrite) && rawWrite >= 0 ? { cacheWrite: rawWrite * 1_000_000 } : {}),
      }];
    });
    if (!prices.length) throw new Error('Empty pricing response');
    const cached = OpenRouterCacheSchema.parse({ fetchedAt: new Date().toISOString(), prices });
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(OPENROUTER_CACHE_FILE, `${JSON.stringify(cached)}\n`, "utf8");
    openRouterPrices = prices;
    revision++;
    nextRefresh = Date.now() + OPENROUTER_MAX_AGE_MS;
  })().catch((error) => {
    console.error("token-ledger: OpenRouter pricing refresh failed; using cached prices", error);
  }).finally(() => { clearTimeout(timeout); refreshPromise = null; });
}

/** Local pricing is available immediately; remote freshness never blocks RPC. */
export async function ensurePricing(): Promise<void> {
  loadPromise ??= Promise.all([loadOverrides(), loadCachedPrices()]).then(() => {
    revision++; nextOverrideCheck = Date.now() + 30000;
  }).catch((error) => { loadPromise = null; throw error; });
  await loadPromise;
  if (Date.now() >= nextOverrideCheck) {
    nextOverrideCheck = Date.now() + 30000;
    try {
      const prices = PriceFileSchema.parse(JSON.parse(await readFile(PRICE_FILE, 'utf8'))).prices;
      if (JSON.stringify(prices) !== JSON.stringify(overridePrices)) { overridePrices = prices; revision++; }
    } catch (error) { console.error('token-ledger: retaining last valid pricing overrides', error); }
  }
  refreshPrices();
}

function lookupOpenRouter(model: string): ModelPricing | null {
  const canonical = canonicalModel(model);
  const matches = openRouterPrices.filter((price) => canonicalModel(price.id) === canonical);
  if (matches.length !== 1) return null;
  const price = matches[0];
  return { input: price.prompt, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite, output: price.completion };
}

/** Detect the old lossy matching rule only to warn; never select a price with it. */
function legacyPriceKey(value: string): string {
  let model = value.trim().toLowerCase();
  if (model.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(model);
      if (Array.isArray(parsed) && typeof parsed.at(-1) === 'string') model = parsed.at(-1);
    } catch {}
  }
  return (model.split('/').at(-1) ?? model).replace(/\[1m\]$/, '').replace(/[._]/g, '-').replace(/-+/g, '-');
}


function resolvePricing(provider: string | null, model: string | null, prompt: number | null): { pricing: ModelPricing; source: Exclude<CostSource, "reported"> } | { warning: string } | null {
  if (!model) return null;
  const canonical = canonicalModel(model);
  const matches = overridePrices.filter((entry) =>
    [entry.model, ...(entry.aliases ?? [])].some((id) => canonicalModel(id) === canonical) && providerMatches(entry, provider));
  const scoped = matches.filter((entry) => entry.providers?.length);
  const candidates = scoped.length ? scoped : matches;
  if (candidates.length > 1) return { warning: `Multiple custom prices match ${model}. Keep one matching entry in pricing.json; reference-price fallback is blocked.` };
  if (candidates.length === 1) {
    const pricing = chooseTier(candidates[0], prompt);
    return pricing ? { pricing, source: 'override' } : null;
  }
  const legacyKey = legacyPriceKey(model);
  const formerScope = `${provider ?? ''} ${model}`.toLowerCase();
  const legacyMatch = overridePrices.some((entry) =>
    (!entry.providers?.length || entry.providers.some((scope) => formerScope.includes(scope.toLowerCase())))
    && [entry.model, ...(entry.aliases ?? [])].some((id) => legacyPriceKey(id) === legacyKey));
  if (legacyMatch) return { warning: `Review custom pricing for ${model}: add its full ID to model/aliases and check providers in pricing.json. The old name/provider folding is unsafe; reference-price fallback is blocked.` };
  const openrouter = getPreferences().openRouterPricing ? lookupOpenRouter(model) : null;
  if (openrouter) return { pricing: openrouter, source: "openrouter" };
  const builtin = getPreferences().builtinPricing ? modelPricing(model) : null;
  return builtin ? { pricing: builtin, source: "builtin" } : null;
}

type PriceableUsage = Pick<TurnRecord, "provider" | "model" | "input" | "cached" | "cacheWrite" | "output"> & {
  requests?: TurnRecord['requests'];
  tokenScope?: TurnRecord['tokenScope'];
};

/** Reference estimates only for usage with a verified per-turn accounting scope. */
export function estimateUsageCost(usage: PriceableUsage): {
  effectiveCostUsd: number | null;
  costSource: Exclude<CostSource, 'reported'> | null;
  costBreakdown: CostBreakdown | null;
  partialCost: boolean;
  pricingWarning: string | null;
} {
  const unavailable = { effectiveCostUsd: null, costSource: null, costBreakdown: null, partialCost: true, pricingWarning: null };
  if (tokenScope(usage) !== 'turn' || !usageSemantics(usage.provider)) return unavailable;
  const semantics = usageSemantics(usage.provider);
  const requests = usage.requests?.length ? usage.requests : [usage];
  let breakdown: CostBreakdown | null = null;
  let source: Exclude<CostSource, 'reported'> | null = null;
  let incomplete = false;
  let pricingWarning: string | null = null;
  for (const request of requests) {
    const resolved = resolvePricing(usage.provider, usage.model, promptTokens(usage.provider, request));
    if (!resolved) { incomplete = true; continue; }
    if ('warning' in resolved) { pricingWarning ??= resolved.warning; incomplete = true; continue; }
    const input = freshInput(semantics, request.input, request.cached, request.cacheWrite);
    const part = costBreakdownWithPricing({ ...request, input, costUsd: null }, resolved.pricing);
    if (!part) { incomplete = true; continue; }
    source = resolved.source;
    incomplete ||= partialCost(part);
    if (!breakdown) breakdown = { ...part };
    else {
      for (const field of ['inUsd', 'cacheUsd', 'cacheWriteUsd', 'outUsd'] as const) {
        const value = part[field];
        if (value != null) breakdown[field] = (breakdown[field] ?? 0) + value;
      }
    }
  }
  return { effectiveCostUsd: knownCost(breakdown), costSource: source, costBreakdown: breakdown, partialCost: incomplete || !breakdown, pricingWarning };
}

export function enrichTurn(record: TurnRecord, seq: number): TurnRow {
  const scope = tokenScope(record);
  const input = freshInput(usageSemantics(record.provider), record.input, record.cached, record.cacheWrite);
  const estimated = estimateUsageCost(record);
  const runtime = scope === 'turn' ? record.costUsd : null;
  // Runtimes can report list-price fallbacks for unbilled local models; the raw value stays on disk.
  const reported = getPreferences().preferEstimates && estimated.effectiveCostUsd !== null ? null : runtime;
  const breakdown = estimated.costBreakdown && reported !== null
    ? { ...estimated.costBreakdown, otherUsd: reported - estimated.effectiveCostUsd! }
    : estimated.costBreakdown;
  return {
    ...record, input, seq, tokenScope: scope,
    // Historical session/unknown rows counted snapshots, not model calls.
    modelCalls: scope === 'turn' ? record.modelCalls : null,
    promptTokens: promptTokens(record.provider, record),
    incompleteUsage: scope !== 'turn' || record.quality !== 'exact' || !!record.usageGap
      || input === null || record.cached === null || record.cacheWrite == null || record.output === null,
    partialCost: reported === null && (estimated.partialCost || record.quality !== 'exact' || !!record.usageGap),
    pricingWarning: estimated.pricingWarning,
    costUsd: reported,
    effectiveCostUsd: reported ?? estimated.effectiveCostUsd,
    costSource: reported !== null ? 'reported' : estimated.costSource,
    costBreakdown: breakdown,
  };
}

export function pricingFilePath(): string {
  return PRICE_FILE;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginServerContext, PluginSettingsState } from '@getpaseo/plugin/server';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PREFERENCES, preferences } from '../shared/preferences.ts';
import { initializePreferences, getPreferences } from './preferences.ts';

test('settings changes win over a stale read, update pricing immediately, and preserve reported/custom costs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-settings-'));
  const oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const dir = join(home, 'plugins/token-ledger');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pricing.json'), JSON.stringify({ version: 1, currency: 'USD', prices: [{ model: 'custom', tiers: [{ input: 9, cacheRead: 1, output: 20 }] }] }));
  await writeFile(join(dir, 'openrouter-pricing.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), prices: [{ id: 'remote', prompt: 1, completion: 2, cacheRead: 0.1 }] }));
  type State = PluginSettingsState<typeof preferences.schema>;
  let notify!: (state: State) => void;
  let resolveRead!: (state: State) => void;
  const settings = initializePreferences({ registerSettings: () => ({
    read: () => new Promise<State>((resolve) => { resolveRead = resolve; }),
    subscribe: (listener: typeof notify) => { notify = listener; return () => {}; },
  }) } as unknown as PluginServerContext);
  const pricing = await import('./pricing.ts');
  const { TimelinePublisher } = await import('./timeline.ts');
  try {
    notify({ status: 'ready', revision: 'new', values: { ...DEFAULT_PREFERENCES, timelineSummaries: false, openRouterPricing: false, builtinPricing: false, customPricesOverride: true } });
    resolveRead({ status: 'ready', revision: 'old', values: DEFAULT_PREFERENCES });
    await settings.ready;
    assert.equal(getPreferences().openRouterPricing, false);
    await pricing.ensurePricing();
    const usage = { provider: 'claude', model: 'claude-opus-5.5', input: 1_000_000, cached: 0, output: 0 };
    assert.equal(pricing.estimateUsageCost(usage).effectiveCostUsd, null);
    assert.equal(pricing.estimateUsageCost({ ...usage, model: 'remote' }).effectiveCostUsd, null);
    assert.equal(pricing.estimateUsageCost({ ...usage, model: 'custom' }).effectiveCostUsd, 9);
    const { finalizeTurn } = await import('../shared/aggregate.ts');
    const record = finalizeTurn({ agentId: 'a', turnId: 't', provider: 'claude', model: 'claude-opus-5.5', startedAt: null, endedAt: new Date().toISOString(), status: 'completed', observations: [], finalUsage: { inputTokens: 1_000_000, totalCostUsd: 2 }, prevSessionCostUsd: 0 });
    // Without a custom price the reported cost stays.
    assert.equal(pricing.enrichTurn(record, 1).effectiveCostUsd, 2);
    const local = pricing.enrichTurn({ ...record, model: 'custom' }, 1);
    assert.equal(local.effectiveCostUsd, 9);
    assert.equal(local.costSource, 'override');
    assert.equal(local.costUsd, null);
    assert.equal(local.costBreakdown?.otherUsd, null);
    const publisher = new TimelinePublisher();
    publisher.publish({} as never, record); // Disabled summaries must never call the timeline API.
    await publisher.flush();
    const previous = pricing.pricingRevision();
    notify({ status: 'ready', revision: 'enabled', values: DEFAULT_PREFERENCES });
    assert.notEqual(pricing.pricingRevision(), previous);
    assert.equal(pricing.estimateUsageCost(usage).effectiveCostUsd, 4);
    assert.equal(pricing.estimateUsageCost({ ...usage, model: 'remote' }).effectiveCostUsd, 1);
    assert.equal(pricing.enrichTurn({ ...record, model: 'custom' }, 1).effectiveCostUsd, 2, 'reported costs win by default');
    notify({ status: 'ready', revision: 'override', values: { ...DEFAULT_PREFERENCES, customPricesOverride: true } });
    const builtin = pricing.enrichTurn(record, 1);
    assert.equal(builtin.effectiveCostUsd, 2, 'reference prices never replace reported costs');
    assert.equal(builtin.costSource, 'reported');
    assert.equal(pricing.enrichTurn({ ...record, model: 'custom' }, 1).effectiveCostUsd, 9);
  } finally {
    await settings.dispose();
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('custom providers that extend a known harness follow its usage semantics', async () => {
  const { setProviderBases, providerBasesRevision } = await import('../shared/semantics.ts');
  const { finalizeTurn } = await import('../shared/aggregate.ts');
  const pricing = await import('./pricing.ts');
  const turn = () => finalizeTurn({ agentId: 'a', turnId: 't', provider: 'local-claude', model: 'acme/local-1', startedAt: null, endedAt: new Date().toISOString(), status: 'completed', observations: [], finalUsage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalCostUsd: 2 }, prevSessionCostUsd: 0 });
  try {
    const unresolved = turn();
    assert.equal(unresolved.tokenScope, 'unknown');
    assert.equal(unresolved.harness, undefined);
    const previous = pricing.pricingRevision();
    setProviderBases({ 'local-claude': 'claude' });
    assert.notEqual(pricing.pricingRevision(), previous);
    const resolved = turn();
    assert.equal(resolved.tokenScope, 'turn');
    assert.equal(resolved.harness, 'claude');
    assert.equal(resolved.costUsd, 2);
    const revision = providerBasesRevision();
    setProviderBases({ 'local-claude': 'claude' });
    assert.equal(providerBasesRevision(), revision, 'an unchanged config keeps cached rows');
    // The recorded harness keeps semantics when the config later changes.
    setProviderBases({});
    assert.equal(pricing.enrichTurn(resolved, 1).effectiveCostUsd, 2);
  } finally {
    setProviderBases({});
  }
});

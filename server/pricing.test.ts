import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeTurn } from '../shared/aggregate.ts';

test('pricing preserves model identity, provider scopes, explicit aliases and unknown tiers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-identities-'));
  const oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const dir = join(home, 'plugins', 'token-ledger');
  await mkdir(dir, { recursive: true });
  const prices = [
    { model: 'vendor-a/model-x', aliases: ['shared-alias'], tiers: [{ input: 1, cacheRead: 0, output: 0 }] },
    { model: 'vendor-b/model-x', aliases: ['shared-alias', 'explicit-alias'], tiers: [{ input: 10, cacheRead: 0, output: 0 }] },
    { model: 'acme/model-x', providers: ['acme'], tiers: [{ input: 99, cacheRead: 0, output: 0 }] },
    { model: 'tiered', tiers: [{ upToInputTokens: 100, input: 1, cacheRead: 0, output: 0 }, { input: 10, cacheRead: 0, output: 0 }] },
    { model: 'claude-opus-5.5', tiers: [{ input: 100, cacheRead: 0, cacheWrite: 0, output: 0 }] },
    { model: 'gateway/claude-sonnet-4-6', tiers: [{ input: 50, cacheRead: 0, cacheWrite: 0, output: 0 }] },
    { model: 'claude-haiku-4-5[1m]', tiers: [{ input: 20, cacheRead: 0, cacheWrite: 0, output: 0 }] },
  ];
  await writeFile(join(dir, 'pricing.json'), JSON.stringify({ version: 1, currency: 'USD', prices }));
  await writeFile(join(dir, 'openrouter-pricing.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), prices: [] }));
  const originalNow = Date.now;
  try {
    // Module-load boundary: pricing captures PASEO_HOME; static import would target the real ledger.
    const { ensurePricing, estimateUsageCost, enrichTurn } = await import('./pricing.ts');
    const { summaryFromRows } = await import('./read-model.ts');
    await ensurePricing();
    const usage = { provider: 'claude', model: 'vendor-b/model-x', input: 1_000_000, cached: 0, cacheWrite: 0, output: 0 };
    assert.equal(estimateUsageCost(usage).effectiveCostUsd, 10);
    assert.equal(estimateUsageCost({ ...usage, model: 'vendor-a/model-x' }).effectiveCostUsd, 1);
    assert.equal(estimateUsageCost({ ...usage, model: 'explicit-alias' }).effectiveCostUsd, 10);
    assert.equal(estimateUsageCost({ ...usage, model: 'shared-alias' }).effectiveCostUsd, null);
    assert.equal(estimateUsageCost({ ...usage, model: 'acme/model-x' }).effectiveCostUsd, null);
    assert.equal(estimateUsageCost({ ...usage, provider: 'claude-acme', model: 'acme/model-x' }).effectiveCostUsd, 99);
    assert.equal(estimateUsageCost({ ...usage, model: 'tiered', input: 80, cacheWrite: undefined }).effectiveCostUsd, null);
    assert.equal(estimateUsageCost({ ...usage, model: 'tiered', input: 80 }).effectiveCostUsd, 0.00008);
    assert.equal(estimateUsageCost({ ...usage, provider: 'omp' }).effectiveCostUsd, null);
    assert.equal(estimateUsageCost({ ...usage, provider: 'unknown' }).effectiveCostUsd, null);
    const dotted = estimateUsageCost({ ...usage, model: 'claude-opus-5.5' });
    const dashed = estimateUsageCost({ ...usage, model: 'claude-opus-5-5' });
    assert.equal(dotted.effectiveCostUsd, 100);
    assert.equal(dashed.effectiveCostUsd, 100);
    assert.equal(dashed.costSource, 'override');
    assert.equal(dashed.pricingWarning, null);
    for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'shared-alias', 'acme/model-x']) {
      const result = estimateUsageCost({ ...usage, model });
      assert.equal(result.effectiveCostUsd, null);
      assert.equal(result.costSource, null);
      assert.ok(result.pricingWarning != null);
    }
    assert.equal(estimateUsageCost({ ...usage, model: 'claude-opus-4' }).effectiveCostUsd, 15);
    const record = finalizeTurn({ agentId: 'a', turnId: 't', provider: 'claude', model: 'claude-sonnet-4-6',
      startedAt: null, endedAt: '2026-10-14T00:00:00Z', status: 'completed', observations: [], prevSessionCostUsd: 0,
      finalUsage: { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 } });
    const blocked = enrichTurn(record, 1);
    assert.equal(summaryFromRows([blocked]).pricingWarningTurns, 1);
    // Reported costs remain visible even when reference breakdown pricing needs review.
    const reported = enrichTurn({ ...record, costUsd: 7 }, 1);
    assert.equal(reported.effectiveCostUsd, 7);
    assert.ok(reported.pricingWarning != null);
    const repaired = prices.map((entry) => entry.model === 'gateway/claude-sonnet-4-6'
      ? { ...entry, aliases: ['claude-sonnet-4-6'] } : entry);
    await writeFile(join(dir, 'pricing.json'), JSON.stringify({ version: 1, currency: 'USD', prices: repaired }));
    Date.now = () => originalNow() + 31_000;
    await ensurePricing();
    const fixed = enrichTurn(record, 1);
    assert.equal(fixed.effectiveCostUsd, 50);
    assert.equal(fixed.pricingWarning, null);
    assert.equal(summaryFromRows([fixed]).pricingWarningTurns, 0);
  } finally {
    Date.now = originalNow;
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

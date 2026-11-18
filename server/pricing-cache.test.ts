import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeTurn } from '../shared/aggregate.ts';

test('pricing serves local rates during network refresh, prices each request, and refreshes again after expiry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-ledger-pricing-'));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const dir = join(home, 'plugins', 'token-ledger');
  await mkdir(dir, { recursive: true });
  const prices = { version: 1, currency: 'USD', prices: [{ model: 'test', tiers: [
    { upToInputTokens: 100, input: 1, cacheRead: 0.1, cacheWrite: 2, output: 2 },
    { input: 10, cacheRead: 1, cacheWrite: 20, output: 20 },
  ] }] };
  await writeFile(join(dir, 'pricing.json'), JSON.stringify(prices));
  let resolveFetch!: (value: Response) => void;
  let calls = 0;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  globalThis.fetch = () => { calls++; return new Promise((resolve) => { resolveFetch = resolve; }); };
  const pricing = await import('./pricing.ts');
  try {
    await pricing.ensurePricing(); // Must finish while fetch remains pending.
    assert.equal(calls, 1);
    const record = finalizeTurn({ agentId: 'a', turnId: 't', provider: 'codex', model: 'test',
      startedAt: null, endedAt: new Date().toISOString(), status: 'completed', finalUsage: null, prevSessionCostUsd: null,
      observations: [{ input: 80, cached: 0, output: 0, cost: null }, { input: 90, cached: 0, output: 0, cost: null }],
    });
    assert.equal(pricing.enrichTurn(record, 1).effectiveCostUsd, 0.00017);
    assert.equal(pricing.enrichTurn({ ...record, requests: undefined }, 1).effectiveCostUsd, 0.0017);
    assert.equal(pricing.estimateUsageCost(record).effectiveCostUsd, 0.00017);
    const request = { input: 100, cached: 60, cacheWrite: 30, output: 0 };
    const writing = { ...record, ...request, requests: [request] };
    const row = pricing.enrichTurn(writing, 1);
    assert.equal(row.input, 10);
    assert.equal(row.cacheWrite, 30);
    assert.equal(row.costBreakdown?.cacheWriteUsd, 0.00006);
    assert.ok(Math.abs(row.effectiveCostUsd! - 0.000076) < 1e-12);
    const large = { ...request, input: 101 };
    assert.ok(Math.abs(pricing.estimateUsageCost({ ...writing, requests: [large] }).effectiveCostUsd! - 0.00077) < 1e-12);
    assert.ok(Math.abs(pricing.estimateUsageCost({ ...writing, requests: [request, request] }).effectiveCostUsd! - 0.000152) < 1e-12);
    assert.equal(pricing.enrichTurn({ ...writing, costUsd: 0.5 }, 1).effectiveCostUsd, 0.5);
    assert.equal(pricing.enrichTurn({ ...writing, costUsd: 0.5 }, 1).costBreakdown?.otherUsd, 0.5 - row.effectiveCostUsd!);
    assert.equal(pricing.PriceFileSchema.safeParse({ ...prices, prices: [{ model: 'bad', tiers: [] }] }).success, false);
    assert.equal(pricing.PriceFileSchema.safeParse({ ...prices, prices: [{ model: 'bad', tiers: [{ input: 1, cacheRead: 0, cacheWrite: -1, output: 2 }] }] }).success, false);
    const before = pricing.pricingRevision();
    resolveFetch(new Response(JSON.stringify({ data: [{ id: 'remote', pricing: { prompt: '0.001', completion: '0.002', input_cache_read: '0.0001', input_cache_write: '0.003' } }] })));
    for (let i = 0; pricing.pricingRevision() === before && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
    assert.notEqual(pricing.pricingRevision(), before);
    const remote = pricing.estimateUsageCost({ provider: 'codex', model: 'remote', ...request });
    assert.ok(Math.abs(remote.effectiveCostUsd! - 0.106) < 1e-12);
    assert.equal(remote.costBreakdown?.cacheWriteUsd, 0.09);
    Date.now = () => originalNow() + 25 * 60 * 60 * 1000;
    await pricing.ensurePricing(); assert.equal(calls, 2);
    const refreshed = pricing.pricingRevision();
    resolveFetch(new Response(JSON.stringify({ data: [{ id: 'remote', pricing: { prompt: '0.002', completion: '0.003' } }] })));
    for (let i = 0; pricing.pricingRevision() === refreshed && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
    assert.notEqual(pricing.pricingRevision(), refreshed);
    // Matches are cached per model, but a new price list replaces them.
    const repriced = pricing.estimateUsageCost({ provider: 'codex', model: 'remote', ...request });
    assert.ok(Math.abs(repriced.effectiveCostUsd! - 0.02) < 1e-12);
    assert.equal(repriced.partialCost, true);
  } finally {
    globalThis.fetch = originalFetch; Date.now = originalNow;
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

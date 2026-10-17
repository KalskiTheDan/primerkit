import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig, writeConfig } from '@primerkit/core';
import { readableBy, fetchCatalog, type Tier } from '@primerkit/connector-prereason';
import { keepTier, tierOfKey } from '../src/tier';

// Keys are built here, never written out, and are not real keys.
const fakeKey = (tag: string) => `pr_test_${tag.repeat(20)}`;
const CATALOG = [
  { id: 'btc.context', name: 'BTC Context', description: 'free', tier: 'free' },
  { id: 'commodities.gold', name: 'Gold', description: 'basic', tier: 'basic' },
  { id: 'bonds.full', name: 'Bonds', description: 'pro', tier: 'pro' },
];

// A PreReason that names the plan on a catalog read made with a key, as its rate limiter does.
function prereason(plan: Tier | null) {
  const seen: Array<{ path: string; auth: string | undefined }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ path: new URL(String(input)).pathname, auth: headers.Authorization });
    return new Response(JSON.stringify({ briefings: CATALOG }), { status: 200, headers: headers.Authorization && plan ? { 'x-prereason-tier': plan } : {} });
  }) as typeof fetch;
  return { seen, impl };
}

const homes: string[] = [];
const scratchHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'primerkit-tier-'));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("the key's tier", () => {
  it("learns a key's tier from one keyed read of the catalog, keeps it, and asks no more", async () => {
    const home = scratchHome();
    const net = prereason('pro');
    expect(await tierOfKey(home, fakeKey('a'), '0.1.0', { fetch: net.impl })).toBe('pro');
    expect(net.seen).toEqual([{ path: '/api/context/briefings', auth: `Bearer ${fakeKey('a')}` }]);
    expect(readConfig(home).prereason?.tier).toBe('pro');
    expect(await tierOfKey(home, fakeKey('a'), '0.1.0', { fetch: net.impl })).toBe('pro');
    expect(net.seen).toHaveLength(1);
    // So the briefings a pro key reads are offered, not the free ones alone.
    const entries = await fetchCatalog('0.1.0', { fetch: net.impl });
    expect(readableBy(entries, (await tierOfKey(home, fakeKey('a'), '0.1.0', { fetch: net.impl })) ?? 'free').map((b) => b.id)).toEqual(['btc.context', 'commodities.gold', 'bonds.full']);
  });

  it('with no key asks nothing and keeps nothing; a plan PreReason does not name is not guessed', async () => {
    const home = scratchHome();
    const net = prereason('pro');
    expect(await tierOfKey(home, null, '0.1.0', { fetch: net.impl })).toBeNull();
    expect(net.seen).toHaveLength(0);
    const silent = prereason(null);
    expect(await tierOfKey(home, fakeKey('b'), '0.1.0', { fetch: silent.impl })).toBeNull();
    expect(readConfig(home).prereason?.tier).toBeUndefined();
  });

  it('never fails a command over a catalog that cannot be read', async () => {
    const home = scratchHome();
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    expect(await tierOfKey(home, fakeKey('c'), '0.1.0', { fetch: down })).toBeNull();
  });

  it("keeps a new key's tier in place of the old one, and leaves the rest of the config as it was", () => {
    const home = scratchHome();
    writeConfig(home, { watchlist: ['btc.context'], prereason: { tier: 'free', checked_at: '2026-10-01T00:00:00.000Z' } });
    keepTier(home, 'basic');
    const config = readConfig(home);
    expect(config.prereason?.tier).toBe('basic');
    expect(config.watchlist).toEqual(['btc.context']);
  });
});

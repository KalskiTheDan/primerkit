import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, Snapshots, loadOperation, primerkitHome, readConfig, writeConfig, type BenchFile } from '@primerkit/core';
import { FixtureConnector, PreReasonClient, fetchCatalog, fetchMetricCatalog, parseCatalog, readableBy, resolveKey, type CatalogEntry, type MetricEntry, type Tier } from '@primerkit/connector-prereason';
import { ASK_DIR, DEMO_BRIEFINGS, DEMO_CATALOG, DEMO_DATE, DIGEST_DIR, ROOT, ROUTINE_DIR, defaultWatchlist, fitnessInputs } from '@primerkit/session';
import type { HostDeps } from './runs';

export const BENCH_FIXTURES = '2026-09-25';

// The server's reach outside itself. The key is looked up on each call, so connecting
// PreReason in a terminal works without restarting the AI app. The demo reads the saved
// briefings and catalog, uses no key, and keeps nothing past the server's life.
export function hostDeps({ version, demo = false, env = process.env }: { version: string; demo?: boolean; env?: Record<string, string | undefined> }): HostDeps {
  const ask = loadOperation(ASK_DIR);
  const home = demo ? mkdtempSync(join(tmpdir(), 'primerkit-demo-')) : primerkitHome(env);
  let client: { key: string; data: PreReasonClient } | null = null;
  let catalog: { at: number; entries: CatalogEntry[] } | null = null;
  const keptTier = (): Tier | null => (readConfig(home).prereason?.tier as Tier | undefined) ?? null;
  // A key whose tier is not known yet reads the catalog with the key once: PreReason names the
  // plan, and the config keeps it, so its paid briefings are offered from the first question.
  const loadCatalog = async (): Promise<CatalogEntry[]> => {
    if (demo) return parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8')));
    if (catalog && Date.now() - catalog.at < 10 * 60_000) return catalog.entries;
    const key = client?.data.tier || keptTier() ? null : (resolveKey(env)?.key ?? null);
    const onTier = (named: Tier) => {
      const config = readConfig(home);
      if (config.prereason?.tier !== named) writeConfig(home, { ...config, prereason: { ...config.prereason, tier: named, checked_at: new Date().toISOString() } });
    };
    catalog = { at: Date.now(), entries: await fetchCatalog(version, { key, onTier }) };
    return catalog.entries;
  };
  // The keyless metric list, read again after ten minutes as the catalog is.
  let metricList: { at: number; entries: MetricEntry[] } | null = null;
  const loadMetrics = async (): Promise<MetricEntry[]> => {
    if (metricList && Date.now() - metricList.at < 10 * 60_000) return metricList.entries;
    metricList = { at: Date.now(), entries: await fetchMetricCatalog(version) };
    return metricList.entries;
  };
  const tier = (): Tier | null => (demo ? 'free' : (client?.data.tier ?? keptTier()));
  const bench = JSON.parse(readFileSync(join(ROOT, 'operations', 'bench-comprehension', `questions-${BENCH_FIXTURES}.json`), 'utf8')) as BenchFile;
  return {
    ask,
    digest: loadOperation(DIGEST_DIR),
    data: () => {
      if (demo) return new FixtureConnector(DEMO_BRIEFINGS);
      const key = resolveKey(env);
      if (!key) return null;
      if (client?.key !== key.key) client = { key: key.key, data: new PreReasonClient({ key: key.key, version }) };
      return client.data;
    },
    catalog: loadCatalog,
    ...(demo ? {} : { metrics: loadMetrics }),
    tier,
    watchlist: async () => {
      const kept = demo ? undefined : readConfig(home).watchlist;
      return kept?.length ? kept : defaultWatchlist(readableBy(await loadCatalog(), tier() ?? 'free'));
    },
    snapshots: new Snapshots(join(home, 'snapshots')),
    journal: demo ? null : new Journal(join(home, 'journal')),
    home,
    bench: { file: bench, data: fitnessInputs(ROOT, ask).benchData, fixtures: BENCH_FIXTURES },
    routine: demo ? null : loadOperation(ROUTINE_DIR),
    ...(demo ? { savedOn: DEMO_DATE } : {}),
  };
}

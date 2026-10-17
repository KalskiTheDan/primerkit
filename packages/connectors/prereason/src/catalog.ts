import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_BASE, PreReasonError, requestHeaders, tierOf, type Tier } from './client';
import { COMPANY_FAMILY } from '@primerkit/core';
import { METRIC_ID } from './ids';

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  tier: Tier;
  metrics?: number; // how many metrics it serves, as the catalog counts them
  derivatives?: true; // PreReason's mark: it serves a series that measures a futures, swap or options market
}

const RANK: Record<Tier, number> = { free: 0, basic: 1, pro: 2, enterprise: 3 };

// The roster, read at run time from the keyless catalog, which lists only live
// briefings. It is never hardcoded, any equities id is refused, and it is cut to what
// the key's tier may read.
export function readableBy(entries: CatalogEntry[], tier: Tier): CatalogEntry[] {
  return entries.filter((b) => (!b.id.startsWith('equities.') || b.id === COMPANY_FAMILY) && RANK[b.tier] !== undefined && RANK[b.tier] <= RANK[tier]);
}

export function parseCatalog(body: unknown): CatalogEntry[] {
  const list = (body as { briefings?: unknown[] } | null)?.briefings;
  if (!Array.isArray(list)) return [];
  return list
    .map((b) => b as Partial<CatalogEntry> & { metrics_count?: unknown; derivatives?: unknown })
    .filter((b): b is CatalogEntry & { metrics_count?: unknown; derivatives?: unknown } => typeof b.id === 'string' && typeof b.tier === 'string' && b.tier in RANK)
    .map((b) => ({
      id: b.id,
      name: String(b.name ?? b.id),
      description: String(b.description ?? ''),
      tier: b.tier,
      ...(typeof b.metrics_count === 'number' ? { metrics: b.metrics_count } : {}),
      ...(b.derivatives === true ? { derivatives: true as const } : {}),
    }))
    // Of the equities briefings, the company family is read (with a company in its id).
    .filter((b) => !b.id.startsWith('equities.') || b.id === COMPANY_FAMILY);
}

// The free briefing with the fewest metrics: the least a call can read to learn the
// key's tier, which the response names.
export function smallestFree(entries: CatalogEntry[]): CatalogEntry | null {
  return readableBy(entries, 'free').sort((a, b) => (a.metrics ?? 99) - (b.metrics ?? 99))[0] ?? null;
}

// The catalog needs no key. Read with one, it is the one call that learns the key's tier
// (see learnTier): PreReason names the plan on any call made with a key.
export async function fetchCatalog(
  version: string,
  options: { base?: string; fetch?: typeof fetch; key?: string | null; onTier?: (tier: Tier) => void } = {},
): Promise<CatalogEntry[]> {
  const res = await (options.fetch ?? fetch)(new URL('/api/context/briefings', options.base ?? DEFAULT_BASE).toString(), {
    headers: requestHeaders(version, options.key ?? null),
  });
  const tier = tierOf(res.headers);
  if (tier) options.onTier?.(tier);
  busy(res, 'its list of briefings');
  if (!res.ok) throw new Error(`the catalog answered ${res.status}`);
  return parseCatalog(await res.json());
}

// The tier a key reads at: the one kept, else as PreReason names it on one read of the
// catalog made with the key. A key found in PREREASON_API_KEY was read as free until a
// connect saved its tier, which hid every paid briefing it reads. Null with no key, or when
// PreReason names no plan; the caller keeps what this learns, so it costs one counted call
// a key.
export async function learnTier(version: string, key: string | null, kept: Tier | null, options: { base?: string; fetch?: typeof fetch } = {}): Promise<Tier | null> {
  if (kept || !key) return kept;
  let named = null as Tier | null;
  await fetchCatalog(version, { ...options, key, onTier: (tier) => { named = tier; } }).catch(() => null);
  return named;
}

// A metric PreReason serves on its own, from its keyless list: its id, its name, what it
// is, and the category PreReason files it under (bitcoin, macro, calculated). Every key
// reads each metric as it stands now; none is read for a past day.
export interface MetricEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  instrument?: Instrument; // PreReason's mark: the series measures a futures, swap or options market
  fullAt?: Tier; // the lowest tier PreReason serves it in full at, with its changes, as its list says
}

export type Instrument = 'futures' | 'swap' | 'options';
const INSTRUMENTS: readonly string[] = ['futures', 'swap', 'options'];

// What a key below a metric's tier is served: its latest reading alone, with no changes. The
// list says which metrics a free key reads in full ("A free key reads the 17 metrics in the
// bitcoin category in full, ...") and names the ones only Pro briefings use; every other
// metric is read in full at Basic. Where the list does not say both, no metric's tier is known.
const FREE_DOOR = /\bfree key reads the \d+ metrics in the ([a-z0-9-]+) category in full\b/i;

export function parseMetricCatalog(body: unknown): MetricEntry[] {
  const served = body as { metrics?: unknown[]; free_key?: unknown; pro_only_metrics?: unknown } | null;
  const list = served?.metrics;
  if (!Array.isArray(list)) return [];
  const door = typeof served?.free_key === 'string' ? (FREE_DOOR.exec(served.free_key)?.[1]?.toLowerCase() ?? null) : null;
  const proOnly = Array.isArray(served?.pro_only_metrics) ? new Set(served.pro_only_metrics.filter((id): id is string => typeof id === 'string')) : null;
  const fullAt = (id: string, category: string): Tier | null => (door === null || proOnly === null ? null : category === door ? 'free' : proOnly.has(id) ? 'pro' : 'basic');
  return list
    .map((m) => m as { name?: unknown; display_name?: unknown; description?: unknown; category?: unknown; instrument?: unknown })
    .filter((m): m is typeof m & { name: string } => typeof m.name === 'string' && METRIC_ID.test(m.name))
    .map((m) => {
      const category = String(m.category ?? 'other');
      const tier = fullAt(m.name, category);
      return {
        id: m.name,
        name: String(m.display_name ?? m.name),
        description: String(m.description ?? ''),
        category,
        ...(typeof m.instrument === 'string' && INSTRUMENTS.includes(m.instrument) ? { instrument: m.instrument as Instrument } : {}),
        ...(tier ? { fullAt: tier } : {}),
      };
    });
}

// The briefings and metrics PreReason marks as measuring a futures, swap or options market:
// a briefing with derivatives: true, and a metric with an instrument. The list is read from
// PreReason's catalogue, never typed into primerkit. Every id the two lists hold comes too, so
// an id neither lists (a draft, a retired one, a typo) is known to carry no mark to read.
export interface DerivativesMarks {
  marked: Set<string>;
  listed: Set<string>;
}

export function derivativesMarks(briefings: CatalogEntry[], metrics: MetricEntry[]): DerivativesMarks {
  return {
    marked: new Set([...briefings.filter((b) => b.derivatives).map((b) => b.id), ...metrics.filter((m) => m.instrument).map((m) => m.id)]),
    listed: new Set([...briefings.map((b) => b.id), ...metrics.map((m) => m.id)]),
  };
}

// The keyless list of metrics. It asks for JSON alone, since the route answers in markdown
// to a request that also accepts markdown.
export async function fetchMetricCatalog(version: string, options: { base?: string; fetch?: typeof fetch } = {}): Promise<MetricEntry[]> {
  const res = await (options.fetch ?? fetch)(new URL('/api/metrics', options.base ?? DEFAULT_BASE).toString(), {
    headers: { ...requestHeaders(version, null), Accept: 'application/json' },
  });
  busy(res, 'its list of metrics');
  if (!res.ok) throw new Error(`the list of metrics answered ${res.status}`);
  return parseMetricCatalog(await res.json());
}

// PreReason allows a few keyless reads a minute from one address. A 429 is PreReason asking
// to wait, with its own Retry-After, not PreReason out of reach.
function busy(res: Response, what: string): void {
  if (res.status !== 429) return;
  const after = Number(res.headers.get('retry-after'));
  throw new PreReasonError(`PreReason asked primerkit to wait: ${what} takes only a few reads a minute from one address`, 429, 'RATE_LIMITED', Number.isFinite(after) && after > 0 ? after : null);
}

// The keyless catalog and list of metrics change a few times a day, and each command read
// them again, so a quick run of commands was refused. Kept in a file for a few minutes,
// they are read once for a burst of commands. A file that cannot be read or written is
// read through, never a failure.
export async function keptFor<T>(file: string, minutes: number, load: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  try {
    const kept = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown; value?: unknown };
    if (typeof kept.at === 'number' && now() - kept.at >= 0 && now() - kept.at < minutes * 60_000 && kept.value !== undefined) return kept.value as T;
  } catch {
    // Not kept yet, or not readable: read it again.
  }
  const value = await load();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ at: now(), value }));
    renameSync(`${file}.tmp`, file);
  } catch {
    // Kept next time, perhaps.
  }
  return value;
}

// The briefings and the metrics a key reads, by area, for /catalog: briefings by the part
// of the id before its first dot, metrics by PreReason's own category.
const BRIEFING_AREAS: Record<string, string> = { btc: 'Bitcoin', eth: 'Ethereum', macro: 'macro', cross: 'cross asset', fx: 'currencies', equities: 'companies' };

export interface CatalogArea {
  area: string;
  ids: string[];
}

export function briefingsByArea(entries: CatalogEntry[]): CatalogArea[] {
  // The company family is listed as it is read: with the company in its id.
  const shown = entries.map((b) => (b.id === COMPANY_FAMILY ? { ...b, id: `${COMPANY_FAMILY}/<company>` } : b));
  return groupBy(shown, (b) => BRIEFING_AREAS[b.id.split('.')[0] ?? ''] ?? b.id.split('.')[0] ?? '');
}

// What plans above the key's read beyond it, by area, for the catalog's last line: a new user
// learns what a key would add. The company family is one entry that stands for every company
// PreReason covers, so it is named apart (companies), never counted as one briefing; no other
// equities briefing is read by primerkit. Null when nothing more is served.
export function moreByArea(all: CatalogEntry[], readable: CatalogEntry[]): { count: number; areas: string; companies: boolean } | null {
  const have = new Set(readable.map((b) => b.id));
  const above = all.filter((b) => !have.has(b.id) && RANK[b.tier] !== undefined);
  const more = above.filter((b) => !b.id.startsWith('equities.'));
  const companies = above.some((b) => b.id === COMPANY_FAMILY);
  if (!more.length && !companies) return null;
  return { count: more.length, areas: briefingsByArea(more).map((a) => `${a.area} ${a.ids.length}`).join(', '), companies };
}

// PreReason's own categories, named as the briefing areas are: proper names capitalised.
const METRIC_AREAS: Record<string, string> = { bitcoin: 'Bitcoin', eth: 'Ethereum' };

// An area's ids in a list a person reads: the first few and how many more, or every one.
// PreReason serves about 270 metrics, 184 of them macro: listed whole, they are a wall.
export const IDS_SHOWN = 8;
export function idsShown(ids: string[], all = false): string {
  if (all || ids.length <= IDS_SHOWN) return ids.join(', ');
  return `${ids.slice(0, IDS_SHOWN).join(', ')} and ${ids.length - IDS_SHOWN} more`;
}

export function metricsByArea(entries: MetricEntry[]): CatalogArea[] {
  return groupBy(entries, (m) => METRIC_AREAS[m.category] ?? m.category);
}

function groupBy<T extends { id: string }>(entries: T[], areaOf: (entry: T) => string): CatalogArea[] {
  const areas = new Map<string, string[]>();
  for (const e of entries) areas.set(areaOf(e), [...(areas.get(areaOf(e)) ?? []), e.id]);
  return [...areas].map(([area, ids]) => ({ area, ids }));
}

// What the free briefings cover today, for the connect step: "Bitcoin, macro and
// correlations", grouped by the part of the id before its first dot.
const AREAS: Record<string, string> = { btc: 'Bitcoin', macro: 'macro', cross: 'correlations', fx: 'currencies', eth: 'Ethereum' };

export function coverage(entries: CatalogEntry[]): string {
  const areas = [...new Set(entries.map((b) => AREAS[b.id.split('.')[0] ?? ''] ?? b.id.split('.')[0] ?? ''))].filter(Boolean);
  if (areas.length <= 1) return areas.join('');
  return `${areas.slice(0, -1).join(', ')} and ${areas.at(-1)}`;
}

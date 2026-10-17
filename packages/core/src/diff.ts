import type { DataBlock } from './types';

// The digest's diff: computed from the served JSON, locally and
// before any model is asked, because PreReason has no "changes since" endpoint. It reads
// each metric's signal and its trend direction, the metrics that appeared or went
// missing, and the briefing's data quality. Live labels switch only past a margin, so a
// signal change here is a move past that margin.

export type DiffKind = 'signal' | 'direction' | 'appeared' | 'missing' | 'quality';

export interface DiffItem {
  id: string; // "d1"
  briefing: string;
  metric: string | null; // the metric's key, or null for the briefing as a whole
  kind: DiffKind;
  from: string | null;
  to: string | null;
  line: number; // the line of today's JSON block that states it
}

interface ServedMetric {
  signal?: string;
  trend?: { direction?: string };
  timestamp?: string;
  value_formatted?: string;
}

interface Served {
  metrics?: Record<string, ServedMetric>;
  data_quality?: { severity?: string; health_score?: number; unavailable_metrics?: string[] };
}

// The line of a JSON block that holds a metric, or the data quality line.
function lineOf(block: DataBlock, metric: string | null): number {
  const index = block.lines.findIndex((l) => (metric ? l.startsWith(`{"metric":${JSON.stringify(metric)}`) : l.startsWith('{"data_quality"')));
  return index >= 0 ? (block.numbers?.[index] ?? index + 1) : 1;
}

export function diffBriefing(briefing: string, before: string | null, now: DataBlock): { items: Omit<DiffItem, 'id'>[]; same: string[] } {
  const after = JSON.parse(now.raw ?? '{}') as Served;
  const prior = before ? (JSON.parse(before) as Served) : null;
  const items: Omit<DiffItem, 'id'>[] = [];
  const same: string[] = [];
  if (!prior) return { items, same };
  const was = prior.metrics ?? {};
  const is = after.metrics ?? {};
  for (const [metric, m] of Object.entries(is)) {
    const p = was[metric];
    const line = lineOf(now, metric);
    if (!p) {
      items.push({ briefing, metric, kind: 'appeared', from: null, to: m.value_formatted ?? null, line });
      continue;
    }
    let moved = false;
    if (p.signal && m.signal && p.signal !== m.signal) {
      items.push({ briefing, metric, kind: 'signal', from: p.signal, to: m.signal, line });
      moved = true;
    }
    const from = p.trend?.direction;
    const to = m.trend?.direction;
    if (from && to && from !== to) {
      items.push({ briefing, metric, kind: 'direction', from, to, line });
      moved = true;
    }
    if (!moved) same.push(metric);
  }
  for (const metric of Object.keys(was)) {
    if (!is[metric]) items.push({ briefing, metric, kind: 'missing', from: was[metric]?.value_formatted ?? null, to: null, line: lineOf(now, null) });
  }
  const q0 = prior.data_quality?.severity;
  const q1 = after.data_quality?.severity;
  if (q0 && q1 && q0 !== q1) items.push({ briefing, metric: null, kind: 'quality', from: q0, to: q1, line: lineOf(now, null) });
  return { items, same };
}

// Items numbered across the whole digest, in the watchlist's order.
export function numberItems(items: Omit<DiffItem, 'id'>[]): DiffItem[] {
  return items.map((item, i) => ({ id: `d${i + 1}`, ...item }));
}

// The diff as a block the model reads: one item per line.
export function diffBlock(items: DiffItem[], fetchedAt: string): DataBlock {
  return { id: 'diff', source: 'primerkit', format: 'json', fetchedAt, lines: items.map((item) => JSON.stringify(item)) };
}

export function itemsOf(block: DataBlock | undefined): DiffItem[] {
  if (!block) return [];
  return block.lines.map((l) => JSON.parse(l) as DiffItem);
}

// "net-liquidity" as a reader says it: "Net liquidity". Short codes stay capitals.
const CAPS = new Set(['btc', 'eth', 'etf', 'tga', 'dxy', 'uup', 'spy', 'qqq', 'vxx', 'm2', 'm3', 'eu', 'us', 'boj', 'ecb', 'fx', 'gdp', 'cpi', 'eur', 'usd', 'cny', 'jpy', 'rrp', 'tic']);

// A series named by what PreReason serves under its id, where the id says otherwise: the dxy
// series is the dollar fund's share price (UUP, about $29), not the Dollar Index (near 100).
const SERVED_NAMES: Record<string, string> = { dxy: 'UUP' };

export function metricName(slug: string): string {
  const served = SERVED_NAMES[slug];
  if (served) return served;
  const words = slug.split(/[-_]/).map((w) => (CAPS.has(w) || /^\d+[a-z]$/.test(w) ? w.toUpperCase() : w));
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// One item said by code, for an item a model's sentence does not cover.
export function itemSentence(item: DiffItem): string {
  const name = item.metric ? metricName(item.metric) : item.briefing;
  switch (item.kind) {
    case 'signal':
      return `${name}'s signal moved from ${item.from} to ${item.to}.`;
    case 'direction':
      return `${name} turned ${item.to}, from ${item.from}.`;
    case 'appeared':
      return `${name} is new in ${item.briefing}.`;
    case 'missing':
      return `${name} is no longer in ${item.briefing}.`;
    case 'quality':
      return `${item.briefing}'s data quality moved from ${item.from} to ${item.to}.`;
  }
}

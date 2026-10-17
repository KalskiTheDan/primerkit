import { readFileSync } from 'node:fs';
import type { Snapshots } from '@primerkit/core';
import { readingInSentence, type SingleMetric } from '@primerkit/connector-prereason';
import { sparkline, widthOf, type Line, type Maker } from '@primerkit/ui';
import { beyond, changeMark, changeText, changeUnit, heatDepths, levelOf, noticeLines, type Board } from './boards';
import { BOARD_ROOM } from './fit';

// Markets as they stood when read: nine funds and series by their 7 day change, and SPY
// beside the speculative net position in S&P 500 futures. Each figure is a metric read on
// its own, as PreReason served it, with the source PreReason names for it. Nothing is
// ranked or computed here; a line over time comes from the readings kept on this machine.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const readWords = (readAt: string) => `read ${dayLabel(readAt)}, ${readAt.slice(11, 16)} UTC`;
const listed = (names: string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

// A served time as an ISO time in UTC, or null where it is not one.
export function isoTime(at: string | null | undefined): string | null {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// One metric as read: its answer, or why it was not read. A refusal for the key's tier is
// "on this key"; anything else keeps PreReason's own words. A key PreReason does not accept,
// or a rate limit, stops the reads, and the board is not drawn (board-load.ts).
export interface MetricRead {
  id: string;
  metric: SingleMetric | null;
  missed?: { onKey: boolean; why: string };
}

const NOT_READ = 'not read on this key';
const missedText = (r: MetricRead | undefined) => (r?.missed && !r.missed.onKey ? 'not read' : NOT_READ);

// Whether a credit fits beside the PR mark in the room. One that does not shortens to the
// mark alone, so what it says is said on the board too, where it wraps.
const creditFits = (t: Maker, credit: string, room: number) => 5 + widthOf([t('dim', credit)]) <= room;

// The day a metric's value is from, where it is older than the day it was read: a weekend,
// a holiday, a series on its own calendar. A change over it must not look current.
function staleDay(m: SingleMetric, readAt: string): string | null {
  const day = isoTime(m.timestamp)?.slice(0, 10) ?? null;
  return day && day < readAt.slice(0, 10) ? day : null;
}

// ------------------------------------------------------------------ /chart market map

export const MARKET_MAP = [
  { id: 'etf-spy', label: 'SPY' },
  { id: 'etf-qqq', label: 'QQQ' },
  { id: 'etf-iwm', label: 'IWM' },
  { id: 'etf-tlt', label: 'TLT' },
  { id: 'etf-hyg', label: 'HYG' },
  { id: 'etf-vxx', label: 'VXX' },
  { id: 'etf-uup', label: 'UUP' },
  { id: 'etf-gld', label: 'GLD' },
  { id: 'oil-wti', label: 'oil (WTI)' },
] as const;

const GAP = 3;

// A tile: the name and its 7 day change as served: up in green and down in red, by its
// sign, with the arrow beside it so the sign never rests on colour.
// Plain text keeps the + and -, since there they are the only sign. No tile is sized or
// ordered by its value.
function tile(t: Maker, label: string, read: MetricRead | undefined, readAt: string): { line: Line; stale: boolean; only: boolean } {
  const name = t('fg', `${label}  `);
  const m = read?.metric;
  if (!m) return { line: [name, t('dim', missedText(read))], stale: false, only: false };
  const day = staleDay(m, readAt);
  const date: Line = day ? [t('dim', `  ${dayLabel(day)}`)] : [];
  if (m.readingOnly) return { line: [name, t('dim', 'no 7 day change on this key'), ...date], stale: Boolean(day), only: true };
  const v = m.trend.change_7d;
  if (m.trend.change_7d_available === false || typeof v !== 'number') return { line: [name, t('dim', '7 day change not served'), ...date], stale: Boolean(day), only: false };
  // Green for a rise and red for a fall, by the change's sign.
  const mark = changeMark(v, m.trend.change_unit);
  const amount = changeText(v, m.trend.change_unit);
  const sign = mark.role === 'muted' && !mark.sign ? '' : v > 0 ? '+' : '-';
  return { line: [name, t(mark.role, `${mark.glyph} ${mark.sign}${amount}`, `${sign}${amount}`), ...date], stale: Boolean(day), only: false };
}

// The tiles in rows, three across where they fit the room, else two, else one. Each column
// is as wide as the longest words in it, so a tile's place comes from the names, never
// from a change.
function grid(t: Maker, tiles: Line[], room: number): Line[] {
  for (const across of [3, 2, 1]) {
    const widths = Array.from({ length: across }, (_, c) => Math.max(0, ...tiles.filter((_, i) => i % across === c).map(widthOf)));
    if (across > 1 && widths.reduce((s, w) => s + w, 0) + GAP * (across - 1) > room) continue;
    const rows: Line[] = [];
    for (let i = 0; i < tiles.length; i += across) {
      const row = tiles.slice(i, i + across);
      rows.push(row.flatMap((cell, c): Line => (c === row.length - 1 ? cell : [...cell, t('fg', ' '.repeat(widths[c]! - widthOf(cell) + GAP))])));
    }
    return rows;
  }
  return [];
}

// The map by asset class: equities, rates and credit, FX, commodities and energy, then crypto.
// A tile is labelled as PreReason names the series: jpy-usd is yen per US dollar, USD/JPY.
export const MARKET_GROUPS: ReadonlyArray<{ name: string; tiles: ReadonlyArray<{ id: string; label: string }> }> = [
  { name: 'equities', tiles: [{ id: 'etf-spy', label: 'SPY' }, { id: 'etf-qqq', label: 'QQQ' }, { id: 'etf-iwm', label: 'IWM' }, { id: 'etf-vxx', label: 'VXX' }] },
  { name: 'rates and credit', tiles: [{ id: 'treasury-10y', label: '10Y yield' }, { id: 'etf-tlt', label: 'TLT' }, { id: 'etf-hyg', label: 'HYG' }, { id: 'etf-lqd', label: 'LQD' }] },
  { name: 'FX', tiles: [{ id: 'etf-uup', label: 'UUP' }, { id: 'eur-usd', label: 'EUR/USD' }, { id: 'jpy-usd', label: 'USD/JPY' }] },
  { name: 'commodities and energy', tiles: [{ id: 'etf-gld', label: 'GLD' }, { id: 'etf-slv', label: 'SLV' }, { id: 'etf-cper', label: 'CPER' }, { id: 'oil-wti', label: 'oil (WTI)' }, { id: 'oil-brent', label: 'oil (Brent)' }] },
  { name: 'crypto', tiles: [{ id: 'bitcoin-price', label: 'Bitcoin' }, { id: 'ethereum-price', label: 'Ether' }] },
];
// Every metric the grouped map reads, a call each.
export const MARKET_GROUP_IDS: readonly string[] = MARKET_GROUPS.flatMap((g) => g.tiles.map((x) => x.id));

const TILE = 22;

// The markets grouped by asset class, each a tile of two rows: its name, then its level and
// its 7 day change. A tile is green for a rise and red for a fall, by its sign, deeper for a
// larger move within its group in the same unit; every tile is the same size, since the
// metrics serve no size to weigh them by. Plain text has no tiles: a row each, the sign
// carrying the direction.
export function groupedMapBoard(t: Maker, plain: boolean, reads: MetricRead[], readAt: string, room = BOARD_ROOM): Board {
  const byId = new Map(reads.map((r) => [r.id, r]));
  const across = Math.max(1, Math.floor((room + 1) / (TILE + 1)));
  const lines: Line[] = [];
  let stale = false;
  let only = false;
  for (const group of MARKET_GROUPS) {
    const cells = group.tiles.map((x) => {
      const m = byId.get(x.id)?.metric ?? null;
      const v = m?.trend.change_7d;
      const value = m && !m.readingOnly && m.trend.change_7d_available !== false && typeof v === 'number' ? v : null;
      if (m && staleDay(m, readAt)) stale = true;
      if (m?.readingOnly) only = true;
      return { x, m, value, unit: changeUnit(m?.trend.change_unit, m?.reading) };
    });
    const depths = heatDepths(
      cells.map((c) => c.value),
      cells.map((c) => c.unit),
    );
    lines.push([t('accentBold', group.name.toUpperCase())]);
    for (let i = 0; i < cells.length; i += across) {
      const row = cells.slice(i, i + across);
      const top: Line = [];
      const bottom: Line = [];
      row.forEach((c, j) => {
        const level = c.m?.reading ?? (c.m ? 'n/a' : missedText(byId.get(c.x.id)));
        const mark = c.value === null ? null : changeMark(c.value, c.unit);
        const change = c.value === null || !mark ? '' : `${mark.role === 'muted' ? '' : c.value > 0 ? '+' : '-'}${changeText(c.value, c.unit)}`;
        const tileRole = !mark || mark.role === 'muted' ? 'barText/bar' : `heatInk/heat${mark.role === 'up' ? 'Up' : 'Down'}${depths[i + j] || 1}`;
        const gap = j ? [t('fg', ' ')] : [];
        if (plain) {
          top.push(...gap, t('fg', ` ${c.x.label}`.padEnd(TILE)));
          bottom.push(...gap, t('fg', ` ${level}  ${change}`.slice(0, TILE).padEnd(TILE)));
        } else {
          top.push(...gap, t(tileRole, ` ${c.x.label}`.padEnd(TILE)));
          const body = ` ${level}`;
          const tail = change ? `${change} ` : '';
          const fill = Math.max(1, TILE - body.length - tail.length);
          bottom.push(...gap, t(tileRole, `${body}${' '.repeat(fill)}${tail}`.slice(0, TILE)));
        }
      });
      lines.push(top, bottom);
    }
    lines.push([]);
  }
  const notes: Line[] = [[t('dim', "each tile: the market's 7 day change, green for a rise and red for a fall, deeper for a larger move within its group in the same unit; equal tiles, not sized by value")]];
  if (stale) notes.push([t('dim', 'A tile whose newest value is older than the read shows its 7 day change to that day.')]);
  if (only) notes.push([t('dim', "No 7 day change on this key for some tiles: its tier is served those metrics' latest reading alone.")]);
  const sources = [...new Set(MARKET_GROUP_IDS.flatMap((id) => byId.get(id)?.metric?.source ?? []))];
  const counted = MARKET_GROUPS.reduce((n, g) => n + g.tiles.length, 0);
  const credit = `${counted} markets by asset class · equal tiles${sources.length ? ` · from ${listed(sources)}` : ''}`;
  if (sources.length && !creditFits(t, credit, room)) notes.push([t('dim', `> from ${listed(sources)}, as PreReason names each value's source`)]);
  notes.push(...noticeLines(t, MARKET_GROUP_IDS.map((id) => byId.get(id)?.metric)));
  return { title: 'Markets', subtitle: `7 day change by asset class · ${readWords(readAt)}`, lines: [...lines, ...notes], sources: credit, generated: null, readAt };
}

export function marketMapBoard(t: Maker, plain: boolean, reads: MetricRead[], readAt: string, room = BOARD_ROOM): Board {
  const byId = new Map(reads.map((r) => [r.id, r]));
  const tiles = MARKET_MAP.map((s) => tile(t, s.label, byId.get(s.id), readAt));
  const notes: Line[] = [];
  // Plain text has the signs; in colour, the arrow and its colour say which way.
  if (!plain) notes.push([t('dim', 'over 7 days  '), t('up', '▲ rose'), t('dim', ' · '), t('down', '▼ fell')]);
  if (tiles.some((x) => x.stale)) notes.push([t('dim', 'A date on a tile is the day of its newest value, older than the read, and its 7 day change runs to that day.')]);
  if (tiles.some((x) => x.only)) notes.push([t('dim', "No 7 day change on this key: its tier is served each metric's latest reading alone.")]);
  // PreReason's own words for a metric not read for another reason than the key.
  const why = new Map<string, string[]>();
  for (const s of MARKET_MAP) {
    const missed = byId.get(s.id)?.missed;
    if (missed && !missed.onKey) why.set(missed.why, [...(why.get(missed.why) ?? []), s.label]);
  }
  for (const [words, labels] of why) notes.push([t('dim', `${listed(labels)} not read: ${words.replace(/\.$/, '')}.`)]);
  // Every value names its source, as PreReason serves it for that metric.
  const sources = [...new Set(MARKET_MAP.flatMap((s) => byId.get(s.id)?.metric?.source ?? []))];
  const credit = `${MARKET_MAP.length} metrics · equal tiles, not sized by value${sources.length ? ` · from ${listed(sources)}` : ''}`;
  if (sources.length && !creditFits(t, credit, room)) notes.push([t('dim', `> from ${listed(sources)}, as PreReason names each value's source`)]);
  notes.push(...noticeLines(t, MARKET_MAP.map((s) => byId.get(s.id)?.metric)));
  // The tiles, and below them, after a blank line, whatever needs saying.
  const lines: Line[] = [...grid(t, tiles.map((x) => x.line), room), ...(notes.length ? [[], ...notes] : [])];
  return { title: 'Market map', subtitle: `7 day change · ${readWords(readAt)}`, lines, sources: credit, generated: null, readAt };
}

// ------------------------------------------------------------------ /chart positioning

// The CFTC's weekly noncommercial net position in E-mini S&P 500 futures, and where it
// ranks among the prior 26, 52 and 156 weekly reports, each rank a metric PreReason serves.
export const POSITIONING = {
  spy: 'etf-spy',
  net: 'cot-spx-noncomm-net',
  ranks: [
    { weeks: 26, id: 'cot-spx-noncomm-net-percentile-26w' },
    { weeks: 52, id: 'cot-spx-noncomm-net-percentile-52w' },
    { weeks: 156, id: 'cot-spx-noncomm-net-percentile-156w' },
  ],
} as const;

export const POSITIONING_IDS: readonly string[] = [POSITIONING.spy, POSITIONING.net, ...POSITIONING.ranks.map((r) => r.id)];

// A futures market figure, so it is marked futures wherever it is shown: the CFTC's legacy
// report counts futures alone.
const NET_LABEL = 'S&P 500 futures, noncommercial net (CFTC, weekly, futures)';

export interface Kept {
  at: string; // ISO time of the value, as served
  value: number;
}

// The readings of a metric kept on this machine, oldest first, each by the metric's own
// time: one a day for a series that moves through the day, and every distinct reading for
// a weekly one. Each chart that reads a metric on its own keeps the answer as served.
export function keptReadings(snapshots: Snapshots | null, id: string, per: 'day' | 'reading', count: number): Kept[] {
  const byKey = new Map<string, Kept>();
  for (const s of snapshots?.list(id, 'json') ?? []) {
    try {
      const body = JSON.parse(readFileSync(s.path, 'utf8')) as { timestamp?: string; context?: string; reading?: unknown };
      const at = isoTime(body.timestamp) ?? s.generatedAt;
      const value = levelOf((typeof body.reading === 'string' ? body.reading : readingInSentence(body.context ?? '')) ?? undefined);
      if (value === null) continue;
      const key = per === 'day' ? at.slice(0, 10) : at;
      const held = byKey.get(key);
      if (!held || held.at <= at) byKey.set(key, { at, value });
    } catch {
      // a snapshot that does not parse is left out
    }
  }
  return [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-count);
}

// Parts joined by " · " after a lead, on as few lines as fit the room: the whole on one,
// else the lead on its own and the parts packed under it.
function packed(t: Maker, lead: Line, parts: Line[], room: number, indent: string): Line[] {
  const join = (ps: Line[]): Line => ps.flatMap((p, i) => (i ? [t('dim', ' · '), ...p] : p));
  const whole = [...lead, t('dim', ' '), ...join(parts)];
  if (widthOf(whole) <= room) return [whole];
  const out: Line[] = [lead];
  let row: Line[] = [];
  for (const p of parts) {
    if (row.length && indent.length + widthOf(join([...row, p])) > room) {
      out.push([t('dim', indent), ...join(row)]);
      row = [];
    }
    row.push(p);
  }
  if (row.length) out.push([t('dim', indent), ...join(row)]);
  return out;
}

// A labelled line over the readings kept, with how many and over which days; the count
// goes under the line where the room is short. Fewer than two readings draw no line.
function keptLine(t: Maker, plain: boolean, label: string, kept: Kept[], unit: string, room: number): Line[] {
  const lead = `  ${label}  `;
  const plural = kept.length === 1 ? `1 ${unit} reading` : `${kept.length} ${unit} readings`;
  if (kept.length < 2) {
    const few = `${plural} kept; a line needs two`;
    return lead.length + few.length <= room ? [[t('fg', lead), t('dim', few)]] : [[t('fg', lead.trimEnd())], [t('dim', `${' '.repeat(lead.length)}${few}`)]];
  }
  // Sixteen points on the grid, and a point more for each column a wider window adds.
  const spark = sparkline(kept.map((k) => k.value), plain, 16 + beyond(room));
  const span = `${plural}, ${dayLabel(kept[0]!.at)} to ${dayLabel(kept.at(-1)!.at)}`;
  const row: Line = [t('fg', lead), t('chart', spark)];
  return widthOf(row) + 2 + span.length <= room ? [[...row, t('dim', `  ${span}`)]] : [row, [t('dim', `${' '.repeat(lead.length)}${span}`)]];
}

export function positioningBoard(t: Maker, plain: boolean, reads: MetricRead[], kept: { spy: Kept[]; net: Kept[] }, readAt: string, room = BOARD_ROOM): Board {
  const byId = new Map(reads.map((r) => [r.id, r]));
  const lines: Line[] = [];
  let stale = false;
  const dated = (m: SingleMetric): Line => {
    const day = staleDay(m, readAt);
    if (day) stale = true;
    return day ? [t('dim', ` · ${dayLabel(day)}`)] : [];
  };
  // The CFTC's figures are dated by the day it released the weekly report they come from,
  // the time PreReason serves with each. The positions in it stand as of an earlier day, so
  // the date is never read as the value's own.
  const released = (m: SingleMetric | null | undefined): string | null => {
    const day = isoTime(m?.timestamp)?.slice(0, 10);
    return day ? `released ${dayLabel(day)}` : null;
  };
  // SPY: its level and 7 day change as served, with their sign; no colour says which way.
  const spyRead = byId.get(POSITIONING.spy);
  const spy = spyRead?.metric;
  if (!spy) lines.push([t('fg', 'SPY  '), t('dim', missedText(spyRead))]);
  else {
    const c = spy.trend.change_7d;
    // A key served the latest reading alone, in the map's own words for it.
    const change: Line = spy.readingOnly
      ? [t('dim', ' · no 7 day change on this key')]
      : [t('dim', ' · 7 day '), t('bright', spy.trend.change_7d_available === false || typeof c !== 'number' ? 'not served' : `${changeMark(c, spy.trend.change_unit).role === 'muted' ? '' : c > 0 ? '+' : '-'}${changeText(c, spy.trend.change_unit)}`)];
    lines.push([t('fg', 'SPY  '), t('bright', spy.reading ?? 'n/a'), ...change, ...dated(spy)]);
  }
  // The net position, as served in contracts, marked futures, with its report's release.
  const netRead = byId.get(POSITIONING.net);
  const net = netRead?.metric;
  const netDay = released(net);
  const value: Line = net ? [t('bright', `${(net.reading ?? 'n/a').replace(/\s*contracts$/, '')} contracts`), ...(netDay ? [t('dim', ` · ${netDay}`)] : [])] : [t('dim', missedText(netRead))];
  const both: Line = [t('fg', NET_LABEL), t('dim', '  '), ...value];
  lines.push(...(widthOf(both) <= room ? [both] : [[t('fg', NET_LABEL)], [t('dim', '  '), ...value]]));
  // Each rank as PreReason serves it: where this week's net sits among the prior reports,
  // dated by its report's release, once where the ranks share one, else beside each.
  const rankReads = POSITIONING.ranks.map(({ weeks, id }) => ({ weeks, r: byId.get(id) }));
  const days = [...new Set(rankReads.flatMap(({ r }) => released(r?.metric) ?? []))];
  const ranks = rankReads.map(({ weeks, r }): Line => {
    const served = /^(?:percentile )?(\d+(?:\.\d+)?)\b/.exec(r?.metric?.reading ?? '')?.[1];
    const own = days.length > 1 ? released(r?.metric) : null;
    return [t('dim', `${weeks} weeks `), served ? t('bright', served) : t('dim', r?.metric ? 'n/a' : missedText(r)), ...(own ? [t('dim', ` ${own}`)] : [])];
  });
  lines.push(...packed(t, [t('dim', `  percentile of its own history${days.length === 1 ? `, ${days[0]}` : ''}:`)], ranks, room, '    '));
  lines.push([t('dim', 'Each percentile as PreReason ranks it, among the prior weekly CFTC reports; 100 is the most net long.')]);
  if (stale) lines.push([t('dim', "A date beside a value is that value's own day, older than the read.")]);
  lines.push([]);
  lines.push([t('muted', 'over time, from the readings kept on this machine')]);
  lines.push(...keptLine(t, plain, 'SPY', kept.spy, 'daily', room));
  // The net's line is marked futures too, as the figure is: the CFTC's report counts futures alone.
  lines.push(...keptLine(t, plain, 'net (futures)', kept.net, 'weekly', room));
  // Every source as PreReason names it for each value. The read time is in the heading, as
  // on the market map.
  const named = [
    { said: 'SPY', ids: [POSITIONING.spy] },
    { said: 'the net', ids: [POSITIONING.net] },
    { said: 'its percentiles', ids: POSITIONING.ranks.map((r) => r.id) },
  ].flatMap((g) => g.ids.map((id) => ({ said: g.said, source: byId.get(id)?.metric?.source ?? null })));
  const bySource = new Map<string, string[]>();
  for (const n of named) if (n.source && !bySource.get(n.source)?.includes(n.said)) bySource.set(n.source, [...(bySource.get(n.source) ?? []), n.said]);
  const from = [...bySource].map(([source, said]) => `${listed(said)} from ${source}`);
  if (from.length) lines.push([t('dim', `> ${from.join(' · ')}`)]);
  // As short as it can be and still say what the figure is, so it fits the grid's room.
  const credit = `${POSITIONING.spy}, ${POSITIONING.net} · futures positions, not fund exposure`;
  if (!creditFits(t, credit, room)) lines.push([t('dim', `> ${credit}`)]);
  lines.push(...noticeLines(t, POSITIONING_IDS.map((id) => byId.get(id)?.metric)));
  return { title: 'Positioning', subtitle: `SPY and the speculative net position in S&P 500 futures · ${readWords(readAt)}`, lines, sources: credit, generated: null, readAt };
}

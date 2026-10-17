import { readdirSync, readFileSync } from 'node:fs';
import { metricName, type DataBlock, type Snapshots } from '@primerkit/core';
import type { PricePoint, SingleMetric } from '@primerkit/connector-prereason';
import { ascii, bar, lineChart, rangeBar, sparkline, widthOf, type Line, type Maker } from '@primerkit/ui';
import { BOARD_ROOM, wrapIn } from './fit';

// Boards and charts: the briefings' own numbers, drawn. No model is asked; every figure
// is what PreReason served, rounded as it rounded it, and each chart says where its
// points came from. A history PreReason does not serve comes from the journal, where
// primerkit keeps each briefing it reads.

export interface Board {
  title: string; // "Macro snapshot"
  subtitle: string; // "15 metrics | 09:05 UTC"
  lines: Line[]; // inside the block
  sources: string; // for the PR line: "macro.snapshot"
  generated: string | null; // ISO time the data was generated
  // ISO time a board drawn from metrics read on their own was read. The board names it
  // itself, and its credit names no generated time, since each metric has its own.
  readAt?: string;
}

interface Trend {
  direction?: string;
  change_7d?: number | null;
  change_7d_available?: boolean;
  change_30d?: number | null;
  change_30d_available?: boolean;
  change_90d?: number | null;
  change_90d_available?: boolean;
  change_unit?: string;
  percentile?: number | null;
  percentile_label?: string;
}

interface ServedMetric {
  name?: string;
  value_formatted?: string;
  timestamp?: string;
  trend?: Trend;
}

interface ServedCorrelation {
  metric1?: string;
  metric2?: string;
  value?: number | null;
  observations?: number;
  window_start?: string;
  window_end?: string;
}

interface Served {
  briefing_metadata?: { name?: string };
  generated_at?: string;
  date?: string;
  metrics?: Record<string, ServedMetric>;
  correlations?: Record<string, ServedCorrelation>;
  treasury?: {
    aggregate?: { total_btc_formatted?: string; total_companies?: number; net_change_formatted?: string };
    miner_split?: { miners_pct?: number; corporates_pct?: number; classified_coverage_pct?: number };
    top_holders?: Array<{ ticker?: string; company_name?: string; holdings_formatted?: string; trend?: string; type?: string }>;
    accumulation_summary?: { increasing?: number; decreasing?: number; net_change_formatted?: string; change_period?: string };
  };
}

// Within the grid's 72 columns each board keeps the size it has always had there, and
// narrows from it; in a wider window its chart grows by every column the window adds,
// while its sentences still wrap at 72, so they read as lines.
export const within = (room: number): number => Math.min(room, BOARD_ROOM);
export const beyond = (room: number): number => Math.max(0, room - BOARD_ROOM);

// The notices PreReason serves with the metrics a board draws, read on their own, under the
// board, each once, word for word as served and with no lead-in, in the order the board reads
// its metrics: a notice is a publisher's term, asked for beside its figures. Only the same
// words are said once, so a figure PreReason calculates keeps its own notice, never folded
// into its publisher's.
export function noticeLines(t: Maker, metrics: Array<SingleMetric | null | undefined>): Line[] {
  return [...new Set(metrics.flatMap((m) => m?.notices ?? []))].map((notice): Line => [t('dim', notice)]);
}

export function served(block: DataBlock): Served {
  try {
    return JSON.parse(block.raw ?? '{}') as Served;
  } catch {
    return {};
  }
}

// A served level as a number: "$5.77T", "58.5%", "933.46 EH/s", "~846K", "1.01x".
export function levelOf(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^[~≈]?\s*([+\-−])?\s*[$€£¥]?\s*([+\-−])?\s*(\d[\d,]*(?:\.\d+)?)\s*([KMBT](?![a-z]))?/.exec(text.trim());
  if (!m?.[3]) return null;
  const negative = /[-−]/.test(`${m[1] ?? ''}${m[2] ?? ''}`);
  const scale = m[4] ? { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[4] as 'K' | 'M' | 'B' | 'T'] : 1;
  return (negative ? -1 : 1) * Number(m[3].replace(/,/g, '')) * scale;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string, year = false) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}${year ? `, ${iso.slice(0, 4)}` : ''}`;
const hhmm = (iso: string | undefined) => (iso ? `${iso.slice(11, 16)} UTC` : '');
const DAY = 86_400_000;
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const daysBefore = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY));

// One level a day from the journal, oldest first: the newest snapshot of each day, for
// every metric of the briefing. A day with no snapshot is a gap.
export function journalLevels(snapshots: Snapshots | null, briefing: string, days: number, today: string): { days: string[]; levels: Map<string, Array<number | null>>; kept: number } {
  const dayList = Array.from({ length: days }, (_, i) => daysBefore(today, days - 1 - i));
  const byDay = new Map<string, string>();
  for (const s of snapshots?.list(briefing, 'json') ?? []) byDay.set(s.generatedAt.slice(0, 10), s.path);
  const levels = new Map<string, Array<number | null>>();
  let kept = 0;
  dayList.forEach((day, i) => {
    const path = byDay.get(day);
    if (!path) return;
    let body: Served;
    try {
      body = JSON.parse(readFileSync(path, 'utf8')) as Served;
    } catch {
      return;
    }
    kept += 1;
    for (const [key, m] of Object.entries(body.metrics ?? {})) {
      const row = levels.get(key) ?? new Array<number | null>(days).fill(null);
      row[i] = levelOf(m.value_formatted);
      levels.set(key, row);
    }
  });
  return { days: dayList, levels, kept };
}

// ------------------------------------------------------------------ /brief

// PreReason ranks a growing series by its week's change and any other by its level;
// the label says which.
const PACE_LABELS = new Set(['unusually fast growth', 'above-average growth', 'moderate growth', 'typical pace', 'below-average growth', 'slow growth', 'unusually slow or contracting']);

// A change as the briefing measured it: a percent to one place, a change in percentage
// points to two (changeUnit), otherwise in the level's own units to two significant
// figures, so every cell fits its column.
export function changeText(value: number, unit: string | undefined): string {
  const a = Math.abs(value);
  if (unit === 'percent') return `${a.toFixed(1)}%`;
  if (unit === 'pp') return `${a.toFixed(2)} pp`;
  return a >= 100 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : `${Number(a.toPrecision(2))}`;
}

// The unit a change prints in. A level served as a percent, such as a yield or a spread,
// moves in percentage points where the briefing does not measure its change as a percent:
// that change prints with "pp", at the two places the reading has, so it is not read as a
// percent change.
export function changeUnit(unit: string | undefined, level: string | null | undefined): string | undefined {
  return unit !== 'percent' && /%\s*$/.test(level ?? '') ? 'pp' : unit;
}

// The direction PreReason serves for a window: up or down where the briefing calls that
// window rising or falling, flat where it calls it flat or stable, and null where it names no
// direction for that window. A trend names one window, its direction_horizon (7 days where
// it names none).
export type ServedWay = 'up' | 'down' | 'flat' | null;
export function servedDirection(trend: { direction?: string; direction_horizon?: string } | undefined, horizon: '7d' | '30d'): ServedWay {
  const d = trend?.direction;
  if (!d || (trend?.direction_horizon ?? '7d') !== horizon) return null;
  return d === 'rising' ? 'up' : d === 'falling' ? 'down' : 'flat';
}

// The glyph and colour of a change: green for a rise and red for a fall, by the sign of
// the measured change alone, whatever word the briefing uses for it. One that shows as zero
// at its precision is drawn as unchanged, since a rise of 0.0% would say two things at
// once. Given a served direction (servedDirection), a change it does not agree with is
// drawn muted with its sign written; the boards and charts pass none.
export function changeMark(value: number, unit: string | undefined, served?: ServedWay): { glyph: string; plain: string; role: 'up' | 'down' | 'muted'; sign: string } {
  if (parseFloat(changeText(value, unit)) === 0) return { glyph: '●', plain: 'o', role: 'muted', sign: '' };
  const rose = value > 0;
  if (served !== undefined && served !== (rose ? 'up' : 'down')) return { glyph: '●', plain: 'o', role: 'muted', sign: rose ? '+' : '-' };
  return rose ? { glyph: '▲', plain: '^', role: 'up', sign: '' } : { glyph: '▼', plain: 'v', role: 'down', sign: '' };
}

function changeCell(t: Maker, trend: Trend | undefined, horizon: '7d' | '30d', width: number): Line {
  const value = trend?.[`change_${horizon}`];
  if (trend?.[`change_${horizon}_available`] === false || value === null || value === undefined) return [t('dim', 'n/a'.padEnd(width))];
  const mark = changeMark(value, trend?.change_unit);
  // The figure takes its arrow's colour: up in green, down in red, by the change's sign.
  return [t(mark.role, mark.glyph, mark.plain), t(mark.role, ` ${mark.sign}${changeText(value, trend?.change_unit)}`.padEnd(width - 1))];
}

// The board's columns, which fit the 72 columns inside a block with room for P100.
const COLS = { name: 15, level: 12, change: 9, spark: 17 };
export const BRIEF_DAYS = 30;

// What a narrower window gives up, in order: the 30 day line (55 columns without it),
// the range bar beside the percentile (50), then the 30 day change (41). Below 41 the
// board is wider than the room, and whoever prints it says so.
function briefColumns(room: number): { spark: boolean; bar: boolean; month: boolean } {
  return { spark: room >= 72, bar: room >= 55, month: room >= 50 };
}

export function briefBoard(t: Maker, plain: boolean, block: DataBlock, snapshots: Snapshots | null, today: string, room = BOARD_ROOM): Board {
  const body = served(block);
  const metrics = Object.entries(body.metrics ?? {});
  const history = journalLevels(snapshots, block.id, BRIEF_DAYS, today);
  // A level is never cut: its column widens to the longest (a plain terminal writes a yen
  // or euro sign as three letters), and what a narrower window gives up is decided on the
  // room the wider column leaves.
  const levels = metrics.map(([, m]) => (plain ? ascii(m.value_formatted ?? 'n/a') : (m.value_formatted ?? 'n/a')));
  const levelWidth = Math.max(COLS.level, ...levels.map((l) => l.length + 1));
  const extra = levelWidth - COLS.level;
  const show = briefColumns(room - extra);
  // Wider than the grid, the name column first widens until no name is cut, and then the
  // 30 day line takes a point a day in place of one every 2 days.
  const longest = Math.max(0, ...metrics.map(([key]) => metricName(key).length));
  const spare = Math.max(0, beyond(room) - extra);
  const nameWidth = COLS.name + Math.min(spare, Math.max(0, longest + 1 - COLS.name));
  const daily = spare - (nameWidth - COLS.name) >= BRIEF_DAYS - (COLS.spark - 1);
  // A row ranked by its week's change carries a mark after its P; on the grid the 30 day line
  // gives that mark its column, so the percentile still fits whole.
  const anyPaced = metrics.some(([, m]) => typeof m.trend?.percentile === 'number' && PACE_LABELS.has(m.trend?.percentile_label ?? ''));
  const points = daily ? BRIEF_DAYS : COLS.spark - 1 - (anyPaced ? 1 : 0);
  const sparkWidth = points + 1;
  // The 30 days are a column only where a row has two days or more to draw: a column with
  // nothing in it is left out, not shown empty.
  const sparks = new Map(metrics.map(([key]): [string, string] => {
    const series = history.levels.get(key) ?? [];
    return [key, series.filter((v) => v !== null).length >= 2 ? sparkline(series, plain, points) : ''];
  }));
  const drawn = show.spark && [...sparks.values()].some(Boolean);
  const rows: Line[] = [[t('dim', `${'metric'.padEnd(nameWidth)}${'level'.padEnd(levelWidth)}${'7d'.padEnd(COLS.change)}${show.month ? '30d'.padEnd(COLS.change) : ''}${drawn ? '30 days'.padEnd(sparkWidth) : ''}where`)]];
  let paced = false;
  for (const [i, [key, m]] of metrics.entries()) {
    const name = metricName(key);
    const level = m.value_formatted ?? 'n/a';
    const spark = sparks.get(key) ?? '';
    const p = m.trend?.percentile;
    let where: Line = [t('dim', 'n/a')];
    if (typeof p === 'number') {
      // Every row draws the same bar; one ranked by its week's change is marked after its P.
      const pace = PACE_LABELS.has(m.trend?.percentile_label ?? '');
      if (pace) paced = true;
      const mark: Line = pace ? [t('accent', '*')] : [];
      where = show.bar ? [t('chart', rangeBar(p, plain)), t('muted', ` P${p}`), ...mark] : [t('muted', `P${p}`), ...mark];
    }
    const shown = (levels[i] ?? level).padEnd(levelWidth);
    rows.push([
      t('fg', (name.length > nameWidth - 1 ? `${name.slice(0, nameWidth - 2)}.` : name).padEnd(nameWidth)),
      t('bright', shown, shown),
      ...changeCell(t, m.trend, '7d', COLS.change),
      ...(show.month ? changeCell(t, m.trend, '30d', COLS.change) : []),
      ...(drawn ? [t('chart', spark.padEnd(sparkWidth))] : []),
      ...where,
    ]);
  }
  rows.push([]);
  // The journal's 30 days are drawn only where the window has room for them.
  if (show.spark && history.kept >= 2) rows.push([t('dim', `30 days from your journal: ${history.kept} of ${BRIEF_DAYS} days kept, ${daily ? 'a point a day' : 'a point every 2 days'}`)]);
  if (show.spark && history.kept < BRIEF_DAYS) rows.push([t('dim', `/brief ${block.id} fill reads the ${BRIEF_DAYS - history.kept} missing days, one call each`)]);
  rows.push([t('dim', "where: the level's percentile over its history, as PreReason ranks it")]);
  if (paced) rows.push([t('dim', "* after a P: a series that grows is ranked by its week's change instead")]);
  rows.push([t('dim', "changes: % where PreReason gives a percent, else the level's own units")]);
  return { title: body.briefing_metadata?.name ?? block.id, subtitle: `${metrics.length} metrics | ${hhmm(body.generated_at)}`, lines: rows, sources: block.id, generated: body.generated_at ?? null };
}

// ------------------------------------------------------------------ /chart yield curve

// The maturities the curve is drawn at: eight benchmarks, each value under its point.
// macro.rates, a Pro briefing, carries every maturity on Treasury's par yield curve,
// fourteen, today and on a past date, and /brief macro.rates lists them all; fourteen on
// one chart were too many to read. Below Pro, macro.snapshot carries 2, 10 and 30 years,
// and 3 months and 5 years are metrics of their own, read for today only, so that curve
// has five points.
const CURVE = [
  { key: 'treasury-1mo', label: '1M', words: '1 month' },
  { key: 'treasury-3mo', label: '3M', words: '3 months' },
  { key: 'treasury-6mo', label: '6M', words: '6 months' },
  { key: 'treasury-1y', label: '1Y', words: '1 year' },
  { key: 'treasury-2y', label: '2Y', words: '2 years' },
  { key: 'treasury-5y', label: '5Y', words: '5 years' },
  { key: 'treasury-10y', label: '10Y', words: '10 years' },
  { key: 'treasury-30y', label: '30Y', words: '30 years' },
] as const;
type Tenor = (typeof CURVE)[number];
const FIVE: ReadonlySet<string> = new Set(['treasury-3mo', 'treasury-2y', 'treasury-5y', 'treasury-10y', 'treasury-30y']);

// All eight when the briefing carries a benchmark only macro.rates has, else the five. A
// benchmark it does not carry reads n/a.
function tenorsIn(metrics: Record<string, ServedMetric> | undefined): Tenor[] {
  const all = CURVE.some((c) => !FIVE.has(c.key) && levelOf(metrics?.[c.key]?.value_formatted) !== null);
  return CURVE.filter((c) => all || FIVE.has(c.key));
}

// The newest day every maturity drawn shares, when their newest days differ; null when
// they agree. Treasury posts the 1M, 6M and 1Y the same evening and FRED posts its five a
// day later, so for most of a day the newest values span two days, and a curve drawn
// from them would bend by a day's move.
export function sharedCurveDay(block: DataBlock): string | null {
  const metrics = served(block).metrics;
  const days = tenorsIn(metrics)
    .map((c) => metrics?.[c.key]?.timestamp?.slice(0, 10))
    .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (days.length < 2) return null;
  const oldest = days.reduce((a, b) => (b < a ? b : a));
  const newest = days.reduce((a, b) => (b > a ? b : a));
  return oldest === newest ? null : oldest;
}

interface Leg {
  level: number | null;
  trend?: Trend;
}

const legOf = (m: ServedMetric | undefined): Leg => ({ level: levelOf(m?.value_formatted), ...(m?.trend ? { trend: m.trend } : {}) });
const legOfMetric = (m: SingleMetric | null | undefined): Leg => ({ level: m?.level ?? null, ...(m?.trend ? { trend: m.trend as Trend } : {}) });

// The level as it stood `horizon` ago: the level less its measured change, where the
// change was measured; a percent change is undone as a ratio.
function levelBefore(leg: Leg, horizon: '30d' | '90d'): number | null {
  const change = leg.trend?.[`change_${horizon}`];
  if (leg.level === null || change === null || change === undefined || leg.trend?.[`change_${horizon}_available`] === false) return null;
  if (leg.trend?.change_unit !== 'percent') return leg.level - change;
  if (change <= -100) return null;
  return leg.level / (1 + change / 100);
}

export interface CurveExtra {
  m3?: SingleMetric | null; // the 3 month yield, on its own
  y5?: SingleMetric | null; // the 5 year yield, on its own
}

export type CurveCompare = { kind: 'ago'; horizon: '30d' | '90d' } | { kind: 'date'; date: string; block: DataBlock };

// The levels in maturity order, each from the briefing where it carries the maturity,
// else, for 3 months and 5 years, from the metric read on its own. The 3 month level
// falls back last to the 10 year less the 10y minus 3M spread. `drawn` holds the metrics
// read on their own whose levels the curve draws, for their notices.
function curveNow(metrics: Record<string, ServedMetric> | undefined, extra: CurveExtra, tenors: readonly Tenor[]): { legs: Leg[]; derived3m: boolean; drawn: SingleMetric[] } {
  const drawn: SingleMetric[] = [];
  const pick = (key: string, own: SingleMetric | null | undefined): Leg => {
    const leg = legOf(metrics?.[key]);
    if (leg.level !== null) return leg;
    const mine = legOfMetric(own);
    if (own && mine.level !== null) drawn.push(own);
    return mine;
  };
  const y10 = legOf(metrics?.['treasury-10y']);
  const spread = legOf(metrics?.['t10y3m-spread']);
  const own3m = pick('treasury-3mo', extra.m3);
  const derived3m = own3m.level === null;
  const m3 = derived3m ? { level: y10.level !== null && spread.level !== null ? y10.level - spread.level : null } : own3m;
  const legs = tenors.map((c) => (c.key === 'treasury-3mo' ? m3 : c.key === 'treasury-5y' ? pick(c.key, extra.y5) : legOf(metrics?.[c.key])));
  return { legs, derived3m, drawn };
}

const points2 = (d: number) => Math.abs(d).toFixed(2);

// What moved, in one sentence. Five maturities are each named; eight would run to three
// lines, so they are counted, with the largest moves named.
function curveSentence(since: string, moves: Array<{ word: string; d: number }>): string {
  if (!moves.length) return 'There is no earlier curve to compare with.';
  if (moves.length <= 5) {
    return `${since}: ${moves.map((m) => `${m.word} ${Math.abs(m.d) < 0.005 ? 'held' : `${m.d > 0 ? 'rose' : 'fell'} ${points2(m.d)}`}`).join(', ')} points.`;
  }
  const up = moves.filter((m) => m.d >= 0.005);
  const down = moves.filter((m) => m.d <= -0.005);
  const most = (xs: typeof moves) => xs.reduce((a, b) => (Math.abs(b.d) > Math.abs(a.d) ? b : a));
  const least = (xs: typeof moves) => xs.reduce((a, b) => (Math.abs(b.d) < Math.abs(a.d) ? b : a));
  if (up.length === moves.length || down.length === moves.length) {
    const verb = up.length ? 'rose' : 'fell';
    return `${since} every maturity ${verb}: ${most(moves).word} the most, ${points2(most(moves).d)} points, and ${least(moves).word} the least, ${points2(least(moves).d)}.`;
  }
  const held = moves.length - up.length - down.length;
  const counts = `${up.length} ${up.length === 1 ? 'maturity' : 'maturities'} rose and ${down.length} fell${held ? `, ${held} held` : ''}`;
  const named = [up.length ? `${most(up).word} rose the most, ${points2(most(up).d)} points` : '', down.length ? `${most(down).word} fell the most, ${points2(most(down).d)}` : '']
    .filter(Boolean)
    .join(', and ');
  return `${since} ${counts}: ${named}.`;
}

// `nowDay` names the day the current curve was read as it stood, when that is not today.
// `room` is the columns the board's lines may take; the chart narrows to it, or grows in
// a window wider than the grid, and the sentence and notes wrap in it, at most at 72.
// The rows a chart's plot has on the grid: the yield curve's six, and a series' seven. A
// taller window gives a chart more (see taller in board-load).
export const CURVE_ROWS = 6;
export const SERIES_ROWS = 7;

export function yieldCurveBoard(t: Maker, plain: boolean, today: DataBlock, compare: CurveCompare, extra: CurveExtra = {}, nowDay?: string, room = BOARD_ROOM, height = CURVE_ROWS): Board {
  const body = served(today);
  const tenors = tenorsIn(body.metrics);
  const at3m = tenors.findIndex((c) => c.key === 'treasury-3mo');
  const at5y = tenors.findIndex((c) => c.key === 'treasury-5y');
  const at10y = tenors.findIndex((c) => c.key === 'treasury-10y');
  const { legs, derived3m, drawn } = curveNow(body.metrics, extra, tenors);
  const now = legs.map((l) => l.level);
  let then: Array<number | null>;
  let thenName: string;
  let how: string;
  if (compare.kind === 'ago') {
    const n = compare.horizon.replace('d', '');
    then = legs.map((l) => levelBefore(l, compare.horizon));
    if (derived3m) {
      // Derived from the spread, the earlier 3 month is the earlier 10 year less the
      // earlier spread, where the spread kept its sign.
      const spread = legOf(body.metrics?.['t10y3m-spread']);
      const spreadThen = levelBefore(spread, compare.horizon);
      const y10Then = then[at10y] ?? null;
      then[at3m] = spreadThen !== null && spread.level !== null && Math.sign(spreadThen) === Math.sign(spread.level) && y10Then !== null ? y10Then - spreadThen : null;
    }
    // Counted back from the day the curve is drawn on, which is not today when it was
    // read as it stood on the shared day: that row is labelled with its own date, which
    // also fits the label's seven columns ("30d before" does not).
    thenName = nowDay ? dayLabel(daysBefore(nowDay, Number(n))) : `${n}d ago`;
    how = `${n} days ${nowDay ? 'before' : 'ago'}: each level less its measured ${n} day change.`;
  } else {
    const dated = served(compare.block).metrics;
    const at = (key: string) => levelOf(dated?.[key]?.value_formatted);
    const y10 = at('treasury-10y');
    const spread = at('t10y3m-spread');
    // macro.rates serves every maturity for a past date. macro.snapshot serves 2, 10 and
    // 30 years and the spread, so from it the 3 month is derived and the 5 year is missing.
    then = tenors.map((c) => (c.key === 'treasury-3mo' ? at(c.key) ?? (y10 !== null && spread !== null ? y10 - spread : null) : at(c.key)));
    thenName = 'then';
    how = `${compare.date}: as it stood, read with date=${then[at5y] === null ? '; 5Y comes with macro.rates' : ''}.`;
  }
  const points = now.flatMap((y, x) => (y === null ? [] : [{ x, y }]));
  const last = tenors.length - 1;
  const nowName = nowDay ? dayLabel(nowDay) : 'now';
  // The chart narrows to the room it has, from the 52 columns it has on the grid, and in
  // a wider window grows by every column the window adds. Each value sits under its
  // point, four characters and a space, so points come no closer than five columns
  // apart, and at that spacing the last value ends three columns past the chart. The
  // gutter is seven where there is room and six where it is narrow, but never narrower
  // than a row's label ("30d ago" is seven), or that row's values would sit a column
  // right of the others. Too narrow even so, the lines are wider than the room, and
  // whoever prints them says so.
  const gutter = Math.max(room >= 60 ? 7 : 6, nowName.length, thenName.length);
  const width = Math.max(5 * last + 1, Math.min(52, within(room) - gutter - 5)) + beyond(room);
  const chart = lineChart(t, {
    series: [
      { points: points.map((p): [number, number] => [p.x, p.y]), style: 'main', smooth: true },
      { points: then.flatMap((y, x): Array<[number, number]> => (y === null ? [] : [[x, y]])), style: 'compare', smooth: true },
    ],
    points,
    width,
    // Six rows on the grid, so the curve, its values, the sentence and the notes fit one
    // screen; a taller window gives it the rows it has to spare.
    height,
    gutter,
    xRange: [0, last],
    // A taller curve labels its rows closer together, so to the hundredth.
    yLabel: (v) => `${v.toFixed(height > CURVE_ROWS ? 2 : 1)}%`,
    xTicks: tenors.map((c, x) => ({ x, label: c.label })),
    plain,
  });
  // The values sit under their maturities, centred, each starting at least a column
  // after the one before it (centred, two close values once ran together as "4.04.24").
  const under = (label: string, values: Array<number | null>, role: string): Line => {
    const cells = Array.from({ length: width + 8 }, () => ' ');
    let free = 0;
    values.forEach((v, x) => {
      const text = v === null ? 'n/a' : v.toFixed(2);
      const centred = Math.floor((x / last) * (width - 1)) - Math.floor(text.length / 2);
      const c = Math.min(width + 8 - text.length, Math.max(free, centred));
      Array.from(text).forEach((ch, k) => (cells[c + k] = ch));
      free = c + text.length + 1;
    });
    return [t('dim', `${label.padStart(gutter)}  `), t(role, cells.join('').trimEnd())];
  };
  // Each maturity's change between the two curves, under its values: green for a rise and
  // red for a fall, by its sign.
  const changes = (): Line => {
    const segs: Line = [t('dim', `${'change'.padStart(gutter)}  `)];
    // The room the block leaves after the label: a change may run a column past the level
    // above it (a sign makes it a character longer), never past the room.
    const limit = room - gutter - 2;
    let col = 0;
    now.forEach((v, x) => {
      const w = then[x];
      if (v === null || w === null || w === undefined) return;
      const d = Number((v - w).toFixed(2));
      const text = `${d > 0 ? '+' : d < 0 ? '-' : ''}${Math.abs(d).toFixed(2)}`;
      const c = Math.min(width + 8 - text.length, Math.max(col ? col + 1 : 0, Math.floor((x / last) * (width - 1)) - Math.floor(text.length / 2)));
      // A change with no room left beside the one before it, or past the room, is left out,
      // never run past the edge.
      if ((col && c < col + 1) || c + text.length > limit) return;
      segs.push(t('fg', ' '.repeat(Math.max(0, c - col))), t(d === 0 ? 'muted' : d > 0 ? 'up' : 'down', text));
      col = c + text.length;
    });
    return segs;
  };
  const moves = now
    .map((y, i): { word: string; d: number } | null => (y !== null && then[i] !== null && then[i] !== undefined ? { word: tenors[i]!.words, d: y - then[i]! } : null))
    .filter((m): m is { word: string; d: number } => m !== null);
  const since = compare.kind === 'ago' ? `Over ${compare.horizon.replace('d', '')} days` : `Since ${compare.date}`;
  const sentence = curveSentence(since, moves);
  const date = compare.kind === 'date' ? dayLabel(compare.date, true) : '';
  const fromRates = today.id === 'macro.rates';
  // The maturities the read carries, of which the chart draws its benchmarks.
  const carried = Object.keys(body.metrics ?? {}).filter((k) => /^treasury-\d/.test(k)).length;
  const from = fromRates
    ? carried > tenors.length
      ? `> ${tenors.length} of ${carried} maturities from macro.rates; /brief macro.rates lists all ${carried}`
      : `> all ${tenors.length} maturities from macro.rates`
    : derived3m
      ? '> 2y, 10y, 30y from macro.snapshot; 3M is the 10y less the 10y-3M spread'
      : '> 2y, 10y and 30y from macro.snapshot; 3M and 5Y from their own metrics';
  const withRates = CURVE.filter((c) => !FIVE.has(c.key)).map((c) => c.label);
  const gap =
    tenors.length === CURVE.length
      ? 'Between maturities the line is drawn, not measured.'
      : `${withRates.slice(0, -1).join(', ')} and ${withRates.at(-1)} are drawn with macro.rates, a Pro briefing; each is also a metric of its own, such as treasury-1mo. Between maturities the line is drawn, not measured.`;
  // A note under the curve, indented two, wrapped in the room, at most at 72.
  const note = (text: string): Line[] => wrapIn(t, 'dim', text, within(room) - 2).map((l): Line => [t('dim', '  '), ...l]);
  const sources =
    compare.kind === 'date'
      ? `${[...new Set([today.id, compare.block.id])].join(', ')}, two dates`
      : fromRates || derived3m
        ? today.id
        : `${today.id}, treasury-3mo, treasury-5y`;
  return {
    title: 'Treasury yield curve',
    subtitle: `${nowDay ? `on ${dayLabel(nowDay, true)}` : 'now'}, and ${compare.kind === 'ago' ? `${compare.horizon.replace('d', '')} days ${nowDay ? 'before' : 'ago'}` : `on ${date}`}`,
    // A blank line each side of the values, so they read apart from the chart and the
    // sentence.
    lines: [
      ...chart,
      [],
      under(nowName, now, 'bright'),
      under(thenName, then, 'muted'),
      changes(),
      [],
      ...wrapIn(t, 'fg', sentence, within(room), '  '),
      ...wrapIn(t, 'dim', from, within(room), '  '),
      // The spread as PreReason read it, in its own sentence, cited.
      ...readingLines(t, today, 'yield-curve', within(room)),
      ...(nowDay ? note(`${dayLabel(nowDay)} is the newest day all of them share: FRED posts a day later`) : []),
      ...note(gap),
      ...note(how),
      ...noticeLines(t, drawn),
    ],
    sources,
    generated: body.generated_at ?? null,
  };
}

// ------------------------------------------------------------------ a series over time

function seriesBoard(
  t: Maker,
  plain: boolean,
  points: Array<{ date: string; value: number }>,
  o: { format: (v: number) => string; average?: { value: number; label: string } },
  room = BOARD_ROOM,
  height = SERIES_ROWS,
): { chart: Line[]; low: { date: string; value: number }; high: { date: string; value: number }; last: { date: string; value: number } } {
  const t0 = Date.parse(points[0]!.date);
  const x = (d: string) => (Date.parse(d) - t0) / DAY;
  const span = x(points.at(-1)!.date) || 1;
  const low = points.reduce((a, b) => (b.value < a.value ? b : a));
  const high = points.reduce((a, b) => (b.value > a.value ? b : a));
  const last = points.at(-1)!;
  const ticks = [0, 1, 2, 3].map((i) => {
    const d = new Date(t0 + ((span * i) / 3) * DAY).toISOString().slice(0, 10);
    return { x: x(d), label: span > 400 ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : dayLabel(d) };
  });
  const chart = lineChart(t, {
    series: [
      { points: points.map((p): [number, number] => [x(p.date), p.value]), style: 'main' },
      ...(o.average ? [{ points: [[0, o.average.value], [span, o.average.value]] as Array<[number, number]>, style: 'compare' as const }] : []),
    ],
    points: [low, high, last].map((p) => ({ x: x(p.date), y: p.value })),
    // The chart narrows to the room from the 56 columns it has on the grid, and grows by
    // every column a wider window adds: beside it its labels, the axis mark, and the last
    // date running three columns past its end.
    width: Math.max(30, Math.min(56, within(room) - Math.max(o.format(low.value).length, o.format(high.value).length) - 6)) + beyond(room),
    height,
    xRange: [0, span],
    yLabel: o.format,
    xTicks: ticks,
    plain,
  });
  return { chart, low, high, last };
}

const dollars = (v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}K` : v >= 1 ? `$${v.toFixed(0)}` : `$${v.toFixed(3)}`);
const exact = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 0 : 4 })}`;

export const BITCOIN_RANGES = ['30d', '90d', '1y', 'all'] as const;
export type BitcoinRange = (typeof BITCOIN_RANGES)[number] | { from: string };

// The ranges to pick from, the one drawn in brackets, then "or from a date", or the
// date drawn from. Where the room is short of the whole row, that last part is left
// off: the subtitle names the range in any case.
export function rangeRow(t: Maker, current: BitcoinRange, room = BOARD_ROOM): Line {
  const tail = typeof current === 'object' ? `  from ${current.from}` : '  or from a date';
  const ranges = BITCOIN_RANGES.flatMap((r) => (r === current ? [t('accentBold', ` [${r}] `)] : [t('muted', `  ${r}  `)]));
  const row: Line = [t('dim', 'range  '), ...ranges];
  return widthOf(row) + tail.length <= room ? [...row, t('dim', tail)] : row;
}

// The Bitcoin price now, from a briefing that carries it: btc.momentum does, and so do
// the free btc.quick-check and btc.pulse.
export interface PriceNow {
  value: number;
  at: string; // when the price was taken
  from: string; // the briefing it came from
}

export function priceNow(block: DataBlock | null): PriceNow | null {
  const m = block ? served(block).metrics?.['bitcoin-price'] : undefined;
  const value = levelOf(m?.value_formatted);
  return block && value !== null && m?.timestamp ? { value, at: m.timestamp, from: block.id } : null;
}

// Names as a sentence lists them: "a", "a and b", "a, b and c".
const listed = (names: string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

// PreReason's price history has a point a day and ends with yesterday. The price now,
// where a briefing carries it, ends the line and is the price the board calls "now",
// the same price the distance from the 200 day average is measured from. Without it
// the last day of the history is named for what it is.
export function bitcoinBoard(t: Maker, plain: boolean, history: PricePoint[], range: BitcoinRange, momentum: DataBlock | null, room = BOARD_ROOM, now = priceNow(momentum), height = SERIES_ROWS): Board {
  if (history.length < 2) return { title: 'Bitcoin', subtitle: 'no history in this range', lines: [[t('fg', 'PreReason served fewer than two days for this range.')]], sources: 'history', generated: null };
  const m = momentum ? served(momentum).metrics : undefined;
  const average = levelOf(m?.['btc-price-200d-ma']?.value_formatted);
  const distance = m?.['btc-price-200d-distance']?.value_formatted;
  const days = history.map((p) => ({ date: p.date, value: p.price }));
  const lastDay = days.at(-1)!.date;
  const nowDay = now?.at.slice(0, 10) ?? '';
  // A price taken on the history's last day stands for that day; one taken before it is
  // older than the history and is not used.
  const live = now && nowDay >= lastDay ? now : null;
  const points = !live ? days : nowDay === lastDay ? [...days.slice(0, -1), { date: nowDay, value: live.value }] : [...days, { date: nowDay, value: live.value }];
  const { chart, low, high, last } = seriesBoard(
    t,
    plain,
    points,
    { format: dollars, ...(average !== null ? { average: { value: average, label: 'its 200 day average today' } } : {}) },
    room,
    height,
  );
  const first = points[0]!;
  const change = ((last.value - first.value) / first.value) * 100;
  const pct = `${Math.abs(change).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  const span = typeof range === 'object' ? `from ${range.from}` : range === 'all' ? 'all of it' : range === '1y' ? 'a year' : `${range.replace('d', '')} days`;
  const where = live ? `Now ${exact(last.value)}` : `On ${dayLabel(last.date, true)} it was ${exact(last.value)}`;
  // A blank line each side of the range row, so it reads apart from the chart's dates
  // and from the sentences.
  const lines: Line[] = [
    ...chart,
    [],
    rangeRow(t, range, room),
    [],
    [t('fg', `${where}, ${change >= 0 ? 'up' : 'down'} ${pct} from ${exact(first.value)} on ${dayLabel(first.date, true)}.`)],
    [t('fg', `Low ${exact(low.value)} on ${dayLabel(low.date, true)} | high ${exact(high.value)} on ${dayLabel(high.date, true)}.`)],
  ];
  if (average !== null) lines.push([t('fg', `Its 200 day average is ${exact(average)} today${distance ? `, ${distance} away` : ''}; the dotted line draws it across the range.`)]);
  const fromMomentum = live?.from === 'btc.momentum';
  const read = [
    `PreReason's price history, ${history.length.toLocaleString('en-US')} points from ${first.date}`,
    ...(fromMomentum && average !== null
      ? ['the price now and the 200 day average from btc.momentum']
      : [...(live ? [`the price now from ${live.from}`] : []), ...(average !== null ? ['the 200 day average from btc.momentum'] : [])]),
  ];
  lines.push([t('dim', `> ${read.join(' | ')}`)]);
  // Where PreReason names each close's source, the board names every source it drew, the
  // newest first, and shows the notice a source's terms ask for. It names none otherwise.
  const drawn = [...new Set(history.slice().reverse().flatMap((p) => (p.source ? [p.source] : [])))];
  if (drawn.length) lines.push([t('dim', `> closes from ${listed(drawn)}, as PreReason names each day's source`)]);
  for (const notice of [...new Set(history.flatMap((p) => (p.notice ? [p.notice] : [])))]) lines.push([t('dim', notice)]);
  const sources = ['history', ...(average !== null || fromMomentum ? ['btc.momentum'] : []), ...(live && !fromMomentum ? [live.from] : [])].join(', ');
  return { title: 'Bitcoin', subtitle: `${span}, ${dayLabel(first.date, true)} to ${dayLabel(last.date, true)}`, lines, sources, generated: null };
}

export function hashpriceBoard(t: Maker, plain: boolean, points: Array<{ date: string; value: number }>, want: number, callsLeft: number | null, room = BOARD_ROOM, height = SERIES_ROWS): Board {
  const missing = want - points.length;
  // One sentence, so it wraps as one wherever the window ends.
  const fill: Line[] = missing > 0 ? [[t('dim', `${points.length} of ${want} days ${points.length === 1 ? 'is' : 'are'} in your journal. /chart hashprice fill reads the other ${missing} with date=, one call each${callsLeft !== null ? `, of the ${callsLeft.toLocaleString('en-US')} calls left today` : ''}.`)]] : [];
  if (points.length < 2) {
    return { title: 'Hashprice', subtitle: 'dollars per TH/s a day', lines: [[t('fg', 'The journal holds fewer than two days of btc.miner-survival yet.')], ...fill], sources: 'btc.miner-survival', generated: null };
  }
  const { chart, low, high, last } = seriesBoard(t, plain, points, { format: (v) => `$${v.toFixed(3)}` }, room, height);
  return {
    title: 'Hashprice',
    subtitle: `dollars per TH/s a day, ${points.length} days`,
    lines: [...chart, [], [t('fg', `Low ${exact(low.value)} on ${dayLabel(low.date)} | high ${exact(high.value)} on ${dayLabel(high.date)} | now ${exact(last.value)}.`)], [t('dim', `> your journal: ${points.length} daily snapshots of btc.miner-survival`)], ...fill],
    sources: 'btc.miner-survival',
    generated: null,
  };
}

// The hashprice a day from the journal, oldest first.
export function hashpricePoints(snapshots: Snapshots | null, days: number, today: string): Array<{ date: string; value: number }> {
  const h = journalLevels(snapshots, 'btc.miner-survival', days, today);
  const row = h.levels.get('hashprice') ?? [];
  return h.days.flatMap((date, i) => (row[i] !== null && row[i] !== undefined ? [{ date, value: row[i]! }] : []));
}

// ------------------------------------------------------------------ /chart <metric>

export const METRIC_RANGES = ['30d', '90d', '1y'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];
export const rangeDays = (range: MetricRange): number => (range === '30d' ? 30 : range === '90d' ? 90 : 365);

// The short names a person types for a metric, each to its id.
export const METRIC_NAMES: Record<string, string> = {
  gold: 'etf-gld',
  silver: 'etf-slv',
  copper: 'etf-cper',
  oil: 'oil-wti',
  wti: 'oil-wti',
  brent: 'oil-brent',
  spy: 'etf-spy',
  qqq: 'etf-qqq',
  iwm: 'etf-iwm',
  tlt: 'etf-tlt',
  uup: 'dxy',
  dxy: 'dxy',
  tga: 'tga',
  m2: 'm2-supply',
  eurusd: 'eur-usd',
  'eur/usd': 'eur-usd',
};

// The keys a briefing may carry a metric under: its id, an ETF's ticker alone (cross.correlations
// names SPY "spy"), and UUP under dxy, as macro.snapshot serves it.
export function metricKeys(id: string): string[] {
  const keys = [id];
  if (id.startsWith('etf-')) keys.push(id.slice(4));
  if (id === 'etf-uup') keys.push('dxy');
  if (id === 'dxy') keys.push('etf-uup', 'uup');
  return [...new Set(keys)];
}

export interface MetricSeries {
  briefing: string | null; // the briefing kept on this machine that carries it
  key: string | null; // the key it carries the metric under
  points: Array<{ date: string; value: number }>;
  served: (ServedMetric & { context?: string; source?: string }) | null; // as the newest snapshot serves it
  generated: string | null; // when the newest snapshot was generated
}

// A metric's days from the journal: of the briefings kept on this machine (or the one named),
// the one that carries it on the most days. Read from the snapshots, never from PreReason.
export function metricSeries(snapshots: Snapshots | null, id: string, briefing: string | null, days: number, today: string): MetricSeries {
  const none: MetricSeries = { briefing, key: null, points: [], served: null, generated: null };
  if (!snapshots) return none;
  let kept: string[] = [];
  try {
    kept = briefing ? [briefing] : readdirSync(snapshots.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return none;
  }
  let best = none;
  for (const b of kept) {
    const h = journalLevels(snapshots, b, days, today);
    for (const key of metricKeys(id)) {
      const row = h.levels.get(key);
      if (!row) continue;
      const points = h.days.flatMap((date, i) => (row[i] !== null && row[i] !== undefined ? [{ date, value: row[i]! }] : []));
      if (points.length <= best.points.length && best.key) continue;
      const latest = snapshots.latest(b, 'json');
      let served: MetricSeries['served'] = null;
      try {
        served = latest ? ((JSON.parse(latest.raw) as Served).metrics?.[key] ?? null) : null;
      } catch {
        served = null;
      }
      best = { briefing: b, key, points, served, generated: latest?.generatedAt ?? null };
    }
  }
  return best.key ? best : none;
}

// A level's axis label in the units it is served in: a percent, a dollar amount, or a count.
function unitFormat(served: string | undefined): { format: (v: number) => string; unit: string } {
  const text = served ?? '';
  const short = (v: number) => {
    const a = Math.abs(v);
    return a >= 1e12 ? `${(v / 1e12).toFixed(2)}T` : a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e4 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a >= 100 ? v.toFixed(1) : v.toFixed(2);
  };
  if (/%\s*$/.test(text)) return { format: (v) => `${v.toFixed(2)}%`, unit: 'percent' };
  if (/^\s*[-−]?\$/.test(text)) return { format: (v) => `$${short(v)}`, unit: 'dollars' };
  if (/^\s*[-−]?€/.test(text)) return { format: (v) => `€${short(v)}`, unit: 'euros' };
  return { format: short, unit: 'level' };
}

// A metric over time: its days from the journal as a dated line, with its title and unit, the
// axis's values and days, the last value with its 7 and 30 day changes coloured by their sign,
// its low and high, the source and day line, and PreReason's own sentence for it, cited.
export function metricChartBoard(t: Maker, plain: boolean, id: string, series: MetricSeries, range: MetricRange, reach: string | null, callsLeft: number | null, room = BOARD_ROOM, height = SERIES_ROWS): Board {
  const days = rangeDays(range);
  const name = series.key ? metricName(series.key) : metricName(id);
  const { format, unit } = unitFormat(series.served?.value_formatted);
  const missing = days - series.points.length;
  const where = series.briefing ?? 'a briefing that carries it';
  const fill: Line[] =
    missing > 0
      ? [[t('dim', `${series.points.length} of ${days} days are in your journal. /chart ${id}${series.briefing ? ` in ${series.briefing}` : ''} ${range} fill reads the others from ${where} with date=, one call each${callsLeft !== null ? `, of the ${callsLeft.toLocaleString('en-US')} calls left today` : ''}${reach ? `; this key reads back to ${dayLabel(reach, true)}` : ''}.`)]]
      : [];
  if (series.points.length < 2) {
    const why = series.briefing ? `The journal holds ${series.points.length === 1 ? 'one day' : 'no day'} of ${name} in ${series.briefing} yet.` : `No briefing kept on this machine carries ${id}. Name the one that does: /chart ${id} in macro.snapshot.`;
    return { title: name, subtitle: `${range === '1y' ? 'a year' : `${days} days`}`, lines: [[t('fg', why)], ...fill], sources: series.briefing ?? id, generated: null };
  }
  const { chart, low, high, last } = seriesBoard(t, plain, series.points, { format }, room, height);
  const trend = series.served?.trend;
  const level = series.served?.value_formatted ?? format(last.value);
  const by = changeUnit(trend?.change_unit, level);
  const change = (w: '7d' | '30d'): Line => {
    const v = trend?.[`change_${w}`];
    if (trend?.[`change_${w}_available`] === false || typeof v !== 'number') return [t('dim', `  ${w} n/a`)];
    const mark = changeMark(v, by);
    return [t('dim', `  ${w} `), t(mark.role, `${mark.glyph} ${changeText(v, by)}`, `${mark.role === 'muted' ? '' : v > 0 ? '+' : '-'}${changeText(v, by)}`)];
  };
  const lines: Line[] = [
    ...chart,
    [],
    [t('dim', 'now '), t('bright', plain ? ascii(level) : level), ...change('7d'), ...change('30d')],
    [t('fg', `Low ${format(low.value)} on ${dayLabel(low.date)} | high ${format(high.value)} on ${dayLabel(high.date)} | ${series.points.length} days, ${dayLabel(series.points[0]!.date)} to ${dayLabel(last.date, true)}.`)],
    [t('dim', `> your journal: ${series.points.length} daily snapshots of ${series.briefing}, ${series.key}${series.served?.source ? `; source: ${series.served.source}` : ''}`)],
    ...(series.served?.context ? quoted(t, series.served.context, `${series.briefing}, ${series.key}`, within(room)) : []),
    ...fill,
  ];
  return { title: name, subtitle: `${unit}, ${range === '1y' ? 'a year' : `${days} days`}`, lines, sources: series.briefing ?? id, generated: series.generated };
}

// ------------------------------------------------------------------ the heatmap

const HEAT_WINDOWS = ['7d', '30d', '90d'] as const;
const HEAT_CELL = 10;

// How deep a change's tile is, 1 to 3: its size among the column's other changes in the same
// unit, by rank, so a percent is never measured against a point. A change alone in
// its unit takes the middle depth.
export function heatDepths(values: Array<number | null>, units: Array<string | undefined>): Array<number> {
  const out = values.map(() => 0);
  for (const unit of new Set(units)) {
    const sized = values.map((v, i) => ({ i, a: v === null || units[i] !== unit ? 0 : Math.abs(v) })).filter((x) => x.a > 0).sort((x, y) => x.a - y.a);
    if (sized.length === 1) out[sized[0]!.i] = 2;
    // The smallest light, the largest deep, and the rest spread between them by rank.
    else sized.forEach((x, rank) => (out[x.i] = 1 + Math.round((rank * 2) / (sized.length - 1))));
  }
  return out;
}

// A briefing's metrics as a heatmap: a row each, a column for each window PreReason serves
// (7, 30 and 90 days), each cell its change, its tile green for a rise and red for a fall by
// the sign alone, and deeper for a larger move among its column's rows. Plain text has no
// tiles: the sign says the direction.
export function heatBoard(t: Maker, plain: boolean, block: DataBlock, room = BOARD_ROOM): Board {
  const body = served(block);
  const metrics = Object.entries(body.metrics ?? {});
  const changeOf = (m: ServedMetric, w: (typeof HEAT_WINDOWS)[number]): number | null => {
    const v = m.trend?.[`change_${w}` as keyof Trend];
    return m.trend?.[`change_${w}_available` as keyof Trend] === false || typeof v !== 'number' ? null : v;
  };
  const units = metrics.map(([, m]) => m.trend?.change_unit);
  const depths = HEAT_WINDOWS.map((w) => heatDepths(metrics.map(([, m]) => changeOf(m, w)), units));
  const levels = metrics.map(([, m]) => (plain ? ascii(m.value_formatted ?? 'n/a') : (m.value_formatted ?? 'n/a')));
  const levelWidth = Math.max(COLS.level, ...levels.map((l) => l.length + 1));
  const nameWidth = Math.max(COLS.name, Math.min(22, Math.max(0, ...metrics.map(([key]) => metricName(key).length)) + 1));
  const fits = nameWidth + levelWidth + HEAT_WINDOWS.length * (HEAT_CELL + 1) <= Math.max(room, BOARD_ROOM);
  const windows = fits ? HEAT_WINDOWS : HEAT_WINDOWS.slice(0, 2);
  const centre = (s: string) => {
    const left = Math.floor((HEAT_CELL - s.length) / 2);
    return `${' '.repeat(Math.max(0, left))}${s}`.padEnd(HEAT_CELL);
  };
  const rows: Line[] = [[t('dim', `${'metric'.padEnd(nameWidth)}${'level'.padEnd(levelWidth)}${windows.map((w) => ` ${centre(w)}`).join('')}`)]];
  for (const [i, [key, m]] of metrics.entries()) {
    const name = metricName(key);
    const cells: Line = windows.flatMap((w): Line => {
      const v = changeOf(m, w);
      if (v === null) return [t('fg', ' '), t('dim', centre('n/a'))];
      const mark = changeMark(v, m.trend?.change_unit);
      const text = `${mark.role === 'muted' ? '' : v > 0 ? '+' : '-'}${changeText(v, m.trend?.change_unit)}`;
      if (mark.role === 'muted') return [t('fg', ' '), t('muted', centre(text))];
      const depth = depths[HEAT_WINDOWS.indexOf(w)]?.[i] || 1;
      return [t('fg', ' '), t(`heatInk/heat${mark.role === 'up' ? 'Up' : 'Down'}${depth}`, centre(text))];
    });
    rows.push([t('fg', (name.length > nameWidth - 1 ? `${name.slice(0, nameWidth - 2)}.` : name).padEnd(nameWidth)), t('bright', (levels[i] ?? '').padEnd(levelWidth)), ...cells]);
  }
  rows.push([]);
  rows.push([t('dim', "each cell: the change over its window, green for a rise and red for a fall, deeper for a larger move among the column's rows in the same unit")]);
  rows.push([t('dim', "changes: % where PreReason gives a percent, else the level's own units")]);
  return { title: body.briefing_metadata?.name ?? block.id, subtitle: `heatmap · ${metrics.length} metrics | ${hhmm(body.generated_at)}`, lines: rows, sources: block.id, generated: body.generated_at ?? null };
}

// One reading PreReason served for a metric, quoted as served and cited to its briefing and
// metric, for the foot of a chart: what the chart shows, in the briefing's own sentence.
export function readingLines(t: Maker, block: DataBlock, metric: string, room: number): Line[] {
  const m = served(block).metrics?.[metric];
  const context = (m as { context?: string } | undefined)?.context;
  return context ? quoted(t, context, `${block.id}, ${metric}`, room) : [];
}

// A served sentence quoted whole under "reading", with where it was served, wrapped under its start.
function quoted(t: Maker, sentence: string, cite: string, room: number): Line[] {
  const words = `reading  "${sentence}" (${cite})`;
  const out: Line[] = [];
  let line = '';
  for (const word of words.split(/\s+/)) {
    if (line && line.length + 1 + word.length > room) {
      out.push([t('dim', line)]);
      line = `         ${word}`;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push([t('dim', line)]);
  return out;
}

// ------------------------------------------------------------------ /chart treasury

const TREND_GLYPH: Record<string, [string, string, string]> = { accumulating: ['▲', '^', 'up'], distributing: ['▼', 'v', 'down'] };

export function treasuryBoard(t: Maker, plain: boolean, block: DataBlock, room = BOARD_ROOM): Board {
  const body = served(block);
  const tr = body.treasury;
  if (!tr) return { title: 'Bitcoin treasuries', subtitle: '', lines: [[t('fg', 'This briefing carries no treasury section.')]], sources: block.id, generated: body.generated_at ?? null };
  // The bars take what the room leaves beside the name, the holding and the trend mark:
  // the 36 columns they have on the grid, less in a narrower window, and every column
  // more that a wider one adds.
  const length = Math.max(10, Math.min(36, within(room) - 22)) + beyond(room);
  const lines: Line[] = [];
  const split = tr.miner_split;
  if (split?.corporates_pct !== undefined && split.miners_pct !== undefined) {
    lines.push([t('muted', 'By type'), t('dim', split.classified_coverage_pct !== undefined ? `  of the ${split.classified_coverage_pct}% of holdings classified` : '')]);
    for (const [name, pct] of [['corporate', split.corporates_pct], ['miners', split.miners_pct]] as const) {
      lines.push([t('fg', name.padEnd(12)), t('chart', bar(pct / 100, length, plain).padEnd(length + 1)), t('bright', `${pct}%`.padStart(5))]);
    }
    lines.push([]);
  }
  const holders = (tr.top_holders ?? []).slice(0, 6);
  const top = Math.max(1, ...holders.map((h) => levelOf(h.holdings_formatted) ?? 0));
  lines.push([t('muted', 'Largest holders'), t('dim', '  trend over the latest filings')]);
  for (const h of holders) {
    const [glyph, plainGlyph, role] = TREND_GLYPH[h.trend ?? ''] ?? ['●', 'o', 'muted'];
    lines.push([
      t('fg', (h.ticker ?? '?').padEnd(12)),
      t('chart', bar((levelOf(h.holdings_formatted) ?? 0) / top, length, plain).padEnd(length + 1)),
      t('bright', (h.holdings_formatted ?? 'n/a').padStart(6)),
      t(role, `  ${glyph}`, `  ${plainGlyph}`),
    ]);
  }
  const acc = tr.accumulation_summary;
  if (acc?.net_change_formatted) {
    lines.push([]);
    const period = acc.change_period ? ` over ${acc.change_period.replace(/\s*[–-]\s*/, ' to ')}` : '';
    lines.push([t('fg', `${acc.increasing ?? 0} companies added and ${acc.decreasing ?? 0} reduced${period}: net ${acc.net_change_formatted}.`)]);
  }
  const agg = tr.aggregate;
  return {
    title: 'Bitcoin treasuries',
    subtitle: `${agg?.total_btc_formatted ?? 'n/a'} across ${agg?.total_companies ?? '?'} tracked companies`,
    lines,
    sources: block.id,
    generated: body.generated_at ?? null,
  };
}

// ------------------------------------------------------------------ /chart correlations

export function correlationsBoard(t: Maker, plain: boolean, block: DataBlock, room = BOARD_ROOM): Board {
  const body = served(block);
  const pairs = Object.values(body.correlations ?? {}).filter((c): c is ServedCorrelation & { value: number } => typeof c.value === 'number');
  if (!pairs.length) return { title: 'Correlations', subtitle: '', lines: [[t('fg', `${block.id} carries no correlations.`)]], sources: block.id, generated: body.generated_at ?? null };
  const label = (c: ServedCorrelation): string => {
    const second = metricName(c.metric2 ?? '?');
    return `${metricName(c.metric1 ?? '?')} and ${/^[A-Z0-9]{2,}\b/.test(second) ? second : second.charAt(0).toLowerCase() + second.slice(1)}`;
  };
  // A narrower window shortens the bars before the names: each side of zero from 12
  // columns down to 6, and only then the name column, whose longest name ends in "."
  // where it is cut. Wider, the name column is no wider than the longest name needs, and
  // in a window wider than the grid each side of zero takes half of what it adds.
  const longest = Math.max(...pairs.map((c) => label(c).length));
  const narrowed = Math.max(6, Math.min(12, Math.floor((within(room) - Math.min(longest, 38) - 8) / 2)));
  const nameWidth = Math.max(12, Math.min(38, longest, within(room) - 2 * narrowed - 8)) + 1;
  const side = narrowed + Math.floor(beyond(room) / 2);
  const lines: Line[] = [...pairs]
    .sort((a, b) => b.value - a.value)
    .map((c) => {
      const name = label(c);
      const length = bar(Math.abs(c.value), side, plain);
      // A correlation is not a move, so its bar takes the chart colour, never green or red.
      const left = c.value < 0 ? length.padStart(side) : ' '.repeat(side);
      const right = c.value >= 0 ? length.padEnd(side) : ' '.repeat(side);
      return [t('fg', (name.length > nameWidth - 1 ? `${name.slice(0, nameWidth - 2)}.` : name).padEnd(nameWidth)), t('chart', left), t('rule', '│', '|'), t('chart', right), t('bright', ` ${c.value >= 0 ? '+' : '-'}${Math.abs(c.value).toFixed(2)}`)];
    });
  lines.push([t('dim', `${' '.repeat(nameWidth)}${'-1'.padEnd(side)}0${'+1'.padStart(side)}`)]);
  // Each pair carries its own window and count (a stock trades fewer days than Bitcoin),
  // so the line says one window and one count only where every pair shares them.
  const starts = pairs.map((c) => c.window_start).filter((d): d is string => Boolean(d)).sort();
  const ends = pairs.map((c) => c.window_end).filter((d): d is string => Boolean(d)).sort();
  const counts = pairs.map((c) => c.observations).filter((n): n is number => typeof n === 'number');
  const oneWindow = starts.length === pairs.length && ends.length === pairs.length && starts[0] === starts.at(-1) && ends[0] === ends.at(-1);
  const window = !starts.length || !ends.length ? '' : oneWindow ? `${starts[0]} to ${ends[0]}` : `windows from ${starts[0]} to ${ends.at(-1)}`;
  const low = Math.min(...counts);
  const high = Math.max(...counts);
  const observed = !counts.length ? '' : low === high ? `${low} observations` : `${low} to ${high} observations a pair`;
  lines.push([], [t('dim', `> ${block.id}: daily returns, paired by date${window ? `, ${window}` : ''}${observed ? `, ${observed}` : ''}`)]);
  // The strongest pair as PreReason read it, in its own sentence, cited; a pair of markets
  // before one with Bitcoin.
  const strongest = [...pairs].sort((a, b) => Number(/bitcoin|btc|hash/.test(`${a.metric1}${a.metric2}`)) - Number(/bitcoin|btc|hash/.test(`${b.metric1}${b.metric2}`)) || Math.abs(b.value) - Math.abs(a.value))[0] as (ServedCorrelation & { interpretation?: string; pair?: string }) | undefined;
  if (strongest?.interpretation) lines.push(...quoted(t, strongest.interpretation, `${block.id}, ${strongest.pair ?? `${strongest.metric1}_vs_${strongest.metric2}`}`, within(room)));
  return { title: 'Correlations', subtitle: 'daily returns, paired by date', lines, sources: block.id, generated: body.generated_at ?? null };
}

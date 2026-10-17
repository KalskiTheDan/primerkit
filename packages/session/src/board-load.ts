import { join } from 'node:path';
import { RunCancelled, forwardAccount, loadRoutine, longDay, reachOf, readForward, readForwardCloses, readForwardSchedule, replayOf, tickWorkings, type Snapshots } from '@primerkit/core';
import { BITCOIN_HISTORY_START, PreReasonError, TIERS, type CatalogEntry, type MetricEntry, type PricePoint, type SingleMetric, type Tier } from '@primerkit/connector-prereason';
import type { Maker } from '@primerkit/ui';
import {
  BITCOIN_RANGES,
  BRIEF_DAYS,
  bitcoinBoard,
  briefBoard,
  heatBoard,
  METRIC_NAMES,
  METRIC_RANGES,
  metricChartBoard,
  metricSeries,
  rangeDays,
  type MetricRange,
  correlationsBoard,
  daysBefore,
  hashpriceBoard,
  hashpricePoints,
  journalLevels,
  CURVE_ROWS,
  SERIES_ROWS,
  priceNow,
  sharedCurveDay,
  treasuryBoard,
  yieldCurveBoard,
  type BitcoinRange,
  type Board,
  type CurveExtra,
} from './boards';
import { backtestBoard, forwardBoard, tickBoard } from './boards-backtest';
import { ETF_DAYS, etfFlowDays, etfFlowsBoard, journalMetric, liquidityBoard } from './boards-flows';
import { MARKET_GROUP_IDS, MARKET_MAP, POSITIONING, POSITIONING_IDS, groupedMapBoard, isoTime, keptReadings, marketMapBoard, positioningBoard, type MetricRead } from './boards-markets';
import { readBriefing, tryAgainIn, type Briefings } from './engine';
import { BOARD_ROOM, fitLines } from './fit';

// What /brief and /chart ask for, read from what the person typed.
export type BoardRequest =
  | { kind: 'brief'; briefing: string; fill?: boolean; heat?: boolean }
  | { kind: 'yield curve'; compare: '30d' | '90d' | '1y' | { date: string } }
  | { kind: 'bitcoin'; range: BitcoinRange }
  | { kind: 'hashprice'; fill: boolean }
  | { kind: 'treasury' }
  | { kind: 'correlations'; briefing: string }
  | { kind: 'etf flows'; fill: boolean }
  | { kind: 'liquidity' }
  // Metrics read on their own: nine markets by their 7 day change, and SPY beside the
  // speculative net position in S&P 500 futures.
  | { kind: 'market map' }
  // The markets grouped by asset class, a tile each.
  | { kind: 'markets' }
  | { kind: 'positioning' }
  // A metric over time, from the journal: its briefing found there or named, its range.
  | { kind: 'metric'; metric: string; briefing: string | null; range: MetricRange; fill: boolean }
  // A finished backtest of a routine, and the tick of its first repeat the arrows are on.
  | { kind: 'backtest'; routine: string; run: string; tick: number | null; ticks: number; detail?: boolean }
  // A routine's forward record, from its folder.
  | { kind: 'forward'; routine: string };

export const CHARTS = ['yield curve', 'bitcoin', 'hashprice', 'treasury', 'etf flows', 'liquidity', 'correlations', 'market map', 'markets', 'positioning'] as const;
export type Chart = (typeof CHARTS)[number];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The charts drawn from metrics read on their own, which the saved briefings do not hold.
const METRIC_CHARTS = ['market map', 'markets', 'positioning'] as const;
const isMetricChart = (chart: Chart): chart is (typeof METRIC_CHARTS)[number] => (METRIC_CHARTS as readonly string[]).includes(chart);

// The briefings each chart draws from, any one of them enough; Bitcoin's chart reads the
// price history instead.
const CHART_READS: Record<Exclude<Chart, 'bitcoin' | (typeof METRIC_CHARTS)[number]>, string[]> = {
  'yield curve': ['macro.rates', 'macro.snapshot'],
  hashprice: ['btc.miner-survival'],
  treasury: ['btc.treasury'],
  'etf flows': ['btc.etf-flows'],
  liquidity: ['macro.liquidity'],
  correlations: ['cross.correlations'],
};

// Whether a chart can be drawn on this connection, so /chart offers only those: saved
// briefings say for themselves what they hold; a live connection, or none yet, offers
// every chart, and reading says what a key cannot reach.
export function chartDraws(chart: Chart, data: Briefings | null): boolean {
  if (!data) return true;
  if (chart === 'bitcoin') return Boolean(data.bitcoinHistory);
  if (isMetricChart(chart)) return Boolean(data.metric);
  const has = data.has?.bind(data);
  return !has || CHART_READS[chart].some((id) => has(id));
}

// ------------------------------------------------------------------ what a key's tier draws

// The tiers in order, each reading all the one before it reads.
const rank = (tier: Tier): number => TIERS.indexOf(tier);
const NAMED: Record<Tier, string> = { free: 'Free', basic: 'Basic', pro: 'Pro', enterprise: 'Enterprise' };
export const tierName = (tier: Tier): string => NAMED[tier];

// The first day a Bitcoin range asks for. A range of N days counts today as its last, so 30d
// is today and the 29 days before it, which a free key reads. Nothing before the history's
// first day is asked for, whatever day is typed.
export function rangeFrom(range: BitcoinRange, today: string): string {
  const asked = typeof range === 'object' ? range.from : range === 'all' ? BITCOIN_HISTORY_START : daysBefore(today, (range === '30d' ? 30 : range === '90d' ? 90 : 365) - 1);
  return asked < BITCOIN_HISTORY_START ? BITCOIN_HISTORY_START : asked;
}

// The lowest tier that reads a day, by how far back each reads (reachOf).
function tierReaching(day: string, today: string): Tier {
  return TIERS.find((tier) => (reachOf(tier, today) ?? day) <= day) ?? 'enterprise';
}

// Bitcoin with no range typed: 90 days, or 30 on a key that does not read 90 days back. A key
// whose tier is not known is taken at the smallest reach, as reachOf takes it.
export function bitcoinDefault(tier: Tier | null, today: string): BitcoinRange {
  return rank(tierReaching(rangeFrom('90d', today), today)) <= rank(tier ?? 'free') ? '90d' : '30d';
}

// What PreReason lists about tiers, as the charts read it: the catalog's briefings, each with
// the tier that reads it, and the list of metrics, each with the tier that serves it in full.
// Either is null where it was not read.
export interface TierLists {
  briefings: CatalogEntry[] | null;
  metrics: MetricEntry[] | null;
}

// The lowest tier that draws a chart over its range, from what PreReason lists; null where
// the lists do not say. A chart of briefings needs the lowest tier among those it can draw
// from, and a past day as far back as it asks for. The market map draws each market's 7 day
// change, served at each metric's own tier; positioning draws the latest readings, which
// every key reads.
export function requestTier(req: BoardRequest, lists: TierLists, today: string): Tier | null {
  const lowest = (ids: readonly string[]): Tier | null => {
    const tiers = ids.flatMap((id) => lists.briefings?.find((b) => b.id === id)?.tier ?? []);
    return tiers.length ? tiers.reduce((a, b) => (rank(b) < rank(a) ? b : a)) : null;
  };
  switch (req.kind) {
    case 'bitcoin':
      return tierReaching(rangeFrom(req.range, today), today);
    case 'yield curve': {
      // 30d and 90d are drawn from today's briefing; 1y and a date read one as it stood then,
      // which a key reads only as far back as its tier does.
      const day = req.compare === '30d' || req.compare === '90d' ? today : req.compare === '1y' ? daysBefore(today, 365) : req.compare.date;
      const briefing = lowest(CHART_READS['yield curve']);
      const dated: Tier = day >= (reachOf('free', today) ?? day) ? 'free' : 'basic';
      if (!briefing) return null;
      return rank(briefing) >= rank(dated) ? briefing : dated;
    }
    case 'correlations':
      return lowest([req.briefing]);
    case 'hashprice':
    case 'treasury':
    case 'etf flows':
    case 'liquidity':
      return lowest(CHART_READS[req.kind]);
    case 'markets':
    case 'market map': {
      const tiers = (req.kind === 'markets' ? MARKET_GROUP_IDS : MARKET_MAP.map((s) => s.id)).map((id) => lists.metrics?.find((m) => m.id === id)?.fullAt ?? null);
      return tiers.every((x): x is Tier => x !== null) ? tiers.reduce((a, b) => (rank(b) > rank(a) ? b : a)) : null;
    }
    case 'positioning':
      return 'free';
    default:
      return null;
  }
}

// The words for a chart a key cannot draw, said before anything is read: what the key reads,
// and the tier that draws the chart.
function beyondTier(req: BoardRequest, tier: Tier | null, needs: Tier, today: string, catalog: string): string {
  const key = tier ? `A ${tierName(tier)} key` : "This key's tier";
  const reach = tier ? reachOf(tier, today) : null;
  // How far back the key reads: a number of days where its reach moves with today, else from
  // its first day.
  const back = !tier || !reach ? 'less far back' : tier === 'free' ? `${daysBetween(reach, today) + 1} days back` : `back to ${longDay(reach)}`;
  const needed = `needs a ${tierName(needs)} key or above`;
  if (req.kind === 'bitcoin') return `${key} reads Bitcoin's price ${back}; ${typeof req.range === 'object' ? `from ${req.range.from}` : req.range} ${needed}.`;
  if (req.kind === 'yield curve' && (req.compare === '1y' || typeof req.compare === 'object') && needs === 'basic') {
    return `${key} reads the yield curve as it stood up to ${back}; ${typeof req.compare === 'object' ? req.compare.date : req.compare} ${needed}.`;
  }
  if (req.kind === 'market map') return `The market map ${needed}: it draws each market's 7 day change, and ${tier ? `a ${tierName(tier)} key` : 'this key'} reads each market's level alone. ${catalog} lists what your key reads.`;
  const reads = req.kind === 'correlations' ? [req.briefing] : req.kind in CHART_READS ? CHART_READS[req.kind as keyof typeof CHART_READS] : [];
  return `The ${req.kind} chart ${needed}${reads.length ? `, for ${reads.join(' or ')}` : ''}; ${catalog} lists what your key reads.`;
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const listed = (names: string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

// The charts as primerkit --help lists them, each with what can follow its name, and the
// ranges whose tier is named on their own.
const HELP_CHARTS: Array<{ chart: Chart; args: string; ranges: string[] }> = [
  { chart: 'yield curve', args: '[30d|90d|1y|date]', ranges: ['30d', '90d', '1y'] },
  { chart: 'bitcoin', args: '[30d|90d|1y|all|from date]', ranges: ['30d', '90d', '1y', 'all'] },
  { chart: 'hashprice', args: '[fill]', ranges: [] },
  { chart: 'treasury', args: '', ranges: [] },
  { chart: 'etf flows', args: '[fill]', ranges: [] },
  { chart: 'liquidity', args: '', ranges: [] },
  { chart: 'correlations', args: '[briefing]', ranges: [] },
  { chart: 'market map', args: '', ranges: [] },
  { chart: 'markets', args: '', ranges: [] },
  { chart: 'positioning', args: '', ranges: [] },
];

// --help's list of charts, each marked with the tier it needs where that is above Free, from
// PreReason's lists: "liquidity (Basic)", and a range on its own, "(90d and 1y: Basic, all: Pro)".
// A chart the lists say nothing about is left unmarked. In parts that are never split across
// lines, each with its punctuation.
export function chartHelp(lists: TierLists, today: string): string[] {
  const tierOf = (text: string): Tier | null => {
    const req = parseBoard('chart', text);
    return 'error' in req ? null : requestTier(req, lists, today);
  };
  const paid = (tier: Tier | null): tier is Tier => tier !== null && tier !== 'free';
  const items = HELP_CHARTS.map(({ chart, args, ranges }) => {
    const name = args ? `${chart} ${args}` : chart;
    if (!ranges.length) {
      const tier = tierOf(chart);
      return paid(tier) ? `${name} (${tierName(tier)})` : name;
    }
    const byTier = new Map<Tier, string[]>();
    for (const range of ranges) {
      const tier = tierOf(`${chart} ${range}`);
      if (paid(tier)) byTier.set(tier, [...(byTier.get(tier) ?? []), range]);
    }
    return byTier.size ? `${name} (${[...byTier].map(([tier, named]) => `${listed(named)}: ${tierName(tier)}`).join(', ')})` : name;
  });
  return [...items.map((item, i) => `${item}${i < items.length - 1 ? ',' : ';'}`), 'a tier named is the least key that draws it'];
}

// key: the key's tier where it is known, and today, so Bitcoin with no range typed draws as
// far back as that key reads, up to 90 days.
export function parseBoard(command: 'brief' | 'chart', text: string, key?: { tier: Tier | null; today: string }): BoardRequest | { error: string } {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (command === 'brief') {
    return words[0] ? { kind: 'brief', briefing: words[0], ...(words[1] === 'fill' ? { fill: true } : {}), ...(words[1] === 'heat' ? { heat: true } : {}) } : { error: 'Say which briefing: /brief macro.snapshot' };
  }
  const pair = `${words[0] ?? ''} ${words[1] ?? ''}`;
  const two = pair === 'yield curve' || pair === 'etf flows' || pair === 'market map' ? pair : null;
  const name = two ?? words[0] ?? '';
  const args = words.slice(two ? 2 : 1);
  const arg = args[0] ?? null;
  switch (name) {
    case 'yield curve':
      if (!arg) return { kind: 'yield curve', compare: '30d' };
      if (arg === '30d' || arg === '90d' || arg === '1y') return { kind: 'yield curve', compare: arg };
      return DATE.test(arg) ? { kind: 'yield curve', compare: { date: arg } } : { error: 'The yield curve compares with 30d, 90d, 1y or a date such as 2025-09-26.' };
    case 'bitcoin':
      if (!arg) return { kind: 'bitcoin', range: key ? bitcoinDefault(key.tier, key.today) : '90d' };
      if ((BITCOIN_RANGES as readonly string[]).includes(arg)) return { kind: 'bitcoin', range: arg as BitcoinRange };
      if (arg === 'from' && args[1] && DATE.test(args[1])) return { kind: 'bitcoin', range: { from: args[1] } };
      return { error: 'Bitcoin draws over 30d, 90d, 1y, all, or from a date: /chart bitcoin from 2025-01-01' };
    case 'hashprice':
      return { kind: 'hashprice', fill: arg === 'fill' };
    case 'treasury':
      return { kind: 'treasury' };
    case 'etf flows':
      return { kind: 'etf flows', fill: arg === 'fill' };
    case 'liquidity':
      return { kind: 'liquidity' };
    case 'correlations':
      return { kind: 'correlations', briefing: arg ?? 'cross.correlations' };
    case 'market map':
      return { kind: 'market map' };
    case 'markets':
      return { kind: 'markets' };
    case 'positioning':
      return { kind: 'positioning' };
    // A heatmap of a briefing's changes: /brief <briefing> heat, by another name.
    case 'heatmap':
      return { kind: 'brief', briefing: arg ?? 'macro.snapshot', heat: true };
    default: {
      // A metric over time: its id (any with a dash), or a short name such as gold or spy,
      // then "in <briefing>", a range and fill, in any order.
      const id = METRIC_NAMES[name] ?? (name.includes('-') ? name : null);
      if (!id) return { error: `The charts are ${CHARTS.join(', ')}, or a metric over time, such as /chart treasury-10y.` };
      const rest = words.slice(1);
      const at = rest.indexOf('in');
      const briefing = at >= 0 ? (rest[at + 1] ?? null) : null;
      const range = (rest.find((w) => (METRIC_RANGES as readonly string[]).includes(w)) as MetricRange | undefined) ?? '30d';
      return { kind: 'metric', metric: id, briefing, range, fill: rest.includes('fill') };
    }
  }
}

export interface BoardEnv {
  data: Briefings;
  snapshots: Snapshots | null;
  today: string; // YYYY-MM-DD, UTC
  now?: string; // the ISO time of the read, which a board of metrics names; the clock's where absent
  onStatus?: (text: string) => void;
  routines?: string; // where the person's routines are kept, for a backtest's replay
  journal?: string; // the journal's folder, for a tick's inner workings
  // The key's tier where it is known (as the config keeps it), and PreReason's lists, read
  // only where a chart needs them: on a known tier, a chart the key cannot draw is refused
  // before any call is spent on it. Without them every chart is read, and PreReason's answer
  // says what the key cannot reach.
  tier?: Tier | null;
  lists?: { briefings?: () => Promise<CatalogEntry[]>; metrics?: () => Promise<MetricEntry[]> };
  hints?: { catalog: string }; // what lists what a key reads: /catalog in the session
  // Aborted when the board is closed or another is asked for: nothing more is read for it.
  signal?: AbortSignal;
}

// The key's tier where it is known: as PreReason last named it, else as the config keeps it.
// Saved briefings say for themselves what they hold, so no tier stands for them.
const knownTier = (env: BoardEnv): Tier | null => (env.data.has ? null : (env.data.tier ?? env.tier ?? null));

// What a chart needs of PreReason's lists to know its tier, read where the key's tier is
// known and below the top; a list that cannot be read is not known, and the chart is read.
async function listsFor(req: BoardRequest, env: BoardEnv): Promise<TierLists> {
  const tier = knownTier(env);
  const none: TierLists = { briefings: null, metrics: null };
  if (!tier || rank(tier) >= rank('pro')) return none;
  const ofBriefings = req.kind === 'bitcoin' || req.kind === 'yield curve' || req.kind === 'correlations' || req.kind in CHART_READS;
  const briefings = ofBriefings && env.lists?.briefings ? await env.lists.briefings().catch(() => null) : null;
  const metrics = req.kind === 'market map' && env.lists?.metrics ? await env.lists.metrics().catch(() => null) : null;
  return { briefings: briefings?.length ? briefings : null, metrics: metrics?.length ? metrics : null };
}

// Whether the key reads a briefing, by the catalog; true where either is not known.
const keyReads = (id: string, tier: Tier | null, lists: TierLists): boolean => {
  const entry = lists.briefings?.find((b) => b.id === id);
  return !tier || !entry || rank(entry.tier) <= rank(tier);
};

// Reads what a board needs, and returns its drawing: in Unicode or plain, as the
// terminal takes it, in `room` columns, to which each board narrows as far as it can,
// and in `rows` rows where a window is taller than a board needs, which a chart grows
// into. Each briefing read is kept as a snapshot, so the journal's histories grow with use.
export type Draw = (t: Maker, plain: boolean, room?: number, rows?: number) => Board;

// A line chart grows taller where the window has rows to spare: drawn at its height on
// the grid first, then again with every row the board leaves unused, counted as its
// sentences wrap on screen, up to a quarter of the room's width, so it stays wider than
// it is tall. A window with no rows to spare gets the chart as it always was.
export function taller(t: Maker, draw: (height?: number) => Board, base: number, room: number, rows: number | undefined): Board {
  const board = draw();
  const used = fitLines(t, board.lines, Math.min(room, BOARD_ROOM)).length;
  if (!rows || used >= rows) return board;
  const height = Math.min(base + rows - used, Math.max(base, Math.floor(room / 4)));
  return height > base ? draw(height) : board;
}

// The briefings that carry net liquidity, for its 30 days from the journal.
const NET_LIQUIDITY_BRIEFINGS = ['macro.liquidity', 'macro.snapshot', 'btc.context', 'cross.correlations'];

// Whether to ask for macro.rates: saved briefings say for themselves, a known tier
// decides, and an unknown tier asks and falls back if refused.
function readsRates(data: Briefings, tier: Tier | null): boolean {
  if (data.has) return data.has('macro.rates');
  if (tier) return tier === 'pro' || tier === 'enterprise';
  return true;
}

export async function loadBoard(req: BoardRequest, env: BoardEnv): Promise<Draw> {
  // On a known tier, a chart the key cannot draw is refused here, before any call.
  const tier = knownTier(env);
  const lists = await listsFor(req, env);
  const needs = tier ? requestTier(req, lists, env.today) : null;
  if (tier && needs && rank(needs) > rank(tier)) throw new Error(beyondTier(req, tier, needs, env.today, env.hints?.catalog ?? '/catalog'));
  const say = (text: string) => env.onStatus?.(text);
  // Before each call to PreReason: a board closed while it reads asks for nothing more.
  const open = () => {
    if (env.signal?.aborted) throw new RunCancelled();
  };
  const read = (briefing: string, date?: string) => {
    open();
    say(date ? `reading ${briefing} as it stood on ${date}` : `reading ${briefing}`);
    return readBriefing({ data: env.data, snapshots: env.snapshots }, briefing, 'json', date);
  };
  // A metric on its own, where the connection reads one; null where it cannot.
  const single = async (name: string): Promise<SingleMetric | null> => {
    if (!env.data.metric) return null;
    open();
    say(`reading ${name}`);
    return env.data.metric(name).catch(() => null);
  };
  // Metrics read on their own for a chart of them, one call each. Each answer is kept as
  // served, by the metric's own time, so the charts' lines over time grow with use; a
  // metric not read says why.
  const metrics = async (ids: readonly string[], chart: string): Promise<{ reads: MetricRead[]; at: string }> => {
    const read = env.data.metric?.bind(env.data);
    if (!read) throw new Error(`The saved briefings carry no metrics on their own, which the ${chart} is drawn from. They are read from PreReason once it is connected.`);
    const at = env.now ?? new Date().toISOString();
    const reads: MetricRead[] = [];
    for (const id of ids) {
      open();
      say(`reading ${id}`);
      let metric: SingleMetric;
      try {
        metric = await read(id);
      } catch (error) {
        // A key PreReason does not accept, or the account's rate limit, would answer every
        // call after it the same: nothing more is asked, and the board says what PreReason
        // answered rather than drawing a tile for each that looks like the tier's.
        if (error instanceof PreReasonError && (error.status === 401 || error.status === 429)) throw new Error([`${error.message}.`, tryAgainIn(error.retryAfterSeconds)].filter(Boolean).join(' '));
        const onKey = error instanceof PreReasonError && (error.tierRefusal || error.status === 403);
        reads.push({ id, metric: null, missed: { onKey, why: error instanceof Error ? error.message : String(error) } });
        continue;
      }
      reads.push({ id, metric });
      if (metric.raw) env.snapshots?.save({ id, source: 'prereason', format: 'json', fetchedAt: at, generatedAt: isoTime(metric.timestamp) ?? at, lines: [], raw: metric.raw });
    }
    return { reads, at };
  };
  switch (req.kind) {
    case 'brief': {
      const block = await read(req.briefing);
      if (req.fill) {
        // The days of the last 30 the journal lacks, each read as it stood that day.
        const kept = journalLevels(env.snapshots, req.briefing, BRIEF_DAYS, env.today);
        const have = new Set(kept.days.filter((_, i) => [...kept.levels.values()].some((row) => row[i] !== null)));
        for (const day of kept.days.slice(0, -1)) if (!have.has(day)) await read(req.briefing, day);
      }
      return (t, plain, room) => (req.heat ? heatBoard(t, plain, block, room) : briefBoard(t, plain, block, env.snapshots, env.today, room));
    }
    case 'yield curve': {
      // macro.rates carries all five maturities, today and on a past date, and is a Pro
      // briefing. A key below Pro reads macro.snapshot and the 3 month and 5 year metrics
      // instead; a key whose tier is not known tries macro.rates first.
      const rates = readsRates(env.data, tier) ? await read('macro.rates').catch(() => null) : null;
      // One curve, one day: where the newest values span two days, the curve is read as
      // it stood on the newest day all of them share.
      const shared = rates ? sharedCurveDay(rates) : null;
      const current = shared ? await read('macro.rates', shared).catch(() => null) : null;
      const nowDay = current ? shared ?? undefined : undefined;
      const today = current ?? rates ?? (await read('macro.snapshot'));
      const extra: CurveExtra = rates ? {} : { m3: await single('treasury-3mo'), y5: await single('treasury-5y') };
      const ago = req.compare;
      if (ago === '30d' || ago === '90d') return (t, plain, room = BOARD_ROOM, rows) => taller(t, (h) => yieldCurveBoard(t, plain, today, { kind: 'ago', horizon: ago }, extra, nowDay, room, h), CURVE_ROWS, room, rows);
      const date = ago === '1y' ? daysBefore(env.today, 365) : ago.date;
      const then = (rates ? await read('macro.rates', date).catch(() => null) : null) ?? (await read('macro.snapshot', date));
      return (t, plain, room = BOARD_ROOM, rows) => taller(t, (h) => yieldCurveBoard(t, plain, today, { kind: 'date', date, block: then }, extra, nowDay, room, h), CURVE_ROWS, room, rows);
    }
    case 'bitcoin': {
      if (!env.data.bitcoinHistory) throw new Error('The saved briefings carry no price history. It is read from PreReason once it is connected.');
      const range = req.range;
      const from = rangeFrom(range, env.today);
      say(`reading the Bitcoin price history from ${from}`);
      // Up to 1,000 days a call, so a long range takes a few.
      const points: PricePoint[] = [];
      try {
        for (let start = from; start <= env.today; start = daysBefore(start, -1000)) {
          open();
          const end = daysBefore(start, -999) < env.today ? daysBefore(start, -999) : env.today;
          points.push(...(await env.data.bitcoinHistory({ from: start, to: end })));
        }
      } catch (error) {
        // A range past a key whose tier was not known: said as a known one is, never in
        // PreReason's own sentence. The refusal names the tier, where PreReason sent it.
        if (error instanceof PreReasonError && error.code === 'DATE_RESTRICTED') throw new Error(beyondTier(req, knownTier(env), tierReaching(from, env.today), env.today, env.hints?.catalog ?? '/catalog'));
        throw error;
      }
      // btc.momentum is not asked of a key the catalog says cannot read it.
      const momentum = keyReads('btc.momentum', tier, lists) ? await read('btc.momentum').catch(() => null) : null;
      // The price now: btc.momentum carries it where the key reads that briefing, and a key
      // below Basic reads it from btc.quick-check, the smallest free briefing that does.
      const now = priceNow(momentum) ?? priceNow(await read('btc.quick-check').catch(() => null));
      return (t, plain, room = BOARD_ROOM, rows) => taller(t, (h) => bitcoinBoard(t, plain, points, range, momentum, room, now, h), SERIES_ROWS, room, rows);
    }
    case 'hashprice': {
      const want = 90;
      if (req.fill) {
        const have = new Set(hashpricePoints(env.snapshots, want, env.today).map((p) => p.date));
        await read('btc.miner-survival');
        for (let i = want - 1; i >= 1; i -= 1) {
          const day = daysBefore(env.today, i);
          if (!have.has(day)) await read('btc.miner-survival', day);
        }
      } else if (!hashpricePoints(env.snapshots, 1, env.today).length) {
        await read('btc.miner-survival');
      }
      const points = hashpricePoints(env.snapshots, want, env.today);
      const left = env.data.budget?.remaining ?? null;
      return (t, plain, room = BOARD_ROOM, rows) => taller(t, (h) => hashpriceBoard(t, plain, points, want, left, room, h), SERIES_ROWS, room, rows);
    }
    case 'treasury': {
      const block = await read('btc.treasury');
      return (t, plain, room) => treasuryBoard(t, plain, block, room);
    }
    case 'etf flows': {
      const block = await read('btc.etf-flows');
      if (req.fill) {
        // Trading days come a few fewer than calendar days, so six weeks back covers 30.
        const kept = new Set((env.snapshots?.list('btc.etf-flows', 'json') ?? []).map((s) => s.generatedAt.slice(0, 10)));
        for (let i = 42; i >= 1; i -= 1) {
          const day = daysBefore(env.today, i);
          if (!kept.has(day)) await read('btc.etf-flows', day);
        }
      }
      const days = etfFlowDays(env.snapshots, ETF_DAYS);
      const left = env.data.budget?.remaining ?? null;
      return (t, plain, room) => etfFlowsBoard(t, plain, block, days, left, room);
    }
    case 'liquidity': {
      const block = await read('macro.liquidity');
      const history = journalMetric(env.snapshots, NET_LIQUIDITY_BRIEFINGS, 'net-liquidity', 30, env.today);
      return (t, plain, room) => liquidityBoard(t, plain, block, history, room);
    }
    case 'correlations': {
      const block = await read(req.briefing);
      return (t, plain, room) => correlationsBoard(t, plain, block, room);
    }
    case 'metric': {
      const days = rangeDays(req.range);
      const reach = tier ? reachOf(tier, env.today) : null;
      let series = metricSeries(env.snapshots, req.metric, req.briefing, days, env.today);
      // A briefing named but not kept yet is read today, one call, so its newest day is there.
      if (!series.key && req.briefing) {
        await read(req.briefing);
        series = metricSeries(env.snapshots, req.metric, req.briefing, days, env.today);
      }
      if (req.fill && series.briefing && series.key) {
        const have = new Set(series.points.map((p) => p.date));
        for (let i = days - 1; i >= 1; i -= 1) {
          const day = daysBefore(env.today, i);
          if (!have.has(day) && (!reach || day >= reach)) await read(series.briefing, day);
        }
        series = metricSeries(env.snapshots, req.metric, series.briefing, days, env.today);
      }
      const left = env.data.budget?.remaining ?? null;
      const final = series;
      return (t, plain, room = BOARD_ROOM, rows) => taller(t, (h) => metricChartBoard(t, plain, req.metric, final, req.range, reach, left, room, h), SERIES_ROWS, room, rows);
    }
    case 'market map': {
      const { reads, at } = await metrics(MARKET_MAP.map((s) => s.id), 'market map');
      return (t, plain, room) => marketMapBoard(t, plain, reads, at, room);
    }
    case 'markets': {
      // The markets by asset class, as many tiles across as the window holds.
      const { reads, at } = await metrics(MARKET_GROUP_IDS, 'map of markets');
      return (t, plain, room) => groupedMapBoard(t, plain, reads, at, room);
    }
    case 'positioning': {
      const { reads, at } = await metrics(POSITIONING_IDS, 'positioning chart');
      // A year of SPY's days and three years of the weekly reports, at most.
      const kept = { spy: keptReadings(env.snapshots, POSITIONING.spy, 'day', 365), net: keptReadings(env.snapshots, POSITIONING.net, 'reading', 156) };
      return (t, plain, room) => positioningBoard(t, plain, reads, kept, at, room);
    }
    case 'backtest': {
      // From the run's own folder: nothing is read from PreReason or asked of a model.
      if (!env.routines) throw new Error('This session keeps no routines.');
      const replay = replayOf(loadRoutine(join(env.routines, req.routine)), req.run);
      if (!replay) throw new Error(`${req.routine} has no finished backtest ${req.run}.`);
      const tick = req.tick !== null ? replay.run.ticks[req.tick] : undefined;
      if (req.detail && tick) {
        const workings = tickWorkings(replay, env.journal ?? null, tick);
        return (t, _plain, room) => tickBoard(t, replay, tick, workings, room);
      }
      return (t, plain, room, rows) => taller(t, (height) => backtestBoard(t, plain, replay, room, height, req.tick), SERIES_ROWS, room ?? BOARD_ROOM, rows);
    }
    case 'forward': {
      if (!env.routines) throw new Error('This session keeps no routines.');
      const routine = loadRoutine(join(env.routines, req.routine));
      const account = forwardAccount(readForward(routine), readForwardCloses(routine), routine.spec.fees.perTrade ?? 0);
      const o = { routine: req.routine, briefings: routine.spec.briefings, account, schedule: readForwardSchedule(routine) };
      return (t, plain, room, rows) => taller(t, (height) => forwardBoard(t, plain, o, room, height), SERIES_ROWS, room ?? BOARD_ROOM, rows);
    }
  }
}

// The next range for the arrow keys, where a chart has them.
export function nextRange(req: BoardRequest, step: 1 | -1): BoardRequest | null {
  if (req.kind === 'bitcoin') {
    const at = typeof req.range === 'object' ? 1 : BITCOIN_RANGES.indexOf(req.range);
    const next = BITCOIN_RANGES[(at + step + BITCOIN_RANGES.length) % BITCOIN_RANGES.length]!;
    return { kind: 'bitcoin', range: next };
  }
  if (req.kind === 'metric') {
    const at = METRIC_RANGES.indexOf(req.range);
    return { ...req, range: METRIC_RANGES[(at + step + METRIC_RANGES.length) % METRIC_RANGES.length]!, fill: false };
  }
  if (req.kind === 'yield curve') {
    const order = ['30d', '90d', '1y'] as const;
    const at = typeof req.compare === 'object' ? 0 : order.indexOf(req.compare);
    return { kind: 'yield curve', compare: order[(at + step + order.length) % order.length]! };
  }
  // A backtest's arrows move through its ticks, and stop at either end.
  if (req.kind === 'backtest') {
    const tick = req.tick === null ? (step === 1 ? 0 : req.ticks - 1) : Math.min(req.ticks - 1, Math.max(0, req.tick + step));
    return tick === req.tick ? null : { ...req, tick };
  }
  return null;
}

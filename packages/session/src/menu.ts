// The menu under the input at home. Typing / lists every command with what it does,
// and the list narrows as the command is typed; /brief, /chart and /routine open a list
// of their own. The arrow keys move through it and Enter runs the row, so no command has
// to be remembered, and a command typed in full still runs as typed.

import type { Tier } from '@primerkit/connector-prereason';
import { tierName, type Chart } from './board-load';

export interface MenuRow {
  text: string; // the command as it runs, such as "/chart yield curve 90d"
  about: string; // what it does, in a few words
  opens?: boolean; // choosing it lists its own options instead of running it
}

export interface Menu {
  rows: MenuRow[];
  cursor: number;
}

// The functions the launchpad lists, each with a short code: a code typed alone, and Enter,
// runs its command, or puts it in the input where it takes more, as /brief does.
export const FUNCTIONS: ReadonlyArray<{ code: string; command: string; about: string; opens?: boolean }> = [
  { code: 'DG', command: '/digest', about: 'what changed' },
  { code: 'BR', command: '/brief', about: 'a briefing as a board', opens: true },
  { code: 'CH', command: '/chart', about: 'a chart', opens: true },
  { code: 'CT', command: '/catalog', about: 'every briefing, metric' },
  { code: 'CP', command: '/compare', about: 'briefings and web search', opens: true },
  { code: 'JR', command: '/journal', about: 'every run, kept here' },
  { code: 'MD', command: '/model', about: 'switch the model' },
  { code: 'CN', command: '/connect', about: 'data and brokers' },
];

// The function a typed code names, in either case; null where it names none.
export function functionOf(typed: string): (typeof FUNCTIONS)[number] | null {
  const code = typed.trim().toUpperCase();
  return FUNCTIONS.find((f) => f.code === code) ?? null;
}

export interface MenuContext {
  briefings: Array<{ id: string; name: string }> | null; // what /brief can read; null while the list is read
  hosted: boolean; // the model in use runs at a provider, which charges for /bench
  routines?: string[] | null; // the person's routines; null where none can be kept, as in the demo
  charts?: (chart: Chart) => boolean; // whether a chart can be drawn here; every chart where absent
  // The tier a /chart row needs, from what follows /chart; null where it is not known. A row
  // that needs more than a Free key names that tier, so a paid chart is known before it reads.
  chartTier?: (args: string) => Tier | null;
}

// In the order of the commands the help lists; each command's options follow it.
function commandRows(context: MenuContext): MenuRow[] {
  return [
    { text: '/digest', about: 'what changed since the last digest' },
    { text: '/brief', about: 'a briefing as a board, chosen next', opens: true },
    { text: '/chart', about: 'a chart, chosen next', opens: true },
    { text: '/catalog', about: 'every briefing and metric you can ask about' },
    { text: '/catalog all', about: 'the same, with every metric named' },
    { text: '/compare', about: 'one question, from the briefings and by web search', opens: true },
    { text: '/bench', about: 'the benchmark, on the model in use' },
    ...(context.hosted ? [{ text: '/bench yes', about: 'run it on your key; the provider charges' }] : []),
    { text: '/bench card', about: 'a share card of the last benchmark' },
    { text: '/routine', about: 'your rules, one label a run', opens: true },
    { text: '/journal', about: 'every run kept on this machine' },
    { text: '/model', about: 'switch the model; Tab from home does too' },
    { text: '/model check', about: 'check the model again' },
    { text: '/schedule', about: "set the morning digest's time" },
    { text: '/schedule remove', about: 'take the digest off the schedule' },
    { text: '/connect', about: 'every connection, on or off' },
    { text: '/connect prereason', about: 'connect PreReason' },
    { text: '/connect alpaca', about: 'how to connect Alpaca paper trading' },
    { text: '/help', about: 'what to type' },
    { text: '/clear', about: 'clear the feed' },
    { text: '/quit', about: 'leave primerkit' },
  ];
}

// Each chart, and each range it draws over; a date is typed, such as
// /chart yield curve 2025-09-26 or /chart bitcoin from 2025-01-01. Bitcoin with no range
// draws as far back as the key reads, so it names no tier.
const CHART_ROWS: Array<MenuRow & { chart: Chart; adapts?: true }> = [
  { chart: 'yield curve', text: '/chart yield curve', about: 'Treasury yields now and 30 days ago' },
  { chart: 'yield curve', text: '/chart yield curve 90d', about: 'now and 90 days ago' },
  { chart: 'yield curve', text: '/chart yield curve 1y', about: 'now and a year ago' },
  { chart: 'bitcoin', text: '/chart bitcoin', about: 'Bitcoin over 90 days, or as far as a Free key reads', adapts: true },
  { chart: 'bitcoin', text: '/chart bitcoin 30d', about: 'over 30 days' },
  { chart: 'bitcoin', text: '/chart bitcoin 1y', about: 'over a year' },
  { chart: 'bitcoin', text: '/chart bitcoin all', about: 'over all its price history' },
  { chart: 'hashprice', text: '/chart hashprice', about: 'hashprice, from your journal' },
  { chart: 'hashprice', text: '/chart hashprice fill', about: 'reads the missing days, a call each' },
  { chart: 'etf flows', text: '/chart etf flows', about: 'spot Bitcoin ETF flows by fund' },
  { chart: 'etf flows', text: '/chart etf flows fill', about: 'reads the missing days, a call each' },
  { chart: 'liquidity', text: '/chart liquidity', about: 'net liquidity and its parts' },
  { chart: 'market map', text: '/chart market map', about: 'nine markets by 7 day change, a call each' },
  { chart: 'markets', text: '/chart markets', about: 'markets by asset class, a tile each, a call each' },
  { chart: 'positioning', text: '/chart positioning', about: 'SPY beside S&P 500 futures positioning' },
  { chart: 'treasury', text: '/chart treasury', about: 'Bitcoin treasury holders' },
  { chart: 'correlations', text: '/chart correlations', about: 'correlations across markets' },
];

// The heatmap of a briefing's changes, which draws from any briefing the key reads.
const HEAT_ROWS: MenuRow[] = [
  { text: '/chart heatmap', about: "macro.snapshot's changes as a heatmap, 7, 30 and 90 days" },
  { text: '/chart heatmap btc.context', about: "btc.context's changes as a heatmap" },
  { text: '/chart heatmap cross.correlations', about: "cross.correlations' changes as a heatmap" },
];

// Each of the person's routines with what it can do, then a new one.
function routineRows(context: MenuContext): MenuRow[] {
  return [
    ...(context.routines ?? []).flatMap((n): MenuRow[] => [
      { text: `/routine ${n}`, about: 'what it reads and does' },
      { text: `/routine ${n} rules`, about: 'your rules file and its tests' },
      { text: `/routine ${n} test`, about: 'the logic tests, on the model in use' },
      ...(context.hosted ? [{ text: `/routine ${n} test yes`, about: 'run them on your key; the provider charges' }] : []),
      { text: `/routine ${n} replay`, about: 'its newest backtest, drawn again' },
      { text: `/routine ${n} track`, about: 'its forward record, a label a day' },
      { text: `/routine ${n} track run`, about: 'run the forward record once now' },
      { text: `/routine ${n} hypothesis`, about: 'your hypothesis card and its form check' },
      { text: `/routine ${n} research`, about: 'its newest backtest, hurdle by hurdle, H1 to H5' },
    ]),
    ...(context.routines ? [{ text: '/routine registry', about: 'every hypothesis and version, with its status' }] : []),
    { text: '/routine new', about: 'a new routine: type its name', opens: true },
  ];
}

// The rows for what is typed: none unless it starts with /, and otherwise every row
// that starts with it. The options of /brief, /chart and /routine show once the command
// and a space are typed.
export function menuRows(input: string, context: MenuContext): MenuRow[] {
  if (!input.startsWith('/')) return [];
  const typed = input.toLowerCase();
  const marked = (text: string, about: string): string => {
    const tier = context.chartTier?.(text.slice('/chart '.length)) ?? null;
    return tier && tier !== 'free' ? `${about} (${tierName(tier)})` : about;
  };
  const rows = typed.startsWith('/chart ')
    ? [...CHART_ROWS.filter((r) => !context.charts || context.charts(r.chart)).map(({ text, about, adapts }): MenuRow => ({ text, about: adapts ? about : marked(text, about) })), ...HEAT_ROWS]
    : typed.startsWith('/brief ')
      ? (context.briefings ?? []).map((b): MenuRow => ({ text: `/brief ${b.id}`, about: b.name }))
      : typed.startsWith('/routine ')
        ? routineRows(context)
        : commandRows(context);
  return rows.filter((r) => r.text.startsWith(typed));
}

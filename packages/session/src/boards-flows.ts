import { readFileSync } from 'node:fs';
import type { DataBlock, Snapshots } from '@primerkit/core';
import { bar, flowColumns, sparkline, type Line, type Maker } from '@primerkit/ui';
import { beyond, changeMark, changeText, daysBefore, levelOf, served, within, type Board } from './boards';
import { BOARD_ROOM } from './fit';

// Money moving: the spot Bitcoin ETFs' flows, and net liquidity drawn as the sum it is.
// Every figure is as PreReason served it; the only arithmetic here is named where it is
// done (the flow of the funds not listed, and the parts of net liquidity added up).

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = (iso: string) => `${WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const asOf = (iso: string | undefined) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : '');

// Dollars as the briefings write them: +$134.5M, -$11.8M, $6.75T.
export function money(v: number, signed = true): string {
  const a = Math.abs(v);
  const sign = !signed ? (v < 0 ? '-' : '') : v < 0 ? '-' : v > 0 ? '+' : '';
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  return `${sign}$${(a / 1e6).toFixed(1)}M`;
}

// A scale's step, which is always a round figure: $200M, $2.5B.
const stepMoney = (v: number) => (v >= 1e9 ? `$${Number((v / 1e9).toPrecision(3))}B` : `$${Number((v / 1e6).toPrecision(3))}M`);

interface ServedFlows {
  date?: string;
  generated_at?: string;
  metrics?: Record<string, { value_formatted?: string; timestamp?: string; trend?: { change_7d?: number; change_7d_available?: boolean; change_unit?: string } }>;
}

// ------------------------------------------------------------------ /chart etf flows

const FUNDS = [
  ['IBIT', 'btc-etf-ibit-flow'],
  ['FBTC', 'btc-etf-fbtc-flow'],
  ['GBTC', 'btc-etf-gbtc-flow'],
] as const;

export const ETF_DAYS = 30;

// The ETFs' net flow a trading day, from the journal. Each snapshot names its flow's own
// date, so a weekend read of Friday's flow counts once.
export function etfFlowDays(snapshots: Snapshots | null, count = ETF_DAYS): Array<{ day: string; flow: number }> {
  const byDay = new Map<string, number>();
  for (const s of snapshots?.list('btc.etf-flows', 'json') ?? []) {
    try {
      const m = (JSON.parse(readFileSync(s.path, 'utf8')) as ServedFlows).metrics?.['btc-etf-net-flow'];
      const flow = levelOf(m?.value_formatted);
      const day = m?.timestamp?.slice(0, 10);
      if (flow !== null && day) byDay.set(day, flow);
    } catch {
      // a snapshot that does not parse is left out
    }
  }
  return [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-count)
    .map(([day, flow]) => ({ day, flow }));
}

export function etfFlowsBoard(t: Maker, plain: boolean, block: DataBlock, days: Array<{ day: string; flow: number }>, callsLeft: number | null, room = BOARD_ROOM): Board {
  const body = served(block) as ServedFlows;
  const m = body.metrics ?? {};
  const net = levelOf(m['btc-etf-net-flow']?.value_formatted);
  const day = m['btc-etf-net-flow']?.timestamp?.slice(0, 10) ?? body.date ?? '';
  const funds = FUNDS.map(([name, key]) => ({ name, value: levelOf(m[key]?.value_formatted) }));
  // The funds not listed, as the net less the three that are.
  const rest = net !== null && funds.every((f) => f.value !== null) ? net - funds.reduce((s, f) => s + f.value!, 0) : null;
  const rows = [...funds, { name: 'the rest', value: rest }];
  const most = Math.max(1, ...rows.map((r) => Math.abs(r.value ?? 0)));
  // Each side of zero takes what the room leaves beside the name and the amount: the 16
  // columns it has on the grid, less in a narrower window, and half of every column a
  // wider one adds.
  const side = Math.max(6, Math.min(16, Math.floor((within(room) - 20) / 2))) + Math.floor(beyond(room) / 2);
  const heading = 'The day, by fund';
  const aside = 'the rest: the net less the three named';
  const lines: Line[] = heading.length + 2 + aside.length <= room ? [[t('muted', heading), t('dim', `  ${aside}`)]] : [[t('muted', heading)], [t('dim', aside)]];
  for (const r of rows) {
    const length = r.value === null ? '' : bar(Math.abs(r.value) / most, side, plain);
    lines.push([
      t('fg', r.name.padEnd(10)),
      t('chart', r.value !== null && r.value < 0 ? length.padStart(side) : ' '.repeat(side)),
      t('rule', '│', '|'),
      t('chart', r.value !== null && r.value > 0 ? length.padEnd(side) : ' '.repeat(side)),
      t('bright', (r.value === null ? 'n/a' : money(r.value)).padStart(9)),
    ]);
  }
  lines.push([]);
  // Two columns a day, beside a four column label: a narrower window shows the latest
  // days that fit, and says how many. In a window wider than the grid each day's column
  // widens, up to four, to take the room.
  const shown = days.slice(-Math.max(2, Math.floor((room - 4) / 2)));
  if (shown.length >= 2) {
    const cell = beyond(room) ? Math.max(1, Math.min(4, Math.floor((room - 3 - shown.length) / shown.length))) : 1;
    const cols = flowColumns(shown.map((d) => d.flow), plain, undefined, cell);
    const title = `${shown.length} trading days`;
    const scale = `in above the line, out below, a half row per ${stepMoney(cols.step)}`;
    lines.push(...(title.length + 2 + scale.length <= room ? [[t('muted', title), t('dim', `  ${scale}`)]] : [[t('muted', title)], [t('dim', scale)]]));
    cols.rows.forEach((row, i) => lines.push([t('dim', i === cols.up - 1 ? 'in  ' : i === cols.up ? 'out ' : '    '), t('chart', row)]));
    lines.push([t('dim', `    ${shown[0]!.day.slice(5)}${' '.repeat(Math.max(1, shown.length * (cell + 1) - 11))}${shown.at(-1)!.day.slice(5)}`)]);
    const inDays = shown.filter((d) => d.flow > 0).length;
    const outDays = shown.filter((d) => d.flow < 0).length;
    lines.push([t('fg', `In on ${inDays} of ${shown.length} days, out on ${outDays}.`)]);
  }
  lines.push([t('fg', `Since launch ${m['btc-etf-cumulative-flow']?.value_formatted ?? 'n/a'} net in; ${m['btc-etf-aum']?.value_formatted ?? 'n/a'} held.`)]);
  if (days.length < ETF_DAYS) {
    // One sentence, so it wraps as one wherever the window ends.
    lines.push([t('dim', `${days.length} of ${ETF_DAYS} trading days are in your journal. /chart etf flows fill reads the missing days with date=, one call each${callsLeft !== null ? `, of the ${callsLeft.toLocaleString('en-US')} calls left today` : ''}.`)]);
  }
  return { title: 'Spot Bitcoin ETFs', subtitle: `${day ? dayName(day) : ''} | net ${net === null ? 'n/a' : money(net)}`, lines, sources: block.id, generated: body.generated_at ?? null };
}

// ------------------------------------------------------------------ /chart liquidity

// One metric a day from the journal, from whichever of the briefings carried it that day.
export function journalMetric(snapshots: Snapshots | null, briefings: string[], metric: string, days: number, today: string): Array<number | null> {
  const dayList = Array.from({ length: days }, (_, i) => daysBefore(today, days - 1 - i));
  const byDay = new Map<string, { at: string; value: number }>();
  for (const briefing of briefings) {
    for (const s of snapshots?.list(briefing, 'json') ?? []) {
      const day = s.generatedAt.slice(0, 10);
      const held = byDay.get(day);
      if (held && held.at >= s.generatedAt) continue;
      try {
        const value = levelOf((JSON.parse(readFileSync(s.path, 'utf8')) as ServedFlows).metrics?.[metric]?.value_formatted);
        if (value !== null) byDay.set(day, { at: s.generatedAt, value });
      } catch {
        // a snapshot that does not parse is left out
      }
    }
  }
  return dayList.map((d) => byDay.get(d)?.value ?? null);
}

const PARTS = [
  { name: "Fed balance sheet", key: 'fed-balance', sign: 1, said: "the Fed's balance sheet" },
  { name: 'less reverse repo', key: 'nyfed-rrp-daily', sign: -1, said: 'reverse repo' },
  { name: 'less the TGA', key: 'tga', sign: -1, said: 'the TGA' },
] as const;

export function liquidityBoard(t: Maker, plain: boolean, block: DataBlock, history: Array<number | null>, room = BOARD_ROOM): Board {
  const body = served(block) as ServedFlows;
  const m = body.metrics ?? {};
  const level = (key: string) => levelOf(m[key]?.value_formatted);
  const fed = level('fed-balance');
  // The bars take what the room leaves beside the name, level, change and date: the 24
  // columns they have on the grid, every column more that a wider window adds, and in a
  // room too narrow for a readable bar, none.
  const spare = within(room) - 47;
  const width = spare >= 6 ? Math.min(24, spare) + beyond(room) : 0;
  const change = (key: string): { text: string; role: string; glyph: [string, string]; value: number | null } => {
    const tr = m[key]?.trend;
    const v = tr?.change_7d;
    if (tr?.change_7d_available === false || v === undefined || v === null) return { text: 'n/a', role: 'dim', glyph: ['', ''], value: null };
    // Green for a rise and red for a fall, by the change's sign, as on the board.
    const mark = changeMark(v, tr?.change_unit);
    return { text: `${mark.sign}${changeText(v, tr?.change_unit)}`, role: mark.role, glyph: [mark.glyph, mark.plain], value: v };
  };
  const row = (name: string, key: string, sign: number): Line => {
    const v = level(key);
    const c = change(key);
    const shown = v === null ? 'n/a' : `${sign < 0 ? '-' : ''}${m[key]?.value_formatted ?? ''}`;
    return [
      t('fg', name.padEnd(18)),
      t(key === 'net-liquidity' ? 'chart' : 'rule', (v !== null && fed ? bar(v / fed, width, plain) : '').padEnd(width + 1)),
      t('bright', shown.padStart(10)),
      t(c.role, `  ${c.glyph[0]}`, `  ${c.glyph[1]}`),
      t(c.role === 'muted' ? 'muted' : 'bright', ` ${c.text}`.padEnd(8)),
      t('dim', asOf(m[key]?.timestamp)),
    ];
  };
  const lines: Line[] = [[t('dim', `${'part'.padEnd(18)}${' '.repeat(width + 1)}${'level'.padStart(10)}  7 days    as of`)]];
  for (const p of PARTS) lines.push(row(p.name, p.key, p.sign));
  lines.push(row('Net liquidity', 'net-liquidity', 1));
  const net = level('net-liquidity');
  const parts = PARTS.map((p) => level(p.key));
  if (net !== null && parts.every((v) => v !== null)) {
    const sum = parts.reduce<number>((s, v, i) => s + PARTS[i]!.sign * v!, 0);
    lines.push([t('dim', Math.abs(sum - net) <= 0.005 * Math.abs(net) ? `The parts add to ${money(sum, false)}, as served.` : `The parts add to ${money(sum, false)}; PreReason serves ${money(net, false)}, on the dates shown.`)]);
  }
  lines.push([]);
  const kept = history.filter((v) => v !== null).length;
  // Without two days kept there is no line to draw, only a sentence, which wraps. With
  // them, the line and what it is drawn from share a row where the room allows.
  if (kept >= 2) {
    // Sixteen points on the grid, and up to a point a day in a wider window.
    const spark = sparkline(history, plain, Math.min(Math.max(16, history.length), 16 + beyond(room)));
    const from = `from your journal, ${kept} days kept`;
    lines.push(...(9 + spark.length + 2 + from.length <= room ? [[t('muted', '30 days  '), t('chart', spark), t('dim', `  ${from}`)]] : [[t('muted', '30 days  '), t('chart', spark)], [t('dim', `         ${from}`)]]));
  } else lines.push([t('dim', '30 days of net liquidity fill in from your journal as briefings that carry it are read.')]);
  lines.push([]);
  // The week in words: each change as measured, the ones that held named together.
  const moves = [{ said: 'net liquidity', key: 'net-liquidity' }, ...PARTS.map((p) => ({ said: p.said, key: p.key }))].map((p) => ({ ...p, c: change(p.key).value, unit: m[p.key]?.trend?.change_unit }));
  const moved = moves.filter((x) => x.c !== null && Math.abs(x.c) >= 0.05).map((x) => `${x.said} ${x.c! > 0 ? 'rose' : 'fell'} ${changeText(x.c!, x.unit)}`);
  const held = moves.filter((x) => x.c !== null && Math.abs(x.c) < 0.05).map((x) => x.said);
  const heldText = held.length ? `${held.length > 1 ? `${held.slice(0, -1).join(', ')} and ${held.at(-1)}` : held[0]} held` : '';
  const clauses = [...moved, ...(heldText ? [heldText] : [])];
  if (clauses.length) lines.push([t('fg', `Over 7 days ${clauses.length > 1 ? `${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}` : clauses[0]}.`)]);
  return { title: 'Net liquidity', subtitle: "the Fed's balance sheet, less reverse repo and the TGA", lines, sources: block.id, generated: body.generated_at ?? null };
}

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Snapshots, blockFromJson, itemSentence, metricName, type DataBlock } from '@primerkit/core';
import { FixtureConnector, type PricePoint } from '@primerkit/connector-prereason';
import { maker, monotoneCubic, renderLine, sparkline, widthOf, type Line } from '@primerkit/ui';
import {
  BOARD_ROOM,
  BENCH_BRIEFINGS,
  bitcoinBoard,
  briefBoard,
  correlationsBoard,
  etfFlowsBoard,
  fitLines,
  hashpriceBoard,
  heatBoard,
  heatDepths,
  DEMO_DAY,
  DEMO_JOURNAL,
  metricChartBoard,
  metricSeries,
  readingLines,
  levelOf,
  liquidityBoard,
  loadBoard,
  nextRange,
  parseBoard,
  printedBoard,
  roomFor,
  treasuryBoard,
  sharedCurveDay,
  taller,
  CURVE_ROWS,
  yieldCurveBoard,
  type Board,
  type Briefings,
} from '../src/index';

const text = (b: Board) => b.lines.map((l: Line) => renderLine(l, 'plain')).join('\n');
// A board's text with each wrapped line joined to the one before: wrapIn indents a
// sentence's later lines by two.
const flat = (s: string) => s.replace(/\n {2}(?=\S)/g, ' ');
const saved = (id: string, at = '2026-09-25T09:06:00.000Z') => blockFromJson(id, readFileSync(join(BENCH_BRIEFINGS, `${id}.json`), 'utf8'), at);
const json = (id: string, body: object) => blockFromJson(id, JSON.stringify(body), '2026-09-27T03:00:00.000Z');
const plainT = maker(true);
const uniT = maker(false);

// macro.rates as PreReason served it on 2026-09-27, cut to the curve.
const pct = (value: string, change30d: number) => ({ value_formatted: value, trend: { change_30d: change30d, change_30d_available: true, change_unit: 'percent' } });
const RATES = {
  briefing_metadata: { name: 'Yield Curve and Breakeven Inflation' },
  generated_at: '2026-09-27T05:17:00.000Z',
  metrics: {
    'treasury-3mo': pct('4.24%', 9.84),
    'treasury-2y': pct('4.87%', 16.79),
    'treasury-5y': pct('5.03%', 15.63),
    'treasury-10y': pct('5.18%', 11.64),
    'treasury-30y': pct('5.47%', 5.8),
    't10y3m-spread': pct('0.94%', 9.3),
  },
};

describe('reading a served level', () => {
  it('takes the number from what PreReason formatted, with its magnitude', () => {
    expect(levelOf('$5.77T')).toBe(5.77e12);
    expect(levelOf('$977.08B')).toBeCloseTo(977.08e9);
    expect(levelOf('58.5%')).toBe(58.5);
    expect(levelOf('~846K')).toBe(846_000);
    expect(levelOf('¥644.66T')).toBeCloseTo(644.66e12);
    expect(levelOf('933.46 EH/s')).toBe(933.46);
    expect(levelOf('-1.35σ')).toBe(-1.35);
    expect(levelOf('+3.1%')).toBe(3.1);
    expect(levelOf('1.01x')).toBe(1.01);
    expect(levelOf('$84,462.2')).toBe(84462.2);
    expect(levelOf('n/a')).toBeNull();
  });
});

describe('the drawing', () => {
  it('bends a curve through its points by monotone cubic, never past them', () => {
    const f = monotoneCubic([0, 1, 2, 3], [3.92, 3.61, 4.12, 4.61]);
    expect(f(0)).toBeCloseTo(3.92);
    expect(f(2)).toBeCloseTo(4.12);
    for (let x = 0; x <= 1; x += 0.05) expect(f(x)).toBeGreaterThanOrEqual(3.61 - 1e-9);
    for (let x = 2; x <= 3; x += 0.05) expect(f(x)).toBeLessThanOrEqual(4.61 + 1e-9);
  });

  it('runs a sparkline from a quarter cell to seven eighths, with gaps for missing days', () => {
    expect(sparkline([1, 2, 3, 4, 5, 6], false)).toBe('▂▃▄▅▆▇');
    expect(sparkline([1, null, 6], true)).toBe('. #');
    expect(sparkline([2, 2, 2], false)).toBe('▄▄▄');
  });
});

describe('/brief', () => {
  it('draws each metric: its level, 7 and 30 day changes, 30 days from the journal, and where it sits', () => {
    const snapshots = new Snapshots(mkdtempSync(join(tmpdir(), 'pk-brief-')));
    const today = JSON.parse(readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8')) as { metrics: Record<string, { value_formatted: string }> };
    for (const [day, level] of [['2026-09-23', '$5.70T'], ['2026-09-24', '$5.74T'], ['2026-09-25', '$5.77T']] as const) {
      today.metrics['net-liquidity']!.value_formatted = level;
      snapshots.save(blockFromJson('macro.snapshot', JSON.stringify({ ...today, generated_at: `${day}T09:00:00.000Z` }), `${day}T09:00:00.000Z`));
    }
    const board = briefBoard(plainT, true, saved('macro.snapshot'), snapshots, '2026-09-25');
    expect(board.title).toBe('Macro Snapshot');
    expect(board.subtitle).toBe('15 metrics | 09:05 UTC');
    const lines = text(board).split('\n');
    const net = lines.find((l) => l.startsWith('Net liquidity'))!;
    // The week-ranked row draws the same bar as every other, marked after its P.
    // Coloured by the sign alone, though PreReason calls the week flat.
    expect(net).toMatch(/^Net liquidity\s+\$5\.77T\s+v 1\.7%\s+v 0\.4%\s+\S+\s+o---- P3\*$/);
    // A point stands for two days, so the three days kept draw as two, the later higher.
    expect(net).toMatch(/ \.# +o---- P3\*$/);
    expect(text(board)).toContain("* after a P: a series that grows is ranked by its week's change instead");
    const fed = lines.find((l) => l.startsWith('Fed balance'))!;
    expect(fed).toMatch(/---o- P79$/);
    expect(text(board)).toContain('30 days from your journal: 3 of 30 days kept');
    expect(text(board)).toContain('/brief macro.snapshot fill reads the 27 missing days, one call each');
    // Every row fits inside a block, the percentile included.
    for (const line of board.lines) expect(renderLine(line, 'plain').length).toBeLessThanOrEqual(72);
  });

  it('never cuts a level: its column widens to the longest, and every row stays in line', () => {
    // Before 2026-10-09 a level was cut at 11 characters: "$2,650.40/oz" read "$2,650.40/o",
    // and a plain terminal's "EUR1,234,567.89" read "EUR1,234,56".
    const trend = { change_7d: 1.2, change_30d: 3.4, change_unit: 'percent', percentile: 70 };
    const body = { metrics: { 'gold-price': { value_formatted: '$2,650.40/oz', trend }, 'ecb-balance': { value_formatted: '€1,234,567.89', trend }, 'gold-silver-ratio': { value_formatted: '84.2', trend } } };
    for (const [maker, plain, long] of [[uniT, false, '€1,234,567.89'], [plainT, true, 'EUR1,234,567.89']] as const) {
      const lines = text(briefBoard(maker, plain, json('commodities.gold', body), null, '2026-09-27')).split('\n');
      expect(lines.some((l) => l.includes('$2,650.40/oz')), String(plain)).toBe(true);
      expect(lines.some((l) => l.includes(long)), String(plain)).toBe(true);
      const at = lines.filter((l) => /1\.2%/.test(l)).map((l) => l.indexOf('1.2%'));
      expect(at).toHaveLength(3);
      expect(new Set(at).size).toBe(1);
      for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(BOARD_ROOM);
    }
  });

  it("says n/a for a change PreReason did not measure, and pads after the plain mapping", () => {
    const body = JSON.parse(readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8')) as { metrics: Record<string, { trend: Record<string, unknown> }> };
    body.metrics['m2-supply']!.trend.change_7d_available = false;
    const board = briefBoard(plainT, true, json('macro.snapshot', body), null, '2026-09-27');
    const lines = text(board).split('\n');
    expect(lines.find((l) => l.startsWith('M2 supply'))).toMatch(/^M2 supply\s+\$23\.34T\s+n\/a\s+/);
    // The 7d column starts at the same place on every row, the yen sign written as JPY.
    const m2 = lines.find((l) => l.startsWith('M2 supply'))!;
    const boj = lines.find((l) => l.startsWith('BOJ balance'))!;
    expect(m2.indexOf('n/a')).toBe(27);
    expect(boj.slice(15, 27)).toBe('JPY644.66T  ');
    expect(boj.charAt(27)).toMatch(/[\^vo]/);
  });
});

describe('/chart yield curve', () => {
  it('draws now and 30 days ago, 3 months being the 10 year less the spread, each level less its measured change', () => {
    const board = yieldCurveBoard(plainT, true, saved('macro.snapshot'), { kind: 'ago', horizon: '30d' });
    const out = text(board);
    // With no metrics of their own, 3 months is 10y 5.11 less the spread 0.92, and 5 years
    // is not known; 30 days ago the 2 year was 4.85 / 1.1575.
    expect(out).toMatch(/now\s+4\.19\s+4\.85\s+n\/a\s+5\.11\s+5\.40/);
    expect(out).toMatch(/30d ago\s+3\.\d\d\s+4\.19\s+n\/a\s+4\.66\s+5\.18/);
    expect(out).toContain('> 2y, 10y, 30y from macro.snapshot; 3M is the 10y less the 10y-3M spread');
    expect(flat(out)).toContain('1M, 6M and 1Y are drawn with macro.rates, a Pro briefing; each is also a metric of its own, such as treasury-1mo. Between maturities the line is drawn, not measured.');
    // The board wraps its own sentences, so every line fits the block.
    for (const line of board.lines) expect(renderLine(line, 'plain').length).toBeLessThanOrEqual(72);
    expect(out).toContain('Over 30 days: 3 months rose');
    // Six rows of plot, labelled at the middle of every other row.
    expect(out.split('\n').filter((l) => /^\s+\d\.\d% \+/.test(l))).toHaveLength(3);
    expect(out).toContain('  30 days ago: each level less its measured 30 day change.');
    expect(/[^\x00-\x7f]/.test(out)).toBe(false);
    const unicode = text(yieldCurveBoard(uniT, false, saved('macro.snapshot'), { kind: 'ago', horizon: '30d' }));
    expect(unicode).toMatch(/[⠀-⣿]/);
    expect(unicode).toContain('●');
  });

  it('leaves 3 months out of the earlier curve when the spread crossed zero', () => {
    const body = JSON.parse(readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8')) as { metrics: Record<string, { value_formatted: string; trend: Record<string, unknown> }> };
    body.metrics['t10y3m-spread']!.value_formatted = '0.10';
    body.metrics['t10y3m-spread']!.trend.change_unit = 'absolute';
    body.metrics['t10y3m-spread']!.trend.change_30d = 0.3; // it was -0.20
    const out = text(yieldCurveBoard(plainT, true, json('macro.snapshot', body), { kind: 'ago', horizon: '30d' }));
    expect(out).toMatch(/30d ago\s+n\/a/);
  });

  it('draws against a date, from the briefing as it stood that day', () => {
    const then = json('macro.snapshot', { metrics: { 'treasury-2y': { value_formatted: '3.63%' }, 'treasury-10y': { value_formatted: '4.20%' }, 'treasury-30y': { value_formatted: '4.77%' } } });
    const board = yieldCurveBoard(plainT, true, saved('macro.snapshot'), { kind: 'date', date: '2025-09-26', block: then });
    expect(board.subtitle).toBe('now, and on Sep 26, 2025');
    expect(text(board)).toMatch(/then\s+n\/a\s+3\.63\s+n\/a\s+4\.20\s+4\.77/);
    expect(flat(text(board))).toContain('Since 2025-09-26: 2 years rose 1.22, 10 years rose 0.91, 30 years rose 0.63 points.');
    expect(text(board)).toContain('  2025-09-26: as it stood, read with date=; 5Y comes with macro.rates.');
    expect(board.sources).toBe('macro.snapshot, two dates');
  });

  it('draws all five from macro.rates, and 30 days ago from their own measured changes', () => {
    const board = yieldCurveBoard(plainT, true, json('macro.rates', RATES), { kind: 'ago', horizon: '30d' });
    const out = text(board);
    // 4.24 / 1.0984 and so on: each level less its own 30 day change.
    expect(out).toMatch(/now\s+4\.24\s+4\.87\s+5\.03\s+5\.18\s+5\.47/);
    expect(out).toMatch(/30d ago\s+3\.86\s+4\.17\s+4\.35\s+4\.64\s+5\.17/);
    expect(out).toContain('> all 5 maturities from macro.rates');
    expect(flat(out)).toContain('Over 30 days: 3 months rose 0.38, 2 years rose 0.70, 5 years rose 0.68, 10 years rose 0.54, 30 years rose 0.30 points.');
    expect(board.sources).toBe('macro.rates');
  });

  it('draws all five on a date from macro.rates as it stood that day', () => {
    const then = json('macro.rates', { metrics: { 'treasury-3mo': { value_formatted: '4.02%' }, 'treasury-2y': { value_formatted: '3.63%' }, 'treasury-5y': { value_formatted: '3.76%' }, 'treasury-10y': { value_formatted: '4.20%' }, 'treasury-30y': { value_formatted: '4.77%' } } });
    const board = yieldCurveBoard(plainT, true, json('macro.rates', RATES), { kind: 'date', date: '2025-09-26', block: then });
    expect(text(board)).toMatch(/then\s+4\.02\s+3\.63\s+3\.76\s+4\.20\s+4\.77/);
    expect(text(board)).toContain('  2025-09-26: as it stood, read with date=.');
    expect(board.sources).toBe('macro.rates, two dates');
  });
});

describe('/chart yield curve at its eight benchmarks', () => {
  // macro.rates since 2026-09-27 carries every maturity on Treasury's par curve, fourteen,
  // here at Treasury's levels for 2026-09-24. The chart draws eight of them.
  const RATES14 = {
    ...RATES,
    metrics: {
      ...RATES.metrics,
      'treasury-1mo': pct('4.01%', 4.0),
      'treasury-1-5mo': pct('4.10%', 4.5),
      'treasury-2mo': pct('4.18%', 5.0),
      'treasury-4mo': pct('4.33%', 7.0),
      'treasury-6mo': pct('4.34%', 8.0),
      'treasury-1y': pct('4.51%', 9.0),
      'treasury-3y': pct('4.99%', 14.0),
      'treasury-7y': pct('5.10%', 12.0),
      'treasury-20y': pct('5.53%', 6.0),
    },
  };

  it('draws the eight benchmarks, each value under its point, with room either side of the values', () => {
    const board = yieldCurveBoard(plainT, true, json('macro.rates', RATES14), { kind: 'ago', horizon: '30d' });
    const out = text(board);
    expect(out).toMatch(/^ {9}1M +3M +6M +1Y +2Y +5Y +10Y +30Y$/m);
    expect(out).toMatch(/^ +now +4\.01 +4\.24 +4\.34 +4\.51 +4\.87 +5\.03 +5\.18 +5\.47$/m);
    expect(out).toMatch(/^ *30d ago +3\.86 +3\.86 +4\.02 +4\.14 +4\.17 +4\.35 +4\.64 +5\.17$/m);
    // The two rows' values line up, whatever their labels.
    const rowsAt = out.split('\n');
    expect(rowsAt.find((l) => /^ *30d ago /.test(l))!.indexOf('3.86')).toBe(rowsAt.find((l) => /^ +now /.test(l))!.indexOf('4.01'));
    const rows = out.split('\n');
    const at = rows.findIndex((l) => /^ +now /.test(l));
    expect(rows[at - 1]).toBe('');
    // The change row sits under the two rows of values, then a blank.
    expect(rows[at + 2]).toMatch(/^ +change /);
    expect(rows[at + 3]).toBe('');
    expect(flat(out)).toContain('Over 30 days every maturity rose: 2 years the most, 0.70 points, and 1 month the least, 0.15.');
    expect(flat(out)).toContain('> 8 of 14 maturities from macro.rates; /brief macro.rates lists all 14');
    expect(out).toContain('  Between maturities the line is drawn, not measured.');
    for (const line of board.lines) expect(renderLine(line, 'plain').length).toBeLessThanOrEqual(72);
  });

  it('narrows to the window it is printed in, and refuses one too narrow to draw', () => {
    // A 57 column window leaves 53 inside the block.
    const narrow = yieldCurveBoard(plainT, true, json('macro.rates', RATES14), { kind: 'ago', horizon: '30d' }, {}, undefined, roomFor(57));
    for (const line of narrow.lines) expect(renderLine(line, 'plain').length).toBeLessThanOrEqual(53);
    const narrowRows = text(narrow).split('\n');
    expect(narrowRows.find((l) => /^ *30d ago /.test(l))!.indexOf('3.86')).toBe(narrowRows.find((l) => /^ +now /.test(l))!.indexOf('4.01'));
    expect(text(narrow)).toMatch(/^ +1M +3M +6M +1Y +2Y +5Y +10Y +30Y$/m);
    expect(text(narrow)).toMatch(/^ +now +4\.01 +4\.24 +4\.34 +4\.51 +4\.87 +5\.03 +5\.18 +5\.47$/m);
    const printed = printedBoard(plainT, narrow, '17:46', 57);
    expect(printed.drawn).toBe(true);
    for (const line of printed.lines) expect(renderLine(line, 'plain').length).toBeLessThanOrEqual(56);
    expect(renderLine(printed.lines.at(-1)!, 'plain')).toBe(' + PR  macro.rates | generated 17:46 UTC');
    // CONTROL: in 45 columns the eight values cannot sit apart, so nothing broken is printed.
    const tooNarrow = yieldCurveBoard(plainT, true, json('macro.rates', RATES14), { kind: 'ago', horizon: '30d' }, {}, undefined, roomFor(45));
    const refused = printedBoard(plainT, tooNarrow, '17:46', 45);
    expect(refused.drawn).toBe(false);
    // The note wraps to the window like any sentence, so it is read whole.
    const note = refused.lines.map((l) => renderLine(l, 'plain').trim()).join(' ');
    for (const line of refused.lines) expect(renderLine(line, 'plain').length).toBeLessThanOrEqual(44);
    const needed = /it needs a window at least (\d+) columns wide, and this one is 45\./.exec(note);
    expect(Number(needed?.[1])).toBeGreaterThan(45);
    expect(Number(needed?.[1])).toBeLessThanOrEqual(52);
  });

  it('puts the date on a line of its own when the heading does not fit the window', () => {
    const board = yieldCurveBoard(plainT, true, json('macro.rates', RATES14), { kind: 'ago', horizon: '30d' }, {}, '2026-09-24', roomFor(57));
    const heading = printedBoard(plainT, board, '17:46', 57).lines.slice(0, 2).map((l) => renderLine(l, 'plain'));
    expect(heading).toEqual([' Treasury yield curve', ' on Sep 24, 2026, and 30 days before']);
    // CONTROL: in 80 columns the two share a line.
    expect(renderLine(printedBoard(plainT, board, '17:46', 80).lines[0]!, 'plain')).toBe(' Treasury yield curve  on Sep 24, 2026, and 30 days before');
  });

  it('shows a benchmark the read does not carry as n/a, and counts what it carries', () => {
    const { ['treasury-6mo']: _gone, ...rest } = RATES14.metrics;
    const out = text(yieldCurveBoard(plainT, true, json('macro.rates', { ...RATES14, metrics: rest }), { kind: 'ago', horizon: '30d' }));
    expect(out).toMatch(/^ +now +4\.01 +4\.24 +n\/a +4\.51 +4\.87/m);
    expect(flat(out)).toContain('> 8 of 13 maturities from macro.rates; /brief macro.rates lists all 13');
  });

  it('names the largest rise and the largest fall when the curve moved both ways', () => {
    const level = (v: string) => ({ value_formatted: v });
    const then = json('macro.rates', {
      metrics: {
        'treasury-1mo': level('4.30%'), 'treasury-3mo': level('4.02%'), 'treasury-6mo': level('4.20%'), 'treasury-1y': level('4.10%'),
        'treasury-2y': level('3.63%'), 'treasury-5y': level('3.76%'), 'treasury-10y': level('4.20%'), 'treasury-30y': level('4.77%'),
      },
    });
    const out = text(yieldCurveBoard(plainT, true, json('macro.rates', RATES14), { kind: 'date', date: '2025-09-26', block: then }));
    // 5 years rose 1.27, from 3.76 to 5.03, just ahead of 2 years' 1.24.
    expect(flat(out)).toContain('Since 2025-09-26 7 maturities rose and 1 fell: 5 years rose the most, 1.27 points, and 1 month fell the most, 0.29.');
    expect(out).toMatch(/^ +then +4\.30 +4\.02 +4\.20 +4\.10 +3\.63 +3\.76 +4\.20 +4\.77$/m);
    expect(out).toContain('  2025-09-26: as it stood, read with date=.');
  });

  // As served on 2026-09-27: Treasury's maturities through the 25th, FRED's five through the 24th.
  const stamped = (body: typeof RATES14) => ({
    ...body,
    metrics: Object.fromEntries(
      Object.entries(body.metrics).map(([k, v]) => [k, { ...v, timestamp: ['treasury-3mo', 'treasury-2y', 'treasury-5y', 'treasury-10y', 'treasury-30y', 't10y3m-spread'].includes(k) ? '2026-09-24T00:00:00+00:00' : '2026-09-25T00:00:00+00:00' }]),
    ),
  });

  it('finds the newest day every maturity shares, and nothing when they agree', () => {
    expect(sharedCurveDay(json('macro.rates', stamped(RATES14)))).toBe('2026-09-24');
    const sameDay = { ...RATES14, metrics: Object.fromEntries(Object.entries(RATES14.metrics).map(([k, v]) => [k, { ...v, timestamp: '2026-09-24T00:00:00+00:00' }])) };
    expect(sharedCurveDay(json('macro.rates', sameDay))).toBeNull();
    expect(sharedCurveDay(json('macro.rates', RATES14))).toBeNull();
  });

  it('labels a curve read as it stood on that day with the day', () => {
    const board = yieldCurveBoard(plainT, true, json('macro.rates', RATES14), { kind: 'ago', horizon: '30d' }, {}, '2026-09-24');
    expect(board.subtitle).toBe('on Sep 24, 2026, and 30 days before');
    expect(text(board)).toMatch(/^ +Sep 24 +4\.01 +4\.24/m);
    expect(text(board)).toContain('Sep 24 is the newest day all of them share: FRED posts a day later');
    // Counted back from that day: the row is Aug 25, and it lines up with the Sep 24 row.
    expect(text(board)).toMatch(/^ +Aug 25 +3\.\d\d/m);
    const rows = text(board).split('\n');
    expect(rows.find((l) => /^ +Aug 25 /.test(l))!.indexOf('3.')).toBe(rows.find((l) => /^ +Sep 24 /.test(l))!.indexOf('4.01'));
    expect(text(board)).toContain('  30 days before: each level less its measured 30 day change.');
  });

  it('reads the curve on the shared day when the newest values span two days', async () => {
    const asked: string[] = [];
    const data: Briefings = {
      id: 'test',
      tier: 'pro',
      fetch: async ({ briefing, date }) => {
        asked.push(date ? `${briefing} ${date}` : briefing);
        return json(briefing, date ? RATES14 : stamped(RATES14));
      },
    };
    const draw = await loadBoard({ kind: 'yield curve', compare: '30d' }, { data, snapshots: null, today: '2026-09-27' });
    expect(asked).toEqual(['macro.rates', 'macro.rates 2026-09-24']);
    expect(draw(plainT, true).subtitle).toBe('on Sep 24, 2026, and 30 days before');
  });
});

describe('/chart yield curve, what it reads', () => {
  const snapshot = JSON.parse(readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8')) as object;
  const connection = (tier: Briefings['tier'], refuseRates = false) => {
    const asked: string[] = [];
    const data: Briefings = {
      id: 'test',
      tier,
      fetch: async ({ briefing, date }) => {
        asked.push(date ? `${briefing} ${date}` : briefing);
        if (briefing === 'macro.rates' && refuseRates) throw new Error('403: macro.rates needs Pro');
        return json(briefing, briefing === 'macro.rates' ? RATES : snapshot);
      },
      metric: async (name) => {
        asked.push(name);
        throw new Error('no single metric in this test');
      },
    };
    return { data, asked };
  };
  const curve = { kind: 'yield curve', compare: { date: '2025-09-26' } } as const;

  it('reads macro.rates today and on the date for a Pro key, and nothing else', async () => {
    const { data, asked } = connection('pro');
    const draw = await loadBoard(curve, { data, snapshots: null, today: '2026-09-27' });
    expect(asked).toEqual(['macro.rates', 'macro.rates 2025-09-26']);
    expect(draw(plainT, true).sources).toBe('macro.rates, two dates');
  });

  it('reads macro.snapshot and the two metrics below Pro, never asking for macro.rates', async () => {
    const { data, asked } = connection('basic');
    await loadBoard(curve, { data, snapshots: null, today: '2026-09-27' });
    expect(asked).toEqual(['macro.snapshot', 'treasury-3mo', 'treasury-5y', 'macro.snapshot 2025-09-26']);
  });

  it('asks for macro.rates when the tier is not known, and falls back when it is refused', async () => {
    const { data, asked } = connection(null, true);
    const draw = await loadBoard(curve, { data, snapshots: null, today: '2026-09-27' });
    expect(asked).toEqual(['macro.rates', 'macro.snapshot', 'treasury-3mo', 'treasury-5y', 'macro.snapshot 2025-09-26']);
    expect(draw(plainT, true).sources).toBe('macro.snapshot, two dates');
  });
});

const days = (n: number, from = '2026-06-29'): PricePoint[] =>
  Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), price: 60_000 + 300 * i - (i === 1 ? 2_000 : 0) }));

describe('/chart bitcoin', () => {
  it('marks the low, the high and the latest, draws the 200 day average dotted, and shows the range row', () => {
    const momentum = json('btc.momentum', { metrics: { 'btc-price-200d-ma': { value_formatted: '$71,073.51' }, 'btc-price-200d-distance': { value_formatted: '+18.8%' } } });
    const board = bitcoinBoard(plainT, true, days(90), '90d', momentum);
    const out = text(board);
    expect(board.subtitle).toBe('90 days, Jun 29, 2026 to Sep 26, 2026');
    expect(out).toContain('range    30d   [90d]   1y    all    or from a date');
    // No briefing carried the price now, so the last day of the history is named as such.
    expect(out).toContain('On Sep 26, 2026 it was $86,700, up 44.5% from $60,000 on Jun 29, 2026.');
    expect(out).not.toContain('Now $');
    expect(out).toContain('Low $58,300 on Jun 30, 2026 | high $86,700 on Sep 26, 2026.');
    expect(out).toContain('Its 200 day average is $71,074 today, +18.8% away');
    expect(out.split('\n').some((l) => /\.{20,}/.test(l))).toBe(true);
    expect(board.sources).toBe('history, btc.momentum');
  });

  // btc.momentum as PreReason serves it, with the price now it measures the average from.
  const momentumNow = (price: string, at: string) =>
    json('btc.momentum', { metrics: { 'bitcoin-price': { value_formatted: price, timestamp: at }, 'btc-price-200d-ma': { value_formatted: '$71,073.51' }, 'btc-price-200d-distance': { value_formatted: '+17.1%' } } });

  it('names the sources of the closes it drew, newest first, with the notice their terms ask for, and none where PreReason names none', () => {
    const history = days(90).map((p, i) => ({ ...p, ...(i < 60 ? { source: 'Example Prices', notice: 'Powered by Example Prices.' } : { source: 'Sample Exchange' }) }));
    const out = flat(text(bitcoinBoard(plainT, true, history, '90d', null)));
    expect(out).toContain("> closes from Sample Exchange and Example Prices, as PreReason names each day's source");
    expect(out).toContain('Powered by Example Prices.');
    const recent = flat(text(bitcoinBoard(plainT, true, history.slice(60), '30d', null)));
    expect(recent).toContain("> closes from Sample Exchange, as PreReason names each day's source");
    expect(recent).not.toContain('Example Prices');
    // CONTROL: an answer that names no source per close puts no source on the board.
    expect(flat(text(bitcoinBoard(plainT, true, days(90), '90d', null)))).not.toContain('closes from');
  });

  it('ends the line on the price now and calls that price now, the one the 200 day distance is measured from', () => {
    const board = bitcoinBoard(plainT, true, days(90), '90d', momentumNow('$83,207.53', '2026-09-27T06:06:39.82+00:00'));
    const out = flat(text(board));
    expect(board.subtitle).toBe('90 days, Jun 29, 2026 to Sep 27, 2026');
    expect(out).toContain('Now $83,208, up 38.7% from $60,000 on Jun 29, 2026.');
    expect(out).toContain('high $86,700 on Sep 26, 2026');
    expect(out).toContain('the price now and the 200 day average from btc.momentum');
    expect(board.sources).toBe('history, btc.momentum');
    // CONTROL: a price taken before the history's last day is older than it, and not used.
    const old = flat(text(bitcoinBoard(plainT, true, days(90), '90d', momentumNow('$83,207.53', '2026-09-20T06:06:39.82+00:00'))));
    expect(old).toContain('On Sep 26, 2026 it was $86,700');
    expect(old).not.toContain('Now $');
  });

  it('reads the price now from btc.quick-check where the key cannot read btc.momentum', async () => {
    const asked: string[] = [];
    // A key whose tier is not known yet: btc.momentum is asked, and refused. A known Free key
    // is not asked it at all, nor 90 days (free-charts.test.ts).
    const data: Briefings = {
      id: 'test',
      fetch: async ({ briefing }) => {
        asked.push(briefing);
        if (briefing === 'btc.momentum') throw new Error('403: btc.momentum needs Basic');
        return json(briefing, { metrics: { 'bitcoin-price': { value_formatted: '$83,067.11', timestamp: '2026-09-27T05:50:40+00:00' } } });
      },
      bitcoinHistory: async () => days(90),
    };
    const draw = await loadBoard({ kind: 'bitcoin', range: '90d' }, { data, snapshots: null, today: '2026-09-27' });
    expect(asked).toEqual(['btc.momentum', 'btc.quick-check']);
    const board = draw(plainT, true);
    expect(flat(text(board))).toContain('Now $83,067, up 38.4% from $60,000 on Jun 29, 2026.');
    expect(flat(text(board))).toContain('the price now from btc.quick-check');
    expect(board.sources).toBe('history, btc.quick-check');
  });

  it('reads a long range in calls of up to 1,000 days, and the arrows move through the ranges', async () => {
    const calls: Array<{ from: string; to: string }> = [];
    const data = Object.assign(new FixtureConnector(BENCH_BRIEFINGS), {
      bitcoinHistory: async (range: { from: string; to: string }) => {
        calls.push(range);
        return days(3, range.from);
      },
    }) as Briefings;
    const draw = await loadBoard({ kind: 'bitcoin', range: 'all' }, { data, snapshots: null, today: '2026-09-27' });
    expect(calls[0]).toEqual({ from: '2013-04-28', to: '2016-01-22' });
    expect(calls.at(-1)?.to).toBe('2026-09-27');
    expect(calls).toHaveLength(5);
    expect(draw(plainT, true).title).toBe('Bitcoin');
    // A day typed before the history begins asks from its first day, not 740 calls of nothing.
    calls.length = 0;
    await loadBoard({ kind: 'bitcoin', range: { from: '0001-01-01' } }, { data, snapshots: null, today: '2026-09-27' });
    expect(calls[0]?.from).toBe('2013-04-28');
    expect(calls).toHaveLength(5);
    expect(nextRange({ kind: 'bitcoin', range: '90d' }, 1)).toEqual({ kind: 'bitcoin', range: '1y' });
    expect(nextRange({ kind: 'bitcoin', range: '30d' }, -1)).toEqual({ kind: 'bitcoin', range: 'all' });
    expect(nextRange({ kind: 'yield curve', compare: '30d' }, 1)).toEqual({ kind: 'yield curve', compare: '90d' });
  });
});

describe('/chart hashprice', () => {
  it('says how many days the journal holds, and what filling the rest costs', () => {
    const out = text(hashpriceBoard(plainT, true, [{ date: '2026-09-27', value: 0.0402 }], 90, 99_943));
    expect(out).toContain('1 of 90 days is in your journal. /chart hashprice fill reads the other 89');
    expect(out).toContain('with date=, one call each, of the 99,943 calls left today.');
  });

  it('fills only the days the journal lacks, each kept at the end of its day', async () => {
    const snapshots = new Snapshots(mkdtempSync(join(tmpdir(), 'pk-hash-')));
    const reads: string[] = [];
    const data: Briefings = {
      id: 'prereason',
      fetch: async (req) => {
        reads.push(req.date ?? 'today');
        const day = req.date ?? '2026-09-27';
        return json('btc.miner-survival', { generated_at: `${day}T12:00:00.000Z`, metrics: { hashprice: { value_formatted: `$0.0${300 + Number(day.slice(8, 10))}` } } });
      },
    };
    snapshots.save({ ...json('btc.miner-survival', { metrics: { hashprice: { value_formatted: '$0.0350' } } }), generatedAt: '2026-09-20T23:59:59.999Z' });
    const draw = await loadBoard({ kind: 'hashprice', fill: true }, { data, snapshots, today: '2026-09-27' });
    expect(reads[0]).toBe('today');
    expect(reads).toHaveLength(1 + 88);
    expect(reads).not.toContain('2026-09-20');
    const board = draw(plainT, true);
    expect(board.subtitle).toBe('dollars per TH/s a day, 90 days');
    expect(snapshots.list('btc.miner-survival', 'json').filter((s) => s.generatedAt.endsWith('T23:59:59.999Z'))).toHaveLength(89);
    // 89 snapshots written and read back, which is slow on a loaded laptop.
  }, 60_000);
});

describe('/chart treasury and /chart correlations', () => {
  it('splits the holdings by type and shows the largest holders with their trends', () => {
    const block = json('btc.treasury', {
      generated_at: '2026-09-27T02:52:25.882Z',
      treasury: {
        aggregate: { total_btc_formatted: '~1.3M BTC', total_companies: 87 },
        miner_split: { miners_pct: 8, corporates_pct: 92, classified_coverage_pct: 94 },
        top_holders: [
          { ticker: 'MSTR', holdings_formatted: '~846K', trend: 'accumulating' },
          { ticker: 'MARA', holdings_formatted: '~35K', trend: 'distributing' },
          { ticker: 'XXI', holdings_formatted: '~44K', trend: 'stable' },
        ],
        accumulation_summary: { increasing: 12, decreasing: 5, net_change_formatted: '+~34K BTC', change_period: 'Dec 2025 – Sep 2026' },
      },
    });
    const board = treasuryBoard(plainT, true, block);
    const out = text(board);
    expect(board.subtitle).toBe('~1.3M BTC across 87 tracked companies');
    expect(out).toMatch(/corporate\s+#{33}\s+92%/);
    expect(out).toMatch(/MSTR\s+#{36}\s+~846K\s+\^/);
    expect(out).toMatch(/MARA\s+#+\s+~35K\s+v/);
    expect(out).toContain('12 companies added and 5 reduced over Dec 2025 to Sep 2026: net +~34K BTC.');
    expect(out).not.toContain('–');
  });

  it('orders the pairs by correlation, draws them either side of zero in the chart colour, and names the window', () => {
    const board = correlationsBoard(plainT, true, saved('cross.correlations'));
    const lines = text(board).split('\n');
    expect(lines[0]).toMatch(/^Bitcoin price and QQQ\s+\|#+\s+\+0\.\d\d$/);
    expect(lines.find((l) => l.startsWith('SPY and VXX'))).toMatch(/#+\|\s+-0\.\d\d$/);
    // The pairs' own windows and counts (the stock pairs 20, EUR/USD 15, net liquidity 30),
    // never the first pair's for all of them.
    expect(text(board).replace(/\s+/g, ' ')).toContain('> cross.correlations: daily returns, paired by date, windows from 2026-08-26 to 2026-09-25, 15 to 30 observations a pair');
    const one = saved('cross.correlations');
    const shared = { ...one, raw: one.raw!.replace(/"observations":\s*\d+/g, '"observations": 20').replace(/"window_start":\s*"[^"]+"/g, '"window_start": "2026-08-26"').replace(/"window_end":\s*"[^"]+"/g, '"window_end": "2026-09-24"') };
    expect(text(correlationsBoard(plainT, true, shared)).replace(/\s+/g, ' ')).toContain('paired by date, 2026-08-26 to 2026-09-24, 20 observations');
    const roles = new Set(correlationsBoard(uniT, false, saved('cross.correlations')).lines.flat().map(([role]) => role));
    expect(roles.has('up')).toBe(false);
    expect(roles.has('down')).toBe(false);
  });
});

describe('every board narrows to the room it is drawn in', () => {
  // 72 is the grid's; 53 is a 57 column window's; 46 is a 50 column window's.
  const ROOMS = [72, 64, 53, 46];
  const fits = (b: Board, room: number) => fitLines(plainT, b.lines, room).every((l) => widthOf(l) <= room);
  const pctOf = (value: string, c7: number) => ({ value_formatted: value, timestamp: '2026-09-25T00:00:00+00:00', trend: { change_7d: c7, change_7d_available: true, change_unit: 'percent' } });
  const TREASURY = json('btc.treasury', {
    treasury: {
      aggregate: { total_btc_formatted: '~1.3M BTC', total_companies: 87 },
      miner_split: { miners_pct: 8, corporates_pct: 92, classified_coverage_pct: 94 },
      top_holders: [{ ticker: 'MSTR', holdings_formatted: '~846K', trend: 'accumulating' }, { ticker: 'MARA', holdings_formatted: '~35K', trend: 'distributing' }],
      accumulation_summary: { increasing: 7, decreasing: 6, net_change_formatted: '+~38K BTC', change_period: 'Dec 2025 – Sep 2026' },
    },
  });
  const FLOWS = json('btc.etf-flows', {
    metrics: {
      'btc-etf-net-flow': { value_formatted: '+$134.5M', timestamp: '2026-09-25T00:00:00+00:00' },
      'btc-etf-ibit-flow': { value_formatted: '+$97.0M' }, 'btc-etf-fbtc-flow': { value_formatted: '+$49.3M' }, 'btc-etf-gbtc-flow': { value_formatted: '$0.0M' },
      'btc-etf-cumulative-flow': { value_formatted: '+$57.62B' }, 'btc-etf-aum': { value_formatted: '$108.71B' },
    },
  });
  const LIQUIDITY = json('macro.liquidity', {
    metrics: { 'fed-balance': pctOf('$6.75T', 0.0), 'nyfed-rrp-daily': pctOf('$576.00M', 0.0), tga: pctOf('$977.08B', 11.4), 'net-liquidity': pctOf('$5.77T', -1.7) },
  });
  const flows = Array.from({ length: 30 }, (_, i) => ({ day: `2026-08-${String(i + 1).padStart(2, '0')}`, flow: (i % 3 === 0 ? -1 : 1) * 50e6 }));

  it('fits every board, in Unicode and plain, in every room down to a 50 column window', () => {
    for (const room of ROOMS) {
      for (const [t, plain] of [[plainT, true], [uniT, false]] as const) {
        const boards: Array<[string, Board]> = [
          ['brief', briefBoard(t, plain, saved('macro.snapshot'), null, '2026-09-25', room)],
          ['correlations', correlationsBoard(t, plain, saved('cross.correlations'), room)],
          ['treasury', treasuryBoard(t, plain, TREASURY, room)],
          ['etf flows', etfFlowsBoard(t, plain, FLOWS, flows, 99_000, room)],
          ['etf flows, no journal', etfFlowsBoard(t, plain, FLOWS, [], 99_000, room)],
          ['liquidity', liquidityBoard(t, plain, LIQUIDITY, Array.from({ length: 30 }, (_, i) => 5.7e12 + i * 1e9), room)],
          ['liquidity, no journal', liquidityBoard(t, plain, LIQUIDITY, [], room)],
          ['bitcoin', bitcoinBoard(t, plain, days(90), '90d', null, room)],
          ['bitcoin from a date', bitcoinBoard(t, plain, days(90), { from: '2026-06-29' }, null, room)],
          ['hashprice', hashpriceBoard(t, plain, days(30).map((d) => ({ date: d.date, value: d.price / 1e6 })), 90, 99_000, room)],
        ];
        for (const [name, board] of boards) expect(fits(board, room), `${name} in ${room}`).toBe(true);
      }
    }
  });

  it('gives up the 30 day line first, then the percentile bar, then the 30 day change', () => {
    const head = (room: number) => renderLine(briefBoard(plainT, true, saved('macro.snapshot'), null, '2026-09-25', room).lines[0]!, 'plain');
    // With no journal, no row has 30 days to draw, so that column is left out, never shown empty.
    expect(head(72)).toMatch(/7d\s+30d\s+where/);
    expect(head(72)).not.toContain('30 days');
    // CONTROL: with two days kept, the column is drawn.
    const snapshots = new Snapshots(mkdtempSync(join(tmpdir(), 'pk-brief-two-')));
    for (const day of ['2026-09-24', '2026-09-25']) snapshots.save(blockFromJson('macro.snapshot', JSON.stringify({ ...JSON.parse(readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8')), generated_at: `${day}T09:00:00.000Z` }), `${day}T09:00:00.000Z`));
    expect(renderLine(briefBoard(plainT, true, saved('macro.snapshot'), snapshots, '2026-09-25', 72).lines[0]!, 'plain')).toMatch(/7d\s+30d\s+30 days\s+where/);
    expect(head(64)).toMatch(/7d\s+30d\s+where/);
    expect(head(46)).toMatch(/level\s+7d\s+where$/);
    const net = (room: number) => text(briefBoard(plainT, true, saved('macro.snapshot'), null, '2026-09-25', room)).split('\n').find((l) => l.startsWith('Fed balance'))!;
    expect(net(64)).toMatch(/---o- P\d+$/);
    expect(net(53)).toMatch(/\d% +P\d+$/);
  });

  it('shortens the correlation bars before it cuts a name', () => {
    const names = (room: number) => text(correlationsBoard(plainT, true, saved('cross.correlations'), room)).split('\n').filter((l) => /[+-]0\.\d\d$/.test(l));
    // In a 57 column window every name is whole, and the bars are half as long.
    expect(names(53).every((l) => !/\S\.\s/.test(l))).toBe(true);
    expect(Math.max(...names(53).map((l) => (l.match(/#/g) ?? []).length))).toBeLessThan(Math.max(...names(72).map((l) => (l.match(/#/g) ?? []).length)));
  });

  it('keeps the treasury and liquidity bars as long as the room allows, and leaves liquidity\'s out where it does not', () => {
    expect(text(treasuryBoard(plainT, true, TREASURY, 46))).toMatch(/MSTR\s+#{24}\s+~846K/);
    expect(text(liquidityBoard(plainT, true, LIQUIDITY, [], 72))).toMatch(/Fed balance sheet\s+#{24}\s+\$6\.75T/);
    expect(text(liquidityBoard(plainT, true, LIQUIDITY, [], 46))).toMatch(/Fed balance sheet\s+\$6\.75T/);
  });

  // A 150 column window's room, 74 columns past the grid's.
  const WIDE = roomFor(150);
  const widest = (b: Board) => Math.max(...b.lines.map(widthOf));
  // A sentence: words, with no run of spaces between them as a chart's rows have, once a
  // block's rule and an indent are set aside.
  const isSentence = (l: Line) => {
    const words = l
      .map(([, s]) => s)
      .join('')
      .replace(/^\s*[│|└+]?\s*/, '')
      .trimEnd();
    return /[A-Za-z]{2,}[,.:;]? [A-Za-z]{2,}/.test(words) && !/\S {2,}\S/.test(words);
  };
  const sentences = (b: Board) => b.lines.filter(isSentence);
  const axis = (b: Board) => b.lines.map((l) => renderLine(l, 'plain')).find((l) => /\+-+\+/.test(l))!;

  it('grows every chart by each column a window wider than the grid adds, and wraps its sentences at 72 still', () => {
    expect(WIDE - 72).toBe(74);
    const curve = (room: number) => yieldCurveBoard(plainT, true, json('macro.rates', RATES), { kind: 'ago', horizon: '30d' }, {}, undefined, room);
    const coin = (room: number) => bitcoinBoard(plainT, true, days(90), '90d', null, room);
    expect(axis(curve(WIDE)).length - axis(curve(72)).length).toBe(74);
    expect(axis(coin(WIDE)).length - axis(coin(72)).length).toBe(74);
    expect(text(treasuryBoard(plainT, true, TREASURY, WIDE))).toMatch(/MSTR\s+#{110}\s+~846K/);
    expect(text(liquidityBoard(plainT, true, LIQUIDITY, [], WIDE))).toMatch(/Fed balance sheet\s+#{98}\s+\$6\.75T/);
    const scale = (b: Board) => b.lines.map((l) => renderLine(l, 'plain')).find((l) => /-1\s+0\s+\+1/.test(l))!;
    expect(scale(correlationsBoard(plainT, true, saved('cross.correlations'), WIDE)).length - scale(correlationsBoard(plainT, true, saved('cross.correlations'), 72)).length).toBe(74);
    // Each trading day's column widens to three, beside the four column label.
    const flowIn = (room: number) => text(etfFlowsBoard(plainT, true, FLOWS, flows, 99_000, room)).split('\n').find((l) => l.startsWith('in  '))!;
    expect(flowIn(WIDE)).toMatch(/### /);
    expect(flowIn(72)).not.toMatch(/##/);
    // The table of /brief keeps its columns, and its 30 day line takes a point a day.
    const kept = new Snapshots(mkdtempSync(join(tmpdir(), 'pk-brief-wide-')));
    for (const day of ['2026-09-24', '2026-09-25']) kept.save(blockFromJson('macro.snapshot', JSON.stringify({ ...JSON.parse(readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8')), generated_at: `${day}T09:00:00.000Z` }), `${day}T09:00:00.000Z`));
    const where = (room: number) => renderLine(briefBoard(plainT, true, saved('macro.snapshot'), kept, '2026-09-25', room).lines[0]!, 'plain').indexOf('where');
    // 15: on the grid the 30 day line also gives a column to the mark after a week-ranked P.
    expect(where(WIDE) - where(72)).toBe(15);
    for (const [t, plain] of [[plainT, true], [uniT, false]] as const) {
      const boards: Array<[string, Board]> = [
        ['curve', yieldCurveBoard(t, plain, json('macro.rates', RATES), { kind: 'ago', horizon: '30d' }, {}, undefined, WIDE)],
        ['bitcoin', bitcoinBoard(t, plain, days(90), '90d', null, WIDE)],
        ['treasury', treasuryBoard(t, plain, TREASURY, WIDE)],
        ['etf flows', etfFlowsBoard(t, plain, FLOWS, flows, 99_000, WIDE)],
        ['liquidity', liquidityBoard(t, plain, LIQUIDITY, Array.from({ length: 30 }, (_, i) => 5.7e12 + i * 1e9), WIDE)],
        ['correlations', correlationsBoard(t, plain, saved('cross.correlations'), WIDE)],
      ];
      for (const [name, board] of boards) {
        expect(widest(board), name).toBeGreaterThan(72);
        expect(widest(board), name).toBeLessThanOrEqual(WIDE);
        // Printed once, every sentence wraps at 72 however wide the window.
        const printed = printedBoard(t, board, '00:00', 150).lines;
        for (const l of printed.filter(isSentence)) expect(widthOf(l), `${name}: ${renderLine(l, 'plain')}`).toBeLessThanOrEqual(76);
        expect(sentences(board).length, name).toBeGreaterThan(0);
      }
    }
    // CONTROL: in the grid's room each chart is as wide as it has always been.
    expect(axis(curve(72)).length).toBe(7 + 2 + 52);
    expect(text(treasuryBoard(plainT, true, TREASURY, 72))).toMatch(/MSTR\s+#{36}\s+~846K/);
  });
});

describe('a chart in a tall window', () => {
  const curve = (height?: number) => yieldCurveBoard(plainT, true, json('macro.rates', RATES), { kind: 'ago', horizon: '30d' }, {}, undefined, 72, height);
  // The plot's rows: from its first labelled row to the axis.
  const plotRows = (b: Board) => {
    const lines = b.lines.map((l) => renderLine(l, 'plain'));
    return lines.findIndex((l) => /\+-+\+/.test(l)) - lines.findIndex((l) => /\d% \+/.test(l));
  };
  const grow = (rows: number | undefined) => taller(plainT, (h) => curve(h), CURVE_ROWS, 72, rows);

  it('grows into the rows a board leaves unused, up to a quarter of the room, and not at all where it has none', () => {
    const used = fitLines(plainT, grow(undefined).lines, 72).length;
    expect(plotRows(grow(undefined))).toBe(6);
    // Five rows to spare: the plot takes all five, and the board fills the rows exactly.
    expect(plotRows(grow(used + 5))).toBe(11);
    expect(fitLines(plainT, grow(used + 5).lines, 72).length).toBe(used + 5);
    // Far more to spare: a quarter of the room's 72 columns, 18 rows, so it stays wide.
    expect(plotRows(grow(used + 60))).toBe(18);
    // CONTROL: no rows to spare, or fewer than the board needs: as it always was.
    expect(plotRows(grow(used))).toBe(6);
    expect(plotRows(grow(10))).toBe(6);
  });

  it('labels a taller curve to the hundredth, and never draws one label twice in a row', () => {
    const labels = (b: Board, pattern: RegExp) => text(b).split('\n').map((l) => pattern.exec(l)?.[1]).filter(Boolean);
    const tall = labels(curve(20), /([\d.]+%) \+/);
    expect(tall.every((l) => /^\d\.\d\d%$/.test(l!))).toBe(true);
    expect(new Set(tall).size).toBe(tall.length);
    // CONTROL: on the grid, to the tenth.
    expect(labels(curve(), /([\d.]+%) \+/).every((l) => /^\d\.\d%$/.test(l!))).toBe(true);
    // A tall price chart over a range narrower than its labels' thousands: one label, not a column of them.
    const narrow = days(30).map((p, i) => ({ ...p, price: 84_000 + (i % 7) * 10 }));
    const prices = labels(bitcoinBoard(plainT, true, narrow, '30d', null, 72, null, 30), /(\$[\d.,]+K?) \+/);
    expect(prices.length).toBeGreaterThan(0);
    expect(new Set(prices).size).toBe(prices.length);
  });
});

describe('what /brief and /chart read from a typed line', () => {
  it('parses each chart and its range, and says what is wrong otherwise', () => {
    expect(parseBoard('brief', 'macro.snapshot')).toEqual({ kind: 'brief', briefing: 'macro.snapshot' });
    expect(parseBoard('chart', 'yield curve')).toEqual({ kind: 'yield curve', compare: '30d' });
    expect(parseBoard('chart', 'Yield Curve 2025-09-26')).toEqual({ kind: 'yield curve', compare: { date: '2025-09-26' } });
    expect(parseBoard('chart', 'bitcoin from 2025-01-01')).toEqual({ kind: 'bitcoin', range: { from: '2025-01-01' } });
    expect(parseBoard('chart', 'bitcoin 1y')).toEqual({ kind: 'bitcoin', range: '1y' });
    expect(parseBoard('chart', 'hashprice fill')).toEqual({ kind: 'hashprice', fill: true });
    expect(parseBoard('chart', 'correlations')).toEqual({ kind: 'correlations', briefing: 'cross.correlations' });
    expect(parseBoard('chart', 'sectors')).toEqual({ error: 'The charts are yield curve, bitcoin, hashprice, treasury, etf flows, liquidity, correlations, market map, markets, positioning, or a metric over time, such as /chart treasury-10y.' });
    expect(parseBoard('chart', 'etf flows fill')).toEqual({ kind: 'etf flows', fill: true });
    expect(parseBoard('chart', 'liquidity')).toEqual({ kind: 'liquidity' });
    expect(parseBoard('brief', 'macro.snapshot fill')).toEqual({ kind: 'brief', briefing: 'macro.snapshot', fill: true });
    expect(parseBoard('chart', 'bitcoin 5y')).toHaveProperty('error');
    expect(parseBoard('brief', '')).toHaveProperty('error');
  });
});

export type { DataBlock };

describe('the dollar fund series', () => {
  it('is named UUP, as PreReason serves it, on the board, the correlations and the digest, never DXY', () => {
    expect(metricName('dxy')).toBe('UUP');
    const board = text(briefBoard(plainT, true, saved('macro.snapshot'), null, '2026-09-25'));
    expect(board).toMatch(/^UUP\s+\$?28\.72/m);
    expect(board).not.toMatch(/\bDXY\b/);
    const correlations = text(correlationsBoard(plainT, true, saved('cross.correlations')));
    expect(correlations).toContain('UUP');
    expect(correlations).not.toMatch(/\bDXY\b/);
    expect(itemSentence({ briefing: 'macro.snapshot', metric: 'dxy', kind: 'direction', from: 'rising', to: 'flat' } as Parameters<typeof itemSentence>[0])).not.toMatch(/\bDXY\b/);
    // CONTROL: other short codes keep their capitals.
    expect(metricName('tga')).toBe('TGA');
  });
});

describe('the heatmap', () => {
  it("draws a briefing's changes by window, each tile green for a rise and red for a fall, deeper for a larger move", () => {
    const board = heatBoard(maker(false), false, saved('macro.snapshot'));
    expect(board.subtitle).toMatch(/^heatmap · 15 metrics \| /);
    const out = text(heatBoard(plainT, true, saved('macro.snapshot')));
    expect(out).toMatch(/^metric\s+level\s+7d\s+30d\s+90d\s*$/m);
    // Every change by its sign, as the board: a rise green, a fall red, whatever word the briefing uses.
    const cells = board.lines.flat().filter(([role]) => role.startsWith('heatInk/'));
    expect(cells.length).toBeGreaterThan(20);
    for (const [role, s] of cells) {
      const v = s.trim();
      expect(role, v).toMatch(v.startsWith('+') ? /\/heatUp[123]$/ : /\/heatDown[123]$/);
    }
    // All three depths are used, from the ranks within each unit.
    const roles = new Set(cells.map(([role]) => role));
    for (const depth of [1, 2, 3]) expect([...roles].some((r) => r.endsWith(`Up${depth}`) || r.endsWith(`Down${depth}`))).toBe(true);
    // Plain text is ASCII and carries the sign.
    expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
    expect(out).toMatch(/^Net liquidity\s+\S+\s+[+-]\d/m);
    // CONTROL: a change shown as zero takes no tile.
    expect(board.lines.flat().some(([role, s]) => role === 'muted' && /^0(\.0+)?%?$/.test(s.trim()))).toBe(true);
  });

  it("ranks a tile's depth only among the column's rows in the same unit", () => {
    // A percent row and two point rows: the percent row is alone in its unit, so it takes the
    // middle depth, however large the points are.
    expect(heatDepths([0.3, -0.17, 0.02], ['percent', 'absolute', 'absolute'])).toEqual([2, 3, 1]);
    // CONTROL: the percent row's depth does not move when the points change.
    expect(heatDepths([0.3, -9, 5], ['percent', 'absolute', 'absolute'])[0]).toBe(2);
    expect(heatDepths([0.3, 0.6, 0.9], ['percent', 'percent', 'percent'])).toEqual([1, 2, 3]);
    // A zero or a window not served takes no depth.
    expect(heatDepths([0, null, 1], ['percent', 'percent', 'percent'])).toEqual([0, 0, 2]);
    expect(text(heatBoard(plainT, true, saved('macro.snapshot'))).replace(/\s+/g, ' ')).toContain("deeper for a larger move among the column's rows in the same unit");
  });

  it('is asked for as /chart heatmap or /brief with heat', () => {
    expect(parseBoard('chart', 'heatmap')).toEqual({ kind: 'brief', briefing: 'macro.snapshot', heat: true });
    expect(parseBoard('chart', 'heatmap btc.context')).toEqual({ kind: 'brief', briefing: 'btc.context', heat: true });
    expect(parseBoard('brief', 'cross.correlations heat')).toEqual({ kind: 'brief', briefing: 'cross.correlations', heat: true });
  });
});

describe("the yield curve's change row", () => {
  it('writes a change under every maturity that has both levels, the last one too, inside the room', () => {
    for (const columns of [77, 121]) {
      const rows = text(yieldCurveBoard(plainT, true, saved('macro.snapshot'), { kind: 'ago', horizon: '30d' }, {}, undefined, roomFor(columns))).split('\n');
      const now = rows.find((l) => /^ +now /.test(l))!;
      const change = rows.find((l) => /^ +change /.test(l))!;
      const levels = (now.match(/\d+\.\d{2}/g) ?? []).length;
      // A change has a sign or is zero; one for each maturity drawn now and then.
      expect((change.match(/[+-]?\d+\.\d{2}/g) ?? []).length, `${columns}: ${change}`).toBe(levels);
      for (const line of rows) expect(line.length).toBeLessThanOrEqual(roomFor(columns));
    }
  });
});

describe('a reading under a chart', () => {
  it("quotes PreReason's served sentence whole and cites it, under the yield curve and the correlations", () => {
    const curve = text(yieldCurveBoard(plainT, true, saved('macro.snapshot'), { kind: 'ago', horizon: '30d' }));
    expect(curve.replace(/\s+/g, ' ')).toMatch(/reading "Yield curve spread \(10Y-2Y\) at [^"]+" \(macro\.snapshot, yield-curve\)/);
    const pairs = text(correlationsBoard(plainT, true, saved('cross.correlations'))).replace(/\s+/g, ' ');
    expect(pairs).toMatch(/reading "[^"]+" \(cross\.correlations, [a-z0-9-]+_vs_[a-z0-9-]+\)/);
    // CONTROL: a block with no sentence for the metric carries no reading.
    expect(readingLines(plainT, saved('macro.snapshot'), 'no-such-metric', 72)).toEqual([]);
  });
});

describe('/chart <metric>', () => {
  const journal = new Snapshots(DEMO_JOURNAL);

  it('is asked for by its id or a short name, with a briefing, a range and fill in any order', () => {
    expect(parseBoard('chart', 'treasury-10y')).toEqual({ kind: 'metric', metric: 'treasury-10y', briefing: null, range: '30d', fill: false });
    expect(parseBoard('chart', 'gold in commodities.gold 90d fill')).toEqual({ kind: 'metric', metric: 'etf-gld', briefing: 'commodities.gold', range: '90d', fill: true });
    expect(parseBoard('chart', 'uup 1y')).toEqual({ kind: 'metric', metric: 'dxy', briefing: null, range: '1y', fill: false });
    // The arrows change the range, round and round, and never fill.
    const req = { kind: 'metric', metric: 'treasury-10y', briefing: null, range: '30d', fill: true } as const;
    expect(nextRange(req, 1)).toMatchObject({ range: '90d', fill: false });
    expect(nextRange(req, -1)).toMatchObject({ range: '1y' });
  });

  it("draws a metric's days from the journal: title, unit, axis, the last value with its changes by sign, the source and its reading", () => {
    const series = metricSeries(journal, 'treasury-10y', null, 30, DEMO_DAY);
    expect(series.briefing).toBe('macro.snapshot');
    expect(series.points.length).toBe(30);
    const board = metricChartBoard(maker(false), false, 'treasury-10y', series, '30d', null, null, 72);
    expect(board.title).toBe('Treasury 10Y');
    expect(board.subtitle).toBe('percent, 30 days');
    // The credit names when the newest snapshot was generated, never the time it was drawn.
    expect(board.generated).toMatch(/^2026-10-16T09:28/);
    const out = text(metricChartBoard(plainT, true, 'treasury-10y', series, '30d', null, null, 72));
    expect(out).toMatch(/^\s*\d\.\d{2}% \+/m);
    // A yield moves in percentage points: its change says so, at the reading's two places.
    expect(out).toMatch(/^now 5\.10% {2}7d -0\.12 pp {2}30d \+0\.10 pp$/m);
    expect(out).toContain('> your journal: 30 daily snapshots of macro.snapshot, treasury-10y');
    expect(out.replace(/\s+/g, ' ')).toMatch(/reading "10Y Treasury yield at 5\.1%[^"]*" \(macro\.snapshot, treasury-10y\)/);
    // The changes take their sign's colour.
    const now = board.lines.find((l) => l.some(([, s]) => s === 'now '))!;
    expect(now.some(([role]) => role === 'down')).toBe(true);
    expect(now.some(([role]) => role === 'up')).toBe(true);
    // A short name finds its key: UUP is carried as dxy.
    expect(metricSeries(journal, 'dxy', null, 30, DEMO_DAY).key).toBe('dxy');
  });

  it('says how to fill the days the journal lacks, and names a briefing to read where none carries the metric', () => {
    const ninety = metricSeries(journal, 'treasury-10y', null, 90, DEMO_DAY);
    expect(text(metricChartBoard(plainT, true, 'treasury-10y', ninety, '90d', '2026-07-18', 42, 72)).replace(/\s+/g, ' ')).toContain('30 of 90 days are in your journal. /chart treasury-10y in macro.snapshot 90d fill reads the others from macro.snapshot with date=, one call each, of the 42 calls left today; this key reads back to Jul 18, 2026.');
    const none = metricSeries(journal, 'oil-wti', null, 30, DEMO_DAY);
    expect(none.key).toBeNull();
    expect(text(metricChartBoard(plainT, true, 'oil-wti', none, '30d', null, null, 72))).toContain('No briefing kept on this machine carries oil-wti. Name the one that does: /chart oil-wti in macro.snapshot.');
  });
});

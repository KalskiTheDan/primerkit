import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Snapshots, blockFromJson } from '@primerkit/core';
import type { SingleMetric } from '@primerkit/connector-prereason';
import { flowColumns, maker, niceStep, renderLine, type Line } from '@primerkit/ui';
import { BENCH_BRIEFINGS, changeMark, changeText, changeUnit, etfFlowDays, servedDirection, etfFlowsBoard, journalMetric, liquidityBoard, loadBoard, screen, yieldCurveBoard, type Board, type Briefings } from '../src/index';

const t = maker(true);
const text = (b: Board) => b.lines.map((l: Line) => renderLine(l, 'plain')).join('\n');
const json = (id: string, body: object, at = '2026-09-27T03:00:00.000Z') => blockFromJson(id, JSON.stringify({ generated_at: at, ...body }), at);

const ETF = {
  date: '2026-09-27',
  metrics: {
    'btc-etf-net-flow': { value_formatted: '+$134.5M', timestamp: '2026-09-25T20:00:00+00:00' },
    'btc-etf-ibit-flow': { value_formatted: '+$97.0M', timestamp: '2026-09-25T20:00:00+00:00' },
    'btc-etf-fbtc-flow': { value_formatted: '+$49.3M', timestamp: '2026-09-25T20:00:00+00:00' },
    'btc-etf-gbtc-flow': { value_formatted: '$0.0M', timestamp: '2026-09-25T20:00:00+00:00' },
    'btc-etf-cumulative-flow': { value_formatted: '+$57.62B' },
    'btc-etf-aum': { value_formatted: '$108.71B' },
  },
};

describe('/chart etf flows', () => {
  it("draws the day by fund, the rest as the net less the three named, and the funds' totals", () => {
    const board = etfFlowsBoard(t, true, json('btc.etf-flows', ETF), [], 99_000);
    expect(board.subtitle).toBe('Fri 25 Sep | net +$134.5M');
    const out = text(board);
    expect(out).toMatch(/IBIT\s+\|#{16}\s+\+\$97\.0M/);
    expect(out).toMatch(/the rest\s+#+\|\s+-\$11\.8M/);
    expect(out).toContain('Since launch +$57.62B net in; $108.71B held.');
    expect(out).toContain('0 of 30 trading days are in your journal. /chart etf flows fill reads');
  });

  it('counts a trading day once, however many reads name it, and draws the days in and out', () => {
    const snapshots = new Snapshots(mkdtempSync(join(tmpdir(), 'pk-etf-')));
    const flows: Array<[string, string, string]> = [
      ['2026-09-24T23:59:59.999Z', '2026-09-24T20:00:00+00:00', '-$250.0M'],
      ['2026-09-25T23:59:59.999Z', '2026-09-25T20:00:00+00:00', '+$134.5M'],
      // A Saturday read names Friday's flow again.
      ['2026-09-26T23:59:59.999Z', '2026-09-25T20:00:00+00:00', '+$134.5M'],
    ];
    for (const [at, ts, v] of flows) snapshots.save({ ...json('btc.etf-flows', { metrics: { 'btc-etf-net-flow': { value_formatted: v, timestamp: ts } } }), generatedAt: at });
    const days = etfFlowDays(snapshots);
    expect(days).toEqual([
      { day: '2026-09-24', flow: -250e6 },
      { day: '2026-09-25', flow: 134.5e6 },
    ]);
    const out = text(etfFlowsBoard(t, true, json('btc.etf-flows', ETF), days, null));
    expect(out).toContain('2 trading days  in above the line, out below, a half row per $100M');
    expect(out).toContain('In on 1 of 2 days, out on 1.');
  });

  it('gives each day a column as tall as its flow, a half row at least', () => {
    const cols = flowColumns([300, -150, 10, null, 0], true);
    expect(cols.step).toBe(50);
    expect(cols.rows).toEqual(['#        ', '#        ', '#   .    ', "  #      ", "  '      "]);
    expect(niceStep(37)).toBe(40);
    expect(niceStep(0.3)).toBe(0.4);
  });
});

const LIQUIDITY = {
  metrics: {
    'fed-balance': { value_formatted: '$6.75T', timestamp: '2026-09-23T00:00:00+00:00', trend: { change_7d: 0.02, change_unit: 'percent' } },
    'nyfed-rrp-daily': { value_formatted: '$576.00M', timestamp: '2026-09-25T21:30:00+00:00', trend: { change_7d: 0, change_unit: 'percent' } },
    tga: { value_formatted: '$977.08B', timestamp: '2026-09-23T00:00:00+00:00', trend: { change_7d: 11.41, change_unit: 'percent' } },
    'net-liquidity': { value_formatted: '$5.77T', timestamp: '2026-09-25T00:00:00+00:00', trend: { change_7d: -1.69, change_unit: 'percent' } },
  },
};

describe('/chart liquidity', () => {
  it('draws net liquidity as the sum it is, checks that the parts add up, and says the week in words', () => {
    const board = liquidityBoard(t, true, json('macro.liquidity', LIQUIDITY), [5.7e12, null, 5.8e12, 5.77e12]);
    const out = text(board);
    expect(out).toMatch(/Fed balance sheet\s+#{24}\s+\$6\.75T\s+o 0\.0%\s+Sep 23/);
    expect(out).toMatch(/less the TGA\s+#+\s+-\$977\.08B\s+\^ 11\.4%\s+Sep 23/);
    // Reverse repo, $576M of a $6.75T balance sheet, is far under a cell, and still shows.
    expect(out).toMatch(/less reverse repo\s+\.\s+-\$576\.00M/);
    expect(text(liquidityBoard(maker(false), false, json('macro.liquidity', LIQUIDITY), []))).toMatch(/less reverse repo\s+▏\s+-\$576\.00M/);
    expect(out).toMatch(/Net liquidity\s+#+\s+\$5\.77T\s+v 1\.7%\s+Sep 25/);
    expect(out).toContain('The parts add to $5.77T, as served.');
    expect(out).toContain("Over 7 days net liquidity fell 1.7%, the TGA rose 11.4%, and the Fed's balance sheet and reverse repo held.");
    expect(out).toContain('from your journal, 3 days kept');
  });

  it('says so when the parts do not add up to what is served', () => {
    const off = structuredClone(LIQUIDITY);
    off.metrics['net-liquidity'].value_formatted = '$5.90T';
    expect(text(liquidityBoard(t, true, json('macro.liquidity', off), []))).toContain('The parts add to $5.77T; PreReason serves $5.90T, on the dates shown.');
  });

  it('reads net liquidity a day from whichever briefing carried it', () => {
    const snapshots = new Snapshots(mkdtempSync(join(tmpdir(), 'pk-liq-')));
    snapshots.save({ ...json('macro.snapshot', { metrics: { 'net-liquidity': { value_formatted: '$5.70T' } } }), generatedAt: '2026-09-25T09:00:00.000Z' });
    snapshots.save({ ...json('btc.context', { metrics: { 'net-liquidity': { value_formatted: '$5.71T' } } }), generatedAt: '2026-09-25T10:00:00.000Z' });
    snapshots.save({ ...json('macro.liquidity', { metrics: { 'net-liquidity': { value_formatted: '$5.77T' } } }), generatedAt: '2026-09-27T03:00:00.000Z' });
    const series = journalMetric(snapshots, ['macro.liquidity', 'macro.snapshot', 'btc.context'], 'net-liquidity', 3, '2026-09-27');
    expect(series).toEqual([5.71e12, null, 5.77e12]);
  });
});

describe('the yield curve with every maturity PreReason keeps', () => {
  const metric = (name: string, level: number, change30: number): SingleMetric => ({ name, display: name, timestamp: '2026-09-24T00:00:00+00:00', context: `x at ${level}%; 7d`, level, trend: { change_30d: change30, change_30d_available: true, change_unit: 'percent' } });
  const macro = () => blockFromJson('macro.snapshot', readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8'), '2026-09-25T09:06:00.000Z');

  it('reads 3 months and 5 years from their own metrics, each with its own measured change', () => {
    const board = yieldCurveBoard(t, true, macro(), { kind: 'ago', horizon: '30d' }, { m3: metric('treasury-3mo', 4.24, 9.84), y5: metric('treasury-5y', 5.03, 15.63) });
    const out = text(board);
    expect(out).toMatch(/3M\s+2Y\s+5Y\s+10Y\s+30Y/);
    expect(out).toMatch(/now\s+4\.24\s+4\.85\s+5\.03\s+5\.11\s+5\.40/);
    // 4.24 / 1.0984 and 5.03 / 1.1563.
    expect(out).toMatch(/30d ago\s+3\.86\s+4\.19\s+4\.35\s+4\.66\s+5\.18/);
    expect(out).toContain('> 2y, 10y and 30y from macro.snapshot; 3M and 5Y from their own metrics');
    expect(board.sources).toBe('macro.snapshot, treasury-3mo, treasury-5y');
    for (const line of board.lines) expect(renderLine(line, 'plain').replace(/^Over .*/, '').length).toBeLessThanOrEqual(72);
  });

  it('prints the notices served with the metrics it draws, under the board, each once, and none for a metric whose level it does not draw', async () => {
    const noticed = (m: SingleMetric, notices: string[]): SingleMetric => ({ ...m, notices });
    const shared = 'Source: Sample Treasury Office.';
    const calc = "PreReason's calculation from the Sample Treasury Office's daily yields.";
    const board = yieldCurveBoard(t, true, macro(), { kind: 'ago', horizon: '30d' }, { m3: noticed(metric('treasury-3mo', 4.24, 9.84), [shared]), y5: noticed(metric('treasury-5y', 5.03, 15.63), [shared, calc]) });
    const lines = text(board).split('\n');
    // Each once, word for word with no lead-in, as the board's last lines; the calculation's
    // notice its own line beside its publisher's.
    expect(lines.filter((l) => l === shared)).toHaveLength(1);
    expect(lines.slice(-2)).toEqual([shared, calc]);
    expect(lines.at(-3)).toMatch(/^ {2}30 days ago: each level less its measured 30 day change\.$/);
    // The same in colour, and through the connection below Pro.
    expect(text(yieldCurveBoard(maker(false), false, macro(), { kind: 'ago', horizon: '30d' }, { m3: noticed(metric('treasury-3mo', 4.24, 9.84), [shared]), y5: null })).split('\n').at(-1)).toBe(shared);
    const data: Briefings = { id: 'prereason', tier: 'basic', fetch: async (req) => ({ ...macro(), id: req.briefing }), metric: async (name) => noticed(metric(name, name === 'treasury-3mo' ? 4.24 : 5.03, 10), [shared]) };
    const drawn = text((await loadBoard({ kind: 'yield curve', compare: '30d' }, { data, snapshots: null, today: '2026-09-27' }))(t, true));
    expect(drawn.split('\n').filter((l) => l === shared)).toHaveLength(1);
    // A 3 month metric with no level of its own is not drawn (the 3M comes from the spread),
    // so its notice is not printed; the 5 year's is.
    const derived = text(yieldCurveBoard(t, true, macro(), { kind: 'ago', horizon: '30d' }, { m3: noticed({ ...metric('treasury-3mo', 0, 0), level: null }, ['Source: A notice for a level not drawn.']), y5: noticed(metric('treasury-5y', 5.03, 15.63), [shared]) }));
    expect(derived).toContain('3M is the 10y less the 10y-3M spread');
    expect(derived).not.toContain('A notice for a level not drawn.');
    expect(derived.split('\n').at(-1)).toBe(shared);
    // With no metric read on its own, there is no notice.
    expect(text(yieldCurveBoard(t, true, macro(), { kind: 'ago', horizon: '30d' }))).not.toMatch(/Source:|calculation from/);
  });

  it('reads the two metrics through the connection when the curve is asked for below Pro', async () => {
    const asked: string[] = [];
    const data: Briefings = {
      id: 'prereason',
      // Below Pro, so macro.rates is not asked for (boards.test.ts covers Pro).
      tier: 'basic',
      fetch: async (req) => macro() && { ...macro(), id: req.briefing },
      metric: async (name) => {
        asked.push(name);
        return metric(name, name === 'treasury-3mo' ? 4.24 : 5.03, 10);
      },
    };
    const draw = await loadBoard({ kind: 'yield curve', compare: '30d' }, { data, snapshots: null, today: '2026-09-27' });
    expect(asked).toEqual(['treasury-3mo', 'treasury-5y']);
    expect(text(draw(t, true))).toMatch(/now\s+4\.24\s+4\.85\s+5\.03/);
  });
});

describe('changes that round to nothing', () => {
  it('are drawn as unchanged, not as a rise of 0.0%', () => {
    expect(changeMark(0.02, 'percent')).toEqual({ glyph: '●', plain: 'o', role: 'muted', sign: '' });
    expect(changeMark(0.06, 'percent').role).toBe('up');
    expect(changeMark(-0.004, 'absolute').role).toBe('down');
    expect(changeMark(-0.0004, 'absolute').role).toBe('down');
    // A change in percentage points shows at two places, and one that rounds to 0.00 pp is unchanged.
    expect(changeUnit('absolute', '5.10%')).toBe('pp');
    expect(changeUnit('percent', '5.10%')).toBe('percent');
    expect(changeUnit('absolute', '$883.37B')).toBe('absolute');
    expect(changeText(-0.12, 'pp')).toBe('0.12 pp');
    expect(changeMark(0.004, 'pp').role).toBe('muted');
    expect(changeMark(0.006, 'pp').role).toBe('up');
  });

  // The boards and charts colour by the sign alone; a served direction, where one is given,
  // mutes a change it does not agree with.
  it('mute a change that disagrees with a served direction, where one is given', () => {
    expect(changeMark(0.1, 'percent', 'flat')).toEqual({ glyph: '●', plain: 'o', role: 'muted', sign: '+' });
    expect(changeMark(-1.7, 'percent', 'flat')).toEqual({ glyph: '●', plain: 'o', role: 'muted', sign: '-' });
    // No direction served for the window: not known, so muted too.
    expect(changeMark(0.3, 'percent', null).role).toBe('muted');
    // A direction against the sign is not coloured either.
    expect(changeMark(-0.4, 'percent', 'up').role).toBe('muted');
    // CONTROL: a labelled rise stays green, a labelled fall red.
    expect(changeMark(1.2, 'percent', 'up')).toEqual({ glyph: '▲', plain: '^', role: 'up', sign: '' });
    expect(changeMark(-0.8, 'percent', 'down').role).toBe('down');
    expect(servedDirection({ direction: 'flat', direction_horizon: '7d' }, '7d')).toBe('flat');
    expect(servedDirection({ direction: 'stable' }, '7d')).toBe('flat');
    expect(servedDirection({ direction: 'rising', direction_horizon: '7d' }, '30d')).toBeNull();
    expect(servedDirection({ direction: 'falling', direction_horizon: '30d' }, '30d')).toBe('down');
  });
});

describe('/brief fill', () => {
  it('reads only the days the journal lacks, each as it stood that day', async () => {
    const snapshots = new Snapshots(mkdtempSync(join(tmpdir(), 'pk-fill-')));
    const body = readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8');
    snapshots.save({ ...blockFromJson('macro.snapshot', body, '2026-09-20T09:00:00.000Z'), generatedAt: '2026-09-20T09:00:00.000Z' });
    const dates: string[] = [];
    const data: Briefings = {
      id: 'prereason',
      fetch: async (req) => {
        dates.push(req.date ?? 'today');
        // Today's read is generated today, as a live one is.
        const served = req.date ? body : body.replace(/"generated_at":\s*"[^"]*"/, '"generated_at":"2026-09-27T03:00:00.000Z"');
        return blockFromJson('macro.snapshot', served, req.date ? `${req.date}T12:00:00.000Z` : '2026-09-27T03:00:00.000Z');
      },
    };
    await loadBoard({ kind: 'brief', briefing: 'macro.snapshot', fill: true }, { data, snapshots, today: '2026-09-27' });
    expect(dates[0]).toBe('today');
    expect(dates).not.toContain('2026-09-20');
    // 29 days before today, less the one kept.
    expect(dates.slice(1)).toHaveLength(28);
  });
});

export { screen };

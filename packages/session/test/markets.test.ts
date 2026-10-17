import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Snapshots } from '@primerkit/core';
import { FixtureConnector } from '@primerkit/connector-prereason';
import { maker, renderLine, styleOf, widthOf, type Line } from '@primerkit/ui';
import {
  BENCH_BRIEFINGS,
  MARKET_GROUPS,
  MARKET_GROUP_IDS,
  MARKET_MAP,
  POSITIONING,
  chartDraws,
  fitLines,
  keptReadings,
  loadBoard,
  marketMapBoard,
  parseBoard,
  positioningBoard,
  printedBoard,
  type Board,
  type Briefings,
  type MetricRead,
} from '../src/index';
import { READ_AT, TIER_REFUSED, marketConnection, type Refused } from './market-fixture';

const plainT = maker(true);
const uniT = maker(false);
const text = (b: Board) => b.lines.map((l: Line) => renderLine(l, 'plain')).join('\n');
// A board printed once in the grid's width, as `primerkit chart` prints it: its heading,
// its block, and its credit, which names no time for a board of metrics.
const printed = (b: Board, plain = true) => printedBoard(plain ? plainT : uniT, b, '', undefined).lines.map((l) => renderLine(l, 'plain'));
// A board's text with each wrapped line joined to the one before.
const flat = (s: string) => s.replace(/\n {2,}(?=\S)/g, ' ');

// Every board these tests draw, for the words no board may use.
const drawn: Board[] = [];
const keep = (b: Board) => (drawn.push(b), b);

type Over = Record<string, Record<string, unknown> | Refused | null>;
const env = (data: Briefings, snapshots: Snapshots | null = null) => ({ data, snapshots, today: READ_AT.slice(0, 10), now: READ_AT });
async function map(over: Over = {}, plain = true, room = 72): Promise<Board> {
  const draw = await loadBoard({ kind: 'market map' }, env(marketConnection(over)));
  return keep(draw(plain ? plainT : uniT, plain, room));
}
async function positioning(over: Over = {}, snapshots: Snapshots | null = null, plain = true, room = 72): Promise<Board> {
  const draw = await loadBoard({ kind: 'positioning' }, env(marketConnection(over), snapshots));
  return keep(draw(plain ? plainT : uniT, plain, room));
}
const tempSnapshots = () => new Snapshots(mkdtempSync(join(tmpdir(), 'pk-markets-')));
// A kept answer as the metric route serves it, saved as the chart saves one.
const keptAnswer = (snapshots: Snapshots, id: string, at: string, context: string) =>
  snapshots.save({ id, source: 'prereason', format: 'json', fetchedAt: at, generatedAt: at, lines: [], raw: JSON.stringify({ metric: id, timestamp: at, context, source: 'x' }) });

describe('/chart market map', () => {
  it('draws the nine tiles in the words sent for review, the plain version keeping the signs', async () => {
    const board = await map();
    expect(printed(board)).toEqual([
      ' Market map  7 day change | read Oct 13, 14:02 UTC',
      ' | SPY  +1.2%   QQQ  +2.0%   IWM  -0.4%',
      ' | TLT  -0.8%   HYG  +0.1%   VXX  -6.3%',
      ' | UUP  +0.3%   GLD  +1.1%   oil (WTI)  -2.4%',
      ' |',
      // The notices PreReason serves with the metrics, each once, as served.
      ' | Powered by Acme.',
      ' | Source: Sample Energy Office.',
      ' + PR  9 metrics | equal tiles, not sized by value | from Acme and Sample',
    ]);
    expect(MARKET_MAP.map((s) => s.id)).toEqual(['etf-spy', 'etf-qqq', 'etf-iwm', 'etf-tlt', 'etf-hyg', 'etf-vxx', 'etf-uup', 'etf-gld', 'oil-wti']);
  });

  it('carries the sign in green and red beside its arrow, and names the pair', async () => {
    const board = await map({}, false);
    expect(printed(board, false)).toEqual([
      ' Market map  7 day change · read Oct 13, 14:02 UTC',
      ' │ SPY  ▲ 1.2%   QQQ  ▲ 2.0%   IWM  ▼ 0.4%',
      ' │ TLT  ▼ 0.8%   HYG  ▲ 0.1%   VXX  ▼ 6.3%',
      ' │ UUP  ▲ 0.3%   GLD  ▲ 1.1%   oil (WTI)  ▼ 2.4%',
      ' │',
      ' │ over 7 days  ▲ rose · ▼ fell',
      ' │ Powered by Acme.',
      ' │ Source: Sample Energy Office.',
      // The mark is PreReason's tile, " PR " on charcoal.
      ' └  PR  9 metrics · equal tiles, not sized by value · from Acme and Sample',
    ]);
    const segments = board.lines.flat();
    // Up in green and down in red: the colour marks the direction of a change the data states,
    // and the arrow carries it too, so the sign never rests on colour alone.
    expect(segments).toContainEqual(['up', '▲ 1.2%']);
    expect(segments).toContainEqual(['down', '▼ 6.3%']);
    expect(segments).toContainEqual(['up', '▲ rose']);
    expect(segments).toContainEqual(['down', '▼ fell']);
    // Every change by its sign: HYG's +0.1%, a week PreReason calls stable, is green too.
    expect(segments).toContainEqual(['up', '▲ 0.1%']);
    expect(segments).toContainEqual(['up', '▲ 1.2%']);
    expect([styleOf('up').hex, styleOf('down').hex]).toEqual(['#22c55e', '#f04b4b']);
    // The neutral pair is gone from the palette, and no tile uses it.
    for (const b of [board, await map()]) {
      const roles = new Set(b.lines.flat().map(([role]) => role));
      expect(roles.has('rise')).toBe(false);
      expect(roles.has('fall')).toBe(false);
    }
    // CONTROL: a name, a label, is never coloured by the change beside it.
    expect(segments.filter(([, text]) => /SPY|TLT|oil/.test(text)).every(([role]) => role === 'fg')).toBe(true);
  });

  it('names the read time, never an "as of", and the credit names no generated time', async () => {
    const board = await map();
    expect(board.subtitle).toBe('7 day change · read Oct 13, 14:02 UTC');
    expect(board.readAt).toBe(READ_AT);
    expect(board.generated).toBeNull();
    const all = printed(board).join('\n');
    expect(all).not.toMatch(/as of|generated/);
  });

  it('names its own date on a tile whose newest value is older than the read, and says what that means', async () => {
    const board = await map({ 'oil-wti': { timestamp: '2026-10-09T00:00:00.000Z' } });
    const out = text(board);
    expect(out).toContain('oil (WTI)  -2.4%  Oct 9');
    expect(flat(out)).toContain('A date on a tile is the day of its newest value, older than the read, and its 7 day change runs to that day.');
    // CONTROL: a tile read the same day names no date.
    expect(out).toMatch(/SPY {2}\+1\.2% {3}/);
    expect(text(await map())).not.toContain('Oct 9');
  });

  it('says a metric the key cannot read is not read on this key, never a zero', async () => {
    const board = await map({ 'etf-vxx': TIER_REFUSED });
    const out = text(board);
    expect(out).toContain('VXX  not read on this key');
    expect(out).not.toMatch(/VXX {2}[+-]?\d/);
    // Its source is not named for it, and the others still are.
    expect(board.sources).toBe('9 metrics · equal tiles, not sized by value · from Acme and Sample');
    // A metric not read for another reason keeps PreReason's own words.
    const stale = text(await map({ 'etf-hyg': { status: 503, body: { error: 'STALE_DATA', message: "Data for 'etf-hyg' is critically stale (80.0 hours old, threshold: 72h)" } } }));
    expect(stale).toContain('HYG  not read');
    expect(stale).not.toContain('HYG  not read on this key');
    expect(flat(stale)).toContain("HYG not read: Data for 'etf-hyg' is critically stale (80.0 hours old, threshold: 72h).");
  });

  it('says plainly where no 7 day change is served, rather than computing one', async () => {
    const out = text(await map({ 'etf-tlt': { trend: { change_7d: null, change_7d_available: false, change_unit: 'percent' } } }));
    expect(out).toContain('TLT  7 day change not served');
    // A key below the metric's tier is served its latest reading alone.
    const latest = { trend: undefined, context: undefined, reading: '$377.80', access: { served: 'latest_reading', withheld: ['trend'], full_answer_tier: 'basic' } };
    const cut = text(await map({ 'etf-gld': latest }));
    expect(cut).toContain('GLD  no 7 day change on this key');
    expect(flat(cut)).toContain("No 7 day change on this key: its tier is served each metric's latest reading alone.");
  });

  it('sizes and places no tile by its value: every column starts where it would with any other changes', async () => {
    const offsets = (b: Board) => text(b).split('\n').slice(0, 3).map((row) => [...row.matchAll(/[A-Za-z][A-Za-z() ]*? {2}[+-]/g)].map((m) => m.index));
    const base = offsets(await map());
    expect(base).toEqual([[0, 13, 26], [0, 13, 26], [0, 13, 26]]);
    // The same tiles with changes far apart in size, each written as wide: the same places.
    const moved: Over = {};
    for (const [id, v] of [['etf-spy', 9.8], ['etf-qqq', 0.1], ['etf-iwm', -9.9], ['etf-tlt', -0.1], ['etf-vxx', -1.0], ['oil-wti', -8.8]] as const) moved[id] = { trend: { change_7d: v, change_7d_available: true, change_unit: 'percent' } };
    expect(offsets(await map(moved))).toEqual(base);
  });

  it('names every source as PreReason serves it, read from the answers, a new one too', async () => {
    const board = await map({ 'etf-spy': { source: 'A Source This Screen Has Never Seen' }, 'etf-qqq': { source: 'Unknown' } });
    expect(board.sources).toBe('9 metrics · equal tiles, not sized by value · from A Source This Screen Has Never Seen, Acme and Sample');
    // A credit too wide for the window shortens to the mark, so the board names them too,
    // where they wrap.
    expect(flat(text(board))).toContain("> from A Source This Screen Has Never Seen, Acme and Sample, as PreReason names each value's source");
    expect(flat(text(await map({}, true, 53)))).toContain("> from Acme and Sample, as PreReason names each value's source");
    // CONTROL: where the credit fits, the board does not repeat it.
    expect(text(await map())).not.toContain('> from');
  });

  it('reads the nine metrics, a call each, and keeps each answer on this machine by its own time', async () => {
    const asked: string[] = [];
    const snapshots = tempSnapshots();
    await loadBoard({ kind: 'market map' }, env(marketConnection({}, asked), snapshots));
    expect(asked).toEqual(MARKET_MAP.map((s) => s.id));
    expect(snapshots.list('etf-spy', 'json').map((s) => s.generatedAt)).toEqual(['2026-10-13T13:45:00.000Z']);
  });
});

describe('/chart positioning', () => {
  it('draws SPY beside the speculative net position in S&P 500 futures, marked futures, with its served ranks', async () => {
    const board = await positioning();
    expect(board.title).toBe('Positioning');
    expect(board.subtitle).toBe('SPY and the speculative net position in S&P 500 futures · read Oct 13, 14:02 UTC');
    const lines = text(board).split('\n');
    expect(lines.slice(0, 5)).toEqual([
      'SPY  $671.20 | 7 day +1.2%',
      'S&P 500 futures, noncommercial net (CFTC, weekly, futures)',
      '  -48,213 contracts | released Oct 9',
      '  percentile of its own history, released Oct 9:',
      '    26 weeks 61.5 | 52 weeks 70.2 | 156 weeks 83.0',
    ]);
    const out = flat(text(board));
    expect(out).toContain('Each percentile as PreReason ranks it, among the prior weekly CFTC reports; 100 is the most net long.');
    expect(printed(board).at(-1)).toBe(' + PR  etf-spy, cot-spx-noncomm-net | futures positions, not fund exposure');
    // The credit fits beside the mark in the grid's room; in a narrower one, where it
    // shortens to the mark, the board says it.
    expect(5 + board.sources.length).toBeLessThanOrEqual(72);
    expect(out).not.toContain('> etf-spy');
    expect(flat(text(await positioning({}, null, true, 53)))).toContain('> etf-spy, cot-spx-noncomm-net | futures positions, not fund exposure');
    expect(board.readAt).toBe(READ_AT);
    // The futures mark, on the figure itself.
    expect(out).toContain('(CFTC, weekly, futures)');
    // In a window wide enough, the figure shares the line with its label.
    expect(text(await positioning({}, null, true, 96))).toContain('S&P 500 futures, noncommercial net (CFTC, weekly, futures)  -48,213 contracts | released Oct 9');
  });

  it("dates the CFTC's figures by the day the report was released, never as the positions' own day, and says a SPY a day old", async () => {
    const board = await positioning();
    const out = flat(text(board));
    // The weekly report is released on a Friday for positions as of the Tuesday before: the
    // served time is the release, so the date says so, beside the net and over its ranks.
    expect(out).toContain('-48,213 contracts | released Oct 9');
    expect(out).toContain('percentile of its own history, released Oct 9:');
    expect(out).not.toMatch(/contracts \| Oct 9/);
    // Only a value's own day takes the note that a date is that value's day.
    expect(out).not.toContain("A date beside a value is that value's own day, older than the read.");
    const oldSpy = flat(text(await positioning({ 'etf-spy': { timestamp: '2026-10-10T20:00:00.000Z' } })));
    expect(oldSpy).toContain('SPY  $671.20 | 7 day +1.2% | Oct 10');
    expect(oldSpy).toContain("A date beside a value is that value's own day, older than the read.");
    // Ranks from reports released on different days each say their own.
    const apart = flat(text(await positioning({ 'cot-spx-noncomm-net-percentile-156w': { timestamp: '2026-10-02T19:30:00.000Z' } })));
    expect(apart).toContain('percentile of its own history: 26 weeks 61.5 released Oct 9');
    expect(apart).toContain('52 weeks 70.2 released Oct 9');
    expect(apart).toContain('156 weeks 83.0 released Oct 2');
  });

  it('says a SPY served its latest reading alone has no 7 day change on this key, in the words cleared for the map', async () => {
    const latest = { trend: undefined, context: undefined, reading: '$671.20', access: { served: 'latest_reading', withheld: ['trend'], full_answer_tier: 'basic' } };
    const out = text(await positioning({ 'etf-spy': latest }));
    expect(out).toContain('SPY  $671.20 | no 7 day change on this key');
    expect(out).not.toContain('7 day not on this key');
  });

  it('names the read time in its heading, as the market map does, and every source as served below, the CFTC with SPY beside it', async () => {
    const board = await positioning();
    // The heading, as `primerkit chart` prints it, names the read time once; the board does not repeat it.
    expect(printed(board)[0]).toBe(' Positioning  SPY and the speculative net position in S&P 500 futures | read Oct 13, 14:02 UTC');
    expect(printed(board, false)[0]).toBe(' Positioning  SPY and the speculative net position in S&P 500 futures · read Oct 13, 14:02 UTC');
    // In a window too narrow for the whole heading, the read time goes under it whole.
    const heading = (columns: number, n: number) => printedBoard(plainT, board, '', columns).lines.slice(0, n).map((l) => renderLine(l, 'plain'));
    expect(heading(76, 2)).toEqual([' Positioning  SPY and the speculative net position in S&P 500 futures', ' read Oct 13, 14:02 UTC']);
    expect(heading(60, 3)).toEqual([' Positioning', ' SPY and the speculative net position in S&P 500 futures', ' read Oct 13, 14:02 UTC']);
    // CONTROL: the map's heading, which fits, is one line.
    expect(printedBoard(plainT, await map(), '', 76).lines[0]!.map(([, s]) => s).join('')).toBe(' Market map  7 day change | read Oct 13, 14:02 UTC');
    const out = flat(text(board));
    expect(out).not.toContain('read Oct 13');
    expect(out).toContain('> SPY from Acme | the net and its percentiles from Sample Positions Office, weekly report (futures only)');
    expect(printed(board).join('\n')).not.toMatch(/as of|generated/);
    // A source the screen does not know prints as served.
    expect(flat(text(await positioning({ 'cot-spx-noncomm-net-percentile-156w': { source: 'A Rank Source Never Seen' } })))).toContain(
      '| the net and its percentiles from Sample Positions Office, weekly report (futures only) | its percentiles from A Rank Source Never Seen',
    );
    // Where no value names a source, no line of sources is drawn, and the heading still says the read time.
    const none: Over = {};
    for (const id of [POSITIONING.spy, POSITIONING.net, ...POSITIONING.ranks.map((r) => r.id)]) none[id] = { source: 'Unknown' };
    const unnamed = await positioning(none);
    expect(text(unnamed)).not.toMatch(/^> (?!etf-spy)/m);
    expect(unnamed.subtitle).toContain('read Oct 13, 14:02 UTC');
  });

  it('marks the net\'s line over time as futures positions, as the figure is marked', async () => {
    const snapshots = tempSnapshots();
    for (const [at, v] of [['2026-09-25T19:30:00.000Z', '-55,870'], ['2026-10-02T19:30:00.000Z', '-54,333']] as const) keptAnswer(snapshots, POSITIONING.net, at, `S&P 500 e-mini non-commercial net position at ${v} contracts; 7d +1.`);
    const out = text(await positioning({}, snapshots));
    expect(out).toMatch(/^ {2}net \(futures\) {2}[.\-~=+#]{3} {2}3 weekly readings, Sep 25 to Oct 9$/m);
    expect(out).not.toMatch(/^ {2}net {2}/m);
    // The figure above it carries the same mark, and the credit says what it is not.
    expect(out).toContain('(CFTC, weekly, futures)');
  });

  it('says how many readings are kept, and draws no line from fewer than two', async () => {
    const snapshots = tempSnapshots();
    const first = text(await positioning({}, snapshots));
    // The read itself is kept, so the first draw has one of each.
    expect(first).toContain('over time, from the readings kept on this machine');
    expect(first).toContain('  SPY  1 daily reading kept; a line needs two');
    expect(first).toContain('  net (futures)  1 weekly reading kept; a line needs two');
    // Read again the same week: the same release is not kept twice.
    await positioning({}, snapshots);
    expect(snapshots.list(POSITIONING.net, 'json')).toHaveLength(1);
    for (const [at, v] of [['2026-09-18T19:30:00.000Z', '-61,002'], ['2026-09-25T19:30:00.000Z', '-55,870'], ['2026-10-02T19:30:00.000Z', '-54,333']] as const) {
      keptAnswer(snapshots, POSITIONING.net, at, `S&P 500 e-mini non-commercial net position at ${v} contracts; 7d +1.`);
    }
    // SPY twice on one day: the day's newest counts.
    keptAnswer(snapshots, POSITIONING.spy, '2026-10-12T14:00:00.000Z', 'SPY at $660.00; 7d +0.5%.');
    keptAnswer(snapshots, POSITIONING.spy, '2026-10-12T19:45:00.000Z', 'SPY at $665.50; 7d +0.6%.');
    expect(keptReadings(snapshots, POSITIONING.spy, 'day', 365)).toEqual([
      { at: '2026-10-12T19:45:00.000Z', value: 665.5 },
      { at: '2026-10-13T13:45:00.000Z', value: 671.2 },
    ]);
    expect(keptReadings(snapshots, POSITIONING.net, 'reading', 156).map((k) => k.value)).toEqual([-61002, -55870, -54333, -48213]);
    const later = text(await positioning({}, snapshots));
    expect(later).toMatch(/ {2}SPY {2}[.\-~=+#]{2} {2}2 daily readings, Oct 12 to Oct 13/);
    expect(later).toMatch(/ {2}net \(futures\) {2}[.\-~=+#]{4} {2}4 weekly readings, Sep 18 to Oct 9/);
  });

  it('says a rank or figure the key cannot read is not read on this key', async () => {
    const out = text(await positioning({ 'cot-spx-noncomm-net-percentile-156w': TIER_REFUSED, 'cot-spx-noncomm-net': TIER_REFUSED }));
    expect(out).toContain('156 weeks not read on this key');
    expect(out).toContain('  not read on this key');
    expect(out).not.toContain('contracts');
  });
});

describe('the notices PreReason serves with each metric', () => {
  const count = (lines: string[], notice: string) => lines.filter((l) => l.endsWith(` ${notice}`)).length;

  it('prints each notice under the market map once, word for word with no lead-in, however many metrics carry it, and keeps the credit', async () => {
    for (const plain of [true, false]) {
      const board = await map({}, plain);
      const lines = printed(board, plain);
      // Eight funds carry the same notice, and it is said once.
      expect(count(lines, 'Powered by Acme.')).toBe(1);
      expect(count(lines, 'Source: Sample Energy Office.')).toBe(1);
      // Under the tiles, and the credit stays under them.
      expect(lines.findIndex((l) => l.endsWith('Powered by Acme.'))).toBeGreaterThan(lines.findIndex((l) => l.includes('oil (WTI)')));
      expect(lines.at(-1)).toMatch(/PR {2}9 metrics . equal tiles, not sized by value . from Acme and Sample$/);
      expect(lines.join('\n')).not.toMatch(/Notice:/);
    }
    // A notice is printed as served, a new one too, and none where none is served.
    const served = text(await map({ 'etf-qqq': { notices: ['A notice this screen has never seen, as served.'] } }));
    expect(served).toContain('A notice this screen has never seen, as served.');
    expect(served.split('\n').filter((l) => l === 'Powered by Acme.')).toHaveLength(1);
    const none: Over = {};
    for (const s of MARKET_MAP) none[s.id] = { notices: undefined };
    expect(text(await map(none))).not.toMatch(/Powered by|Source:/);
    // A metric not read carries no notice: a refused oil read leaves its source's out.
    expect(text(await map({ 'oil-wti': TIER_REFUSED }))).not.toContain('Source: Sample Energy Office.');
  });

  it("prints positioning's notices once each, and keeps PreReason's own calculation apart from its publisher's notice", async () => {
    for (const plain of [true, false]) {
      const board = await positioning({}, null, plain);
      const lines = printed(board, plain);
      // Each of the board's own lines, before the window wraps a long one.
      const notices = text(board).split('\n').filter((l) => /(Powered by|Source:|PreReason's calculation)/.test(l));
      // In the order the board reads its metrics: SPY, the net, then its ranks. The publisher's
      // notice the net and all three ranks carry is said once; the ranks' own calculation
      // notice is its own line, never folded into the publisher's, and said once for the three.
      expect(notices).toEqual([
        'Powered by Acme.',
        'Source: Sample Positions Office Commitments of Traders.',
        "PreReason's calculation from the Sample Positions Office Commitments of Traders.",
      ]);
      expect(lines.at(-1)).toMatch(/PR {2}etf-spy, cot-spx-noncomm-net . futures positions, not fund exposure$/);
    }
    // A calculation notice is kept even where no publisher's notice is served beside it.
    const own = text(await positioning({ 'cot-spx-noncomm-net': { notices: undefined }, 'cot-spx-noncomm-net-percentile-26w': { notices: ["PreReason's calculation from the Sample Positions Office Commitments of Traders."] } }));
    expect(own).toContain("PreReason's calculation from the Sample Positions Office Commitments of Traders.");
    expect(own.split('\n').filter((l) => l === 'Source: Sample Positions Office Commitments of Traders.')).toHaveLength(1);
  });
});

describe('a key PreReason does not accept, or its rate limit', () => {
  const UNAUTHORIZED: Refused = { status: 401, body: { error: 'UNAUTHORIZED', message: 'Invalid API key' } };

  it('stops the reads at a refused key, and says PreReason did not accept the key rather than drawing tiles for the tier', async () => {
    for (const [kind, ids] of [['market map', MARKET_MAP.map((s) => s.id)], ['positioning', [POSITIONING.spy]]] as const) {
      const asked: string[] = [];
      const over: Over = {};
      for (const id of ids) over[id] = UNAUTHORIZED;
      await expect(loadBoard({ kind }, env(marketConnection(over, asked)))).rejects.toThrow(/^PreReason did not accept the key\.$/);
      // The first call was refused, and nothing more was asked.
      expect(asked).toEqual(['etf-spy']);
    }
  });

  it('stops the reads at a rate limit, and says when to try again as PreReason names it', async () => {
    const asked: string[] = [];
    const limited: Refused = { status: 429, body: { error: 'RATE_LIMITED', message: 'Too many requests' }, headers: { 'retry-after': '120' } };
    await expect(loadBoard({ kind: 'market map' }, env(marketConnection({ 'etf-iwm': limited }, asked)))).rejects.toThrow(/^PreReason's rate limit for this account is reached\. Try again in about 2 minutes\.$/);
    expect(asked).toEqual(['etf-spy', 'etf-qqq', 'etf-iwm']);
    // CONTROL: a tier refusal is one metric's, and the rest are still read.
    const tier: string[] = [];
    await loadBoard({ kind: 'market map' }, env(marketConnection({ 'etf-iwm': TIER_REFUSED }, tier)));
    expect(tier).toEqual(MARKET_MAP.map((s) => s.id));
  });
});

describe('the market charts on every connection and in every window', () => {
  it('parses /chart market map and /chart positioning', () => {
    expect(parseBoard('chart', 'market map')).toEqual({ kind: 'market map' });
    expect(parseBoard('chart', 'Market  Map')).toEqual({ kind: 'market map' });
    expect(parseBoard('chart', 'positioning')).toEqual({ kind: 'positioning' });
    expect(parseBoard('chart', 'market')).toEqual({ error: 'The charts are yield curve, bitcoin, hashprice, treasury, etf flows, liquidity, correlations, market map, markets, positioning, or a metric over time, such as /chart treasury-10y.' });
  });

  it('is not offered on the saved briefings, and says why where it is typed', async () => {
    const saved = new FixtureConnector(BENCH_BRIEFINGS);
    expect(chartDraws('market map', saved)).toBe(false);
    expect(chartDraws('positioning', saved)).toBe(false);
    expect(chartDraws('market map', marketConnection())).toBe(true);
    expect(chartDraws('positioning', null)).toBe(true);
    await expect(loadBoard({ kind: 'market map' }, env(saved))).rejects.toThrow('The saved briefings carry no metrics on their own, which the market map is drawn from. They are read from PreReason once it is connected.');
    await expect(loadBoard({ kind: 'positioning' }, env(saved))).rejects.toThrow('which the positioning chart is drawn from');
  });

  it('fits both boards, in Unicode and plain, in every room down to a 50 column window', async () => {
    const snapshots = tempSnapshots();
    for (const [at, v] of [['2026-09-25T19:30:00.000Z', '-55,870'], ['2026-10-02T19:30:00.000Z', '-54,333']] as const) keptAnswer(snapshots, POSITIONING.net, at, `S&P 500 e-mini non-commercial net position at ${v} contracts; 7d +1.`);
    keptAnswer(snapshots, POSITIONING.spy, '2026-10-12T19:45:00.000Z', 'SPY at $665.50; 7d +0.6%.');
    for (const room of [72, 64, 53, 46]) {
      for (const plain of [true, false]) {
        const t = plain ? plainT : uniT;
        const boards: Array<[string, Board]> = [
          ['map', await map({}, plain, room)],
          ['map, dated and not read', await map({ 'oil-wti': { timestamp: '2026-10-09T00:00:00.000Z' }, 'etf-vxx': TIER_REFUSED, 'etf-spy': { source: 'A Source This Screen Has Never Seen' } }, plain, room)],
          ['positioning', await positioning({}, snapshots, plain, room)],
          ['positioning, nothing kept', await positioning({ 'cot-spx-noncomm-net-percentile-52w': TIER_REFUSED }, null, plain, room)],
        ];
        for (const [name, board] of boards) {
          for (const l of fitLines(t, board.lines, room)) expect(widthOf(l), `${name} in ${room}: ${renderLine(l, 'plain')}`).toBeLessThanOrEqual(room);
          if (plain) expect(/^[\x00-\x7f]*$/.test(text(board)), name).toBe(true);
        }
      }
    }
    // Narrower, the tiles go two across, then one, and never cut a word.
    const dated = { 'oil-wti': { timestamp: '2026-10-09T00:00:00.000Z' } };
    expect(text(await map(dated, true, 53)).split('\n')[0]).toBe('SPY  +1.2%   QQQ  +2.0%   IWM  -0.4%');
    expect(text(await map(dated, true, 46)).split('\n')[0]).toMatch(/^SPY {2}\+1\.2% +QQQ {2}\+2\.0%$/);
    expect(text(await map({ ...dated, 'etf-vxx': TIER_REFUSED }, true, 46)).split('\n')[0]).toBe('SPY  +1.2%');
  });

  it('uses no word that ranks, advises or reads a position as a fund\'s, on any board drawn here', () => {
    expect(drawn.length).toBeGreaterThan(20);
    for (const board of drawn) {
      for (const plain of [true, false]) {
        // The credit's own "not fund exposure" says what the figure is not.
        const all = [board.title, board.subtitle, ...printed(board, plain)].join('\n').replace(/not fund exposure/g, '');
        expect(all).not.toMatch(/fund exposure|stretched|extreme|signal|\bbest\b|\bworst\b|leader|laggard|recommend|should|\bbuy\b|\bsell\b|bullish|bearish/i);
      }
    }
  });
});

// The board functions alone, from reads made by hand, for what the loader never gives.
describe('the market boards from reads made by hand', () => {
  it('draws a tile for a metric with no read at all as not read on this key', () => {
    const reads: MetricRead[] = [];
    const out = text(marketMapBoard(plainT, true, reads, READ_AT));
    for (const s of MARKET_MAP) expect(out).toContain(`${s.label}  not read on this key`);
    const pos = text(positioningBoard(plainT, true, reads, { spy: [], net: [] }, READ_AT));
    expect(pos).toContain('SPY  not read on this key');
    expect(pos).toContain('26 weeks not read on this key');
    expect(pos).toContain('  SPY  0 daily readings kept; a line needs two');
  });
});

describe('/chart markets', () => {
  const markets = async (plain = true, room = 120) => keep((await loadBoard({ kind: 'markets' }, env(marketConnection())))(plain ? plainT : uniT, plain, room));

  it('groups the markets by asset class, equities first and crypto last, a tile each with its level and change', async () => {
    const board = await markets();
    expect(board.title).toBe('Markets');
    const out = text(board);
    const heads = MARKET_GROUPS.map((g) => out.indexOf(g.name.toUpperCase()));
    expect(heads.every((at) => at >= 0)).toBe(true);
    expect([...heads].sort((a, b) => a - b)).toEqual(heads);
    expect(MARKET_GROUPS.at(-1)!.name).toBe('crypto');
    expect(out).toMatch(/ SPY {2,}/);
    expect(out).toContain('$671.20  +1.2%');
    // A yield's change is in percentage points, and both oils give their level a barrel.
    expect(out).toContain('4.12%  +0.06 pp');
    expect(out).toContain('$58.23/bbl');
    expect(out).toContain('$66.80/bbl');
    expect(out.replace(/\s+/g, ' ')).toContain('equal tiles, not sized by value');
  });

  it('colours each tile by its sign, deeper for a larger move within its group in the same unit', async () => {
    const board = await markets(false);
    const tiles = board.lines.flat().filter(([role]) => role.startsWith('heatInk/'));
    for (const [role, s] of tiles) if (/[+-]\d/.test(s)) expect(role, s).toMatch(/[+]\d/.test(s) ? /heatUp[123]$/ : /heatDown[123]$/);
    // IWM fell 0.4% and VXX 6.3% in one group: VXX's tile is the deeper.
    const depthOf = (label: string) => Number(board.lines.find((l) => l.some(([, s]) => s.trim().startsWith(label)))?.find(([, s]) => s.trim().startsWith(label))?.[0].slice(-1));
    expect(depthOf('VXX')).toBeGreaterThan(depthOf('IWM'));
    // Plain text is ASCII and keeps the signs.
    expect(/^[\x00-\x7f]*$/.test(text(await markets(true)))).toBe(true);
    // The rows of tiles keep within the room; the legend is a sentence, wrapped where it is drawn.
    for (const line of board.lines.filter((l) => l.some(([role]) => role.includes('/')))) expect(widthOf(line)).toBeLessThanOrEqual(120);
  });

  it('is asked for as /chart markets, its tier the highest its markets need', () => {
    expect(parseBoard('chart', 'markets')).toEqual({ kind: 'markets' });
    expect(MARKET_GROUP_IDS).toContain('bitcoin-price');
  });
});

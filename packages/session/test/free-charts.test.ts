import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockFromJson, type Config } from '@primerkit/core';
import { PreReasonError, parseCatalog, parseMetricCatalog, type PricePoint, type Tier } from '@primerkit/connector-prereason';
import { maker } from '@primerkit/ui';
import { DEMO_CATALOG, MARKET_MAP, POSITIONING_IDS, Session, chartHelp, demoDeps, loadBoard, menuRows, parseBoard, requestTier, type BoardEnv, type BoardRequest, type Briefings, type TierLists } from '../src/index';
import { READ_AT, marketConnection } from './market-fixture';

// Charts on a key whose tier is known: what each needs, said before any call is spent on a
// chart the key cannot draw. Nothing here reaches PreReason: the connections are fakes.

const TODAY = '2026-10-14';
const plainT = maker(true);
const CATALOG = parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8')));

// PreReason's list of metrics in its own shape, made up for these tests: the nine markets and
// positioning's five filed outside the free door, one metric only Pro briefings use, and the
// sentence the list says the free door in.
const METRIC_LIST = parseMetricCatalog({
  metrics: [...MARKET_MAP.map((s) => s.id), ...POSITIONING_IDS, 'pro-only-made-up'].map((name) => ({ name, display_name: name, category: 'macro' })).concat([{ name: 'bitcoin-price', display_name: 'Bitcoin', category: 'bitcoin' }]),
  free_key: 'A free key reads the 17 metrics in the bitcoin category in full, and the latest reading of the other 241. A basic key reads 250 in full, and the latest reading of the 8 that only pro briefings use. The pro tier reads every metric in full.',
  pro_only_metrics: ['pro-only-made-up'],
});
const LISTS: TierLists = { briefings: CATALOG, metrics: METRIC_LIST };

// A live connection as the chart code sees it: no saved briefings, every call counted.
function live(tier: Tier | null = null) {
  const calls: string[] = [];
  const ranges: Array<{ from: string; to: string }> = [];
  const price = (id: string) => blockFromJson(id, JSON.stringify({ metrics: { 'bitcoin-price': { value_formatted: '$63,000.00', timestamp: `${TODAY}T05:00:00+00:00` } } }), `${TODAY}T05:00:00.000Z`);
  const data: Briefings = {
    id: 'prereason',
    tier,
    fetch: async ({ briefing }) => {
      calls.push(briefing);
      return price(briefing);
    },
    bitcoinHistory: async (range) => {
      calls.push('history');
      ranges.push(range);
      return Array.from({ length: 29 }, (_, i): PricePoint => ({ date: new Date(Date.parse(`${range.from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), price: 60_000 + i * 100 }));
    },
    metric: async (name) => {
      calls.push(name);
      throw new Error(`${name} is not served here`);
    },
  };
  return { data, calls, ranges };
}

// The board env as the session hands it over, with the tier the config keeps.
const env = (data: Briefings, tier: Tier | null, today = TODAY): BoardEnv => ({
  data,
  snapshots: null,
  today,
  tier,
  lists: { briefings: async () => CATALOG, metrics: async () => METRIC_LIST },
});
const chart = (text: string, tier: Tier | null = 'free', today = TODAY): BoardRequest => {
  const req = parseBoard('chart', text, { tier, today });
  if ('error' in req) throw new Error(req.error);
  return req;
};
const refusal = (req: BoardRequest, e: BoardEnv): Promise<string> => loadBoard(req, e).then(
  () => 'drawn',
  (error: Error) => error.message,
);

describe("/chart bitcoin on a Free key", () => {
  it('draws 30 days with no range typed, asking from today less 29 at most, and reads the price now from a free briefing', async () => {
    const req = chart('bitcoin');
    expect(req).toEqual({ kind: 'bitcoin', range: '30d' });
    const { data, calls, ranges } = live();
    const draw = await loadBoard(req, env(data, 'free'));
    expect(ranges).toEqual([{ from: '2026-09-15', to: TODAY }]);
    // btc.momentum is Basic in the catalog, so no call is spent on it.
    expect(calls).toEqual(['history', 'btc.quick-check']);
    expect(draw(plainT, true).subtitle).toMatch(/^30 days, Sep 15, 2026 to /);
    // 30d typed asks the same days: today and the 29 before it, which a free key reads.
    const typed = live();
    await loadBoard(chart('bitcoin 30d'), env(typed.data, 'free'));
    expect(typed.ranges[0]?.from).toBe('2026-09-15');
    // CONTROL: a key whose tier reaches 90 days draws 90 with no range typed, and asks btc.momentum.
    expect(chart('bitcoin', 'basic')).toEqual({ kind: 'bitcoin', range: '90d' });
    const basic = live();
    await loadBoard(chart('bitcoin', 'basic'), env(basic.data, 'basic'));
    expect(basic.ranges[0]?.from).toBe('2026-07-17');
    expect(basic.calls).toEqual(['history', 'btc.momentum']);
  });

  it("refuses a range past a Free key's reach before any call, in primerkit's own words", async () => {
    for (const [text, words] of [
      ['bitcoin 90d', "A Free key reads Bitcoin's price 30 days back; 90d needs a Basic key or above."],
      ['bitcoin 1y', "A Free key reads Bitcoin's price 30 days back; 1y needs a Basic key or above."],
      ['bitcoin all', "A Free key reads Bitcoin's price 30 days back; all needs a Pro key or above."],
      ['bitcoin from 2026-09-14', "A Free key reads Bitcoin's price 30 days back; from 2026-09-14 needs a Basic key or above."],
    ] as const) {
      const { data, calls } = live();
      expect(await refusal(chart(text), env(data, 'free')), text).toBe(words);
      expect(calls, text).toEqual([]);
    }
    // A Basic key reads from Basic's first day, and all of it needs Pro.
    const basic = live();
    expect(await refusal(chart('bitcoin all', 'basic'), env(basic.data, 'basic'))).toBe("A Basic key reads Bitcoin's price back to Jan 1, 2025; all needs a Pro key or above.");
    expect(basic.calls).toEqual([]);
    // CONTROL: the first day a free key reads is asked for, and drawn.
    const edge = live();
    expect(await refusal(chart('bitcoin from 2026-09-15'), env(edge.data, 'free'))).toBe('drawn');
  });

  it("says a refusal PreReason sends for a key whose tier was not known in primerkit's words, never PreReason's sentence", async () => {
    const data: Briefings & { tier: Tier | null } = {
      id: 'prereason',
      tier: null,
      fetch: async () => {
        throw new Error('not asked');
      },
      bitcoinHistory: async (range) => {
        // The refusal names the tier, as PreReason's header does on every keyed answer.
        data.tier = 'free';
        throw new PreReasonError(`Date '${range.from}' is outside your tier's access range (Today + last 30 days)`, 403, 'DATE_RESTRICTED');
      },
    };
    const said = await refusal({ kind: 'bitcoin', range: '90d' }, { data, snapshots: null, today: TODAY });
    expect(said).toBe("A Free key reads Bitcoin's price 30 days back; 90d needs a Basic key or above.");
    expect(said).not.toContain('access range');
  });
});

describe('the paid charts on a Free key', () => {
  it('refuses each before any call, naming the tier that draws it and where to see what the key reads', async () => {
    for (const [text, words] of [
      ['liquidity', 'The liquidity chart needs a Basic key or above, for macro.liquidity; /catalog lists what your key reads.'],
      ['etf flows', 'The etf flows chart needs a Basic key or above, for btc.etf-flows; /catalog lists what your key reads.'],
      ['etf flows fill', 'The etf flows chart needs a Basic key or above, for btc.etf-flows; /catalog lists what your key reads.'],
      ['hashprice', 'The hashprice chart needs a Basic key or above, for btc.miner-survival; /catalog lists what your key reads.'],
      ['hashprice fill', 'The hashprice chart needs a Basic key or above, for btc.miner-survival; /catalog lists what your key reads.'],
      ['treasury', 'The treasury chart needs a Pro key or above, for btc.treasury; /catalog lists what your key reads.'],
      ['yield curve 1y', 'A Free key reads the yield curve as it stood up to 30 days back; 1y needs a Basic key or above.'],
    ] as const) {
      const { data, calls } = live();
      expect(await refusal(chart(text), env(data, 'free')), text).toBe(words);
      expect(calls, text).toEqual([]);
    }
    // The CLI names its own command for the list.
    const { data } = live();
    expect(await refusal(chart('treasury'), { ...env(data, 'free'), hints: { catalog: 'primerkit catalog' } })).toContain('; primerkit catalog lists what your key reads.');
    // A Basic key reads the Basic charts; the treasury still needs Pro.
    const basic = live();
    expect(await refusal(chart('treasury', 'basic'), env(basic.data, 'basic'))).toBe('The treasury chart needs a Pro key or above, for btc.treasury; /catalog lists what your key reads.');
    expect(basic.calls).toEqual([]);
  });

  it('draws the free charts on a Free key, the yield curve without asking for the Pro macro.rates', async () => {
    const curve = live();
    await loadBoard(chart('yield curve'), env(curve.data, 'free')).catch(() => null);
    expect(curve.calls[0]).toBe('macro.snapshot');
    expect(curve.calls).not.toContain('macro.rates');
    const correlations = live();
    await loadBoard(chart('correlations'), env(correlations.data, 'free')).catch(() => null);
    expect(correlations.calls).toEqual(['cross.correlations']);
    // CONTROL: a key whose tier is not known reads as before, and PreReason's answer says the rest.
    const unknown = live();
    await loadBoard(chart('liquidity', null), { data: unknown.data, snapshots: null, today: TODAY }).catch(() => null);
    expect(unknown.calls).toEqual(['macro.liquidity']);
  });
});

describe('/chart market map on a Free key', () => {
  const at = READ_AT.slice(0, 10);

  it('is refused before its nine calls: the key reads each level alone, and the map draws 7 day changes', async () => {
    const asked: string[] = [];
    const said = await refusal({ kind: 'market map' }, env(marketConnection({}, asked), 'free', at));
    expect(said).toBe("The market map needs a Basic key or above: it draws each market's 7 day change, and a Free key reads each market's level alone. /catalog lists what your key reads.");
    expect(asked).toEqual([]);
    // CONTROL: a Basic key draws it, a call a market.
    const basic: string[] = [];
    expect(await refusal({ kind: 'market map' }, env(marketConnection({}, basic), 'basic', at))).toBe('drawn');
    expect(basic).toHaveLength(9);
    // CONTROL: where PreReason's list does not say its tiers, the map is read as before.
    const unsaid: string[] = [];
    const quiet = parseMetricCatalog({ metrics: MARKET_MAP.map((s) => ({ name: s.id, category: 'macro' })) });
    expect(await refusal({ kind: 'market map' }, { ...env(marketConnection({}, unsaid), 'free', at), lists: { metrics: async () => quiet } })).toBe('drawn');
    expect(unsaid).toHaveLength(9);
  });

  it('leaves positioning drawn on a Free key, its readings being what every key reads', async () => {
    const asked: string[] = [];
    expect(await refusal({ kind: 'positioning' }, env(marketConnection({}, asked), 'free', at))).toBe('drawn');
    expect(asked).toHaveLength(5);
  });
});

describe('a session on a Free key', () => {
  // A later start on a live connection whose config keeps the Free tier, on a fixed clock.
  function freeSession() {
    const { data, calls } = live();
    let config: Config = { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model: { kind: 'ollama', base_url: 'http://127.0.0.1:9', name: 'qwen2.5:7b' }, prereason: { tier: 'free' } };
    const s = new Session({
      ...demoDeps({ version: '0.1.0' }),
      demo: null,
      checkMachine: async () => ({ apps: [], keys: [], local: [], ollama: 'absent' }),
      config: { read: () => config, write: (c) => void (config = c) },
      resolveKey: () => ({ key: 'not-a-key', source: 'env' }),
      briefings: () => data,
      catalog: async () => CATALOG,
      metricCatalog: async () => METRIC_LIST,
      now: () => new Date(`${TODAY}T10:00:00.000Z`),
    });
    s.start();
    return { s, calls };
  }
  const typed = (s: Session, text: string) => Array.from(text).forEach((char) => s.key({ name: 'char', char }));

  it("marks the paid charts in /chart's menu, and refuses one before any call, naming its tier", async () => {
    const { s, calls } = freeSession();
    typed(s, '/chart ');
    await s.idle();
    const rows = Object.fromEntries((s.state.menu?.rows ?? []).map((r) => [r.text, r.about]));
    expect(rows['/chart liquidity']).toBe('net liquidity and its parts (Basic)');
    expect(rows['/chart market map']).toBe('nine markets by 7 day change, a call each (Basic)');
    expect(rows['/chart treasury']).toBe('Bitcoin treasury holders (Pro)');
    expect(rows['/chart correlations']).toBe('correlations across markets');
    typed(s, 'liquidity');
    s.key({ name: 'enter' });
    await s.idle();
    expect(s.state.step).toMatchObject({ name: 'board', error: 'The liquidity chart needs a Basic key or above, for macro.liquidity; /catalog lists what your key reads.' });
    expect(calls).toEqual([]);
    // Bitcoin with no range draws the 30 days a Free key reads.
    s.key({ name: 'escape' });
    typed(s, '/chart bitcoin');
    s.key({ name: 'enter' });
    await s.idle();
    expect(s.state.step).toMatchObject({ name: 'board', request: { kind: 'bitcoin', range: '30d' }, error: null });
    expect(calls).toEqual(['history', 'btc.quick-check']);
  });
});

describe("each chart's tier, in the /chart menu and --help", () => {
  it("reads each metric's tier from the words of PreReason's list, and none where it does not say", () => {
    expect(METRIC_LIST.find((m) => m.id === 'etf-spy')?.fullAt).toBe('basic');
    expect(METRIC_LIST.find((m) => m.id === 'pro-only-made-up')?.fullAt).toBe('pro');
    expect(METRIC_LIST.find((m) => m.id === 'bitcoin-price')?.fullAt).toBe('free');
    expect(parseMetricCatalog({ metrics: [{ name: 'etf-spy', category: 'macro' }], pro_only_metrics: [] })[0]).not.toHaveProperty('fullAt');
    expect(requestTier({ kind: 'market map' }, LISTS, TODAY)).toBe('basic');
    expect(requestTier({ kind: 'market map' }, { briefings: CATALOG, metrics: null }, TODAY)).toBeNull();
  });

  it('marks each /chart row a Free key cannot draw with the tier that draws it', () => {
    const chartTier = (args: string): Tier | null => {
      const req = parseBoard('chart', args, { tier: 'free', today: TODAY });
      return 'error' in req ? null : requestTier(req, LISTS, TODAY);
    };
    const rows = Object.fromEntries(menuRows('/chart ', { briefings: null, hosted: false, chartTier }).map((r) => [r.text, r.about]));
    expect(rows).toEqual({
      '/chart yield curve': 'Treasury yields now and 30 days ago',
      '/chart yield curve 90d': 'now and 90 days ago',
      '/chart yield curve 1y': 'now and a year ago (Basic)',
      '/chart bitcoin': 'Bitcoin over 90 days, or as far as a Free key reads',
      '/chart bitcoin 30d': 'over 30 days',
      '/chart bitcoin 1y': 'over a year (Basic)',
      '/chart bitcoin all': 'over all its price history (Pro)',
      '/chart hashprice': 'hashprice, from your journal (Basic)',
      '/chart hashprice fill': 'reads the missing days, a call each (Basic)',
      '/chart etf flows': 'spot Bitcoin ETF flows by fund (Basic)',
      '/chart etf flows fill': 'reads the missing days, a call each (Basic)',
      '/chart liquidity': 'net liquidity and its parts (Basic)',
      '/chart market map': 'nine markets by 7 day change, a call each (Basic)',
      '/chart markets': 'markets by asset class, a tile each, a call each',
      '/chart positioning': 'SPY beside S&P 500 futures positioning',
      '/chart treasury': 'Bitcoin treasury holders (Pro)',
      '/chart correlations': 'correlations across markets',
      // The heatmap draws from the briefing named, so it carries no tier of its own.
      '/chart heatmap': "macro.snapshot's changes as a heatmap, 7, 30 and 90 days",
      '/chart heatmap btc.context': "btc.context's changes as a heatmap",
      '/chart heatmap cross.correlations': "cross.correlations' changes as a heatmap",
    });
    // CONTROL: where no tier is known, no row is marked.
    expect(menuRows('/chart ', { briefings: null, hosted: false }).filter((r) => /\((Basic|Pro)\)$/.test(r.about))).toEqual([]);
  });

  it("names each chart's tier in --help's chart line, from the lists, and leaves unmarked what they do not say", () => {
    expect(chartHelp(LISTS, TODAY)).toEqual([
      'yield curve [30d|90d|1y|date] (1y: Basic),',
      'bitcoin [30d|90d|1y|all|from date] (90d and 1y: Basic, all: Pro),',
      'hashprice [fill] (Basic),',
      'treasury (Pro),',
      'etf flows [fill] (Basic),',
      'liquidity (Basic),',
      'correlations [briefing],',
      'market map (Basic),',
      // The lists name no tier for some of the grouped map's markets, so it is left unmarked.
      'markets,',
      'positioning;',
      'a tier named is the least key that draws it',
    ]);
    // With no list of metrics kept, the market map is left unmarked rather than guessed.
    expect(chartHelp({ briefings: CATALOG, metrics: null }, TODAY)).toContain('market map,');
  });
});

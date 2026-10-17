import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Journal, Snapshots, blockFromMarkdown, loadOperation, type DataBlock } from '@primerkit/core';
import { FixtureConnector, PreReasonError, parseCatalog, type ContextRequest, type MetricEntry } from '@primerkit/connector-prereason';
import { ASK_DIR, BENCH_BRIEFINGS, DEMO_CATALOG, DIGEST_DIR, journalRows, type Briefings } from '@primerkit/session';
import { HostRuns, callTool, type HostDeps } from '../src/index';

// The three gaps of ask inside an AI app: the app's model picks metrics beside briefings,
// passes the one past day it works out from the question's words, and primerkit holds both
// to the rules the session holds them to.

const catalog = parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8')));
const METRICS: MetricEntry[] = [
  { id: 'treasury-10y', name: '10-Year Treasury Yield', description: 'The 10 year US Treasury constant maturity yield (FRED)', category: 'macro' },
  { id: 'fed-funds-rate', name: 'Federal Funds Rate', description: 'The effective federal funds rate (FRED)', category: 'macro' },
];

class Recording implements Briefings {
  readonly id = 'prereason';
  readsDates = true;
  readonly reads: Array<{ id: string; date: string | null }> = [];
  private readonly saved = new FixtureConnector(BENCH_BRIEFINGS);
  constructor(private readonly refuse: Record<string, PreReasonError> = {}) {}
  has(id: string): boolean {
    return this.saved.has(id);
  }
  async fetch(req: ContextRequest): Promise<DataBlock> {
    this.reads.push({ id: req.briefing, date: req.date ?? null });
    if (this.refuse[req.briefing]) throw this.refuse[req.briefing];
    return this.saved.fetch(req);
  }
  async metricBlock(id: string): Promise<DataBlock> {
    this.reads.push({ id, date: null });
    return blockFromMarkdown(id, `# ${id}\n\n**Latest reading:** 4.12%\n`, '2026-10-03T12:00:00.000Z');
  }
}

function setup(data: Recording = new Recording(), over: Partial<HostDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pk-host-gaps-'));
  const deps: HostDeps = {
    ask: loadOperation(ASK_DIR),
    digest: loadOperation(DIGEST_DIR),
    data: () => data,
    catalog: async () => catalog,
    metrics: async () => METRICS,
    tier: () => 'free',
    watchlist: async () => [],
    snapshots: new Snapshots(join(home, 'snapshots')),
    journal: new Journal(join(home, 'journal')),
    home,
    bench: null,
    routine: null,
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    ...over,
  };
  return { runs: new HostRuns(deps), data, home };
}

const answer = (block: string, quote: string, asOf?: string) => ({
  answer: 'The packet reads as its first line says.',
  claims: [{ text: 'The first line names what was read.', citations: [{ block, line: 1, quote }] }],
  not_in_data: [],
  ...(asOf ? { data_as_of: asOf } : {}),
});

describe('ask gaps inside an AI app', () => {
  it('lists the metrics beside the briefings, each said to be read as it stands now, and asks for the day', async () => {
    const { runs } = setup();
    const listed = await callTool(runs, 'prepare_operation', { operation: 'ask', question: 'Where is the 10 year yield?' });
    const text = listed.content[0]!.text;
    expect(text).toContain('Pick up to three briefings or metrics');
    expect(text).toMatch(/Briefings \(pass as briefings\):\nbtc\.[a-z-]+: /);
    // Each metric by its id and name, its description left to the catalog tool, so the list
    // fits in one result an app takes in.
    expect(text).toContain('Metrics, each read as it stands now (pass as metrics; the catalog tool searches their descriptions):\ntreasury-10y: 10-Year Treasury Yield\n');
    // On a Free key, the agent is told a metric alone is its latest reading, and a briefing carries the changes.
    expect(text).toContain('On a Free key, a metric read on its own gives its latest reading alone; a briefing gives its metrics with their changes, so read a briefing for a question about a change.');
    expect(text).toContain('If the question asks about one past day, pass it as date, YYYY-MM-DD.');
    expect(text).toMatch(/Code would pick: treasury-10y/);
  });

  it("suggests, on a Free key, the briefing that carries a metric for a question about a change, as ask reads; a Basic key, the metric", async () => {
    const NET: MetricEntry = { id: 'net-liquidity', name: 'Net Liquidity', description: 'Net liquidity proxy - Fed balance sheet minus reverse repo and Treasury account balances', category: 'macro' };
    for (const [tier, pick] of [['free', 'macro.snapshot'], ['basic', 'net-liquidity']] as const) {
      const { runs } = setup(new Recording(), { metrics: async () => [...METRICS, NET], tier: () => tier });
      const listed = await callTool(runs, 'prepare_operation', { operation: 'ask', question: 'Is net liquidity rising or falling?' });
      expect(listed.content[0]!.text, tier).toContain(`Code would pick: ${pick}.`);
    }
  });

  it('reads a metric the app names, as lines it cites like a briefing line', async () => {
    const { runs, data } = setup();
    const prepared = await runs.prepare({ operation: 'ask', question: 'Where is the 10 year yield?', metrics: ['treasury-10y'] });
    if (prepared.kind !== 'packet') throw new Error('no packet');
    expect(data.reads).toEqual([{ id: 'treasury-10y', date: null }]);
    expect(prepared.packet).toContain('Metric treasury-10y (10-Year Treasury Yield), markdown, as it stands now:');
    expect(prepared.packet).toContain('[treasury-10y L2] **Latest reading:** 4.12%');
    const done = runs.submit({ runId: prepared.runId, response: answer('treasury-10y', '# treasury-10y') });
    expect(done.kind).toBe('done');
    if (done.kind === 'done') expect(done.outcome).toBe('passed');
  });

  it("holds an app's answer to the direction check: a direction cited to a latest reading alone is repaired, then taken out and named", async () => {
    // The full run of 2026-10-14: "steepening" from a latest reading alone passed 4 of 4 checks.
    const { runs } = setup();
    const prepared = await runs.prepare({ operation: 'ask', question: 'Is the 10 year yield rising?', metrics: ['treasury-10y'] });
    if (prepared.kind !== 'packet') throw new Error('no packet');
    expect(prepared.packet).toContain('3. A direction, such as rising or steepening, needs a change in the lines you cite.');
    const level = { text: 'The yield is at 4.12%.', citations: [{ block: 'treasury-10y', line: 2, quote: '**Latest reading:** 4.12%' }] };
    const rising = { text: 'The yield is rising, at 4.12%.', citations: [{ block: 'treasury-10y', line: 2, quote: '**Latest reading:** 4.12%' }] };
    const said = { answer: 'The yield is rising, at 4.12%.', claims: [level, rising], not_in_data: [] };
    const repair = runs.submit({ runId: prepared.runId, response: said });
    expect(repair).toMatchObject({
      kind: 'repair',
      failures: ['grounded_directions: "rising" is a direction the lines this claim cites do not hold: none of them states a change', 'grounded_directions: the answer states "rising", a direction no cited line holds'],
    });
    const done = runs.submit({ runId: prepared.runId, response: said });
    if (done.kind !== 'done') throw new Error('not done');
    expect(done.outcome).toBe('partial');
    expect(done.render).toContain('**The yield is at 4.12%.**');
    expect(done.render).toContain('Partial answer. Not supported by the data, so taken out: "The yield is rising, at 4.12%.".');
  });

  it("reads the briefings as they stood on the app's day, holds data_as_of to it and keeps where the day came from", async () => {
    const { runs, data, home } = setup();
    const prepared = await runs.prepare({ operation: 'ask', question: 'Where did Bitcoin stand last Friday?', briefings: ['btc.pulse'], date: '2026-10-02' });
    if (prepared.kind !== 'packet') throw new Error('no packet');
    expect(data.reads).toEqual([{ id: 'btc.pulse', date: '2026-10-02' }]);
    expect(prepared.packet).toContain('As of: 2026-10-02.');
    const repair = runs.submit({ runId: prepared.runId, response: answer('btc.pulse', '"briefing":"btc.pulse"') });
    expect(repair).toMatchObject({ kind: 'repair', failures: ['as_of: data_as_of must be 2026-10-02, the day this packet was read for'] });
    const done = runs.submit({ runId: prepared.runId, response: answer('btc.pulse', '"briefing":"btc.pulse"', '2026-10-02') });
    if (done.kind !== 'done') throw new Error('not done');
    expect(done.outcome).toBe('passed');
    expect(done.render).toContain('PR · btc.pulse · as it stood on Oct 2, 2026 ·');
    expect(done.render).toContain('· no advice words · dated the day the briefings were read for ·');
    const dir = journalRows(join(home, 'journal'))[0]!.dir;
    expect(JSON.parse(readFileSync(join(dir, 'pick.json'), 'utf8'))).toMatchObject({ briefings: ['btc.pulse'], picked_by: 'host', date: '2026-10-02', date_from: 'host' });
  });

  it("puts the question's own day before the app's", async () => {
    const { runs, data } = setup();
    await runs.prepare({ operation: 'ask', question: 'Where did Bitcoin stand on 2026-08-15?', briefings: ['btc.pulse'], date: '2026-09-01' });
    expect(data.reads).toEqual([{ id: 'btc.pulse', date: '2026-08-15' }]);
  });

  it('refuses in words what cannot be read: a day to come, a metric for a past day, four ids, a metric not listed, a day the saved briefings lack', async () => {
    const { runs } = setup();
    await expect(runs.prepare({ operation: 'ask', question: 'Bitcoin?', briefings: ['btc.pulse'], date: '2026-10-09' })).rejects.toThrow('Oct 9, 2026 has not come yet, so nothing was read.');
    await expect(runs.prepare({ operation: 'ask', question: 'Yields?', metrics: ['treasury-10y'], date: '2026-08-15' })).rejects.toThrow('treasury-10y: PreReason serves a metric as it stands now, not as it stood on Aug 15, 2026.');
    await expect(runs.prepare({ operation: 'ask', question: 'All of it?', briefings: ['btc.pulse', 'btc.context', 'macro.snapshot'], metrics: ['treasury-10y'] })).rejects.toThrow('4 were named. An answer reads at most three briefings and metrics together.');
    await expect(runs.prepare({ operation: 'ask', question: 'Gold?', metrics: ['gold-price'] })).rejects.toThrow('gold-price is not a metric PreReason lists.');
    await expect(runs.prepare({ operation: 'ask', question: 'From 2026-08-01 to 2026-09-01?', briefings: ['btc.pulse'] })).rejects.toThrow('This question names 2 days');
    const saved = new Recording();
    saved.readsDates = false;
    await expect(setup(saved).runs.prepare({ operation: 'ask', question: 'Bitcoin?', briefings: ['btc.pulse'], date: '2026-08-15' })).rejects.toThrow('These briefings are one saved day');
    expect(saved.reads).toEqual([]);
  });

  it("says PreReason's own words, with its window, where every day was refused", async () => {
    const refused = new PreReasonError("Date '2026-08-15' is outside your tier's access range (Free: the last 30 days)", 403, 'DATE_RESTRICTED');
    const { runs } = setup(new Recording({ 'btc.pulse': refused }));
    await expect(runs.prepare({ operation: 'ask', question: 'Bitcoin?', briefings: ['btc.pulse'], date: '2026-08-15' })).rejects.toThrow("btc.pulse could not be read for Aug 15, 2026. PreReason says: Date '2026-08-15' is outside your tier's access range (Free: the last 30 days).");
  });

  it('offers no metrics where they cannot be read, as in the demo', async () => {
    const { runs } = setup(new Recording(), { metrics: undefined });
    const prepared = await runs.prepare({ operation: 'ask', question: 'Where is the 10 year yield?' });
    if (prepared.kind !== 'catalog') throw new Error('no catalog');
    expect(prepared.metrics).toEqual([]);
    await expect(runs.prepare({ operation: 'ask', question: 'Yields?', metrics: ['treasury-10y'] })).rejects.toThrow('Metrics cannot be read here.');
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Journal, Snapshots, blockFromJson, loadOperation, readConfig, writeConfig, type BenchFile } from '@primerkit/core';
import { FixtureConnector, PreReasonError, parseCatalog, smallestFree } from '@primerkit/connector-prereason';
import { ASK_DIR, BENCH_BRIEFINGS, DEMO_CATALOG, DEMO_DATE, DIGEST_DIR, ROOT, fitnessInputs, journalRows, readLatestDigest } from '@primerkit/session';
import {
  HostError,
  HostRuns,
  TOOLS,
  applyInstall,
  describePlan,
  describeRemoval,
  hostDeps,
  planInstall,
  lmStudioConfig,
  removeInstall,
  serveMcp,
  type HostDeps,
  type Runner,
} from '../src/index';

const ask = loadOperation(ASK_DIR);
const digest = loadOperation(DIGEST_DIR);
const ROUTINE = loadOperation(join(ROOT, 'operations', 'routine'));
const catalog = parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8')));
const bench = JSON.parse(readFileSync(join(ROOT, 'operations', 'bench-comprehension', 'questions-2026-09-25.json'), 'utf8')) as BenchFile;
const QUESTION = 'Where does Bitcoin stand?';

function setup(over: Partial<HostDeps> = {}): { runs: HostRuns; home: string; deps: HostDeps } {
  const home = mkdtempSync(join(tmpdir(), 'pk-host-'));
  const deps: HostDeps = {
    ask,
    digest,
    data: () => new FixtureConnector(BENCH_BRIEFINGS),
    catalog: async () => catalog,
    tier: () => 'free',
    watchlist: async () => ['macro.snapshot', 'cross.correlations', 'btc.context'],
    snapshots: new Snapshots(join(home, 'snapshots')),
    journal: new Journal(join(home, 'journal')),
    home,
    bench: { file: bench, data: fitnessInputs(ROOT, ask).benchData, fixtures: '2026-09-25' },
    routine: ROUTINE,
    now: () => new Date('2026-09-26T14:00:00.000Z'),
    ...over,
  };
  return { runs: new HostRuns(deps), home, deps };
}

// An answer that passes its checks: one claim on btc.pulse's price line.
const GOOD = {
  answer: 'Bitcoin is at $84,512.32.',
  claims: [{ text: 'Bitcoin is at $84,512.32.', citations: [{ block: 'btc.pulse', line: 2, quote: '"value_formatted":"$84,512.32"' }] }],
  not_in_data: [],
};

const runDir = (home: string, runId: string) => journalRows(join(home, 'journal')).find((r) => r.dir.endsWith(runId))!.dir;

describe('ask inside an AI app', () => {
  it('returns the catalog to pick from when no briefings are named', async () => {
    const { runs } = setup();
    const prepared = await runs.prepare({ operation: 'ask', question: QUESTION });
    expect(prepared.kind).toBe('catalog');
    if (prepared.kind !== 'catalog') return;
    expect(prepared.briefings.map((b) => b.id)).toEqual(expect.arrayContaining(['btc.pulse', 'btc.context', 'macro.snapshot']));
    expect(prepared.suggested.length).toBeGreaterThan(0);
  });

  it('journals the run as pending when it prepares the packet, then keeps the answer, its checks and its view', async () => {
    const { runs, home } = setup();
    const prepared = await runs.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.pulse'] });
    expect(prepared.kind).toBe('packet');
    if (prepared.kind !== 'packet') return;
    expect(prepared.packet).toContain('[btc.pulse L');
    const dir = runDir(home, prepared.runId);
    expect(readdirSync(dir).sort()).toEqual(['packet.json', 'packet.md', 'pending.json', 'pick.json']);
    expect(journalRows(join(home, 'journal'))[0]).toMatchObject({ operation: 'ask', title: QUESTION, outcome: 'pending' });

    const submitted = runs.submit({ runId: prepared.runId, response: GOOD });
    expect(submitted.kind).toBe('done');
    if (submitted.kind !== 'done') return;
    expect(submitted.outcome).toBe('passed');
    expect(submitted.render).toContain('$84,512.32');
    expect(readdirSync(dir).sort()).toEqual(['checks.json', 'meta.json', 'packet.json', 'packet.md', 'pending.json', 'pick.json', 'render.md', 'response.json']);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { outcome: string; host: boolean; model: string };
    expect(meta).toMatchObject({ outcome: submitted.outcome, host: true, model: 'the model of the AI app (declared)' });
    expect(journalRows(join(home, 'journal'))[0]?.outcome).toBe(submitted.outcome);
  });

  it('gives one repair turn, keeps both replies, and never takes a third', async () => {
    const { runs, home } = setup();
    const prepared = await runs.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.pulse'] });
    if (prepared.kind !== 'packet') throw new Error('no packet');
    const good = GOOD;
    const bad = structuredClone(GOOD);
    bad.claims[0]!.citations[0]!.quote = 'a sentence that is in no briefing at all, 99.9';
    const repair = runs.submit({ runId: prepared.runId, response: bad });
    expect(repair.kind).toBe('repair');
    if (repair.kind === 'repair') expect(repair.failures.join('\n')).toMatch(/citations/);
    expect(runs.submit({ runId: prepared.runId, response: good }).kind).toBe('done');
    const dir = runDir(home, prepared.runId);
    expect(existsSync(join(dir, 'response.json'))).toBe(true);
    expect(existsSync(join(dir, 'response.repair.json'))).toBe(true);
    expect(() => runs.submit({ runId: prepared.runId, response: good })).toThrow(HostError);
  });

  it('names a field the format does not allow under an answer that failed, and in its render.md', async () => {
    for (const [extra, said] of [
      [{ action: 'buy' }, 'the response holds a field its format does not allow: action'],
      [{ action: 'buy', size: 0.5 }, 'the response holds fields its format does not allow: action, size'],
    ] as const) {
      const { runs, home } = setup();
      const prepared = await runs.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.pulse'] });
      if (prepared.kind !== 'packet') throw new Error('no packet');
      const reply = { ...GOOD, ...extra };
      // The repair turn is told the same words.
      expect(runs.submit({ runId: prepared.runId, response: reply })).toMatchObject({ kind: 'repair', failures: [`schema: ${said}`] });
      const done = runs.submit({ runId: prepared.runId, response: reply });
      if (done.kind !== 'done') throw new Error('not done');
      expect(done.render).toBe(`The answer did not pass its checks, so it is not shown: ${said}.`);
      expect(readFileSync(join(runDir(home, prepared.runId), 'render.md'), 'utf8')).toBe(done.render);
    }
  });

  it('says what went wrong in words: no key, an unknown briefing, an unknown run', async () => {
    const { runs } = setup({ data: () => null });
    await expect(runs.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.pulse'] })).rejects.toThrow('PreReason is not connected');
    const connected = setup().runs;
    // Saved briefings say so; a connection that reads dates is a key's.
    await expect(connected.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.treasury'] })).rejects.toThrow('btc.treasury is not among the saved briefings.');
    const keyed = setup({ data: () => Object.assign(new FixtureConnector(BENCH_BRIEFINGS), { readsDates: true }) }).runs;
    await expect(keyed.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.treasury'] })).rejects.toThrow('not in the catalog this key reads');
    await expect(connected.prepare({ operation: 'trade' })).rejects.toThrow('There is no operation trade');
    expect(() => connected.submit({ runId: 'nothing', response: {} })).toThrow('No run nothing is waiting');
  });

  it('records nothing for a call that gives no reply, so the repair turn is still there', async () => {
    const { runs, home } = setup();
    const prepared = await runs.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.pulse'] });
    if (prepared.kind !== 'packet') throw new Error('no packet');
    for (const response of [undefined, null, '', '  ']) expect(() => runs.submit({ runId: prepared.runId, response })).toThrow('submit_response takes the reply as response, and this call gave none');
    expect(existsSync(join(runDir(home, prepared.runId), 'response.json'))).toBe(false);
    const bad = structuredClone(GOOD);
    bad.claims[0]!.citations[0]!.quote = 'a sentence that is in no briefing at all, 99.9';
    expect(runs.submit({ runId: prepared.runId, response: bad }).kind).toBe('repair');
  });

  it("holds a packet to the ask operation's cap inside an AI app too: fitted, or not handed out", async () => {
    const one = setup();
    const alone = await one.runs.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.pulse'] });
    if (alone.kind !== 'packet') throw new Error('no packet');
    const tokens = (JSON.parse(readFileSync(join(runDir(one.home, alone.runId), 'packet.json'), 'utf8')) as { tokens: { count: number } }).tokens.count;
    const capped = (cap: number) => ({ ...ask, spec: { ...ask.spec, data: { ...ask.spec.data, maxPacketTokens: cap } } });
    // Room for btc.pulse and its note, not for macro.snapshot beside it.
    const { runs } = setup({ ask: capped(tokens + 300) });
    const fitted = await runs.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.pulse', 'macro.snapshot'] });
    if (fitted.kind !== 'packet') throw new Error('no packet');
    expect(fitted.packet).toMatch(/macro\.snapshot (was|were) (not read|read as markdown), to fit the ask operation's cap of [\d,]+ tokens a packet/);
    await expect(setup({ ask: capped(200) }).runs.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.pulse'] })).rejects.toThrow("The packet is over the ask operation's cap, so it was not handed out");
  });

  it("says under the demo's answer that its briefings are a saved day's, as the terminal's demo does", async () => {
    const answered = async (over: Partial<HostDeps>): Promise<string> => {
      const { runs } = setup(over);
      const prepared = await runs.prepare({ operation: 'ask', question: QUESTION, briefings: ['btc.pulse'] });
      if (prepared.kind !== 'packet') throw new Error('no packet');
      const submitted = runs.submit({ runId: prepared.runId, response: GOOD });
      if (submitted.kind !== 'done') throw new Error('not done');
      return submitted.render;
    };
    expect(await answered({ savedOn: 'Sep 25, 2026' })).toContain("(demo: saved briefings of Sep 25, 2026; every time above is that day's, not today's)");
    expect(await answered({})).not.toContain('demo:');
    // The server's own setup gives the demo its day, and live data none.
    expect(hostDeps({ version: '0.0.0', demo: true }).savedOn).toBe(DEMO_DATE);
    expect(hostDeps({ version: '0.0.0', env: { PRIMERKIT_HOME: mkdtempSync(join(tmpdir(), 'pk-host-')) } }).savedOn).toBeUndefined();
  });
});

describe('the digest inside an AI app', () => {
  // Yesterday's macro.snapshot, with the TGA's signal and net liquidity's direction as
  // they stood before today's briefing.
  function withYesterday(): FixtureConnector {
    const today = readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8');
    const before = JSON.parse(today) as { metrics: Record<string, { signal: string; trend: { direction: string } }> };
    before.metrics['net-liquidity']!.trend.direction = 'rising';
    before.metrics['tga']!.signal = 'at-trend';
    const saved = new FixtureConnector(BENCH_BRIEFINGS);
    const data = Object.create(saved) as FixtureConnector;
    data.fetch = async (req) => {
      if (req.date && req.briefing === 'macro.snapshot') return blockFromJson('macro.snapshot', JSON.stringify(before), '2026-09-26T08:00:00.000Z');
      if (req.date) throw new PreReasonError("not available on this key's tier", 403, 'DATE_RESTRICTED');
      return saved.fetch(req);
    };
    return data;
  }

  // One sentence for each item in the diff block, quoting the metric's key from its line.
  function changesFor(packet: string): string {
    const items = [...packet.matchAll(/^\[diff L\d+\] (\{.*\})$/gm)].map((m) => JSON.parse(m[1]!) as { id: string; briefing: string; metric: string; kind: string; to: string; line: number });
    return JSON.stringify({
      changes: items.map((i) => ({
        item: i.id,
        text: i.kind === 'direction' ? `${i.metric} turned ${i.to}.` : `${i.metric}'s signal moved to ${i.to}.`,
        citations: [{ block: i.briefing, line: i.line, quote: `"metric":"${i.metric}"` }],
      })),
    });
  }

  it('writes the changes since yesterday through the host, then finds nothing new on the next run', async () => {
    const data = withYesterday();
    const { runs, home } = setup({ data: () => data });
    const prepared = await runs.prepare({ operation: 'digest' });
    expect(prepared.kind).toBe('packet');
    if (prepared.kind !== 'packet') return;
    const done = runs.submit({ runId: prepared.runId, response: changesFor(prepared.packet) });
    expect(done.kind).toBe('done');
    if (done.kind !== 'done') return;
    expect(done.render).toMatch(/\*\*2 changes since the end of 2026-09-25 UTC\*\*/);
    expect(done.render).toContain("tga's signal moved to above-trend [1].");
    expect(readLatestDigest(home)?.changes).toHaveLength(2);

    const again = await runs.prepare({ operation: 'digest' });
    expect(again.kind).toBe('done');
    if (again.kind === 'done') expect(again.render).toMatch(/No changes since your last digest/);
    // journal_read opens the digest's packet by the run id prepare_operation gave.
    expect(runs.journalRead({ runId: prepared.runId })).toContain('2 changes since the end of 2026-09-25 UTC');
  });

  it("says the demo's day under its digest, and under the digest that finds nothing new", async () => {
    const data = withYesterday();
    const { runs } = setup({ data: () => data, savedOn: 'Sep 25, 2026' });
    const prepared = await runs.prepare({ operation: 'digest' });
    if (prepared.kind !== 'packet') throw new Error('no packet');
    const done = runs.submit({ runId: prepared.runId, response: changesFor(prepared.packet) });
    if (done.kind !== 'done') throw new Error('not done');
    expect(done.render).toContain('(demo: saved briefings of Sep 25, 2026;');
    const again = await runs.prepare({ operation: 'digest' });
    if (again.kind !== 'done') throw new Error('not done');
    expect(again.render).toContain('(demo: saved briefings of Sep 25, 2026;');
  });

  it('names only the format check for a reply that is not JSON, or not in its shape, not five checks that never ran', async () => {
    // Prose; an object in the wrong shape, as the app gives it; and JSON text in the wrong shape.
    for (const reply of ['Net liquidity turned flat, and the TGA moved above trend.', { changes: 'Net liquidity turned flat.' }, '{"changes":[],"summary":"Net liquidity turned flat."}']) {
      const { runs } = setup({ data: () => withYesterday() });
      const prepared = await runs.prepare({ operation: 'digest' });
      if (prepared.kind !== 'packet') throw new Error('no packet');
      const repair = runs.submit({ runId: prepared.runId, response: reply });
      // The repair turn names the format alone, as no other check ran.
      if (repair.kind !== 'repair') throw new Error('no repair turn');
      expect(repair.failures.every((f) => f.startsWith('schema: ')), JSON.stringify(reply)).toBe(true);
      const done = runs.submit({ runId: prepared.runId, response: reply });
      if (done.kind !== 'done') throw new Error('not done');
      expect(done.render, JSON.stringify(reply)).toContain("✗ 0 of 1 checks: the answer's format is wrong, so the other checks did not run on it");
      expect(done.render, JSON.stringify(reply)).not.toMatch(/advice words|of 6 checks/);
    }
  });

  it("says a digest packet over its cap is not handed out, and that a shorter watchlist fits", async () => {
    const data = withYesterday();
    const small = { ...digest, spec: { ...digest.spec, data: { ...digest.spec.data, maxPacketTokens: 50 } } };
    const { runs } = setup({ data: () => data, digest: small });
    await expect(runs.prepare({ operation: 'digest' })).rejects.toThrow(/^The digest's packet is over the digest operation's cap, so it was not handed out: it is [\d,]+ tokens, and the digest sends at most 50 tokens a packet\. A shorter watchlist fits\.$/);
  });
});

describe('journal_read inside an AI app', () => {
  it('opens a run by its id however old it is, and takes nothing but a run id', () => {
    const { runs, home } = setup();
    const old = join(home, 'journal', '2026-01-02', 'ask', '20260102T080000Z-0a0b0c');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'render.md'), 'An old answer.\n');
    // 501 newer runs, more than a listing reads.
    for (let i = 0; i < 501; i += 1) mkdirSync(join(home, 'journal', '2026-09-26', 'ask', `20260926T${String(100000 + i).slice(-6)}Z-${i.toString(16).padStart(6, '0')}`), { recursive: true });
    expect(runs.journalRead({ runId: '20260102T080000Z-0a0b0c' })).toBe('An old answer.\n');
    expect(runs.journalRead({ runId: '20260102T080000Z-ffffff' })).toBe('No run 20260102T080000Z-ffffff is in the journal.');
    expect(runs.journalRead({ runId: '../../secrets' })).toBe('../../secrets is not a run id, such as 20260928T120000Z-1a2b3c.');
  });
});

describe('the benchmark inside an AI app', () => {
  const keyed = (packet: string) => {
    const briefing = /^key: ([^_]+)__/m.exec(packet)?.[1] ?? '';
    const b = bench.briefings.find((x) => x.briefing === briefing)!;
    return { answers: Object.fromEntries(b.questions.map((q) => [q.id, q.key.answer])) };
  };
  const call = (runs: HostRuns, args: Parameters<HostRuns['benchNext']>[0] = {}) => {
    const next = runs.benchNext(args);
    return next.kind === 'packet' ? { ...next, text: `key: ${next.key}\n${next.packet}` } : next;
  };

  it('hands each packet out once, so several subagents can answer at the same time', () => {
    const { runs } = setup();
    const a = call(runs, { model: 'claude-haiku-4-5', runs: 1 });
    const b = call(runs);
    expect(a.kind === 'packet' && b.kind === 'packet' && a.key !== b.key).toBe(true);
    if (a.kind === 'packet') expect(a.total).toBe(15);
  });

  it('scores every reply by code and returns the result once all are recorded', () => {
    const { runs, home } = setup();
    let next = call(runs, { model: 'claude-haiku-4-5', runs: 1 });
    let recorded = 0;
    while (next.kind === 'packet') {
      const score = runs.benchRecord({ key: next.key, response: next.key.includes('__none__') ? '{}' : keyed(next.text) });
      recorded += 1;
      expect(score.done).toBe(recorded);
      next = call(runs);
    }
    expect(recorded).toBe(15);
    expect(next.render).toContain('Benchmark  claude-haiku-4-5 (declared) on the frozen fixtures of 2026-09-25');
    expect(next.render).toMatch(/markdown\s+100%/);
    expect(next.render).toMatch(/none\s+0%.*no data read/);
    const row = journalRows(join(home, 'journal')).find((r) => r.operation === 'bench')!;
    expect(row.title).toBe('claude-haiku-4-5 (declared), 15 answers');
  });

  it('hands a packet out again when it was never recorded, and never replaces a recorded reply', () => {
    const { runs } = setup();
    const keys: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const next = call(runs, { runs: 1 });
      if (next.kind === 'packet') keys.push(next.key);
    }
    for (const key of keys.slice(1)) runs.benchRecord({ key, response: '{}' });
    const again = call(runs);
    expect(again.kind === 'packet' && again.key).toBe(keys[0]);
    expect(() => runs.benchRecord({ key: keys[1]!, response: '{}' })).toThrow('already recorded');
  });
});

describe('a backtest inside an AI app', { timeout: 120_000 }, () => {
  const RULES = '# Rules\n1. Enter when the change over 7 days is above +2.0% and nothing is held.\n2. Exit when the change since entry is above +10.0%.\n3. Otherwise watch.\n';
  const YAML = 'rules: rules.md\nevery: day\ndata:\n  briefings: [btc.pulse]\n  price_days: 30\n  format: markdown\nlabels:\n  watch: { hold: true }\n  enter: { target: 0.5 }\n  exit: { target: 0 }\nfees: { per_trade: 0.001 }\n';
  const day = (i: number): string => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
  const CLOSES = Array.from({ length: 270 }, (_, i) => ({ date: day(i), price: 80_000 + 100 * i })).filter((c) => c.date < '2026-09-28');

  // Saved briefings for any day, and the closes above.
  class Dated extends FixtureConnector {
    readonly days: string[] = [];
    override async fetch(req: { briefing: string; format: 'json' | 'markdown'; date?: string }) {
      this.days.push(req.date ?? 'now');
      return super.fetch(req);
    }
    async bitcoinHistory(range: { from: string; to: string }) {
      return CLOSES.filter((c) => c.date >= range.from && c.date <= range.to);
    }
  }

  function backtesting(over: Partial<HostDeps> = {}) {
    const data = new Dated(BENCH_BRIEFINGS);
    const made = setup({ data: () => data, tier: () => 'enterprise', now: () => new Date('2026-09-28T12:00:00.000Z'), ...over });
    const dir = join(made.home, 'routines', 'btc-rules');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'routine.yaml'), YAML);
    writeFileSync(join(dir, 'rules.md'), RULES);
    return { ...made, data, dir };
  }

  // The answer a subagent gives: the label, citing the price table's first line and its rule.
  function reply(packet: string, label = 'enter'): string {
    const lines = packet.split('\n');
    const find = (block: string, has: string) => {
      const m = lines.map((l) => /^\[([a-z.]+) L(\d+)\] (.*)$/.exec(l)).find((x) => x?.[1] === block && x[3]?.includes(has));
      return { line: Number(m?.[2]), text: m?.[3] ?? '' };
    };
    const rule = find('rules', label === 'enter' ? 'Enter' : label === 'exit' ? 'Exit' : 'Otherwise');
    return JSON.stringify({
      label,
      reason: `The ${label} rule gave ${label}.`,
      claims: [
        { text: 'The price table covers the days read.', citations: [{ block: 'price', line: find('price', "Bitcoin's daily price").line, quote: "Bitcoin's daily price in US dollars" }] },
        { text: `The rule for ${label} applies.`, citations: [{ block: 'rules', line: rule.line, quote: rule.text }] },
      ],
      not_in_data: [],
    });
  }

  // claude-test's training, as the person gives it: it ends before the window.
  const WINDOW = { routine: 'btc-rules', from: '2026-09-01', to: '2026-09-03', model: 'claude-test', cutoff: '2024-01' };

  // Starts a run and answers the memory check as a model that recalls no price, returning
  // the first tick's packet.
  async function begin(runs: HostRuns, args: Parameters<HostRuns['backtestNext']>[0] = WINDOW) {
    let next = await runs.backtestNext(args);
    while (next.kind === 'packet' && next.key.startsWith('memory/')) {
      runs.backtestRecord({ run: next.run, key: next.key, response: { price: null } });
      next = await runs.backtestNext({ routine: args.routine, run: next.run });
    }
    if (next.kind !== 'packet') throw new Error(next.kind);
    return next;
  }

  it('hands out a tick in each arm at a time, and an arm its next tick only once its last is recorded', async () => {
    const { runs } = backtesting();
    const first = await begin(runs);
    expect(first).toMatchObject({ key: '1/treatment/2026-09-01', done: 0, total: 9 });
    expect(first.packet).toContain('Briefing btc.pulse');
    const control = await runs.backtestNext({ routine: 'btc-rules', run: first.run });
    const placebo = await runs.backtestNext({ routine: 'btc-rules', run: first.run });
    expect([control, placebo].map((n) => (n.kind === 'packet' ? n.key : n.kind))).toEqual(['1/control/2026-09-01', '1/placebo/2026-09-01']);
    if (control.kind !== 'packet') throw new Error(control.kind);
    expect(control.packet).not.toContain('Briefing btc.pulse');
    const waiting = await runs.backtestNext({ routine: 'btc-rules', run: first.run });
    expect(waiting).toMatchObject({ kind: 'wait', handed: ['1/treatment/2026-09-01', '1/control/2026-09-01', '1/placebo/2026-09-01'] });
    expect(runs.backtestRecord({ run: first.run, key: first.key, response: reply(first.packet) })).toEqual({ kind: 'recorded', line: '2026-09-01 treatment: enter, filled on 2026-09-02', done: 1, total: 9 });
    const next = await runs.backtestNext({ routine: 'btc-rules', run: first.run });
    expect(next).toMatchObject({ kind: 'packet', key: '1/treatment/2026-09-02' });
  });

  it("holds a label to the person's own cap on a position, as the backtest in a terminal does", async () => {
    const { runs, home } = backtesting();
    writeConfig(home, { ...readConfig(home), brokers: { alpaca: { mode: 'off', caps: { max_position_share: 0.25 } } } } as unknown as ReturnType<typeof readConfig>);
    const first = await begin(runs);
    runs.backtestRecord({ run: first.run, key: first.key, response: reply(first.packet, 'enter') });
    const find = (dir: string, name: string): string | null => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isFile() && entry.name === name) return path;
        const below = entry.isDirectory() ? find(path, name) : null;
        if (below) return below;
      }
      return null;
    };
    const ticks = readFileSync(find(join(home, 'routines'), 'ticks.jsonl') as string, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { target: number; capped: boolean });
    expect(ticks[0]).toMatchObject({ target: 0.25, capped: true });
  });

  it('hands two calls made at the same time two different ticks', async () => {
    const { runs } = backtesting();
    const first = await begin(runs);
    const both = await Promise.all([runs.backtestNext({ routine: 'btc-rules', run: first.run }), runs.backtestNext({ routine: 'btc-rules', run: first.run })]);
    expect(both.map((n) => (n.kind === 'packet' ? n.key : n.kind))).toEqual(['1/control/2026-09-01', '1/placebo/2026-09-01']);
  });

  it('checks each reply, gives one repair turn, and never replaces a recorded tick', async () => {
    const { runs } = backtesting();
    const first = await begin(runs);
    const repair = runs.backtestRecord({ run: first.run, key: first.key, response: reply(first.packet, 'buy') });
    expect(repair.kind).toBe('repair');
    expect(JSON.stringify(repair)).toContain('/label must be equal to one of the allowed values');
    expect(runs.backtestRecord({ run: first.run, key: first.key, response: reply(first.packet, 'watch') })).toMatchObject({ kind: 'recorded', line: '2026-09-01 treatment: watch, nothing to trade' });
    expect(() => runs.backtestRecord({ run: first.run, key: first.key, response: reply(first.packet) })).toThrow('a recorded tick is never replaced');
  });

  it('gives a reply that cites only the rules its repair turn, then records the tick with no label', async () => {
    const { runs } = backtesting();
    const first = await begin(runs);
    // The exit rule's line alone, with no line of the data: the label the personas walk found passing every check (10-14).
    const rulesOnly = (label: string) => {
      const answer = JSON.parse(reply(first.packet, label)) as { claims: unknown[] };
      return JSON.stringify({ ...answer, claims: answer.claims.slice(1) });
    };
    expect(runs.backtestRecord({ run: first.run, key: first.key, response: rulesOnly('exit') })).toEqual({ kind: 'repair', failures: ['cites_data: the label cites only your rules, and no line of the data they were applied to'] });
    expect(runs.backtestRecord({ run: first.run, key: first.key, response: rulesOnly('exit') })).toMatchObject({ kind: 'recorded', line: '2026-09-01 treatment: no label (failed), so the position held' });
  });

  it('returns the report once every tick is recorded, and keeps every answer in the journal', async () => {
    const { runs, home } = backtesting();
    let next: Awaited<ReturnType<HostRuns['backtestNext']>> = await begin(runs);
    const run = next.run;
    while (next.kind === 'packet') {
      runs.backtestRecord({ run, key: next.key, response: reply(next.packet, next.packet.includes('Briefing btc.pulse') ? 'enter' : 'watch') });
      next = await runs.backtestNext({ routine: 'btc-rules', run });
    }
    if (next.kind !== 'done') throw new Error(next.kind);
    expect(next.render).toContain('btc-rules  backtest | 2026-09-01 to 2026-09-03 | every day | 3 ticks');
    expect(next.render).toContain('the data changed the label on 3 of 3 ticks');
    expect(next.render).toContain('A simulation on past data: not a forecast, and not advice.');
    expect(next.render).toContain("Out of sample: claude-test's training reaches 2024-01, as you gave it, before the window.");
    expect(next.render).toContain('Memory check: asked 3 closes in the window with no data, claude-test gave no price for any of them.');
    const rows = journalRows(join(home, 'journal')).filter((r) => r.operation === 'routine.btc-rules');
    expect(rows).toHaveLength(9);
    const kept = JSON.parse(readFileSync(join(rows[0]?.dir as string, 'routine.json'), 'utf8')) as Record<string, unknown>;
    expect(kept).toMatchObject({ routine: 'btc-rules', backtest: run });
    expect(JSON.parse(readFileSync(join(rows[0]?.dir as string, 'meta.json'), 'utf8'))).toMatchObject({ model: 'claude-test (declared)', host: true });
  });

  it('carries a run on after the server restarts, with the model it started on and no other', async () => {
    const { runs, deps } = backtesting();
    const first = await begin(runs);
    runs.backtestRecord({ run: first.run, key: first.key, response: reply(first.packet) });
    await expect(runs.backtestNext({ routine: 'btc-rules', run: first.run, model: 'another-model' })).rejects.toThrow(`Run ${first.run} is answered by claude-test`);
    const restarted = new HostRuns(deps);
    await expect(restarted.backtestNext({ routine: 'btc-rules', run: first.run, model: 'another-model' })).rejects.toThrow('this run started on host:claude-test, not host:another-model');
    const again = new HostRuns(deps);
    const next = await again.backtestNext({ routine: 'btc-rules', run: first.run, model: 'claude-test' });
    expect(next).toMatchObject({ kind: 'packet', key: '1/control/2026-09-01', done: 1 });
  });

  it('learns an unknown tier with one read before it plans, so the key reads as far back as it can', async () => {
    // A key that names its tier on the first read it makes, as PreReason does.
    class Learning extends Dated {
      tier: 'enterprise' | null = null;
      override async fetch(req: { briefing: string; format: 'json' | 'markdown'; date?: string }) {
        this.tier = 'enterprise';
        return super.fetch(req);
      }
    }
    const learning = new Learning(BENCH_BRIEFINGS);
    const { runs } = backtesting({ data: () => learning, tier: () => learning.tier });
    const first = await begin(runs);
    expect(first).toMatchObject({ kind: 'packet', key: '1/treatment/2026-09-01', total: 9 });
    expect(learning.days[0]).toBe('now');
  });

  it('says in words why a run cannot start', async () => {
    const { runs, dir } = backtesting();
    await expect(runs.backtestNext({ ...WINDOW, from: '2026-09-20', to: '2026-09-28' })).rejects.toThrow('cannot run: the window ends on 2026-09-28');
    await expect(runs.backtestNext({ routine: 'btc-rules', model: 'claude-test' })).rejects.toThrow('Give the window to start a run');
    await expect(runs.backtestNext({ ...WINDOW, routine: 'nope' })).rejects.toThrow('There is no routine named nope');
    writeFileSync(join(dir, 'rules.md'), '<!-- later -->\n');
    await expect(runs.backtestNext(WINDOW)).rejects.toThrow('returns no_rules_defined and there is nothing to backtest');
    const { runs: demo } = backtesting({ routine: null });
    await expect(demo.backtestNext(WINDOW)).rejects.toThrow('The demo keeps no routines');
  });

  it('asks the model three closes with no data first, and holds a window it remembers for your yes', async () => {
    const { runs } = backtesting();
    const asked: Array<{ key: string; packet: string }> = [];
    let next = await runs.backtestNext(WINDOW);
    while (next.kind === 'packet') {
      asked.push({ key: next.key, packet: next.packet });
      next = await runs.backtestNext({ routine: 'btc-rules', run: next.run });
    }
    expect(asked.map((a) => a.key)).toEqual(['memory/2026-09-01', 'memory/2026-09-02', 'memory/2026-09-03']);
    expect(next).toMatchObject({ kind: 'wait', handed: ['memory/2026-09-01', 'memory/2026-09-02', 'memory/2026-09-03'] });
    const question = asked[0]?.packet ?? '';
    expect(question).toContain("Question: What was Bitcoin's closing price in US dollars on 2026-09-01?");
    expect(question).not.toContain('[price L');
    const run = next.run;
    // A model that recalls each close to within 1%.
    const lines = asked.map((a) => {
      const close = CLOSES.find((c) => `memory/${c.date}` === a.key)?.price ?? 0;
      return runs.backtestRecord({ run, key: a.key, response: { price: close * 1.01 } });
    });
    expect(lines[0]).toEqual({ kind: 'recorded', line: 'memory check, 2026-09-01: gave $105,343 against the close of $104,300, within 5%', done: 0, total: 9 });
    expect(() => runs.backtestRecord({ run, key: 'memory/2026-09-01', response: { price: 1 } })).toThrow('a recorded answer is never replaced');
    const blocked = await runs.backtestNext({ routine: 'btc-rules', run });
    expect(blocked).toEqual({ kind: 'blocked', run, reason: "claude-test gave 3 of 3 Bitcoin closes in the window within 5%, asked with no data, so it remembers the window; it runs only on your yes, and every result then says it is inside the model's training window" });
    // With the yes the ticks go on, their dates as day numbers, and the report says so.
    const tick = await runs.backtestNext({ routine: 'btc-rules', run, insideTraining: true });
    if (tick.kind !== 'packet') throw new Error(tick.kind);
    expect(tick.key).toBe('1/treatment/2026-09-01');
    expect(tick.packet).toContain('from day -29 to day 1, oldest first');
    expect(tick.packet).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    let done: Awaited<ReturnType<HostRuns['backtestNext']>> = tick;
    while (done.kind === 'packet') {
      runs.backtestRecord({ run, key: done.key, response: reply(done.packet, 'watch') });
      done = await runs.backtestNext({ routine: 'btc-rules', run });
    }
    if (done.kind !== 'done') throw new Error(done.kind);
    expect(done.render).toContain("Inside the model's training window: claude-test gave 3 of 3 closes in it within 5% with no data, and you said yes to running it.");
  });

  it('lets the memory check decide for a model whose cutoff it does not know, keeps a cutoff given, and holds a window inside it', async () => {
    const { runs, home } = backtesting();
    const unknown = { routine: 'btc-rules', from: '2026-09-01', to: '2026-09-03', model: 'claude-test' };
    // Not known, it starts all the same, with the memory check.
    await expect(runs.backtestNext(unknown)).resolves.toMatchObject({ kind: 'packet', key: 'memory/2026-09-01' });
    expect(readConfig(home).cutoffs?.['claude-test']).toBeUndefined();
    await expect(runs.backtestNext({ ...unknown, cutoff: '2024-1' })).rejects.toThrow('cutoff is a month, such as 2025-07');
    // A routine or a run named with a path is refused before anything is read.
    await expect(runs.backtestNext({ ...unknown, routine: '../btc-rules' })).rejects.toThrow('"../btc-rules" is not a routine name');
    await expect(runs.backtestNext({ routine: 'btc-rules', run: '../../btc-rules' })).rejects.toThrow('../../btc-rules is not a run id');
    await begin(runs, WINDOW);
    expect(readConfig(home).cutoffs).toEqual({ 'claude-test': '2024-01' });
    // Kept, it holds for the next run without it.
    await expect(runs.backtestNext(unknown)).resolves.toMatchObject({ kind: 'packet', key: 'memory/2026-09-01' });
    // A model the table knows, on a window inside its training.
    await expect(runs.backtestNext({ ...unknown, model: 'claude-opus-5-5', from: '2026-05-01', to: '2026-05-03' })).rejects.toThrow(
      "the window starts on 2026-05-01, inside claude-opus-5-5's training, which reaches 2026-06",
    );
    await expect(runs.backtestNext({ ...unknown, model: 'claude-opus-5-5', from: '2026-05-01', to: '2026-05-03', insideTraining: true })).resolves.toMatchObject({ kind: 'packet', key: 'memory/2026-05-01' });
  });
});

describe('the tier inside an AI app', () => {
  it('learns an unknown tier with one call before it lists the catalog', async () => {
    let tier: 'free' | 'pro' | null = null;
    const saved = new FixtureConnector(BENCH_BRIEFINGS);
    const reads: string[] = [];
    const data = Object.create(saved) as FixtureConnector;
    data.fetch = async (req) => {
      reads.push(req.briefing);
      tier = 'pro';
      return saved.fetch(req);
    };
    const { runs } = setup({ data: () => data, tier: () => tier });
    const prepared = await runs.prepare({ operation: 'ask', question: QUESTION });
    expect(reads).toEqual([smallestFree(catalog)!.id]);
    if (prepared.kind !== 'catalog') throw new Error('no catalog');
    // A pro key sees more than the six free briefings, where the saved ones exist.
    expect(prepared.briefings.length).toBeGreaterThanOrEqual(5);
    expect(tier).toBe('pro');
  });
});

describe("the plugin's skills", () => {
  const skills = join(ROOT, 'hosts', 'claude-code-plugin', 'skills');

  it('each parse as YAML frontmatter, named for its folder', () => {
    for (const name of readdirSync(skills)) {
      const text = readFileSync(join(skills, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
      expect(front, name).toBeDefined();
      const meta = parse(front!) as { name?: unknown; description?: unknown };
      expect(meta.name).toBe(name);
      expect(typeof meta.description).toBe('string');
    }
    // The control: a colon and a space inside a plain description is what broke the bench skill.
    expect(() => parse('name: bench\ndescription: a model the user picks: reading tests')).toThrow();
  });
});

describe('the MCP server', () => {
  async function session(lines: Array<object | string>): Promise<Array<Record<string, unknown>>> {
    const { runs } = setup();
    const input = new PassThrough();
    const output = new PassThrough();
    const replies: Array<Record<string, unknown>> = [];
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) replies.push(JSON.parse(line) as Record<string, unknown>);
    });
    const served = serveMcp(runs, { input, output }, { version: '0.1.0' });
    for (const line of lines) input.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
    await new Promise((r) => setTimeout(r, 200));
    input.end();
    await served;
    return replies;
  }

  it('speaks JSON-RPC over stdio: the handshake, tools, prompts and errors', async () => {
    const replies = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_operations', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'ask', arguments: { question: QUESTION } } },
      { jsonrpc: '2.0', id: 5, method: 'resources/list' },
      'not json',
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'prepare_operation', arguments: { operation: 'ask', question: QUESTION, briefings: ['btc.treasury'] } } },
      { jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'backtest', arguments: { routine: 'btc-rules', from: '2026-06-01', to: '2026-08-31' } } },
    ]);
    const byId = new Map(replies.map((r) => [r.id, r]));
    expect(byId.get(1)).toMatchObject({ result: { protocolVersion: '2025-06-18', serverInfo: { name: 'primerkit' }, capabilities: { tools: {}, prompts: {} } } });
    expect((byId.get(2) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(TOOLS.map((t) => t.name)).toEqual(['list_operations', 'prepare_operation', 'submit_response', 'journal_read', 'status', 'catalog', 'intent_record', 'bench_next', 'bench_record', 'backtest_next', 'backtest_record']);
    expect(JSON.stringify(byId.get(3))).toContain('Ask the briefings');
    // What prepare_operation takes for ask, and the backtest's two tools, are listed too.
    for (const said of ['metrics (optional)', 'date (optional, YYYY-MM-DD, one past day)', 'backtest_next, backtest_record']) expect(JSON.stringify(byId.get(3))).toContain(said);
    expect(JSON.stringify(byId.get(4))).toContain(`The question: ${QUESTION}`);
    expect(byId.get(5)).toMatchObject({ error: { code: -32601 } });
    expect(byId.get(null)).toMatchObject({ error: { code: -32700 } });
    expect(byId.get(6)).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(byId.get(7))).toContain('The routine: btc-rules. The window: 2026-06-01 to 2026-08-31.');
    expect(JSON.stringify(byId.get(7))).toContain('Call backtest_next with the routine');
    // The notification took no reply.
    expect(replies).toHaveLength(8);
  });

  it('answers a request it cannot read with an error, and keeps serving', async () => {
    const replies = await session([
      'null',
      '[1, 2]',
      '"words"',
      { jsonrpc: '2.0', id: 1, method: 5 },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: null },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ]);
    expect(replies.filter((r) => r.id === null)).toEqual([0, 1, 2].map(() => ({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })));
    const byId = new Map(replies.map((r) => [r.id, r]));
    expect(byId.get(1)).toMatchObject({ error: { code: -32600 } });
    expect(byId.get(2)).toMatchObject({ result: { isError: true } });
    expect(byId.get(3)).toMatchObject({ result: {} });
  });
});

describe('putting primerkit into an AI app', () => {
  const skillsFrom = join(ROOT, 'hosts', 'claude-code-plugin', 'skills');
  const recorder = (present: boolean): { run: Runner; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      run: async (command, args) => {
        calls.push([command, ...args].join(' '));
        return { code: args[1] === 'get' ? (present ? 0 : 1) : 0, stdout: '', stderr: '' };
      },
    };
  };

  it('shows the change for Claude Code, then adds its server and four skills named for primerkit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-install-'));
    const plan = planInstall('claude-code', { node: 'C:\\Program Files\\nodejs\\node.exe', bin: 'C:\\pk\\bin\\primerkit.js', home, skillsFrom });
    expect(describePlan(plan)).toEqual([
      'runs   claude mcp add --scope user primerkit -- "C:\\Program Files\\nodejs\\node.exe" C:\\pk\\bin\\primerkit.js mcp',
      `writes ${join(home, '.claude', 'skills', 'primerkit-ask', 'SKILL.md')}`,
      `writes ${join(home, '.claude', 'skills', 'primerkit-digest', 'SKILL.md')}`,
      `writes ${join(home, '.claude', 'skills', 'primerkit-bench', 'SKILL.md')}`,
      `writes ${join(home, '.claude', 'skills', 'primerkit-backtest', 'SKILL.md')}`,
    ]);
    const { run, calls } = recorder(false);
    await applyInstall(plan, run);
    expect(calls).toEqual(['claude mcp get primerkit', 'claude mcp add --scope user primerkit -- C:\\Program Files\\nodejs\\node.exe C:\\pk\\bin\\primerkit.js mcp']);
    const skill = readFileSync(join(home, '.claude', 'skills', 'primerkit-ask', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: primerkit-ask\n/);

    // Again: the server is there already, so it is not added twice.
    const second = recorder(true);
    expect(await applyInstall(plan, second.run)).toContain("Claude Code already lists primerkit's server");
    expect(second.calls).toEqual(['claude mcp get primerkit']);

    // And out again: exactly what went in.
    const out = recorder(true);
    await removeInstall(plan, out.run);
    expect(out.calls).toEqual(['claude mcp get primerkit', 'claude mcp remove --scope user primerkit']);
    // The skills folder it left empty goes, and .claude with it, which here held nothing else.
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('changes nothing when a skill of the same name is not primerkit\'s', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-install-'));
    const theirs = join(home, '.claude', 'skills', 'primerkit-digest');
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, 'SKILL.md'), '---\nname: my-digest\n---\nmine\n');
    const plan = planInstall('claude-code', { node: 'node', bin: 'pk.js', home, skillsFrom });
    const { run, calls } = recorder(false);
    await expect(applyInstall(plan, run)).rejects.toThrow("holds a skill that is not primerkit's, so nothing was changed");
    expect(calls).toEqual([]);
    expect(existsSync(join(home, '.claude', 'skills', 'primerkit-ask'))).toBe(false);
    expect(readFileSync(join(theirs, 'SKILL.md'), 'utf8')).toContain('mine');
  });

  it("adds a table to Codex's config and an entry to Gemini CLI's settings, keeping what is there", async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-install-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n');
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Dracula', mcpServers: { other: { command: 'x' } } }));
    const o = { node: 'node', bin: '/pk/bin/primerkit.js', home, skillsFrom };
    const { run } = recorder(false);

    const codex = planInstall('codex', o);
    await applyInstall(codex, run);
    await applyInstall(codex, run);
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toBe('model = "o3"\n\n[mcp_servers.primerkit]\ncommand = "node"\nargs = ["/pk/bin/primerkit.js", "mcp"]\n');
    expect(existsSync(join(home, '.agents', 'skills', 'primerkit-bench', 'SKILL.md'))).toBe(true);
    await removeInstall(codex, run);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "o3"\n');

    const gemini = planInstall('gemini', o);
    await applyInstall(gemini, run);
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings).toEqual({ theme: 'Dracula', mcpServers: { other: { command: 'x' }, primerkit: { command: 'node', args: ['/pk/bin/primerkit.js', 'mcp'] } } });
    await removeInstall(gemini, run);
    expect(JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'))).toEqual({ theme: 'Dracula', mcpServers: { other: { command: 'x' } } });
    expect(existsSync(join(home, '.gemini', 'skills'))).toBe(false);
    // The person's files stay, and so do the folders that hold them.
    expect(readdirSync(home).sort()).toEqual(['.codex', '.gemini']);
  });

  it('takes out the files and folders its install made where the app never ran, and leaves the home as it found it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-install-'));
    const o = { node: 'node', bin: 'pk.js', home, skillsFrom };
    const { run } = recorder(false);
    const said: string[] = [];
    for (const host of ['codex', 'gemini', 'lm-studio'] as const) {
      await applyInstall(planInstall(host, o), run);
      said.push(...(await removeInstall(planInstall(host, o), run)));
    }
    expect(readdirSync(home)).toEqual([]);
    expect(said).toContain(`removed ${join(home, '.codex', 'config.toml')}, which set nothing else`);
    expect(said).toContain(`removed ${join(home, '.agents')}, left empty`);
    expect(said).toContain(`removed ${join(home, '.gemini', 'settings.json')}, which set nothing else`);
    // CONTROL: a file primerkit's entry was not in is not touched, though it sets nothing.
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), '');
    expect(await removeInstall(planInstall('codex', o), run)).toEqual([]);
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(true);
  });

  it('replaces an older launch line on a new install, and takes the table or entry out whatever line it was written with', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-install-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n\n# my other server\n[mcp_servers.other]\ncommand = "x"\n');
    const at = (version: string) => ({ node: 'node', bin: 'pk.js', home, skillsFrom, launch: { command: 'npx', args: ['-y', `primerkit@${version}`, 'mcp'] } });
    const { run } = recorder(false);
    await applyInstall(planInstall('codex', at('0.1.0')), run);
    expect(await applyInstall(planInstall('codex', at('0.1.1')), run)).toContain(`edited ${join(home, '.codex', 'config.toml')}`);
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml.match(/\[mcp_servers\.primerkit\]/g)).toHaveLength(1);
    expect(toml).toContain('args = ["-y", "primerkit@0.1.1", "mcp"]');
    expect(toml).not.toContain('primerkit@0.1.0');
    // Out again from another version: primerkit's table goes, and nothing else.
    await removeInstall(planInstall('codex', at('0.2.0')), run);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "o3"\n\n# my other server\n[mcp_servers.other]\ncommand = "x"\n');

    // Gemini CLI's settings, with a byte order mark at the start, the same way.
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini', 'settings.json'), `\uFEFF${JSON.stringify({ theme: 'Dracula' })}`);
    await applyInstall(planInstall('gemini', at('0.1.0')), run);
    await applyInstall(planInstall('gemini', at('0.1.1')), run);
    expect(JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'))).toEqual({ theme: 'Dracula', mcpServers: { primerkit: { command: 'npx', args: ['-y', 'primerkit@0.1.1', 'mcp'] } } });
    await removeInstall(planInstall('gemini', at('0.2.0')), run);
    expect(JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'))).toEqual({ theme: 'Dracula', mcpServers: {} });
  });

  it("keeps what the person added to primerkit's own entry, and the rest of the file as it is", async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-install-'));
    const at = (version: string) => ({ node: 'node', bin: 'pk.js', home, skillsFrom, launch: { command: 'npx', args: ['-y', `primerkit@${version}`, 'mcp'] } });
    const { run } = recorder(false);
    // Codex, written with Windows line ends, with a line of the person's in primerkit's table.
    mkdirSync(join(home, '.codex'));
    const toml = (version: string) => `model = "o3"\r\n\r\n[mcp_servers.primerkit]\r\ncommand = "npx"\r\nargs = ["-y", "primerkit@${version}", "mcp"]\r\nstartup_timeout_sec = 30\r\n\r\n[mcp_servers.other]\r\ncommand = "x"\r\n`;
    writeFileSync(join(home, '.codex', 'config.toml'), toml('0.1.0'));
    expect(await applyInstall(planInstall('codex', at('0.1.0')), run)).toContain(`${join(home, '.codex', 'config.toml')} already lists primerkit's server`);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(toml('0.1.0'));
    await applyInstall(planInstall('codex', at('0.1.1')), run);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(toml('0.1.1'));
    // Gemini CLI: an env and trust the person set on primerkit's entry.
    mkdirSync(join(home, '.gemini'));
    const entry = (version: string) => ({ command: 'npx', args: ['-y', `primerkit@${version}`, 'mcp'], env: { X: '1' }, trust: true });
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { primerkit: entry('0.1.0') } }));
    expect(await applyInstall(planInstall('gemini', at('0.1.0')), run)).toContain(`${join(home, '.gemini', 'settings.json')} already lists primerkit's server`);
    await applyInstall(planInstall('gemini', at('0.1.1')), run);
    expect(JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'))).toEqual({ mcpServers: { primerkit: entry('0.1.1') } });
  });

  it('starts the server through npx at its version when told to, through cmd /c on Windows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-install-'));
    const launch = { command: 'cmd', args: ['/c', 'npx', '-y', 'primerkit@0.1.0', 'mcp'] };
    const plan = planInstall('claude-code', { node: 'node', bin: 'pk.js', home, skillsFrom, launch });
    expect(describePlan(plan)[0]).toBe('runs   claude mcp add --scope user primerkit -- cmd /c npx -y primerkit@0.1.0 mcp');
    const { run } = recorder(false);
    const codex = planInstall('codex', { node: 'node', bin: 'pk.js', home, skillsFrom, launch: { command: 'npx', args: ['-y', 'primerkit@0.1.0', 'mcp'] } });
    await applyInstall(codex, run);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('[mcp_servers.primerkit]\ncommand = "npx"\nargs = ["-y", "primerkit@0.1.0", "mcp"]\n');
  });

  it("adds an entry to LM Studio's mcp.json, with no skills, where LM Studio keeps it", async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-install-'));
    const launch = { command: 'npx', args: ['-y', 'primerkit@0.1.0', 'mcp'] };
    const plan = planInstall('lm-studio', { node: 'node', bin: 'pk.js', home, skillsFrom, launch });
    expect(plan.name).toBe('LM Studio');
    expect(describePlan(plan)).toEqual([`edits  ${join(home, '.lmstudio', 'mcp.json')}: adds "primerkit" under mcpServers: npx -y primerkit@0.1.0 mcp`]);
    const { run } = recorder(false);
    await applyInstall(plan, run);
    expect(JSON.parse(readFileSync(join(home, '.lmstudio', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { primerkit: launch } });
    await removeInstall(plan, run);
    // LM Studio never ran here, so the file the install made goes, and its folder.
    expect(existsSync(join(home, '.lmstudio'))).toBe(false);
    // Where LM Studio has run, its folder holds more, and the file stays, with no servers.
    mkdirSync(join(home, '.lmstudio', 'models'), { recursive: true });
    await applyInstall(plan, run);
    await removeInstall(plan, run);
    expect(JSON.parse(readFileSync(join(home, '.lmstudio', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: {} });
    // A Mac whose LM Studio keeps the file in ~/.cache/lm-studio, and none in ~/.lmstudio.
    const mac = mkdtempSync(join(tmpdir(), 'pk-install-'));
    mkdirSync(join(mac, '.cache', 'lm-studio'), { recursive: true });
    writeFileSync(join(mac, '.cache', 'lm-studio', 'mcp.json'), '{ "mcpServers": {} }');
    expect(lmStudioConfig(mac)).toBe(join(mac, '.cache', 'lm-studio', 'mcp.json'));
    expect(lmStudioConfig(home)).toBe(join(home, '.lmstudio', 'mcp.json'));
  });

  // The walk of 10-14 read "runs claude mcp add" and "writes …SKILL.md" under "Taking
  // primerkit out": the uninstall showed the install's steps.
  it("shows an uninstall its own steps for every app, and the yes takes exactly those", async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-install-'));
    const o = { node: 'node', bin: 'pk.js', home, skillsFrom };
    const skills = (dir: string) => ['ask', 'digest', 'bench', 'backtest'].map((s) => `deletes ${join(dir, `primerkit-${s}`)}`);
    expect(describeRemoval(planInstall('claude-code', o))).toEqual([
      'runs    claude mcp remove --scope user primerkit',
      ...skills(join(home, '.claude', 'skills')),
      `deletes ${join(home, '.claude', 'skills')}, and ${join(home, '.claude')}, if that leaves them empty`,
    ]);
    expect(describeRemoval(planInstall('codex', o))).toEqual([
      `edits   ${join(home, '.codex', 'config.toml')}: takes out the [mcp_servers.primerkit] table`,
      ...skills(join(home, '.agents', 'skills')),
      `deletes ${join(home, '.agents', 'skills')}, and ${join(home, '.agents')}, if that leaves them empty`,
      `deletes ${join(home, '.codex', 'config.toml')}, and ${join(home, '.codex')}, if the file is left setting nothing and alone in its folder`,
    ]);
    expect(describeRemoval(planInstall('gemini', o))).toEqual([
      `edits   ${join(home, '.gemini', 'settings.json')}: takes "primerkit" out from under mcpServers`,
      ...skills(join(home, '.gemini', 'skills')),
      `deletes ${join(home, '.gemini', 'skills')}, and ${join(home, '.gemini')}, if that leaves them empty`,
      `deletes ${join(home, '.gemini', 'settings.json')}, and ${join(home, '.gemini')}, if the file is left setting nothing and alone in its folder`,
    ]);
    expect(describeRemoval(planInstall('lm-studio', o))).toEqual([
      `edits   ${join(home, '.lmstudio', 'mcp.json')}: takes "primerkit" out from under mcpServers`,
      `deletes ${join(home, '.lmstudio', 'mcp.json')}, and ${join(home, '.lmstudio')}, if the file is left setting nothing and alone in its folder`,
    ]);
    // No step of an install is shown for an uninstall, for any app.
    for (const host of ['claude-code', 'codex', 'gemini', 'lm-studio'] as const) {
      const said = describeRemoval(planInstall(host, o)).join('\n');
      expect(said).not.toMatch(/\bwrites\b|\badds?\b| mcp add /);
      // CONTROL: the install's own preview says exactly those words.
      expect(describePlan(planInstall(host, o)).join('\n')).toMatch(/\bwrites\b|\badds\b/);
    }

    // With the yes: the command it said is the one run, and what it said it deletes is gone.
    for (const host of ['claude-code', 'codex', 'gemini', 'lm-studio'] as const) {
      const plan = planInstall(host, o);
      await applyInstall(plan, recorder(false).run);
      const out = recorder(true);
      await removeInstall(plan, out.run);
      const lines = describeRemoval(plan);
      for (const line of lines.filter((l) => l.startsWith('runs    '))) expect(out.calls).toContain(line.slice('runs    '.length));
      expect(out.calls.filter((c) => !c.endsWith(' get primerkit'))).toEqual(lines.filter((l) => l.startsWith('runs    ')).map((l) => l.slice('runs    '.length)));
      for (const line of lines.filter((l) => l.startsWith('deletes '))) expect(existsSync(line.slice('deletes '.length).split(', ')[0]!)).toBe(false);
    }
    // The app never ran here, so taking everything out leaves the home as it was.
    expect(readdirSync(home)).toEqual([]);
  });
});

